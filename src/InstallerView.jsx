// src/InstallerView.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react'
import MapView from './MapView.jsx'
import { parseDXF } from './dxfParser.js'
import { latLngToTM35FIN } from './coords.js'
import { sb } from './supabaseClient.js'
import { KNOWN_SITES, renderGroupMapImage, CAT_EN, SEV_EN } from './shared.js'
import { subscribeToPush, sendPushNotification } from './push.js'

const SESSION_KEY = 'wisol_installer_session'
const FIXED_BATCH_KEY_PREFIX = 'wisol_installer_fixed_batch_' // + installer id
const sevBg = { Kriittinen: '#fde2e2', Huomio: '#fdf0d5', Info: '#dcefe3' }
const sevColor = { Kriittinen: '#b02828', Huomio: '#a06800', Info: '#1a7a45' }

export default function InstallerView() {
  const [lang, setLang] = useState('fi')
  const [session, setSession] = useState(null)
  const [installers, setInstallers] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [pin, setPin] = useState('')
  const [loginErr, setLoginErr] = useState('')

  const [tasks, setTasks] = useState(null) // null = ladataan
  const [siteKey, setSiteKey] = useState(null)
  const [mapData, setMapData] = useState(null)
  const [gpsCoords, setGpsCoords] = useState(null)
  const [pushMsg, setPushMsg] = useState('')
  const [fixedBatch, setFixedBatch] = useState([]) // korjatut mutta ei vielä kuitatut asentajan istunnossa
  // Vain YHDEN tehtävän kartta voi olla auki interaktiivisena kerrallaan —
  // tämä pitää muistinkäytön kurissa vaikka avoimia tehtäviä olisi
  // kymmeniä (ks. aiempi kaatumisbugi, joka johtui liian monesta yhtäaikaa
  // auki olevasta raskaasta MapView-komponentista).
  const [expandedGroupKey, setExpandedGroupKey] = useState(null)
  const [confirmMsg, setConfirmMsg] = useState('')

  const t = key => {
    const dict = {
      title: { fi: 'Omat tehtävät', en: 'My tasks' },
      login: { fi: 'Kirjaudu asentajana', en: 'Log in as installer' },
      chooseName: { fi: 'Valitse nimesi', en: 'Choose your name' },
      pin: { fi: 'PIN-koodi', en: 'PIN code' },
      loginBtn: { fi: 'Kirjaudu', en: 'Log in' },
      wrongPin: { fi: 'Väärä PIN', en: 'Wrong PIN' },
      logout: { fi: 'Vaihda käyttäjä', en: 'Switch user' },
      noTasks: { fi: 'Ei avoimia tehtäviä 🎉', en: 'No open tasks 🎉' },
      markFixed: { fi: '✓ Merkitse korjatuksi', en: '✓ Mark as fixed' },
      loading: { fi: 'Ladataan…', en: 'Loading…' },
      notifOn: { fi: '🔔 Salli ilmoitukset', en: '🔔 Enable notifications' },
      notifOnDone: { fi: '🔔 Ilmoitukset päällä', en: '🔔 Notifications on' },
      row: { fi: 'rivi', en: 'row' },
      confirmBatch: { fi: 'Kuittaa työnjohtajalle', en: 'Confirm to supervisor' },
      fixedCount: { fi: 'korjattu, ei vielä lähetetty', en: 'fixed, not sent yet' },
    }
    return dict[key]?.[lang] ?? key
  }

  // Restore session
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (raw) setSession(JSON.parse(raw))
    } catch {}
  }, [])

  // Palauta kesken jäänyt "korjattu mutta ei vielä kuitattu" -lista, jos
  // sovellus suljettiin (esim. puhelin lukittui taskussa) ennen kuin
  // asentaja ehti painaa koontikuittausta. Ilman tätä lista nollaantuisi
  // hiljaa ja työnjohtaja jäisi kokonaan ilman ilmoitusta niistä korjauksista
  // — itse korjausmerkinnät ovat toki jo tallessa Supabasessa, mutta
  // ilmoitus jäisi silti lähettämättä.
  useEffect(() => {
    if (!session) return
    try {
      const raw = localStorage.getItem(FIXED_BATCH_KEY_PREFIX + session.id)
      if (raw) setFixedBatch(JSON.parse(raw))
    } catch {}
  }, [session])

  // Tallenna lista joka kerta kun se muuttuu, jotta sovelluksen sulkeminen
  // (vahingossa tai tarkoituksella) ei koskaan hukkaa kertyneitä korjauksia.
  useEffect(() => {
    if (!session) return
    try {
      if (fixedBatch.length > 0) localStorage.setItem(FIXED_BATCH_KEY_PREFIX + session.id, JSON.stringify(fixedBatch))
      else localStorage.removeItem(FIXED_BATCH_KEY_PREFIX + session.id)
    } catch {}
  }, [fixedBatch, session])

  // Load installer list for the login picker
  useEffect(() => {
    if (session) return
    sb.from('installers').select('id, name').order('name').then(({ data }) => {
      if (data) setInstallers(data)
    })
  }, [session])

  function login() {
    setLoginErr('')
    const inst = installers.find(i => i.id === selectedId)
    if (!inst) return
    sb.from('installers').select('id, name, pin, team_id').eq('id', selectedId).single().then(({ data }) => {
      if (data && String(data.pin) === String(pin)) {
        const s = { id: data.id, name: data.name, teamId: data.team_id || null }
        localStorage.setItem(SESSION_KEY, JSON.stringify(s))
        setSession(s)
      } else {
        setLoginErr(t('wrongPin'))
      }
    })
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    setTasks(null)
  }

  // Fetch open tasks assigned to this installer directly, OR to their team
  // (if they belong to one) — a task sent to a whole team should show up
  // for every member of it, not just whoever it happened to be attached to.
  async function loadTasks() {
    if (!session) return
    let query = sb.from('observations').select('*').eq('status', 'avoin')
    query = session.teamId
      ? query.or(`assigned_installer_id.eq.${session.id},assigned_team_id.eq.${session.teamId}`)
      : query.eq('assigned_installer_id', session.id)
    const { data, error } = await query.order('created_at', { ascending: true })
    if (error) console.error('loadTasks failed:', error)
    setTasks(data || [])
  }
  useEffect(() => { loadTasks() }, [session])

  // Ryhmitellään avoimet tehtävät vikatyypin (ja työmaan) mukaan, ja
  // piirretään JOKAISELLE RYHMÄLLE yksi yhteinen karttakuva jossa kaikki
  // saman vian pinnit näkyvät numeroituina — sama periaate kuin PDF:n
  // "Yhdistä samat vikatyypit samaan karttakuvaan". Ilman tätä jokainen
  // tehtävä sai oman erillisen kartan, mikä oli sekä hidasta (raskas
  // piirto per tehtävä) että hankalaa käyttää kun samaa vikaa oli merkitty
  // kymmeniä kertoja peräkkäin samalle riville.
  const taskGroups = useMemo(() => {
    if (!mapData || !tasks) return []
    const groups = new Map()
    tasks.forEach(o => {
      const key = `${o.cat}__${o.site || ''}`
      if (!groups.has(key)) groups.set(key, { cat: o.cat, site: o.site, items: [] })
      groups.get(key).items.push(o)
    })
    return [...groups.values()].map(g => {
      const withPin = g.items.filter(o => o.pin_x != null)
      let mapImg = null
      if (withPin.length > 0) {
        try {
          mapImg = renderGroupMapImage(mapData, withPin.map(o => ({ ...o, pin: { x: o.pin_x, y: o.pin_y } })))
        } catch (e) { console.error('group map render failed:', e) }
      }
      return { ...g, withPin, mapImg }
    })
  }, [mapData, tasks])

  // Figure out which site's map to show — first distinct site among open tasks
  useEffect(() => {
    if (!tasks || tasks.length === 0) return
    const firstSite = tasks[0].site
    const known = KNOWN_SITES.find(s => s.label === firstSite)
    if (known) setSiteKey(known.key)
  }, [tasks])

  useEffect(() => {
    if (!siteKey) return
    setMapData(null)
    sb.storage.from('maps').download(`${siteKey}.dxf`).then(({ data, error }) => {
      if (error || !data) return
      data.text().then(text => {
        const parsed = parseDXF(text)
        if (parsed) setMapData(parsed)
      })
    })
  }, [siteKey])

  useEffect(() => {
    if (!navigator.geolocation || !mapData) return
    const watcher = navigator.geolocation.watchPosition(pos => {
      const { x, y } = latLngToTM35FIN(pos.coords.latitude, pos.coords.longitude)
      const mapX = (x - mapData.minX) / (mapData.maxX - mapData.minX)
      const mapY = 1 - (y - mapData.minY) / (mapData.maxY - mapData.minY)
      setGpsCoords({ x: Math.max(-0.2, Math.min(1.2, mapX)), y: Math.max(-0.2, Math.min(1.2, mapY)) })
    }, null, { enableHighAccuracy: true, maximumAge: 5000 })
    return () => navigator.geolocation.clearWatch(watcher)
  }, [mapData])

  async function enableNotifications() {
    const res = await subscribeToPush('installer', session.id)
    setPushMsg(res.ok ? t('notifOnDone') : (res.reason || 'Ei onnistunut'))
  }

  // Merkitsee havainnon korjatuksi HETI Supabaseen (data ei häviä vaikka
  // sovellus suljettaisiin), mutta EI lähetä ilmoitusta työnjohtajalle vielä
  // — jos asentaja korjaa esim. 40 vikaa peräkkäin, työnjohtaja ei halua 40
  // erillistä ilmoitusta. Sen sijaan korjaukset kertyvät `fixedBatch`-listaan,
  // ja asentaja lähettää yhden koontikuittauksen alapalkin napista kun on
  // valmis (ks. confirmBatch).
  async function markFixed(o) {
    await sb.from('observations').update({ status: 'korjattu', fixed_at: new Date().toISOString() }).eq('id', o.id)
    setTasks(prev => prev.filter(x => x.id !== o.id))
    setFixedBatch(prev => [...prev, { cat: o.cat, site: o.site, reportBatch: o.report_batch }])
  }

  async function confirmBatch() {
    if (fixedBatch.length === 0) return
    const n = fixedBatch.length
    const cats = [...new Set(fixedBatch.map(f => f.cat))]
    const catSummary = cats.length <= 2 ? cats.join(', ') : `${cats.length} eri vikatyyppiä`
    const site = fixedBatch[0]?.site || ''
    setConfirmMsg(lang === 'en' ? 'Sending…' : 'Lähetetään…')
    const res = await sendPushNotification({
      role: 'supervisor',
      title: lang === 'en'
        ? `${session.name} fixed ${n} item${n === 1 ? '' : 's'}`
        : `${session.name} korjasi ${n} havainto${n === 1 ? 'n' : 'a'}`,
      body: `${catSummary} — ${site}`,
      tag: fixedBatch[0]?.reportBatch || undefined,
    })
    setFixedBatch([])
    setConfirmMsg(res?.sent > 0 ? '✓ ' + (lang === 'en' ? 'Sent' : 'Lähetetty') : '✓ ' + (lang === 'en' ? 'Saved' : 'Tallennettu'))
    setTimeout(() => setConfirmMsg(''), 4000)
  }

  // --- Login screen ---
  if (!session) {
    return (
      <div style={{ maxWidth: 420, margin: '0 auto', minHeight: '100vh', background: '#f4f6fb', padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16 }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#1a2fcc' }}>WISOL</div>
          <div style={{ fontSize: 13, color: '#6670a0' }}>{t('login')}</div>
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#6670a0', fontWeight: 600 }}>{t('chooseName')}</label>
          <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
            style={{ width: '100%', padding: 12, marginTop: 4, borderRadius: 8, border: '1px solid #d0d5e8', fontSize: 15 }}>
            <option value="">—</option>
            {installers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#6670a0', fontWeight: 600 }}>{t('pin')}</label>
          <input type="tel" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value)}
            style={{ width: '100%', padding: 12, marginTop: 4, borderRadius: 8, border: '1px solid #d0d5e8', fontSize: 20, letterSpacing: 4, textAlign: 'center' }} />
        </div>
        {loginErr && <div style={{ color: '#d63030', fontSize: 13, textAlign: 'center' }}>{loginErr}</div>}
        <button onClick={login} disabled={!selectedId || !pin} style={{ padding: 14, background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15 }}>
          {t('loginBtn')}
        </button>
      </div>
    )
  }

  // --- Task list ---
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', background: '#f4f6fb' }}>
      <div style={{ background: '#1a2fcc', padding: '16px 16px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 17 }}>{session.name}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{t('title')}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setLang(lang === 'fi' ? 'en' : 'fi')} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 6, padding: '5px 9px', fontSize: 12, fontWeight: 700 }}>
            {lang === 'fi' ? 'EN' : 'FI'}
          </button>
          <button onClick={logout} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 6, padding: '5px 9px', fontSize: 12 }}>
            {t('logout')}
          </button>
        </div>
      </div>

      <div style={{ padding: 12 }}>
        <button onClick={enableNotifications} style={{ width: '100%', padding: 10, background: '#fff', border: '1px solid #d0d5e8', borderRadius: 8, fontSize: 13, color: '#1a2fcc', fontWeight: 600, marginBottom: 12 }}>
          {pushMsg || t('notifOn')}
        </button>

        {tasks === null && <div style={{ textAlign: 'center', color: '#6670a0', padding: 40 }}>{t('loading')}</div>}
        {tasks && tasks.length === 0 && <div style={{ textAlign: 'center', color: '#6670a0', padding: 40 }}>{t('noTasks')}</div>}

        {tasks && taskGroups.map(g => {
          const catLabel = lang === 'en' ? (CAT_EN[g.cat] || g.cat) : g.cat
          const groupKey = g.cat + '__' + (g.site || '')
          return (
            <div key={groupKey} style={{ background: '#fff', borderRadius: 12, border: '1px solid #d0d5e8', marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eef0f7' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e' }}>{catLabel}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6670a0' }}>{g.items.length} {lang === 'en' ? 'items' : 'kpl'}</span>
              </div>
              {g.site && <div style={{ padding: '6px 14px 0', fontSize: 11, color: '#9aa2c0' }}>{g.site}</div>}

              {g.mapImg && (
                <div style={{ padding: 12 }}>
                  <div style={{ position: 'relative' }} onClick={() => setExpandedGroupKey(groupKey)}>
                    <img
                      src={g.mapImg.dataUrl}
                      alt=""
                      style={{ width: '100%', display: 'block', borderRadius: 8, border: '1px solid #d0d5e8', cursor: 'pointer' }}
                    />
                    <div style={{ position: 'absolute', bottom: 6, right: 6, background: 'rgba(13,26,110,0.75)', color: '#fff', fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 20 }}>
                      🔍 {lang === 'en' ? 'Tap to zoom' : 'Zoomaa napauttamalla'}
                    </div>
                  </div>
                </div>
              )}

              <div>
                {g.items.map(o => {
                  const sevLabel = lang === 'en' ? (SEV_EN[o.sev] || o.sev) : o.sev
                  const pinIdx = g.withPin.indexOf(o)
                  const rowLabel = pinIdx >= 0 && g.mapImg ? g.mapImg.rowLabels[pinIdx] : null
                  return (
                    <div key={o.id} style={{ padding: '10px 14px', borderTop: '1px solid #f0f1f7', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          {pinIdx >= 0 && (
                            <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#d63030', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {pinIdx + 1}
                            </span>
                          )}
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev], flexShrink: 0 }}>{sevLabel}</span>
                          {rowLabel && <span style={{ fontSize: 12, color: '#1a8a50', fontWeight: 700, whiteSpace: 'nowrap' }}>{t('row')} {rowLabel}</span>}
                        </div>
                        <button onClick={() => markFixed(o)} style={{ padding: '7px 14px', background: '#1a8a50', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12.5, flexShrink: 0 }}>
                          {t('markFixed')}
                        </button>
                      </div>
                      {o.note && <div style={{ fontSize: 12.5, color: '#333' }}>{o.note}</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Koontipalkki: korjaukset kertyvät tähän ilman että jokaisesta lähtee
          oma ilmoitus — asentaja kuittaa kaikki kerralla yhdellä napilla, ja
          työnjohtaja saa yhden koonti-ilmoituksen monen sijaan. */}
      {fixedBatch.length > 0 && (
        <div style={{ position: 'sticky', bottom: 0, left: 0, right: 0, padding: '10px 12px calc(10px + env(safe-area-inset-bottom, 0px))', background: 'rgba(244,246,251,0.97)', borderTop: '1px solid #d0d5e8', backdropFilter: 'blur(4px)' }}>
          <button onClick={confirmBatch} style={{ width: '100%', padding: 13, background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            📬 {fixedBatch.length} {t('fixedCount')} — {t('confirmBatch')}
          </button>
          {confirmMsg && <div style={{ textAlign: 'center', fontSize: 12, color: '#1a8a50', fontWeight: 600, marginTop: 6 }}>{confirmMsg}</div>}
        </div>
      )}
      {/* Täysikokoinen interaktiivinen kartta — vain YKSI ryhmä kerrallaan
          koko näkymässä riippumatta siitä montako tehtävää listassa on,
          jotta muistinkäyttö ei koskaan karkaa käsistä (ks. kaatumisbugin
          korjaus). Näyttää koko ryhmän kaikki pinnit yhtä aikaa. */}
      {expandedGroupKey && mapData && (() => {
        const group = taskGroups.find(g => (g.cat + '__' + (g.site || '')) === expandedGroupKey)
        if (!group || group.withPin.length === 0) return null
        const [first, ...rest] = group.withPin
        return (
          <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 14px', background: '#1a2fcc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
                {lang === 'en' ? (CAT_EN[group.cat] || group.cat) : group.cat} ({group.withPin.length})
              </span>
              <button onClick={() => setExpandedGroupKey(null)} style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700 }}>
                ✕ {lang === 'en' ? 'Close' : 'Sulje'}
              </button>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <MapView
                mapData={mapData}
                pin={{ x: first.pin_x, y: first.pin_y }}
                extraPins={rest.map(o => ({ x: o.pin_x, y: o.pin_y }))}
                onPin={() => {}}
                gpsCoords={gpsCoords}
                height="100%"
                readOnly
              />
            </div>
          </div>
        )
      })()}
    </div>
  )
}
