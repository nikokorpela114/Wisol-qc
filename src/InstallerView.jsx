// src/InstallerView.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react'
import { parseDXF } from './dxfParser.js'
import { latLngToTM35FIN } from './coords.js'
import { sb } from './supabaseClient.js'
import { KNOWN_SITES, findPinRow, renderPinMapThumb, CAT_EN, SEV_EN } from './shared.js'
import { subscribeToPush, sendPushNotification } from './push.js'

const SESSION_KEY = 'wisol_installer_session'
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

  async function markFixed(o) {
    await sb.from('observations').update({ status: 'korjattu', fixed_at: new Date().toISOString() }).eq('id', o.id)
    setTasks(prev => prev.filter(x => x.id !== o.id))
    sendPushNotification({
      role: 'supervisor',
      title: `${session.name} korjasi havainnon`,
      body: `${o.cat} — ${o.site}`,
      tag: o.report_batch || undefined,
    })
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

        {tasks && tasks.map(o => {
          const catLabel = lang === 'en' ? (CAT_EN[o.cat] || o.cat) : o.cat
          const sevLabel = lang === 'en' ? (SEV_EN[o.sev] || o.sev) : o.sev
          const rowInfo = mapData && o.pin_x != null ? findPinRow(mapData, { x: o.pin_x, y: o.pin_y }) : null
          return (
            <div key={o.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #d0d5e8', marginBottom: 12, overflow: 'hidden' }}>
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
                  {rowInfo && (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#1a8a50', fontWeight: 700 }}>
                      📍 {t('row')}: {rowInfo.label}
                    </div>
                  )}
                </div>
              )}

              <div style={{ padding: 12, paddingTop: 0 }}>
                <button onClick={() => markFixed(o)} style={{ width: '100%', padding: 12, background: '#1a8a50', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14 }}>
                  {t('markFixed')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
