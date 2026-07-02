// supabase/functions/send-push/index.ts
//
// Kutsutaan sovelluksesta kun (a) työnjohtaja luo/lähettää uuden
// havaintolistan asentajalle, tai (b) asentaja merkitsee havainnon
// korjatuksi. Hakee kohderoolin push-tilaukset ja lähettää niihin
// oikean selaimen push-ilmoituksen.
//
// Deploy: supabase functions deploy send-push
// Env-muuttujat (aseta Supabasen dashboardista tai CLI:llä, ks. ohje viestissä):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (esim. mailto:sinä@wisol.fi)
// SUPABASE_URL ja SUPABASE_SERVICE_ROLE_KEY ovat Supabasen automaattisesti
// tarjoamia, niitä ei tarvitse asettaa itse.

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:info@wisol.fi',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const { role, installer_id, title, body, url, tag } = await req.json()
    if (!role || !title) {
      return new Response(JSON.stringify({ error: 'role ja title vaaditaan' }), { status: 400 })
    }

    let query = supabase.from('push_subscriptions').select('id, subscription').eq('role', role)
    if (installer_id) query = query.eq('installer_id', installer_id)
    const { data: subs, error } = await query
    if (error) throw error

    const payload = JSON.stringify({ title, body: body || '', url: url || '/', tag })
    const results = await Promise.allSettled(
      (subs || []).map(s => webpush.sendNotification(s.subscription, payload))
    )

    // Siivoa vanhentuneet tilaukset (410 Gone / 404) pois taulusta
    const toDelete = []
    results.forEach((r, i) => {
      if (r.status === 'rejected' && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
        toDelete.push(subs[i].id)
      }
    })
    if (toDelete.length) await supabase.from('push_subscriptions').delete().in('id', toDelete)

    const sent = results.filter(r => r.status === 'fulfilled').length
    return new Response(JSON.stringify({ sent, total: results.length }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
