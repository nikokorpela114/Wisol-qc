// public/sw.js — hoitaa kaksi asiaa:
// 1) Push-ilmoitusten vastaanotto ja näyttö (myös kun sovellus ei ole auki)
// 2) Offline-tuki: automaattinen välimuistitus käytön yhteydessä, jotta
//    sovellus (ja PDF/Excel-vientikirjastot) toimivat huonolla/olemattomalla
//    kuuluvuudella työmaalla, kunhan sivu on ladattu kertaalleen netissä.

const CACHE_VERSION = 'v2'
const CACHE_NAME = `wisol-qc-${CACHE_VERSION}`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

async function cacheFirst(req) {
  // Käytetään omalta origin-osoitteelta tuleville tiedostoille (JS/CSS/
  // kuvat/fontit). Vite-buildissa nämä ovat sisältöhajautettuja nimiä
  // (esim. assets/index-abc123.js) — sama nimi = sama sisältö aina, joten
  // suora välimuistiluku on turvallista eikä koskaan tarjoile vanhentunutta
  // versiota väärällä nimellä.
  const cached = await caches.match(req)
  if (cached) return cached
  try {
    const res = await fetch(req)
    if (res.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()) }
    return res
  } catch (e) {
    return cached || Response.error()
  }
}

async function networkFirst(req) {
  // Käytetään HTML-sivulatauksille (jotta uusin deploy löytyy heti kun
  // netti toimii) ja Supabase-datalle (jotta tuorein tieto on aina
  // ensisijainen, mutta viimeksi ladattu versio toimii varalla offline).
  try {
    const res = await fetch(req)
    if (res.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()) }
    return res
  } catch (e) {
    const cached = await caches.match(req)
    if (cached) return cached
    throw e
  }
}

self.addEventListener('fetch', event => {
  const req = event.request
  // Ei välimuistiteta kirjoituksia (POST/PATCH/DELETE) — vain GET-luvut.
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
    return
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req))
    return
  }
  if (url.hostname.endsWith('.supabase.co')) {
    event.respondWith(networkFirst(req))
    return
  }
})

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'Wisol QC', body: event.data ? event.data.text() : '' } }

  const title = data.title || 'Wisol QC'
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
    renotify: !!data.tag,
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
