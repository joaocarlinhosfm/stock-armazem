// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER — Hiperfrio v5.28
// Estratégia: network-first para tudo, sem pré-cache de app assets
// Isto garante que os deploys chegam sempre sem ciclos de cache bloqueados
// ─────────────────────────────────────────────────────────────────────────────
const SW_VERSION = 'hiperfrio-v6.30';

// Apenas bibliotecas externas imutáveis ficam em cache
const IMMUTABLE_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// Install: sem waitUntil pesado — activa imediatamente
self.addEventListener('install', e => {
    self.skipWaiting();
    // Pré-cache só das libs externas imutáveis (não os assets do app)
    e.waitUntil(
        caches.open(SW_VERSION).then(c => {
            return Promise.allSettled(
                IMMUTABLE_ASSETS.map(url => c.add(url).catch(() => {}))
            );
        })
    );
});

// Activate: apaga caches antigas e toma controlo imediato
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== SW_VERSION).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: estratégia diferente por tipo de recurso
self.addEventListener('fetch', e => {
    const url = e.request.url;

    // Nunca interceptar Firebase, Google, APIs externas
    if (url.includes('firebasedatabase.app')) return;
    if (url.includes('googleapis.com')) return;
    if (url.includes('unpkg.com')) return;
    if (url.includes('tessdata.projectnaptha.com')) return;
    if (url.includes('gstatic.com')) return;
    if (url.includes('firebaseapp.com')) return;

    // Libs externas imutáveis — cache-first (nunca mudam, hash na URL)
    if (url.includes('cdnjs.cloudflare.com')) {
        e.respondWith(
            caches.match(e.request).then(cached => {
                if (cached) return cached;
                return fetch(e.request).then(res => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(SW_VERSION).then(c => c.put(e.request, clone));
                    }
                    return res;
                });
            })
        );
        return;
    }

    // Assets do app (HTML, CSS, JS, imagens) — SEMPRE network-first
    // Cache só como fallback offline — garante que deploys chegam sempre
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok && url.includes(self.location.origin)) {
                    const clone = res.clone();
                    caches.open(SW_VERSION).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request)
                .then(cached => cached || new Response('Offline — abre a app quando tiveres ligação', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain' }
                }))
            )
    );
});

// Responde a pedidos de versão do app.js para detecção de SW desactualizado
self.addEventListener('message', e => {
    if (e.data && e.data.type === 'GET_VERSION') {
        e.ports[0].postMessage({ version: SW_VERSION });
    }
});

// Background Sync — notifica clientes para sincronizar fila offline
self.addEventListener('sync', e => {
    if (e.tag === 'hiperfrio-sync') {
        e.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
                .then(clients => clients.forEach(c => c.postMessage({ type: 'SYNC_QUEUE' })))
        );
    }
});
