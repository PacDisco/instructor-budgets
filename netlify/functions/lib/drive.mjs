// Receipt storage in a Google Shared Drive, via a service account.
//
// A service account has no personal Drive quota, so it cannot own files in a My
// Drive folder. A Shared Drive can, which is why that was the right choice — the
// service account is just a member and the Drive itself owns the files.
//
// Every call needs supportsAllDrives=true or the API pretends the folder isn't
// there, which is a confusing way to spend an afternoon.

import { SignJWT, importPKCS8 } from 'jose';

// Service account keys arrive in more shapes than they should: with \n escapes
// from the JSON file, with real newlines if pasted from a terminal, with the
// PEM header stripped by a careless copy, or base64-wrapped entirely. Rather
// than one brittle replace, normalise all of them into real PKCS#8 PEM.
export function normalisePrivateKey(raw) {
  let k = String(raw || '').trim();
  if (!k) return '';

  // Strip surrounding quotes some UIs add.
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }

  // Literal backslash-n sequences into real newlines.
  k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');

  // Whole value base64'd: decode once if that yields a PEM.
  if (!k.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(k)) {
    try {
      const decoded = atob(k.replace(/\s+/g, ''));
      if (decoded.includes('BEGIN')) k = decoded;
    } catch { /* not base64, fall through */ }
  }

  // Header stripped, leaving just the base64 body — rebuild the wrapper. This is
  // the common one: copying the JSON value without its -----BEGIN----- lines.
  if (!k.includes('BEGIN')) {
    const body = k.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) return k;
    return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  }

  return k.endsWith('\n') ? k : k + '\n';
}

// Full drive scope, not drive.file. drive.file is per-file and only covers what
// the app itself created — an admin-created receipts folder is invisible to it
// and every call returns 404. The blast radius is bounded by Drive membership
// rather than by scope: this service account is a member of exactly one Shared
// Drive, so that is all it can reach.
const SCOPE = 'https://www.googleapis.com/auth/drive';
let cachedToken = null; // { token, expires }

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  const email = process.env.GOOGLE_SA_EMAIL;
  // Netlify env vars can't hold real newlines, so the key is stored with \n
  // escapes and unescaped here.
  const rawKey = normalisePrivateKey(process.env.GOOGLE_SA_PRIVATE_KEY);
  if (!email || !rawKey) throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set');

  const key = await importPKCS8(rawKey, 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Drive token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function driveFetch(path, init = {}) {
  const token = await accessToken();
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// One folder per budget, created on first receipt and remembered on the budget
// row so we don't pay a lookup per upload.
export async function ensureBudgetFolder(sql, budget) {
  if (budget.drive_folder_id) return budget.drive_folder_id;

  const parent = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!parent) throw new Error('DRIVE_ROOT_FOLDER_ID is not set');

  const q = encodeURIComponent(
    `name='${budget.name.replace(/'/g, "\\'")}' and '${parent}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await driveFetch(
    `/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`
  );

  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await driveFetch('/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: budget.name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      }),
    });
    id = created.id;
  }

  await sql`update budgets set drive_folder_id = ${id}, updated_at = now() where id = ${budget.id}`;
  return id;
}

// Multipart upload, built by hand to avoid pulling in the googleapis package —
// which is tens of megabytes for the one call we actually need.
export async function uploadReceipt({ folderId, name, contentType, bytes }) {
  const boundary = `fb${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = JSON.stringify({ name, parents: [folderId] });
  const enc = new TextEncoder();

  const body = new Blob([
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ]);

  const token = await accessToken();
  const res = await fetch(
    '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink'
      .replace(/^/, 'https://www.googleapis.com'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload: ${res.status} ${await res.text()}`);
  return res.json(); // { id, webViewLink }
}

// Streams a receipt back through the API rather than exposing a Drive link to
// the browser. Keeps the Shared Drive private and means a file someone drags to
// another folder still resolves by id.
export async function receiptBytes(fileId) {
  const token = await accessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive download: ${res.status}`);
  return res;
}

/* ---------------------------------------------------------- diagnostics ---
   Receipt upload has four separate prerequisites and failing any of them
   produces the same symptom: nothing arrives in Drive. This walks them in order
   and reports the first that breaks, with the fix rather than the stack trace. */

export async function diagnose(sql) {
  const steps = [];
  const add = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };

  const email = process.env.GOOGLE_SA_EMAIL;
  const key = normalisePrivateKey(process.env.GOOGLE_SA_PRIVATE_KEY);
  const folder = process.env.DRIVE_ROOT_FOLDER_ID;

  if (!add('GOOGLE_SA_EMAIL set', !!email,
      email ? email : 'Missing. Copy client_email from the service account JSON.')) return steps;

  if (!add('GOOGLE_SA_PRIVATE_KEY set', !!key,
      key ? `${key.length} chars` : 'Missing. Copy private_key from the service account JSON.')) return steps;

  // Actually attempt the import rather than pattern-matching the text — the
  // normaliser reconstructs a PEM wrapper from a bare base64 body, so a header
  // check would now always pass and tell you nothing.
  const shape = /BEGIN PRIVATE KEY/.test(String(process.env.GOOGLE_SA_PRIVATE_KEY || ''))
    ? 'PEM as supplied'
    : 'base64 body, PEM wrapper reconstructed';
  try {
    await importPKCS8(key, 'RS256');
    add('private key parses as PKCS#8', true, shape);
  } catch (err) {
    return add('private key parses as PKCS#8', false,
      `${err.message}. Received ${key.length} chars (${shape}). Re-copy the private_key value from the service account JSON, including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.`), steps;
  }

  if (!add('DRIVE_ROOT_FOLDER_ID set', !!folder,
      folder ? folder : 'Missing. Copy the id from the Shared Drive folder URL.')) return steps;

  let token;
  try {
    token = await accessToken();
    add('service account can get a token', true, 'ok');
  } catch (err) {
    return add('service account can get a token', false,
      `${err.message}. Check the key is valid and the Drive API is enabled in this Google Cloud project.`), steps;
  }

  let meta;
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folder)}?supportsAllDrives=true&fields=id,name,mimeType,driveId`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      // Google returns 403 both for "API not enabled" and for "no permission",
      // and the raw body buries which one it is behind 300 characters of prose.
      let why;
      if (res.status === 404) {
        why = `404. The folder is invisible to this service account. Either the id is wrong, `
            + `or ${email} has not been added as a member of the Shared Drive — add it as a `
            + `Content manager. (A 404 rather than a 403 is how Drive reports "you cannot see this".)`;
      } else if (/has not been used in project|is disabled/.test(body)) {
        const project = (body.match(/project (\d+)/) || [])[1];
        why = `The Google Drive API is not enabled${project ? ` in project ${project}` : ''}. `
            + `Enable it at https://console.cloud.google.com/apis/library/drive.googleapis.com`
            + `${project ? `?project=${project}` : ''} and retry in a minute.`;
      } else if (res.status === 403) {
        why = `403. ${email} can reach the API but not this folder — add it as a Content manager on the Shared Drive.`;
      } else {
        why = `${res.status} ${body.slice(0, 200)}`;
      }
      return add('folder is reachable', false, why), steps;
    }
    meta = await res.json();
    add('folder is reachable', true, `${meta.name}${meta.driveId ? ' (Shared Drive)' : ' (My Drive)'}`);
  } catch (err) {
    return add('folder is reachable', false, err.message), steps;
  }

  // A service account has no storage quota of its own, so it cannot own files
  // in a My Drive folder no matter what the sharing says.
  add('folder is on a Shared Drive', !!meta.driveId,
    meta.driveId ? 'ok' : 'This folder is in a personal My Drive. A service account has no storage quota, so uploads will fail with a quota error. Move it to a Shared Drive.');

  try {
    const probe = await driveFetch('/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '.field-budget-write-test', parents: [folder] }),
    });
    await fetch(`https://www.googleapis.com/drive/v3/files/${probe.id}?supportsAllDrives=true`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    add('can create and delete a file', true, 'ok');
  } catch (err) {
    add('can create and delete a file', false,
      `${err.message}. ${email} probably needs Content manager rather than Viewer on the Shared Drive.`);
  }

  return steps;
}
