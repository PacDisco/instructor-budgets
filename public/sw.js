// Cache-first shell so the app opens with no signal. Bump SHELL on every deploy.
const SHELL = 'field-budget-v24';
// Fonts and logo are precached: a brand webfont that only arrives online would
// reflow the layout the moment an instructor regains signal mid-entry.
const ASSETS = [
  '/', '/index.html', '/app.css', '/app.js', '/manifest.webmanifest',
  '/logo.png', '/icon-192.png',
  '/fonts/Poppins-Regular.woff2',
  '/fonts/Poppins-Medium.woff2',
  '/fonts/Poppins-SemiBold.woff2',
  '/fonts/DMSerifDisplay-Regular.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache the API — stale balances are worse than no balances.
  if (url.pathname.startsWith('/api/')) return;
  // Leave cross-origin requests alone. The Google sign-in script must always go
  // to the network, and caching a third party's script is asking for trouble.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
