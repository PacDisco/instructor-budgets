// Response helpers, CORS, and cookies.
// The admin page lives on the dashboard site, so the API is called from two
// origins. Both must be subdomains of the same registrable domain or the
// browser treats the session cookie as third-party and drops it.

const allowed = () =>
  (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

export function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (origin && allowed().includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-allow-methods'] = 'GET,POST,PUT,OPTIONS';
  }
  return h;
}

export function json(data, status = 200, request = null, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(request ? corsHeaders(request) : {}),
      ...extra,
    },
  });
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(value, maxAgeSeconds) {
  const domain = process.env.COOKIE_DOMAIN;
  const bits = [
    `fb_session=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',           // Lax is enough: both origins are same-site subdomains
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (domain) bits.push(`Domain=${domain}`);
  return bits.join('; ');
}

// Gmail-style +tags and case differences are the classic silent-empty-state bug:
// an admin types Katie.Smith@ and the Google account is katie.smith@.
export function normaliseEmail(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return null;
  const local = trimmed.slice(0, at).split('+')[0];
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}
