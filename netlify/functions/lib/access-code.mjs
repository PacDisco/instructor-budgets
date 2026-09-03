// Access code hashing — used by the admin function to set a code and by the
// field app's API to check one.
//
// PBKDF2-SHA256 via Web Crypto: no dependency, available in both runtimes, and
// deliberately slow so a short code isn't trivially brute-forced offline if the
// database ever leaks. bcrypt or argon2 would be better still, but both mean a
// native dependency in a Lambda, and the rate limiting in front of this is what
// actually stops online guessing.

const ITERATIONS = 210_000;   // OWASP's PBKDF2-SHA256 guidance
const KEY_BITS = 256;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(code, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
}

export async function hashCode(code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(code, salt);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

// Compares in constant time. A byte-by-byte early exit leaks how much of the
// hash matched, which is enough to reconstruct it one byte at a time.
export async function verifyCode(code, stored) {
  if (!stored || !code) return false;
  const [scheme, iters, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;

  const bits = await derive(code, unb64(saltB64), Number(iters) || ITERATIONS);
  const a = new Uint8Array(bits);
  const b = unb64(hashB64);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Short enough to type on a phone with cold hands, long enough not to be
// guessable in the attempts the lockout allows.
export function codeProblem(code) {
  const c = String(code || '');
  if (c.length < 8) return 'Code must be at least 8 characters.';
  if (c.length > 128) return 'Code is too long.';
  if (/^\s|\s$/.test(c)) return "Code can't start or end with a space.";
  if (/^(\d)\1+$/.test(c)) return 'Code cannot be a single repeated digit.';
  return null;
}
