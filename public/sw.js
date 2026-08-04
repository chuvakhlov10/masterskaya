// Service Worker — кеширует статику для офлайн-работы
// Стратегия: cache-first для статики, network-first для данных (через fetch в самом приложении)

const CACHE_NAME = 'masterskaya-v5';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './favicon-32.png',
  './icon-192.png',
  './icon-192-maskable.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

// При установке — кешируем основные файлы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Отсутствующая иконка не должна отменять кеширование всего приложения.
      await Promise.all(PRECACHE_URLS.map(async (url) => {
        try { await cache.add(url); }
        catch (err) { console.warn('[SW] precache skipped:', url, err); }
      }));
    })
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

  // GET-запросы на тот же origin — network-first (не отдаём устаревший кеш)
  // ВАЖНО: cache-first вызывал показ старых JS-бандлов после деплоя
  if (req.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const networkRes = await fetch(req);
          if (networkRes && networkRes.ok) cache.put(req, networkRes.clone());
          return networkRes;
        } catch {
          // Оффлайн — отдаём кеш
          return await cache.match(req);
        }
      })
    );
    return;
  }
});
