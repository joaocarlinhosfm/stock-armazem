// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER — Hiperfrio v6.56
// Estratégia: network-first para app assets, cache-first para libs imutáveis.
// Pré-cache de app shell garante que a PWA arranca offline no primeiro uso
// após instalação (antes disto, abrir offline no primeiro boot deixava ecrã branco).
// ─────────────────────────────────────────────────────────────────────────────
const SW_VERSION = 'hiperfrio-v6.60';

// Ficheiro partilhado pendente (Web Share Target). Em memória do SW, expira em 60s
// para evitar servir um ficheiro stale de uma partilha antiga.
// ── Web Share Target — armazenamento persistente de PDF partilhado ──────────
// Guardamos o Response em Cache API (não em variável de memória) porque o SW
// pode ser terminado entre o POST de partilha e o GET do client. Cache persiste.
const SHARE_CACHE_NAME = 'hiperfrio-share-pending';
const SHARE_CACHE_KEY  = '/__shared_pdf__';       // chave interna (não precisa de existir)
const SHARE_CACHE_META_KEY = '/__shared_pdf_meta__';
const SHARED_FILE_TTL_MS = 60_000;

// Libs externas imutáveis — cache-first eterno (hash na URL)
const IMMUTABLE_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// App shell — tentado cachear no install. Falhas não bloqueiam a instalação.
// A versão em query string deve corresponder à usada no index.html.
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './style.css?v=1776419000',
    './utils.js?v=6.56',
    './auth.js?v=6.56',
    './reports.js?v=6.56',
    './stock.js?v=6.56',
    './tools.js?v=6.56',
    './pats.js?v=6.56',
    './guias.js?v=6.56',
    './app.js?v=6.56',
    './icon-192.png',
    './icon-512.png',
];

// Install: pré-cacheia shell + libs imutáveis. Falhas individuais não abortam.
self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(SW_VERSION).then(c =>
            Promise.allSettled([
                ...IMMUTABLE_ASSETS.map(url => c.add(url).catch(err => {
                    console.warn('[SW install] falha imutável:', url, err?.message);
                })),
                ...APP_SHELL.map(url => c.add(url).catch(err => {
                    console.warn('[SW install] falha shell:', url, err?.message);
                })),
            ])
        )
    );
});

// Activate: apaga caches antigas, toma controlo imediato, e força reload
// de clientes existentes para garantir que carregam a versão nova do CSS/JS.
// Sem isto, clientes abertos durante o upgrade ficam com CSS velho em cache de memória.
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                // Preservar SW_VERSION e SHARE_CACHE_NAME — tudo o resto pode ser purgado
                keys.filter(k => k !== SW_VERSION && k !== SHARE_CACHE_NAME)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
            .then(() => self.clients.matchAll({ type: 'window' }))
            .then(clients => {
                // Notifica clientes existentes — eles decidem se recarregam
                clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
            })
    );
});

// Fetch: filtra sempre pedidos não-GET antes de qualquer lógica de cache
self.addEventListener('fetch', e => {
    // ── Web Share Target — intercepta POST de partilha de PDF ─────────────
    // Android/Chrome envia POST multipart para ./index.html?share=pending quando
    // o utilizador partilha um ficheiro. Guardamos o ficheiro na Cache API
    // (persiste entre reinícios do SW) e redirigimos para URL GET que a app carrega.
    if (e.request.method === 'POST' &&
        new URL(e.request.url).searchParams.get('share') === 'pending') {
        e.respondWith((async () => {
            try {
                const form = await e.request.formData();
                const file = form.get('file');
                if (file && file.size > 0) {
                    const cache = await caches.open(SHARE_CACHE_NAME);
                    // Guarda o blob do ficheiro
                    await cache.put(SHARE_CACHE_KEY, new Response(file, {
                        headers: { 'Content-Type': file.type || 'application/pdf' }
                    }));
                    // Guarda metadata (nome, tipo, timestamp) separadamente
                    await cache.put(SHARE_CACHE_META_KEY, new Response(JSON.stringify({
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        ts: Date.now(),
                    }), { headers: { 'Content-Type': 'application/json' } }));
                }
            } catch(err) {
                console.warn('[SW share] falha a ler formData:', err?.message);
            }
            // Redirige para URL GET que a app reconhece e pede o ficheiro ao SW
            return Response.redirect('./index.html?share=ready', 303);
        })());
        return;
    }

    // CRÍTICO: Cache API só suporta GET. POST/PUT/PATCH/DELETE nunca podem ir
    // para cache. Antes não filtrávamos — deixa o browser lidar com eles.
    if (e.request.method !== 'GET') return;

    const url = e.request.url;

    // Nunca interceptar Firebase, Google, APIs externas — deixar o browser passar
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
                    // Só cacheia respostas OK e não-opacas — evita envenenar cache
                    // com respostas de CORS falhadas (status 0).
                    if (res.ok && res.type !== 'opaque') {
                        const clone = res.clone();
                        caches.open(SW_VERSION).then(c => c.put(e.request, clone));
                    }
                    return res;
                });
            })
        );
        return;
    }

    // Assets do app — network-first com fallback à cache
    // Só cacheia same-origin + status 200 OK. Evita cachear redirects,
    // respostas parciais e respostas opacas.
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok && res.status === 200 && url.startsWith(self.location.origin)) {
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
    // App pede o ficheiro partilhado — lê da cache e envia via MessageChannel
    if (e.data && e.data.type === 'GET_SHARED_FILE') {
        e.waitUntil((async () => {
            try {
                const cache = await caches.open(SHARE_CACHE_NAME);
                const metaRes = await cache.match(SHARE_CACHE_META_KEY);
                const fileRes = await cache.match(SHARE_CACHE_KEY);
                if (!metaRes || !fileRes) {
                    e.ports[0].postMessage({ file: null });
                    return;
                }
                const meta = await metaRes.json();
                const fresh = (Date.now() - (meta.ts || 0)) < SHARED_FILE_TTL_MS;
                if (!fresh) {
                    // Expirou — limpa cache
                    await cache.delete(SHARE_CACHE_KEY);
                    await cache.delete(SHARE_CACHE_META_KEY);
                    e.ports[0].postMessage({ file: null });
                    return;
                }
                const blob = await fileRes.blob();
                // Reconstruir File a partir do Blob (preserva nome)
                const file = new File([blob], meta.name || 'shared.pdf', {
                    type: meta.type || 'application/pdf',
                });
                e.ports[0].postMessage({ file });
                // Consome — apaga cache para não reutilizar
                await cache.delete(SHARE_CACHE_KEY);
                await cache.delete(SHARE_CACHE_META_KEY);
            } catch(err) {
                console.warn('[SW share] falha GET_SHARED_FILE:', err?.message);
                e.ports[0].postMessage({ file: null });
            }
        })());
    }
});

// Background Sync — notifica o cliente que disparou o sync para drenar a fila.
// Antes fazia broadcast a todas as abas; com várias abas abertas, cada uma
// corria syncQueue() em paralelo (isSyncing protege mas desperdiça ciclos).
self.addEventListener('sync', e => {
    if (e.tag === 'hiperfrio-sync') {
        e.waitUntil(
            self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
                .then(clients => {
                    // Preferir a aba visível; caso nenhuma esteja, notificar a primeira
                    const target = clients.find(c => c.visibilityState === 'visible') || clients[0];
                    if (target) target.postMessage({ type: 'SYNC_QUEUE' });
                })
        );
    }
});
