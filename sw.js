// Cache version — bump this string on every deploy to force SW update
// TIP: use a CI/CD script to auto-replace this with a build hash
const CACHE_VERSION = 'hiperfrio-v5.25';
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
    // Nunca interceptar Firebase, Google Auth ou Gemini
    if (e.request.url.includes('firebasedatabase.app')) return;
    if (e.request.url.includes('googleapis.com')) return;
    if (e.request.url.includes('gstatic.com')) return;
    if (e.request.url.includes('firebaseapp.com')) return;

    // Network-first para todos os assets do app (HTML, CSS, JS, imagens)
    // Cache apenas como fallback offline — garante que o deploy chega sempre
    e.respondWith(
        fetch(e.request)
            .then(res => {
                // Só guarda em cache respostas válidas do nosso próprio domínio
                if (res.ok && (
                    e.request.url.includes(self.location.origin) ||
                    e.request.url.includes('cdnjs.cloudflare.com')
                )) {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => {
                // Offline: serve da cache se disponível
                return caches.match(e.request)
                    .then(cached => cached || new Response('Offline', { status: 503 }));
            })
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
