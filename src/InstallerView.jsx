// src/InstallerView.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react'
import { parseDXF } from './dxfParser.js'
import { latLngToTM35FIN } from './coords.js'
import { sb } from './supabaseClient.js'
import { KNOWN_SITES, renderPinMapThumb, CAT_EN, SEV_EN, compressImage } from './shared.js'
import { subscribeToPush, sendPushNotification } from './push.js'
import MapView from './MapView.jsx'

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
  const [confirmMsg, setConfirmMsg] = useState('')
  const [fixPhotos, setFixPhotos] = useState({}) // { [observation.id]: dataUrl } — pakollinen korjauskuva ennen "Merkitse korjatuksi"
  const [photoBusy, setPhotoBusy] = useState({}) // { [id]: true } kun kuvaa vielä pakataan
  const taskRefs = useRef({}) // { [observation.id]: HTMLElement } — yleiskartan napautus vierittää oikeaan korttiin
  const [highlightId, setHighlightId] = useState(null) // hetkellinen korostus kartalta navigoitaessa

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
      addFixPhoto: { fi: '📷 Ota korjauskuva', en: '📷 Take fix photo' },
      retakeFixPhoto: { fi: '📷 Ota uusi kuva', en: '📷 Retake photo' },
      needPhoto: { fi: 'Ota kuva korjauksesta ennen kuin voit merkitä sen korjatuksi', en: 'Take a photo of the fix before marking it done' },
      compressing: { fi: 'Käsitellään kuvaa…', en: 'Processing photo…' },
      overviewTitle: { fi: '📍 Kaikki avoimet viat kartalla', en: '📍 All open faults on map' },
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
    sb.from('installers').select('id, name, pin').eq('id', selectedId).single().then(({ data }) => {
      if (data && String(data.pin) === String(pin)) {
        const s = { id: data.id, name: data.name }
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

  // Fetch open tasks assigned to this installer
  async function loadTasks() {
    if (!session) return
    const { data } = await sb.from('observations')
      .select('*')
      .eq('assigned_installer_id', session.id)
      .eq('status', 'avoin')
      .order('created_at', { ascending: true })
    setTasks(data || [])
  }
  useEffect(() => { loadTasks() }, [session])

  // Pre-render a small STATIC map snapshot per task (once, memoized) instead
  // of mounting a full interactive <MapView> for every open task. With many
  // open tasks this used to mount that many live SVG maps with touch/mouse
  // listeners at once, which was heavy enough to crash mobile Safari
  // ("Toistuva ongelma verkkosivulla"). Only recomputes when the task list
  // or the map data actually changes.
  const thumbById = useMemo(() => {
    const map = new Map()
    if (!mapData || !tasks) return map
    tasks.forEach(o => {
      if (o.pin_x == null) return
      try { map.set(o.id, renderPinMapThumb(mapData, { x: o.pin_x, y: o.pin_y })) } catch (e) { console.error('thumb render failed:', e) }
    })
    return map
  }, [mapData, tasks])

  // Kaikkien avointen tehtävien pinnit yhtä, elävää yleiskarttaa varten
  // listan yläreunassa — kevyt lisä thumbById:n rinnalle, ei korvaa sitä.
  // MapView'lle annetaan nämä extraPins-propsina (samat oranssit pisteet
  // joita työnjohtajan pikalisäyskin käyttää), ja pin=null koska mikään
  // yksittäinen tehtävä ei ole tässä "valittuna".
  const overviewTasks = useMemo(
    () => (tasks || []).filter(o => o.pin_x != null),
    [tasks]
  )
  const overviewPins = useMemo(
    () => overviewTasks.map(o => ({ x: o.pin_x, y: o.pin_y })),
    [overviewTasks]
  )

  // Yleiskartan napautus vierittää lähimpään tehtävään sen sijaan että
  // asettaisi uuden pinnin (tässä näkymässä ei koskaan luoda uusia
  // havaintoja — MapView'n onPin-kutsu vain uudelleenkäytetään navigointiin).
  function scrollToNearestTask(coords) {
    let best = Infinity, bestId = null
    overviewTasks.forEach(o => {
      const d = Math.hypot(o.pin_x - coords.x, o.pin_y - coords.y)
      if (d < best) { best = d; bestId = o.id }
    })
    if (bestId == null) return
    taskRefs.current[bestId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(bestId)
    setTimeout(() => setHighlightId(id => (id === bestId ? null : id)), 1800)
  }

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

  async function addFixPhoto(id, file) {
    if (!file) return
    setPhotoBusy(prev => ({ ...prev, [id]: true }))
    const src = await compressImage(file)
    setPhotoBusy(prev => ({ ...prev, [id]: false }))
    if (src) setFixPhotos(prev => ({ ...prev, [id]: src }))
  }

  // Merkitsee havainnon korjatuksi HETI Supabaseen (data ei häviä vaikka
  // sovellus suljettaisiin), mutta EI lähetä ilmoitusta työnjohtajalle vielä
  // — jos asentaja korjaa esim. 40 vikaa peräkkäin, työnjohtaja ei halua 40
  // erillistä ilmoitusta. Sen sijaan korjaukset kertyvät `fixedBatch`-listaan,
  // ja asentaja lähettää yhden koontikuittauksen alapalkin napista kun on
  // valmis (ks. confirmBatch).
  //
  // Korjauskuva on pakollinen — nappi on piilotettu/pois käytöstä kunnes
  // fixPhotos[o.id] on olemassa (ks. käyttöliittymä alempana), joten tämä
  // funktio ei koskaan kutsu ilman kuvaa, mutta tarkistetaan silti
  // varmuuden vuoksi ettei vahingossa tallenneta ilman kuvaa.
  async function markFixed(o) {
    const photo = fixPhotos[o.id]
    if (!photo) return
    await sb.from('observations').update({
      status: 'korjattu', fixed_at: new Date().toISOString(), fixed_photo: photo,
    }).eq('id', o.id)
    setTasks(prev => prev.filter(x => x.id !== o.id))
    setFixedBatch(prev => [...prev, { cat: o.cat, site: o.site, reportBatch: o.report_batch }])
    setFixPhotos(prev => {
      const next = { ...prev }
      delete next[o.id]
      return next
    })
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

        {mapData && overviewPins.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6670a0', marginBottom: 6 }}>
              {t('overviewTitle')}
            </div>
            <MapView
              mapData={mapData}
              pin={null}
              onPin={scrollToNearestTask}
              gpsCoords={gpsCoords}
              extraPins={overviewPins}
              readOnly
              height={200}
            />
          </div>
        )}

        {tasks === null && <div style={{ textAlign: 'center', color: '#6670a0', padding: 40 }}>{t('loading')}</div>}
        {tasks && tasks.length === 0 && <div style={{ textAlign: 'center', color: '#6670a0', padding: 40 }}>{t('noTasks')}</div>}

        {tasks && tasks.map(o => {
          const catLabel = lang === 'en' ? (CAT_EN[o.cat] || o.cat) : o.cat
          const sevLabel = lang === 'en' ? (SEV_EN[o.sev] || o.sev) : o.sev
          return (
            <div
              key={o.id}
              ref={el => { taskRefs.current[o.id] = el }}
              style={{
                background: '#fff', borderRadius: 12, marginBottom: 12, overflow: 'hidden',
                border: highlightId === o.id ? '2px solid #1a2fcc' : '1px solid #d0d5e8',
                boxShadow: highlightId === o.id ? '0 0 0 4px rgba(26,47,204,0.15)' : 'none',
                transition: 'box-shadow 0.3s, border-color 0.3s',
              }}
            >
              <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eef0f7' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e' }}>{catLabel}</span>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{sevLabel}</span>
              </div>
              {o.note && <div style={{ padding: '8px 14px 0', fontSize: 13, color: '#333' }}>{o.note}</div>}
              {o.site && <div style={{ padding: '4px 14px 0', fontSize: 11, color: '#9aa2c0' }}>{o.site}</div>}

              {mapData && o.pin_x != null && (
                <div style={{ padding: 12 }}>
                  {thumbById.has(o.id) ? (
                    <img
                      src={thumbById.get(o.id)}
                      alt=""
                      style={{ width: '100%', display: 'block', borderRadius: 8, border: '1px solid #d0d5e8' }}
                    />
                  ) : (
                    <div style={{ height: 160, background: '#eef4ec', borderRadius: 8 }} />
                  )}
                </div>
              )}

              <div style={{ padding: 12, paddingTop: 0 }}>
                {fixPhotos[o.id] ? (
                  <div style={{ marginBottom: 8 }}>
                    <img
                      src={fixPhotos[o.id]}
                      alt=""
                      style={{ width: '100%', display: 'block', borderRadius: 8, border: '2px solid #1a8a50' }}
                    />
                    <label style={{ display: 'block', textAlign: 'center', marginTop: 6, fontSize: 12, color: '#1a2fcc', fontWeight: 600 }}>
                      {t('retakeFixPhoto')}
                      <input
                        type="file" accept="image/*" capture="environment"
                        onChange={e => addFixPhoto(o.id, e.target.files[0])}
                        style={{ display: 'none' }}
                      />
                    </label>
                  </div>
                ) : (
                  <label style={{
                    display: 'block', textAlign: 'center', padding: 12, marginBottom: 8,
                    border: '1.5px dashed #d0d5e8', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    color: photoBusy[o.id] ? '#9aa2c0' : '#1a2fcc', cursor: 'pointer',
                  }}>
                    {photoBusy[o.id] ? t('compressing') : t('addFixPhoto')}
                    <input
                      type="file" accept="image/*" capture="environment"
                      onChange={e => addFixPhoto(o.id, e.target.files[0])}
                      style={{ display: 'none' }}
                      disabled={!!photoBusy[o.id]}
                    />
                  </label>
                )}
                <button
                  onClick={() => markFixed(o)}
                  disabled={!fixPhotos[o.id]}
                  title={!fixPhotos[o.id] ? t('needPhoto') : undefined}
                  style={{
                    width: '100%', padding: 12, color: '#fff', border: 'none', borderRadius: 8,
                    fontWeight: 700, fontSize: 14,
                    background: fixPhotos[o.id] ? '#1a8a50' : '#b7c0d8',
                    cursor: fixPhotos[o.id] ? 'pointer' : 'not-allowed',
                  }}
                >
                  {t('markFixed')}
                </button>
                {!fixPhotos[o.id] && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#9aa2c0', textAlign: 'center' }}>
                    {t('needPhoto')}
                  </div>
                )}
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
    </div>
  )
}
