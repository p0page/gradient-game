import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const assets = ['index.html', ...(await readdir(resolve(dist, 'assets')))
  .sort().map((file) => `assets/${file}`)];
const hash = createHash('sha256');
for (const asset of assets) {
  hash.update(asset);
  hash.update(await readFile(resolve(dist, asset)));
}

const source = `const base = new URL(self.registration.scope);
const shell = new URL('index.html', base).href;
const assets = ${JSON.stringify(assets)}.map((asset) => new URL(asset, base).href);
const prefix = 'gradient-shell:' + base.pathname + ':';
const release = prefix + '${hash.digest('hex').slice(0, 16)}';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(release);
    await cache.addAll(assets.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== release) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== base.origin) return;

  if (request.mode === 'navigate' && (url.pathname === base.pathname || url.href === shell)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.status < 500) return response;
        return (await caches.open(release)).match(shell).then((cached) => cached ?? response);
      } catch {
        const cached = await (await caches.open(release)).match(shell);
        return cached ?? Response.error();
      }
    })());
  } else if (assets.includes(request.url)) {
    event.respondWith((async () => (await (await caches.open(release)).match(request)) ?? fetch(request))());
  }
});
`;
await writeFile(resolve(dist, 'sw.js'), source);
