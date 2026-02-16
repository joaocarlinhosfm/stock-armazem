onst CACHE_NAME = 'stock-pwa-v13-codigo';

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];
const CACHE_NAME = 'stock-v12';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Cacheando nova versão (V13 - Código)...');
            return cache.addAll(ASSETS);
        })
    );
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }));
        })
    );
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.url.includes('firebaseio.com') || e.request.url.includes('firebasedatabase.app')) {
        return; 
    }
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
    if (e.request.url.includes('firebasedatabase.app')) return;
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});