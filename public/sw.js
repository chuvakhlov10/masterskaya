// Build injects the complete, versioned application shell here.
const CACHE_NAME = 'masterskaya-shell-dev';
const BUILD_ASSETS = ['./index.html'];
const OPTIONAL_ASSETS = ['./manifest.json', './favicon.svg', './favicon-32.png',
  './icon-192.png', './icon-192-maskable.png', './icon-512.png', './icon-512-maskable.png'];
const scope = new URL('./', self.location.href);
const shellUrl = new URL('./index.html', scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A failed bundle download must leave the previous working shell active.
    await Promise.all(BUILD_ASSETS.map(async path => {
      const url = new URL(path, scope).href;
      const response = await fetch(url, {cache:'reload'});
      if (!response.ok) throw new Error('SHELL_DOWNLOAD_FAILED:'+response.status);
      if(path === './index.html') {
        const html = await response.clone().text();
        const known = new Set(BUILD_ASSETS.map(asset => new URL(asset, scope).href));
        const references = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match=>match[1]);
        for(const tag of html.match(/<link\b[^>]*>/gi) || []) {
          if(/\brel=["']stylesheet["']/i.test(tag)) {
            const href = tag.match(/\bhref=["']([^"']+)["']/i);
            if(href) references.push(href[1]);
          }
        }
        if(references.some(reference => !known.has(new URL(reference, scope).href))) throw new Error('SHELL_VERSION_MISMATCH');
      }
      await cache.put(url, response);
    }));
    await Promise.all(OPTIONAL_ASSETS.map(async path => {
      try {
        const url = new URL(path, scope).href;
        const response = await fetch(url, {cache:'reload'});
        if (response.ok) await cache.put(url, response);
      } catch {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter(key => key.startsWith('masterskaya-shell-') && key !== CACHE_NAME);
    // Keep the previous shell for open tabs, and leave other apps' caches alone.
    await Promise.all(old.slice(0, -1).map(key => caches.delete(key)));
    await self.clients.claim();
    for (const client of await self.clients.matchAll()) client.postMessage({type:'OFFLINE_SHELL_READY'});
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Never wait on the network to launch. A new worker installs matched HTML
    // and bundles atomically before taking over from this version.
    if (req.mode === 'navigate') {
      const shell = await cache.match(shellUrl);
      if (shell) return shell;
    }
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const response = await fetch(req);
      if (response.ok) {
        try { await cache.put(req, response.clone()); } catch {}
      }
      return response;
    } catch {
      return new Response('Файл пока недоступен без интернета', {status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_OFFLINE_SHELL') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const complete = (await Promise.all(BUILD_ASSETS.map(path => cache.match(new URL(path, scope).href)))).every(Boolean);
    event.source?.postMessage({type:'OFFLINE_SHELL_STATUS', ready:complete});
  })());
});
