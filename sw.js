const CACHE_NAME = 'stock-pwa-v10-final';

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    // Força o SW a ativar-se sem esperar
    self.skipWaiting();
});

// Ao ativar, limpa caches velhos (essencial para atualizações fluídas)
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // IMPORTANTE: NÃO FAZER CACHE DO FIREBASE
    if (e.request.url.includes('firebaseio.com') || e.request.url.includes('firebasedatabase.app')) {
        return; // Deixa ir à internet sempre
    }
    
    // Para ficheiros visuais (HTML/CSS), usa o cache ou vai à rede
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});
