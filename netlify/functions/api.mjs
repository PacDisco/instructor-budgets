// Field Budget API — single Netlify Function, routed internally.
// netlify.toml rewrites /api/* here, so req.url still carries the original path.

import { json, corsHeaders, readCookie, sessionCookie, normaliseEmail } from './lib/http.mjs';
import { db, adminEmails, assignedBudgetIds, coerceMoney } from './lib/db.mjs';
import {
  issueSession, currentEmail, SESSION_MAX_AGE,
  emailFromGoogleCredential, createMagicToken, consumeMagicToken,
  sendMagicLink, emailIsKnown, checkAccessCode,
} from './lib/auth.mjs';
import { ensureBudgetFolder, uploadReceipt, receiptBytes, diagnose } from './lib/drive.mjs';

const MONEY_BUDGET = ['funded_base'];
const MONEY_CAT = ['allocated'];
const MONEY_ENTRY = ['amount', 'budget_amount', 'actual_base'];

function apiPath(request) {
  let p = new URL(request.url).pathname;
  // Depending on how the rewrite resolves, the function may see either form.
  p = p.replace(/^\/\.netlify\/functions\/api/, '');
  if (!p.startsWith('/api')) p = `/api${p}`;
  return p.replace(/\/+$/, '') || '/api';
}

/* ---------------- auth routes ---------------- */

async function postGoogle(request) {
  const { credential } = await request.json();
  if (!credential) return json({ error: 'Missing credential' }, 400, request);

  let email;
  try {
    email = await emailFromGoogleCredential(credential);
  } catch {
    return json({ error: 'Could not verify that Google sign-in' }, 401, request);
  }
  if (!email) return json({ error: 'That Google account has no verified email' }, 401, request);
  if (!(await emailIsKnown(email))) {
    return json({ error: 'not_assigned', email }, 403, request);
  }

  const token = await issueSession(email);
  return json({ email }, 200, request, { 'set-cookie': sessionCookie(token, SESSION_MAX_AGE) });
}

async function postAccessCode(request) {
  const body = await request.json().catch(() => ({}));
  const email = normaliseEmail(body.email);
  const code = String(body.code || '');
  if (!email || !code) {
    return json({ error: 'Enter your email and code.' }, 400, request);
  }

  const result = await checkAccessCode(email, code);
  if (!result.ok) {
    if (result.reason === 'locked') {
      return json({
        error: `Too many attempts. Try again in ${result.minutes} minute${result.minutes === 1 ? '' : 's'}, or ask your programme director for a new code.`,
        locked: true,
      }, 429, request);
    }
    // Same message whether the address is unknown or the code is wrong — the
    // difference would be a free check on who has an account.
    return json({ error: 'That email and code don\'t match.' }, 401, request);
  }

  if (!(await emailIsKnown(email))) {
    return json({ error: 'not_assigned', email }, 403, request);
  }

  const token = await issueSession(email);
  return json({ email }, 200, request, { 'set-cookie': sessionCookie(token, SESSION_MAX_AGE) });
}

async function postMagicRequest(request) {
  const { email: raw } = await request.json();
  const email = normaliseEmail(raw);
  // Always report success. Telling an anonymous caller which addresses exist is
  // a free directory of your staff.
  if (email && (await emailIsKnown(email))) {
    const token = await createMagicToken(email);
    const base = process.env.APP_ORIGIN || new URL(request.url).origin;
    await sendMagicLink(email, `${base}/api/auth/magic?token=${token}`);
  }
  return json({ sent: true }, 200, request);
}

async function getMagicVerify(request) {
  const token = new URL(request.url).searchParams.get('token');
  const base = process.env.APP_ORIGIN || new URL(request.url).origin;
  const email = token ? await consumeMagicToken(token) : null;
  if (!email) {
    return new Response(null, { status: 302, headers: { location: `${base}/?auth=expired` } });
  }
  const session = await issueSession(normaliseEmail(email));
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/`, 'set-cookie': sessionCookie(session, SESSION_MAX_AGE) },
  });
}

function postLogout(request) {
  return json({ ok: true }, 200, request, { 'set-cookie': sessionCookie('', 0) });
}

/* ---------------- instructor routes ---------------- */

// Everything the app needs to run offline: budgets, categories, and every entry
// on them. Small enough at programme scale to send whole rather than paginate.
async function getMe(request, email) {
  const sql = db();
  const ids = await assignedBudgetIds(email);
  const isAdmin = adminEmails().includes(email);
  if (!ids.length) return json({ email, is_admin: isAdmin, budgets: [], entries: [] }, 200, request);

  const [budgets, categories, entries] = await Promise.all([
    sql`select * from budgets where id = any(${ids}) and status = 'active'`,
    // Parent's position first, then parent-before-children, then the child's
    // own position — so the field app lists categories in the same order the
    // admin arranged them.
    // Recursive materialised path so ordering holds at three levels. Level 1 is
    // a programme leg and carries the currency and rates.
    sql`with recursive tree as (
          select c.*, 1 as depth, lpad(c.sort_order::text, 6, '0') as path
            from categories c
           where c.parent_id is null and c.budget_id = any(${ids})
          union all
          select c.*, t.depth + 1, t.path || '.' || lpad(c.sort_order::text, 6, '0')
            from categories c
            join tree t on c.parent_id = t.id
        )
        select * from tree order by path, id`,
    sql`select * from entries where budget_id = any(${ids}) order by received_at`,
  ]);

  const cats = categories.map((c) => ({
    ...coerceMoney(c, MONEY_CAT),
    rates: c.rates || {},
    depth: Number(c.depth),
  }));
  const shaped = budgets.map((b) => ({
    ...coerceMoney(b, MONEY_BUDGET),
    base_currency: b.base_currency || 'NZD',
    categories: cats.filter((c) => c.budget_id === b.id),
  }));

  return json({
    email,
    is_admin: isAdmin,
    budgets: shaped,
    entries: entries.map((e) => ({ ...coerceMoney(e, MONEY_ENTRY), rate: Number(e.rate) })),
    server_time: new Date().toISOString(),
  }, 200, request);
}

// Append-only and idempotent. A device that resurfaces after eleven days offline
// posts its whole outbox; anything already stored is skipped.
async function postSync(request, email) {
  const sql = db();
  const body = await request.json();
  const incoming = Array.isArray(body.entries) ? body.entries : [];
  if (incoming.length > 500) return json({ error: 'Batch too large, split it' }, 413, request);

  const allowed = new Set(await assignedBudgetIds(email));
  const accepted = [];
  const rejected = [];

  for (const e of incoming) {
    if (!e.id || !allowed.has(e.budget_id)) {
      rejected.push({ id: e.id, reason: 'not_assigned' });
      continue;
    }
    // A correction must point at an existing entry in the same budget. Without
    // this a malformed or malicious client could void a row in someone else's.
    if (e.entry_type === 'correction') {
      if (!e.corrects_id) { rejected.push({ id: e.id, reason: 'correction_without_target' }); continue; }
      const target = await sql`
        select 1 from entries where id = ${e.corrects_id} and budget_id = ${e.budget_id} limit 1`;
      if (!target.length) { rejected.push({ id: e.id, reason: 'correction_target_missing' }); continue; }
    }

    try {
      await sql`
        insert into entries (
          id, budget_id, category_id, email, entry_type, group_id, spent_on, amount,
          currency, rate, budget_amount, payment_method, description,
          receipt_file_id, receipt_link, corrects_id, created_at
        ) values (
          ${e.id}, ${e.budget_id}, ${e.category_id ?? null}, ${email}, ${e.entry_type},
          ${e.group_id ?? null}, ${e.spent_on}, ${Math.round(e.amount)}, ${e.currency},
          ${e.rate ?? 1}, ${Math.round(e.budget_amount)}, ${e.payment_method ?? 'cash'},
          ${e.description ?? ''}, ${e.receipt_file_id ?? null}, ${e.receipt_link ?? null},
          ${e.corrects_id ?? null}, ${e.created_at}
        )
        on conflict (id) do nothing`;
      accepted.push(e.id);
    } catch (err) {
      rejected.push({ id: e.id, reason: String(err.message || err) });
    }
  }
  return json({ accepted, rejected }, 200, request);
}

// Receipts go up on their own request so a stuck photo on a bad uplink never
// blocks a small taxi fare from syncing.
// The instructor's own description makes these findable in Drive months later,
// which a UUID does not. The entry hasn't synced yet when the photo arrives, so
// the note is sent by the client rather than read from the database.
const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};

function receiptFilename(noteHeader, email, entryId, contentType) {
  const stamp = new Date().toISOString().slice(0, 10);
  const short = entryId.slice(0, 8);
  // A gallery pick can be HEIC or PNG; naming it .jpg would make it unopenable
  // on some machines for no reason.
  const ext = EXT_BY_TYPE[String(contentType || '').split(';')[0].trim()] || 'jpg';
  let note = '';
  if (noteHeader) {
    try {
      note = new TextDecoder().decode(
        Uint8Array.from(atob(noteHeader), (c) => c.charCodeAt(0)));
    } catch { note = ''; }
  }

  note = note
    .replace(/[\/\\]/g, '-')        // path separators confuse Drive clients
    .replace(/[\u0000-\u001f]/g, '') // control characters from a paste
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);

  return note
    ? `${note} [${short}].${ext}`
    : `${stamp} - ${email.split('@')[0]} - ${short}.${ext}`;
}

async function putReceipt(request, email, entryId) {
  const sql = db();
  const budgetId = new URL(request.url).searchParams.get('budget');
  if (!budgetId || !entryId) return json({ error: 'Missing budget or entry' }, 400, request);

  const allowed = new Set(await assignedBudgetIds(email));
  if (!allowed.has(budgetId)) return json({ error: 'Not assigned' }, 403, request);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 4_000_000) return json({ error: 'Receipt too large' }, 413, request);

  const rows = await sql`select * from budgets where id = ${budgetId}`;
  if (!rows.length) return json({ error: 'No such budget' }, 404, request);

  let folderId;
  try {
    folderId = await ensureBudgetFolder(sql, rows[0]);
  } catch (err) {
    console.error('receipt folder:', err);
    return json({ error: `Drive folder unavailable: ${err.message}` }, 502, request);
  }
  let uploaded;
  try {
    uploaded = await uploadReceipt({
      folderId,
      name: receiptFilename(request.headers.get('x-receipt-note'), email, entryId,
                            request.headers.get('content-type')),
      contentType: request.headers.get('content-type') || 'image/jpeg',
      bytes,
    });
  } catch (err) {
    console.error('receipt upload:', err);
    return json({ error: `Drive upload failed: ${err.message}` }, 502, request);
  }

  // The entry may not have synced yet; when it does, sync carries these fields.
  await sql`
    update entries set receipt_file_id = ${uploaded.id}, receipt_link = ${uploaded.webViewLink ?? null}
    where id = ${entryId}`;

  return json({ file_id: uploaded.id, link: uploaded.webViewLink ?? null }, 200, request);
}

async function getReceipt(request, email, fileId) {
  const sql = db();
  const rows = await sql`
    select e.id from entries e
    join assignments a on a.budget_id = e.budget_id
    where e.receipt_file_id = ${fileId} and a.email = ${email} limit 1`;
  if (!rows.length && !adminEmails().includes(email)) {
    return json({ error: 'Not found' }, 404, request);
  }
  const upstream = await receiptBytes(fileId);
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'private, max-age=86400',
      ...corsHeaders(request),
    },
  });
}

/* ---------------- entry point ---------------- */

export default async function handler(request) {
  const path = apiPath(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  try {
    // Public: the sign-in paths themselves.
    if (path === '/api/auth/code' && request.method === 'POST') return await postAccessCode(request);
    if (path === '/api/auth/google' && request.method === 'POST') return await postGoogle(request);
    if (path === '/api/auth/magic-link' && request.method === 'POST') return await postMagicRequest(request);
    if (path === '/api/auth/magic' && request.method === 'GET') return await getMagicVerify(request);
    if (path === '/api/auth/logout') return postLogout(request);
    // Public so the static app can render the Google button without a build step.
    if (path === '/api/auth/config') {
      return json({ google_client_id: process.env.GOOGLE_CLIENT_ID || null }, 200, request);
    }

    const email = await currentEmail(request);
    if (!email) return json({ error: 'signed_out' }, 401, request);

    if (path === '/api/me') return await getMe(request, email);
    if (path === '/api/sync' && request.method === 'POST') return await postSync(request, email);

    // Walks the Drive prerequisites and reports the first that fails. Admin only
    // because the output names env vars and the service account address.
    if (path === '/api/receipts/_diagnose') {
      if (!adminEmails().includes(email)) return json({ error: 'Not an admin' }, 403, request);
      const steps = await diagnose();
      return json({ ok: steps.every((s) => s.ok), steps }, 200, request);
    }

    const put = path.match(/^\/api\/receipts\/([^/]+)$/);
    if (put && request.method === 'PUT') return await putReceipt(request, email, put[1]);
    if (put && request.method === 'GET') return await getReceipt(request, email, put[1]);

    return json({ error: 'Not found' }, 404, request);
  } catch (err) {
    console.error('api error', err);
    return json({ error: String(err.message || err) }, 500, request);
  }
}
