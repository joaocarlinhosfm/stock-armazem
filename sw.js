// Cache version — bump this string on every deploy to force SW update
// TIP: use a CI/CD script to auto-replace this with a build hash
const CACHE_VERSION = 'hiperfrio-v5.13';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_VERSION)
            .then(c => c.addAll(ASSETS))
            .catch(err => console.warn('[SW] install cache error:', err)) // FIX #28
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
        ).catch(err => console.warn('[SW] activate cleanup error:', err)) // FIX #28
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    // Never cache Firebase or Google Auth requests — always network
    if (e.request.url.includes('firebasedatabase.app')) return;
    if (e.request.url.includes('googleapis.com')) return;
    if (e.request.url.includes('gstatic.com')) return;
    if (e.request.url.includes('firebaseapp.com')) return;

    // Network-first for HTML to always get latest app
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Cache-first for CSS/JS/image assets
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request)
            .catch(err => console.warn('[SW] fetch failed:', e.request.url, err))
        )
    );
});

// ── Background Sync ────────────────────────────────────────────────────────
// Quando a ligação volta (mesmo com a app fechada), o SW acorda
// e envia mensagem a todos os clientes para sincronizarem a fila offline.
self.addEventListener('sync', e => {
    if (e.tag === 'hiperfrio-sync') {
        e.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
                if (clients.length > 0) {
                    clients.forEach(c => c.postMessage({ type: 'SYNC_QUEUE' }));
                }
            }).catch(err => console.warn('[SW] sync error:', err)) // FIX #28
        );
    }
});
