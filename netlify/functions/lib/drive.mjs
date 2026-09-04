// Receipt storage in a Google Shared Drive, via a service account.
//
// A service account has no personal Drive quota, so it cannot own files in a My
// Drive folder. A Shared Drive can, which is why that was the right choice — the
// service account is just a member and the Drive itself owns the files.
//
// Every call needs supportsAllDrives=true or the API pretends the folder isn't
// there, which is a confusing way to spend an afternoon.

import { SignJWT, importPKCS8 } from 'jose';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
let cachedToken = null; // { token, expires }

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  const email = process.env.GOOGLE_SA_EMAIL;
  // Netlify env vars can't hold real newlines, so the key is stored with \n
  // escapes and unescaped here.
  const rawKey = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
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
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const folder = process.env.DRIVE_ROOT_FOLDER_ID;

  if (!add('GOOGLE_SA_EMAIL set', !!email,
      email ? email : 'Missing. Copy client_email from the service account JSON.')) return steps;

  if (!add('GOOGLE_SA_PRIVATE_KEY set', !!key,
      key ? `${key.length} chars` : 'Missing. Copy private_key from the service account JSON.')) return steps;

  if (!add('private key looks like PKCS#8',
      key.includes('BEGIN PRIVATE KEY'),
      key.includes('BEGIN PRIVATE KEY')
        ? 'ok'
        : 'Does not contain "BEGIN PRIVATE KEY". The \\n escapes were probably mangled on paste.')) return steps;

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
      return add('folder is reachable', false,
        res.status === 404
          ? `404. Either the id is wrong, or ${email} has not been added as a member of the Shared Drive.`
          : `${res.status} ${body.slice(0, 200)}`), steps;
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
