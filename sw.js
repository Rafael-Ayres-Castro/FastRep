/* Service worker básico: guarda o app no aparelho para abrir offline.
   Ao alterar qualquer arquivo do app, aumente a VERSAO para forçar atualização. */
const VERSAO = 'fastrep-v13';

const ARQUIVOS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './vendor/supabase.min.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './fonts/space-grotesk-latin-400-normal.woff2',
  './fonts/space-grotesk-latin-500-normal.woff2',
  './fonts/space-grotesk-latin-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSAO).then((cache) => cache.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // O GitHub Pages permite cache HTTP de 10 min; no-cache sempre confere se há versão nova.
  // Só cuida de GETs do próprio app. Chamadas ao Supabase (outro domínio) passam direto.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Abrir o app: tenta a rede (para pegar atualizações) e cai no cache se estiver offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .then((res) => {
          // Uma resposta de erro nunca pode substituir o app guardado para uso offline.
          if (res.ok) {
            const copia = res.clone();
            caches.open(VERSAO).then((c) => c.put('./index.html', copia));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Demais arquivos: rede primeiro (pega código novo), cache se estiver offline.
  event.respondWith(
    fetch(req.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
