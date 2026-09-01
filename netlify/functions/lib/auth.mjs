// Session handling, Google sign-in, and magic links.
//
// Cloudflare Access used to do all of this. On Netlify it has to be code, so the
// design goal is: no passwords stored anywhere, and both sign-in paths converge
// on one session cookie so the rest of the API only ever sees a verified email.

import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { db } from './db.mjs';
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
