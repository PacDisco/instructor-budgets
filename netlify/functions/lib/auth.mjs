// Session handling, Google sign-in, and magic links.
//
// Cloudflare Access used to do all of this. On Netlify it has to be code, so the
// design goal is: no passwords stored anywhere, and both sign-in paths converge
// on one session cookie so the rest of the API only ever sees a verified email.

import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { db } from './db.mjs';
import { verifyCode } from './access-code.mjs';
import { normaliseEmail, readCookie } from './http.mjs';

const SESSION_DAYS = 30; // field devices go weeks between logins
const MAGIC_TTL_MIN = 20;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return new TextEncoder().encode(s);
}

export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

export async function issueSession(email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function currentEmail(request) {
  const token = readCookie(request, 'fb_session');
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return normaliseEmail(payload.email);
  } catch {
    return null;
  }
}

/* ---------- Google ---------- */

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Verifies the ID token Google Identity Services hands the browser. Checking
// `aud` against our own client id is what stops a token minted for some other
// site being replayed here.
export async function emailFromGoogleCredential(credential) {
  const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  if (!payload.email || payload.email_verified !== true) return null;
  return normaliseEmail(payload.email);
}

/* ---------- Magic links ---------- */

async function hashToken(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createMagicToken(email) {
  const sql = db();
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const hash = await hashToken(token);
  const expires = new Date(Date.now() + MAGIC_TTL_MIN * 60 * 1000).toISOString();
  // Only the hash is stored. A leaked database row can't be used to sign in.
  await sql`
    insert into magic_tokens (token_hash, email, expires_at)
    values (${hash}, ${email}, ${expires})`;
  return token;
}

export async function consumeMagicToken(token) {
  const sql = db();
  const hash = await hashToken(token);
  // Single statement so a token can't be redeemed twice by concurrent requests.
  const rows = await sql`
    update magic_tokens set used_at = now()
    where token_hash = ${hash} and used_at is null and expires_at > now()
    returning email`;
  return rows.length ? rows[0].email : null;
}

export async function sendMagicLink(email, url) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Field Budget <noreply@pacificdiscovery.org>',
      to: [email],
      subject: 'Your Field Budget sign-in link',
      text: [
        'Tap the link below to sign in to Field Budget.',
        '',
        url,
        '',
        `The link works once and expires in ${MAGIC_TTL_MIN} minutes.`,
        "If you didn't ask for it, you can ignore this email.",
      ].join('\n'),
    }),
  });
  if (!res.ok) throw new Error(`Mail send failed: ${res.status} ${await res.text()}`);
}

/* ---------- Access codes ----------
   Instructors sign in with their email and a code an admin sets. Online guessing
   is the realistic attack on a short code, so failures are counted and the
   account locks for a spell — the hash itself is only the second line of
   defence, for if the database leaks. */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function checkAccessCode(email, code) {
  const sql = db();
  const rows = await sql`
    select code_hash, failed_attempts, locked_until
      from instructor_codes where email = ${email}`;

  // No row: still do the work of a verify so an unknown address takes about as
  // long as a wrong code, and don't say which it was.
  if (!rows.length) {
    await verifyCode(code, 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return { ok: false, reason: 'bad' };
  }

  const row = rows[0];
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(row.locked_until) - Date.now()) / 60000);
    return { ok: false, reason: 'locked', minutes: mins };
  }

  if (await verifyCode(code, row.code_hash)) {
    await sql`update instructor_codes
                 set failed_attempts = 0, locked_until = null, last_login_at = now()
               where email = ${email}`;
    return { ok: true };
  }

  const attempts = (row.failed_attempts || 0) + 1;
  const lock = attempts >= MAX_ATTEMPTS;
  await sql`update instructor_codes
               set failed_attempts = ${lock ? 0 : attempts},
                   locked_until = ${lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() : null}
             where email = ${email}`;
  return lock
    ? { ok: false, reason: 'locked', minutes: LOCKOUT_MINUTES }
    : { ok: false, reason: 'bad', remaining: MAX_ATTEMPTS - attempts };
}

/* ---------- Who is allowed in at all ---------- */

// An address that is neither assigned to a budget nor an admin gets no session.
// Deciding this at sign-in rather than per-request keeps the rest of the API
// simple, and means a stale cookie stops working once someone is unassigned.
export async function emailIsKnown(email) {
  const sql = db();
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => normaliseEmail(s)).filter(Boolean);
  if (admins.includes(email)) return true;
  const rows = await sql`select 1 from assignments where email = ${email} limit 1`;
  return rows.length > 0;
}
