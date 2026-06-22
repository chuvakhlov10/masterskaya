// Service Worker — кеширует статику для офлайн-работы
// Стратегия: cache-first для статики, network-first для данных (через fetch в самом приложении)

const CACHE_NAME = 'masterskaya-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
];

// При установке — кешируем основные файлы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(err => {
      console.warn('[SW] precache error:', err);
    }))
  );
  self.skipWaiting();
});

// При активации — удаляем старый кеш
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Стратегия fetch:
// - Для навигационных запросов (HTML) — network-first с fallback на cache
// - Для статики (JS/CSS/иконки) — cache-first с обновлением из сети (stale-while-revalidate)
// - Для API (api.github.com) — всегда network, не кешируем
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Никогда не кешируем GitHub API и Ably
  if (url.hostname === 'api.github.com' || url.hostname.includes('ably')) {
    return;
  }

  // Навигационные запросы — network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // GET-запросы на тот же origin — stale-while-revalidate
  if (req.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || networkPromise;
      })
    );
    return;
  }
});
