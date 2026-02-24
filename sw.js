// Cache version — bump this string on every deploy to force SW update
const CACHE_VERSION = 'hiperfrio-v4.8';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
        )
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

    // Cache-first for CSS/JS assets
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
