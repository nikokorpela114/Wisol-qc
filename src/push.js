// src/push.js
import { sb } from './supabaseClient'

const SUPABASE_FUNCTIONS_URL = 'https://ddgsbamrafhasrtsrsyv.supabase.co/functions/v1/send-push'

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, installer_id: installerId, title, body, url, tag }),
    })
    return await res.json()
  } catch (e) {
    console.error('sendPushNotification failed:', e)
    return { error: e.message }
  }
}
