// src/push.js
import { sb } from './supabaseClient'

const SUPABASE_FUNCTIONS_URL = 'https://ddgsbamrafhasrtsrsyv.supabase.co/functions/v1/send-push'
// Sama julkinen anon-avain kuin supabaseClient.js:ssä — Edge Function vaatii
// tämän Authorization-otsikossa oletuksena, muuten Supabase hylkää koko
// pyynnön 401:llä ennen kuin se pääsee funktion koodiin asti.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZ3NiYW1yYWZoYXNydHNyc3l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODU2MzUsImV4cCI6MjA5Nzg2MTYzNX0.gsbIu5yAUA_iINCGF20p4bSAWJCaEN6UXi8_OlGC3Oc'

// TÄRKEÄÄ: korvaa tämä sillä VAPID_PUBLIC_KEY-arvolla jonka sait — tämä on
// julkinen avain, se on turvallista pitää selainkoodissa.
export const VAPID_PUBLIC_KEY = 'BFayLujytsUxr9kvsNwWpiFBDBUzMs80iN5TM5zKup5S6PFyXx9Q-f8sgPe6nFtFTTe7PsBkDQCUczzTpK6nxgM'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

// Pyytää ilmoitusluvan, rekisteröi Service Workerin, tilaa pushin ja
// tallentaa tilauksen Supabaseen. Palauttaa true/false onnistumisesta.
// role: 'installer' | 'supervisor'. installerId: pakollinen jos role==='installer'.
export async function subscribeToPush(role, installerId = null) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'Selain ei tue push-ilmoituksia' }
  }
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return { ok: false, reason: 'Lupa evätty' }

    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready

    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }

    await sb.from('push_subscriptions').insert([{
      role, installer_id: installerId, subscription: sub.toJSON(),
    }])

    return { ok: true }
  } catch (e) {
    console.error('subscribeToPush failed:', e)
    return { ok: false, reason: e.message }
  }
}

// Kutsuu Edge Functionia joka oikeasti lähettää ilmoitukset. Kutsutaan
// työnjohtajan sovelluksesta kun havaintoja lähetetään asentajalle, ja
// asentajan sovelluksesta kun havainto merkitään korjatuksi.
export async function sendPushNotification({ role, installerId = null, title, body = '', url = '/', tag }) {
  try {
    const res = await fetch(SUPABASE_FUNCTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ role, installer_id: installerId, title, body, url, tag }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('sendPushNotification: HTTP', res.status, text)
      return { error: `HTTP ${res.status}`, detail: text }
    }
    return await res.json()
  } catch (e) {
    console.error('sendPushNotification failed:', e)
    return { error: e.message }
  }
}
