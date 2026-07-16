import React, { useState, useEffect, useRef, useCallback } from 'react'
import MapView from './MapView.jsx'
import { parseDXF } from './dxfParser.js'
import { latLngToTM35FIN } from './coords.js'
import { sb } from './supabaseClient.js'
import InstallerView from './InstallerView.jsx'
import Dashboard from './Dashboard.jsx'
import { subscribeToPush, sendPushNotification } from './push.js'
import { PANEL_W_M, TABLE_DEPTH_M, KNOWN_SITES, CAT_EN, SEV_EN, PDF_STR, findPinRow } from './shared.js'

const CATS = [
  'Paneeli rikkoutunut', 'Paneeli väärinpäin, yläreuna', 'Paneeli väärinpäin, alareuna',
  'Paneelikiinnikkeissä rakoja', 'Kiskon pultti löysällä', 'Kiskon pultti puuttuu',
  'Paneelikiinnikkeiden kiristysmomentit vajaat', 'Kiskot tasaamatta', 'Niittejä puuttuu',
  'Kannake vääntynyt tai rikki', 'DC-kouru katkaisematta', 'Tupla poraruuvit puuttuvat',
  'Poraruuvi puuttuu', 'Koropalojen suoristus', 'Shimmi levy puuttuu',
  'Paalu pultti löysällä', 'Paalu pultti puuttuu', 'Muu asia'
]

let idCounter = 0
const DRAFT_KEY = 'wisol_qc_draft_v1'

// Renders one combined map image containing ALL pins from `items` (a list of
// observations that share a fault category), so an installer can see every
// occurrence of that fault on one picture instead of paging through a
// separate map per observation. Crops to a bounding box that covers all the
// pins (plus padding), highlights every row that contains at least one pin,
// and draws each pin as a small numbered circle (1, 2, 3…) matching the
// numbered list printed under the image in the PDF.
function renderGroupMapImage(mapData, items) {
  const sxm = mapData.W / (mapData.maxX - mapData.minX)
  const sym = mapData.H / (mapData.maxY - mapData.minY)
  const th = TABLE_DEPTH_M * sym

  const pins = items.map(o => ({ x: o.pin.x * mapData.W, y: o.pin.y * mapData.H }))

  // Find each pin's full row (using the shared, bug-fixed findPinRow) once,
  // and reuse it both for highlighting and for sizing the crop.
  const rowInfos = items.map(o => findPinRow(mapData, o.pin))
  const highlightIdx = new Set()
  const rowLabels = rowInfos.map(info => {
    if (info) info.rowInsertIdxs.forEach(idx => highlightIdx.add(idx))
    return info ? info.label : null
  })

  let minX = Math.min(...pins.map(p => p.x)), maxX = Math.max(...pins.map(p => p.x))
  let minY = Math.min(...pins.map(p => p.y)), maxY = Math.max(...pins.map(p => p.y))

  // Expand the bounding box to cover each pin's ENTIRE row — every segment
  // of the chain findPinRow found, not just a fixed radius around the pin
  // point. A "zoomed enough to see the pin clearly" crop showed only one
  // anonymous colour block with no row number and no sense of where along
  // a long row it sat. Showing the whole row (segments + its number label)
  // instead always gives that context, at the cost of a wider image when
  // the row itself is long — which is the correct trade-off here.
  highlightIdx.forEach(idx => {
    const ins = mapData.inserts[idx]
    const left = ins.x, right = ins.x + ins.panels * PANEL_W_M * sxm
    if (left < minX) minX = left
    if (right > maxX) maxX = right
    if (ins.y < minY) minY = ins.y
    if (ins.y + th > maxY) maxY = ins.y + th
  })

  // Small, mostly fixed margin now — the crop width is already driven by
  // the row's real extent, not by guesswork padding.
  const padX = Math.max(6 * sxm, (maxX - minX) * 0.05)
  const padY = Math.max(9 * sym, (maxY - minY) * 0.2)
  const svgX0 = Math.max(0, minX - padX)
  const svgY0 = Math.max(0, minY - padY)
  const svgX1 = Math.min(mapData.W, maxX + padX)
  const svgY1 = Math.min(mapData.H, maxY + padY)
  const svgCropW = Math.max(1, svgX1 - svgX0), svgCropH = Math.max(1, svgY1 - svgY0)

  const outW = 1400, outH = Math.round(outW * svgCropH / svgCropW)
  const canvas = document.createElement('canvas')
  canvas.width = outW; canvas.height = outH
  const mctx = canvas.getContext('2d')
  mctx.fillStyle = '#eef4ec'; mctx.fillRect(0, 0, outW, outH)
  const kx = outW / svgCropW, ky = outH / svgCropH
  const px = sx => (sx - svgX0) * kx, py = sy => (sy - svgY0) * ky

  mctx.fillStyle = 'rgba(200,223,245,0.85)'; mctx.strokeStyle = '#4a90d9'; mctx.lineWidth = 1.2
  mapData.pvAreas.forEach(pts => {
    mctx.beginPath(); pts.forEach(([x, y2], i) => i === 0 ? mctx.moveTo(px(x), py(y2)) : mctx.lineTo(px(x), py(y2)))
    mctx.closePath(); mctx.fill(); mctx.stroke()
  })

  mapData.inserts.forEach((ins, idx) => {
    const tw = ins.panels * PANEL_W_M * sxm * kx
    const thpx = TABLE_DEPTH_M * sym * ky
    const isHi = highlightIdx.has(idx)
    mctx.fillStyle = isHi ? 'rgba(214,48,48,0.30)' : 'rgba(26,47,204,0.18)'
    mctx.strokeStyle = isHi ? '#d63030' : '#1a2fcc'
    mctx.lineWidth = isHi ? 1.6 : 0.6
    mctx.fillRect(px(ins.x), py(ins.y), tw, thpx)
    mctx.strokeRect(px(ins.x), py(ins.y), tw, thpx)
  })

  // Muun wattiluokan / polygonina piirretyt paneelipöydät (665 Wp / 670 Wp /
  // Extra panels) — ks. selitys MapView.jsx:ssä/dxfParser.js:ssä.
  ;(mapData.panelAreas || []).forEach(pts => {
    mctx.fillStyle = 'rgba(26,47,204,0.18)'
    mctx.strokeStyle = '#1a2fcc'
    mctx.lineWidth = 0.6
    mctx.beginPath(); pts.forEach(([x, y2], i) => i === 0 ? mctx.moveTo(px(x), py(y2)) : mctx.lineTo(px(x), py(y2)))
    mctx.closePath(); mctx.fill(); mctx.stroke()
  })

  mctx.textAlign = 'center'
  mapData.rowNumbers.forEach(t => {
    mctx.font = 'bold 12px sans-serif'
    mctx.fillStyle = 'rgba(255,255,255,0.75)'
    mctx.fillRect(px(t.x) - 9, py(t.y) - 9, 18, 12)
    mctx.fillStyle = '#0d1a6e'
    mctx.fillText(t.text, px(t.x), py(t.y) + 1)
  })

  // Numbered pins — number matches the item list printed below the image.
  pins.forEach((p, i) => {
    const cx = px(p.x), cy = py(p.y)
    mctx.beginPath(); mctx.arc(cx, cy, 11, 0, Math.PI * 2)
    mctx.fillStyle = '#d63030'; mctx.fill()
    mctx.strokeStyle = 'white'; mctx.lineWidth = 2; mctx.stroke()
    mctx.font = 'bold 13px sans-serif'; mctx.fillStyle = 'white'
    mctx.fillText(String(i + 1), cx, cy + 4)
  })

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), outW, outH, rowLabels }
}

export default function App() {
  // ?asentaja avaa karsitun asentajanäkymän tämän saman appin sisällä —
  // sama Vite-projekti, sama Netlify-deploy, ei erillistä sivustoa.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('asentaja')) {
    return <InstallerView />
  }
  // ?valvomo avaa työnjohtajan työpöytänäkymän — kuka korjaa mitä, mikä on
  // avoinna, mikä korjattu. Sama periaate kuin ?asentaja.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('valvomo')) {
    return <Dashboard />
  }

  const [site, setSite] = useState('Isoneva, Suonenjoki')
  const [inspector, setInspector] = useState('')
  const [rivi, setRivi] = useState('')
  const [obs, setObs] = useState([])
  const [mapData, setMapData] = useState(null)
  const [mapError, setMapError] = useState('')
  const [currentSiteKey, setCurrentSiteKey] = useState('isoneva')
  const [gpsCoords, setGpsCoords] = useState(null)
  const [syncMsg, setSyncMsg] = useState('')
  const [pdfMode, setPdfMode] = useState(false)
  const [pdfBlob, setPdfBlob] = useState(null)
  const [pdfName, setPdfName] = useState('')
  const [pdfDownloaded, setPdfDownloaded] = useState(false)
  const [groupByCategory, setGroupByCategory] = useState(false)
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [installers, setInstallers] = useState([])
  const [teams, setTeams] = useState([])
  // Pikalisäys: kun tämä on asetettu jonkin havainnon id:hen, saman kartan
  // napautukset eivät enää siirrä TÄMÄN havainnon pinniä vaan luovat uuden,
  // samankaltaisen havainnon napautettuun kohtaan — kartta pysyy koko ajan
  // samana komponenttina (zoom/pan säilyy), eikä jokaista uutta havaintoa
  // tarvitse zoomata erikseen. Uudet pikalisätyt havainnot renderöityvät
  // kevyinä "collapsed"-riveinä (ei omaa raskasta karttaa) suorituskyvyn
  // vuoksi, jos niitä syntyy paljon peräkkäin.
  const [quickAddId, setQuickAddId] = useState(null)
  const [collapsedIds, setCollapsedIds] = useState(() => new Set())
  const [quickAddCounts, setQuickAddCounts] = useState({})
  const [assignMode, setAssignMode] = useState(false)
  const [assignInstallerId, setAssignInstallerId] = useState('')
  const [assignTeamId, setAssignTeamId] = useState('')
  const [newInstallerName, setNewInstallerName] = useState('')
  const [newInstallerPin, setNewInstallerPin] = useState('')
  const [assignMsg, setAssignMsg] = useState('')
  const fileInputRef = useRef(null)
  const syncTimer = useRef(null)
  const restoredRef = useRef(false)
  const obsRef = useRef(obs)
  const metaRef = useRef({ site, inspector, rivi })
  useEffect(() => { obsRef.current = obs }, [obs])
  useEffect(() => { metaRef.current = { site, inspector, rivi } }, [site, inspector, rivi])

  // GPS — convert ETRS-TM35FIN (EPSG:3067) coords from the DXF to lat/lng on the fly
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

  // Load DXF from Supabase storage based on selected site
  useEffect(() => {
    loadDXF(currentSiteKey)
  }, [currentSiteKey])

  async function loadDXF(siteKey) {
    setMapData(null)
    setMapError('')
    try {
      const { data, error } = await sb.storage.from('maps').download(`${siteKey}.dxf`)
      if (error || !data) {
        setMapError('Ei karttaa tälle työmaalle')
        return
      }
      const text = await data.text()
      const parsed = parseDXF(text)
      if (parsed) setMapData(parsed)
      else setMapError('DXF-tiedostoa ei voitu lukea')
    } catch (e) {
      setMapError('Ei karttaa tälle työmaalle')
    }
  }

  function showSync(msg) {
    setSyncMsg(msg)
    clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => setSyncMsg(''), 3000)
  }

  async function saveObs(o, currentSite, currentInspector, currentRivi) {
    const data = {
      cat: o.cat, sev: o.sev, note: o.note, muu: o.muu,
      pin_x: o.pin?.x ?? null, pin_y: o.pin?.y ?? null,
      site: currentSite, inspector: currentInspector, rivi: currentRivi,
      local_id: o.id,
      status: o.status || 'avoin',
      assigned_installer_id: o.assignedInstallerId ?? null,
      assigned_team_id: o.assignedTeamId ?? null,
      report_batch: o.reportBatch ?? null,
    }
    try {
      if (o.db_id) {
        const { error } = await sb.from('observations').update(data).eq('id', o.db_id)
        if (error) throw error
        showSync('✓ Tallennettu')
        return o.db_id
      } else {
        // created_at only set on the first insert — it should reflect when
        // the fault was actually spotted, even if the sync itself happens
        // later (offline catch-up), not overwritten by DB default on retry.
        const { data: res, error } = await sb.from('observations').insert([{ ...data, created_at: o.createdAt || new Date().toISOString() }]).select()
        if (error) throw error
        if (res?.[0]) {
          // Write the new Supabase id straight back into state — otherwise
          // every later edit would insert a new duplicate row instead of
          // updating this one, since o.db_id would still read as null.
          setObs(prev => prev.map(x => x.id === o.id ? { ...x, db_id: res[0].id } : x))
          showSync('✓ Tallennettu')
          return res[0].id
        }
      }
    } catch (e) {
      // Log the real reason to the console — a schema/permission error
      // (e.g. unknown column, RLS block) looks identical to "no network"
      // from the UI's point of view otherwise, which makes it very hard to
      // tell the two apart when something isn't saving.
      console.error('saveObs failed:', e)
      const looksLikeNetwork = !navigator.onLine || e?.message?.toLowerCase().includes('fetch')
      showSync(looksLikeNetwork ? '⚠ Ei yhteyttä — tallessa vain paikallisesti' : '⚠ Tallennusvirhe (katso konsoli)')
      return null
    }
    return null
  }

  // Retry any observations that never made it to Supabase (offline edits,
  // failed requests). Reads the latest state via obsRef/metaRef so it never
  // acts on stale data.
  function retrySync() {
    obsRef.current.forEach(o => {
      if (!o.db_id) {
        const { site: s, inspector: ins, rivi: r } = metaRef.current
        saveObs(o, s, ins, r)
      }
    })
  }

  // Restore a locally-saved draft (survives closed tabs, crashes, and time
  // spent fully offline) as soon as the app opens.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft = JSON.parse(raw)
        if (draft.obs?.length) {
          setObs(draft.obs)
          idCounter = Math.max(idCounter, ...draft.obs.map(o => o.id || 0))
          if (draft.site) setSite(draft.site)
          if (draft.inspector) setInspector(draft.inspector)
          if (draft.rivi) setRivi(draft.rivi)
          if (draft.currentSiteKey) setCurrentSiteKey(draft.currentSiteKey)
          showSync('↺ Luonnos palautettu')
        }
      }
    } catch {}
    restoredRef.current = true
  }, [])

  // Keep a local copy of the whole draft on every change — this is the real
  // safety net. It works regardless of network status, so nothing is lost if
  // the installer loses signal or the browser closes mid-entry.
  useEffect(() => {
    if (!restoredRef.current) return
    try {
      const toSave = { site, inspector, rivi, currentSiteKey, obs: obs.map(({ _timer, ...rest }) => rest) }
      localStorage.setItem(DRAFT_KEY, JSON.stringify(toSave))
    } catch {
      // Quota exceeded or storage unavailable — cloud sync still applies when back online
    }
  }, [obs, site, inspector, rivi, currentSiteKey])

  // Track connectivity and retry pending saves as soon as the connection is back
  useEffect(() => {
    const goOnline = () => { setIsOnline(true); showSync('🌐 Yhteys palautui, synkronoidaan...'); retrySync() }
    const goOffline = () => { setIsOnline(false); showSync('⚠ Ei verkkoyhteyttä') }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const t = setInterval(() => { if (navigator.onLine) retrySync() }, 30000)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      clearInterval(t)
    }
  }, [])

  function addObs() {
    const id = ++idCounter
    setObs(prev => [...prev, { id, cat: CATS[0], sev: 'Huomio', note: '', muu: '', photos: [], pin: null, db_id: null, createdAt: new Date().toISOString() }])
  }

  function newReport() {
    if (obs.length > 0 && !window.confirm('Aloitetaanko uusi raportti? Nykyiset havainnot poistetaan tältä laitteelta (jo pilveen tallentuneet säilyvät Supabasessa ennallaan).')) return
    setObs([])
    setInspector('')
    setRivi('')
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
  }

  useEffect(() => {
    sb.from('installers').select('*').order('name').then(({ data }) => { if (data) setInstallers(data) })
    sb.from('teams').select('*').order('name').then(({ data }) => { if (data) setTeams(data) })
  }, [])

  async function addInstaller() {
    if (!newInstallerName.trim() || newInstallerPin.trim().length < 4) return
    const { data, error } = await sb.from('installers').insert([{ name: newInstallerName.trim(), pin: newInstallerPin.trim() }]).select()
    if (!error && data?.[0]) {
      setInstallers(prev => [...prev, data[0]].sort((a, b) => a.name.localeCompare(b.name)))
      setAssignInstallerId(data[0].id)
      setNewInstallerName(''); setNewInstallerPin('')
    }
  }

  // Assigns every current observation either to one installer OR to a
  // whole team (assignTeamId), tags them with a shared report_batch so the
  // recipient(s) see them as one job, and pushes a real phone notification
  // — to the single installer, or to every member of the chosen team.
  async function assignAndNotify() {
    const target = assignTeamId || assignInstallerId
    if (!target || obs.length === 0) return
    const reportBatch = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setAssignMsg('Lähetetään...')

    if (assignTeamId) {
      const team = teams.find(t => t.id === assignTeamId)
      const members = installers.filter(i => i.team_id === assignTeamId)
      const updated = obs.map(o => ({ ...o, assignedInstallerId: null, assignedTeamId: assignTeamId, status: 'avoin', reportBatch }))
      setObs(updated)
      await Promise.all(updated.map(o => saveObs(o, site, inspector, rivi)))

      // Jokainen tiimin jäsen saa oman ilmoituksensa — kaikki näkevät saman
      // tehtävälistan (InstallerView hakee tehtävät myös assigned_team_id:n
      // perusteella, ei vain omalla installer_id:llään).
      const results = await Promise.all(members.map(m => sendPushNotification({
        role: 'installer',
        installerId: m.id,
        title: 'Uusi tarkistuslista',
        body: `${updated.length} havaintoa — ${site}`,
        url: '/?asentaja=1',
        tag: reportBatch,
      })))
      const anySent = results.some(r => r?.sent > 0)
      setAssignMsg(anySent ? `✓ Lähetetty tiimille ${team?.name || ''}` : '✓ Tallennettu (tiimin jäsenet eivät ehkä ole vielä ottaneet ilmoituksia käyttöön)')
    } else {
      const installer = installers.find(i => i.id === assignInstallerId)
      const updated = obs.map(o => ({ ...o, assignedInstallerId: assignInstallerId, assignedTeamId: null, status: 'avoin', reportBatch }))
      setObs(updated)
      await Promise.all(updated.map(o => saveObs(o, site, inspector, rivi)))

      const res = await sendPushNotification({
        role: 'installer',
        installerId: assignInstallerId,
        title: 'Uusi tarkistuslista',
        body: `${updated.length} havaintoa — ${site}`,
        url: '/?asentaja=1',
        tag: reportBatch,
      })
      setAssignMsg(res?.sent > 0 ? `✓ Lähetetty ${installer?.name || ''}` : '✓ Tallennettu (asentaja ei ehkä ole vielä ottanut ilmoituksia käyttöön)')
    }
    setTimeout(() => setAssignMsg(''), 4000)
  }

  function removeObs(id) {
    if (!window.confirm('Poistetaanko tämä havainto?')) return
    setObs(prev => {
      const o = prev.find(x => x.id === id)
      if (o?.db_id) {
        // anon-roolilla ei ole enää poisto-oikeutta tietoturvasyistä (ks.
        // tighten_permissions.sql) — rivi jää siis pilveen arkistoksi vaikka
        // se katoaa tästä listasta. Tämä on tarkoituksellista: yksittäinen
        // asentaja ei voi enää pyyhkiä havaintoa pysyvästi pois tietokannasta.
        sb.from('observations').delete().eq('id', o.db_id).then(({ error }) => {
          if (error) console.log('Huom: havainto poistui vain paikallisesti, pilvikopio jäi talteen (tarkoituksellista).')
        })
      }
      return prev.filter(x => x.id !== id)
    })
  }

  function updateObs(id, key, val) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const updated = { ...o, [key]: val }
      clearTimeout(updated._timer)
      updated._timer = setTimeout(() => {
        const latest = obsRef.current.find(x => x.id === id)
        if (latest) {
          const { site: s, inspector: ins, rivi: r } = metaRef.current
          saveObs(latest, s, ins, r)
        }
      }, 1200)
      return updated
    }))
  }

  function setPin(id, pin) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const updated = { ...o, pin }
      saveObs(updated, site, inspector, rivi)
      return updated
    }))
  }

  // Napautuksen käsittelijä havainnon kartalle. Normaalisti siirtää tämän
  // havainnon omaa pinniä. Mutta jos pikalisäys on päällä TÄLLE havainnolle
  // JA sillä on jo oma pinni, uusi napautus ei koske olemassa olevaan
  // pinniin lainkaan — se luo kokonaan uuden, samankategorisen havainnon
  // napautettuun kohtaan. Kartta itse ei koskaan unmounttaudu tämän aikana,
  // joten zoom/pan säilyy napautusten välillä.
  function handleMapTap(o, pin) {
    if (quickAddId === o.id && o.pin) {
      const id = ++idCounter
      const clone = {
        id, cat: o.cat, sev: o.sev, note: '', muu: o.muu, photos: [],
        pin, db_id: null, createdAt: new Date().toISOString(),
      }
      setObs(prev => [...prev, clone])
      saveObs(clone, site, inspector, rivi)
      setCollapsedIds(prev => { const next = new Set(prev); next.add(id); return next })
      setQuickAddCounts(prev => ({ ...prev, [o.id]: (prev[o.id] || 0) + 1 }))
    } else {
      setPin(o.id, pin)
    }
  }

  function toggleQuickAdd(id) {
    setQuickAddId(prev => (prev === id ? null : id))
  }

  function expandObs(id) {
    setCollapsedIds(prev => { const next = new Set(prev); next.delete(id); return next })
  }

  function setMapView(id, view) {
    setObs(prev => prev.map(o => o.id !== id ? o : { ...o, mapView: view }))
  }

  // Downscale + re-encode straight away. Raw phone photos can be several MB
  // each, which is both slow to work with and too big to keep safely in a
  // local backup — this keeps them small without a noticeable quality loss
  // in the PDF (which is only ever printed at CW page width anyway).
  function compressImage(file, maxDim = 1600, quality = 0.75) {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = e => {
        const img = new Image()
        img.onload = () => {
          let { width, height } = img
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height)
            width = Math.round(width * scale); height = Math.round(height * scale)
          }
          const c = document.createElement('canvas')
          c.width = width; c.height = height
          c.getContext('2d').drawImage(img, 0, 0, width, height)
          resolve(c.toDataURL('image/jpeg', quality))
        }
        img.onerror = () => resolve(e.target.result)
        img.src = e.target.result
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }

  async function addPhotos(id, files) {
    for (const file of Array.from(files)) {
      const src = await compressImage(file)
      if (!src) continue
      setObs(prev => prev.map(o => o.id !== id ? o : { ...o, photos: [...o.photos, { src }] }))
    }
  }

  function removePhoto(id, pi) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const photos = [...o.photos]
      photos.splice(pi, 1)
      return { ...o, photos }
    }))
  }

  // DXF upload
  async function handleDXFUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    showSync('Ladataan karttaa...')
    const text = await file.text()
    const parsed = parseDXF(text)
    if (parsed) {
      setMapData(parsed)
      setMapError('')
      showSync('✓ Kartta ladattu!')
      try {
        await sb.storage.from('maps').upload(`${currentSiteKey}.dxf`, file, { upsert: true })
      } catch {}
    } else {
      showSync('⚠ DXF-tiedostoa ei voitu lukea')
    }
  }

  // PDF export
  async function exportPDF(lang = 'fi') {
    if (obs.length === 0) {
      alert('Ei havaintoja lisättynä — lisää vähintään yksi havainto ennen PDF:n luontia.')
      return
    }
    const missingPin = obs.filter(o => mapData && !o.pin).length
    if (missingPin > 0) {
      const n = missingPin === 1 ? 'havainnolta puuttuu sijainti kartalta' : `${missingPin} havainnolta puuttuu sijainti kartalta`
      if (!window.confirm(`${n.charAt(0).toUpperCase() + n.slice(1)}. Luodaanko PDF silti?`)) return
    }
    const T = PDF_STR[lang] || PDF_STR.fi
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ unit: 'mm', format: 'a4' })
    const W = 210, M = 14, CW = W - M * 2
    let y = 18
    const dateStr = new Date().toLocaleDateString(T.dateLocale)

    doc.setFillColor(26, 47, 204)
    doc.rect(0, 0, W, 28, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(245, 168, 0)
    doc.text('WISOL OY', M, 12)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(255, 255, 255)
    doc.text(T.title, M, 19)
    doc.setFontSize(9); doc.setTextColor(180, 200, 255)
    doc.text(dateStr, W - M, 12, { align: 'right' })
    y = 38

    const meta = [[T.site, site || '–'], [T.inspector, inspector || '–'], [T.rivi, rivi || '–']]
    meta.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 100, 120); doc.text(k, M, y)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(20, 20, 60); doc.text(v, M + 28, y)
      y += 6
    })
    y += 4; doc.setDrawColor(200, 205, 220); doc.line(M, y, W - M, y); y += 8

    const sevCol = { 'Kriittinen': [180, 40, 40], 'Huomio': [180, 120, 0], 'Info': [30, 140, 80] }

    if (groupByCategory) {
      // Group observations by fault category, preserving the order in which
      // each category first appeared, so the report stays predictable.
      const groups = []
      const groupIdxByCat = {}
      obs.forEach(o => {
        if (!(o.cat in groupIdxByCat)) { groupIdxByCat[o.cat] = groups.length; groups.push({ cat: o.cat, items: [] }) }
        groups[groupIdxByCat[o.cat]].items.push(o)
      })

      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        if (gi > 0) { doc.addPage(); y = 18 }
        const catLabel = lang === 'en' ? (CAT_EN[g.cat] || g.cat) : g.cat
        const worstSev = g.items.some(o => o.sev === 'Kriittinen') ? 'Kriittinen'
          : g.items.some(o => o.sev === 'Huomio') ? 'Huomio' : 'Info'
        const col = sevCol[worstSev] || [80, 80, 80]
        doc.setFillColor(...col)
        doc.roundedRect(M, y, CW, 8, 1.5, 1.5, 'F')
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 255, 255)
        doc.text(`${gi + 1}.  ${catLabel}`, M + 4, y + 5.7)
        const countLabel = lang === 'en' ? `${g.items.length} item${g.items.length === 1 ? '' : 's'}` : `${g.items.length} kpl`
        doc.text(countLabel, W - M - 4, y + 5.7, { align: 'right' })
        y += 11

        // One combined map for every pin in this category, numbered to match
        // the list below.
        const withPin = g.items.filter(o => o.pin)
        let rowLabelByItem = new Map()
        if (withPin.length && mapData) {
          if (y + 150 > 278) { doc.addPage(); y = 18 }
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 100, 120)
          doc.text(T.location, M + 2, y); y += 4.5
          try {
            const { dataUrl, outW, outH, rowLabels } = renderGroupMapImage(mapData, withPin)
            let pdfW = CW, pdfH = pdfW * (outH / outW)
            if (pdfH > 150) { pdfH = 150; pdfW = pdfH * (outW / outH) }
            if (y + pdfH > 278) { doc.addPage(); y = 18 }
            doc.addImage(dataUrl, 'JPEG', M, y, pdfW, pdfH)
            y += pdfH + 4
            withPin.forEach((o, idx) => rowLabelByItem.set(o, rowLabels[idx]))
          } catch (e) { console.error('Group map PDF:', e) }
        }

        // Numbered list of the individual observations in this category —
        // same numbering as the pins on the map above.
        g.items.forEach((o, idx) => {
          if (y + 16 > 278) { doc.addPage(); y = 18 }
          const sevLabel = lang === 'en' ? (SEV_EN[o.sev] || o.sev) : o.sev
          const sc = sevCol[o.sev] || [80, 80, 80]
          const rowLbl = rowLabelByItem.get(o)
          const rowStr = rowLbl ? `  (${T.row} ${rowLbl})` : ''
          const timeStr = o.createdAt ? '  ' + new Date(o.createdAt).toLocaleTimeString(T.dateLocale, { hour: '2-digit', minute: '2-digit' }) : ''
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...sc)
          doc.text(`${idx + 1}. ${sevLabel}${rowStr}${timeStr}`, M + 2, y)
          y += 5.5
          if (o.note) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 60, 60)
            const lines = doc.splitTextToSize(o.note, CW - 6)
            doc.text(lines, M + 6, y); y += lines.length * 5 + 2
          }
        })
        y += 2

        // Photos for every observation in the group, captioned with the
        // matching item number.
        for (let idx = 0; idx < g.items.length; idx++) {
          const o = g.items[idx]
          for (const photo of o.photos) {
            const img = new Image(); img.src = photo.src
            await new Promise(r => { img.onload = r; img.onerror = r })
            const c = document.createElement('canvas')
            c.width = img.naturalWidth; c.height = img.naturalHeight
            c.getContext('2d').drawImage(img, 0, 0)
            const corrected = c.toDataURL('image/jpeg', 0.85)
            const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600
            const sc = Math.min((CW - 8) / nw, 220 / nh)
            const dw = nw * sc, dh = nh * sc
            if (y + dh + 6 > 278) { doc.addPage(); y = 18 }
            doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 140, 140)
            doc.text(`${idx + 1}.`, M + 2, y + 3)
            try { doc.addImage(corrected, 'JPEG', M + 8, y, dw, dh) } catch {}
            y += dh + 5
          }
        }
      }

      const tp0 = doc.getNumberOfPages()
      for (let p = 1; p <= tp0; p++) {
        doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160, 160, 160)
        doc.text(`Wisol Oy · ${T.footer} · ${dateStr}`, M, 292)
        doc.text(`${p} / ${tp0}`, W - M, 292, { align: 'right' })
      }
      const blob0 = doc.output('blob')
      const fn0 = `QC_${(site || 'työmaa').replace(/\s+/g, '_')}_${dateStr.replace(/\./g, '-')}.pdf`
      setPdfBlob(blob0); setPdfName(fn0); setPdfDownloaded(false); setPdfMode(true)
      return
    }

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]
      if (i > 0) { doc.addPage(); y = 18 }
      const catLabel = lang === 'en' ? (CAT_EN[o.cat] || o.cat) : o.cat
      const sevLabel = lang === 'en' ? (SEV_EN[o.sev] || o.sev) : o.sev
      const lbl = o.cat === 'Muu asia' && o.muu ? `${T.other} – ${o.muu}` : catLabel
      const col = sevCol[o.sev] || [80, 80, 80]
      doc.setFillColor(...col)
      doc.roundedRect(M, y, CW, 8, 1.5, 1.5, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 255, 255)
      doc.text(`${i + 1}.  ${lbl}`, M + 4, y + 5.7)
      doc.text(sevLabel, W - M - 4, y + 5.7, { align: 'right' })
      y += 11

      if (o.createdAt) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(140, 140, 140)
        doc.text(new Date(o.createdAt).toLocaleTimeString(T.dateLocale, { hour: '2-digit', minute: '2-digit' }), M + 2, y)
        y += 4.5
      }

      if (o.note) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(40, 40, 40)
        const lines = doc.splitTextToSize(o.note, CW - 4)
        doc.text(lines, M + 2, y); y += lines.length * 5.5 + 3
      }

      // Map thumbnail - uses the zoom level left on screen, centered on the pin, pin's row highlighted in red
      if (o.pin && mapData) {
        if (y + 150 > 278) { doc.addPage(); y = 18 }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 100, 120)
        // Uses the shared findPinRow (shared.js), which groups all insert
        // segments at the same height into one logical row and restricts
        // the label search to that same row band — fixes the earlier bug
        // where a pin in the leftmost segment of a row could grab a
        // completely different row's number label.
        const rowInfoPdf = findPinRow(mapData, o.pin)
        doc.text(`${T.location}${rowInfoPdf ? '  (' + T.row + ' ' + rowInfoPdf.label + ')' : ''}`, M + 2, y); y += 4
        try {
          const PANEL_W = 1.15, TABLE_D = 4.29
          const sxm = mapData.W / (mapData.maxX - mapData.minX)
          const sym = mapData.H / (mapData.maxY - mapData.minY)

          const pinSvgX = o.pin.x * mapData.W, pinSvgY = o.pin.y * mapData.H
          const pinRowIdx = rowInfoPdf ? rowInfoPdf.rowIdx : -1
          const pinRowInsertIdxs = rowInfoPdf ? rowInfoPdf.rowInsertIdxs : []
          let pinLabelIdx = -1
          if (rowInfoPdf) {
            mapData.rowNumbers.forEach((t, idx) => {
              if (t.text === rowInfoPdf.label) pinLabelIdx = idx
            })
          }

          // Work out the crop window (in SVG units) using the zoom level left
          // on screen, centered on the pin — not the saved pan position, so a
          // stray pan afterwards can't drag the crop to an unrelated spot.
          const view = o.mapView || { scale: 1, containerW: 360, containerH: 240 }
          const scale = view.scale || 1
          const containerW = view.containerW || 360, containerH = view.containerH || 240
          const vtx = containerW / 2 - pinSvgX * scale
          const vty = containerH / 2 - pinSvgY * scale
          const svgX0 = Math.max(0, (-vtx) / scale)
          const svgY0 = Math.max(0, (-vty) / scale)
          const svgX1 = Math.min(mapData.W, (containerW - vtx) / scale)
          const svgY1 = Math.min(mapData.H, (containerH - vty) / scale)
          const svgCropW = Math.max(1, svgX1 - svgX0), svgCropH = Math.max(1, svgY1 - svgY0)

          // Render straight to the crop's own resolution (rather than
          // rendering the whole site at a fixed size and cropping a sliver
          // out of it) — this is what was causing the blurriness: a tight
          // zoom only used a small slice of pixels that then had to be
          // stretched up to fill the PDF. Fixed output resolution here means
          // the result stays sharp no matter how far the installer zoomed.
          const outW = 1200, outH = Math.round(outW * svgCropH / svgCropW)
          const mapCanvas = document.createElement('canvas')
          mapCanvas.width = outW; mapCanvas.height = outH
          const mctx = mapCanvas.getContext('2d')
          mctx.fillStyle = '#eef4ec'; mctx.fillRect(0, 0, outW, outH)
          const kx = outW / svgCropW, ky = outH / svgCropH
          const px = sx => (sx - svgX0) * kx, py = sy => (sy - svgY0) * ky

          mctx.fillStyle = 'rgba(200,223,245,0.85)'; mctx.strokeStyle = '#4a90d9'; mctx.lineWidth = 1.2
          mapData.pvAreas.forEach(pts => {
            mctx.beginPath(); pts.forEach(([x,y2],i) => i===0 ? mctx.moveTo(px(x),py(y2)) : mctx.lineTo(px(x),py(y2)))
            mctx.closePath(); mctx.fill(); mctx.stroke()
          })

          mapData.inserts.forEach((ins, idx) => {
            const tw = ins.panels * PANEL_W * sxm * kx
            const th = TABLE_D * sym * ky
            const isPinRow = pinRowInsertIdxs.includes(idx)
            mctx.fillStyle = isPinRow ? 'rgba(214,48,48,0.35)' : 'rgba(26,47,204,0.22)'
            mctx.strokeStyle = isPinRow ? '#d63030' : '#1a2fcc'
            mctx.lineWidth = isPinRow ? 2 : 0.7
            mctx.fillRect(px(ins.x), py(ins.y), tw, th)
            mctx.strokeRect(px(ins.x), py(ins.y), tw, th)
          })

          // Muun wattiluokan / polygonina piirretyt paneelipöydät (665 Wp /
          // 670 Wp / Extra panels) — ks. selitys MapView.jsx:ssä/dxfParser.js:ssä.
          ;(mapData.panelAreas || []).forEach(pts => {
            mctx.fillStyle = 'rgba(26,47,204,0.22)'
            mctx.strokeStyle = '#1a2fcc'
            mctx.lineWidth = 0.7
            mctx.beginPath(); pts.forEach(([x,y2],i) => i===0 ? mctx.moveTo(px(x),py(y2)) : mctx.lineTo(px(x),py(y2)))
            mctx.closePath(); mctx.fill(); mctx.stroke()
          })

          mctx.textAlign = 'center'
          mapData.rowNumbers.forEach((t, idx) => {
            const isPinLabel = idx === pinLabelIdx
            if (isPinLabel) {
              mctx.font = 'bold 17px sans-serif'
              mctx.fillStyle = '#d63030'
              mctx.fillRect(px(t.x)-14, py(t.y)-13, 28, 18)
              mctx.fillStyle = '#ffffff'
              mctx.fillText(t.text, px(t.x), py(t.y)+3)
            } else {
              mctx.font = 'bold 12px sans-serif'
              mctx.fillStyle = 'rgba(255,255,255,0.75)'
              mctx.fillRect(px(t.x)-9, py(t.y)-9, 18, 12)
              mctx.fillStyle = '#0d1a6e'
              mctx.fillText(t.text, px(t.x), py(t.y)+1)
            }
          })

          // Pin — kept deliberately small since several faults can sit close
          // together on the same row.
          mctx.beginPath(); mctx.arc(px(pinSvgX), py(pinSvgY), 4, 0, Math.PI*2)
          mctx.fillStyle = '#d63030'; mctx.fill()
          mctx.strokeStyle = 'white'; mctx.lineWidth = 1.2; mctx.stroke()

          const mapImg = mapCanvas.toDataURL('image/jpeg', 0.95)
          let pdfW = CW, pdfH = pdfW * (outH / outW)
          if (pdfH > 140) { pdfH = 140; pdfW = pdfH * (outW / outH) }
          if (y + pdfH > 278) { doc.addPage(); y = 18 }
          doc.addImage(mapImg, 'JPEG', M, y, pdfW, pdfH)
          y += pdfH + 4
        } catch(e) { console.error('Map PDF:', e) }
      }

      for (const photo of o.photos) {
        const img = new Image(); img.src = photo.src
        await new Promise(r => { img.onload = r; img.onerror = r })
        const c = document.createElement('canvas')
        c.width = img.naturalWidth; c.height = img.naturalHeight
        c.getContext('2d').drawImage(img, 0, 0)
        const corrected = c.toDataURL('image/jpeg', 0.85)
        const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600
        const sc = Math.min(CW / nw, 250 / nh)
        const dw = nw * sc, dh = nh * sc
        if (y + dh > 278) { doc.addPage(); y = 18 }
        try { doc.addImage(corrected, 'JPEG', M, y, dw, dh) } catch {}
        y += dh + 4
      }
    }

    const tp = doc.getNumberOfPages()
    for (let p = 1; p <= tp; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160, 160, 160)
      doc.text(`Wisol Oy · ${T.footer} · ${dateStr}`, M, 292)
      doc.text(`${p} / ${tp}`, W - M, 292, { align: 'right' })
    }

    const blob = doc.output('blob')
    const fn = `QC_${(site || 'työmaa').replace(/\s+/g, '_')}_${dateStr.replace(/\./g, '-')}.pdf`
    setPdfBlob(blob); setPdfName(fn); setPdfDownloaded(false); setPdfMode(true)
  }

  const shareSupported = typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare

  async function sharePDF() {
    if (!pdfBlob) return
    const file = new File([pdfBlob], pdfName, { type: 'application/pdf' })
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: pdfName }) } catch {}
    } else {
      const url = URL.createObjectURL(pdfBlob)
      const a = document.createElement('a'); a.href = url; a.download = pdfName
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 3000)
      setPdfDownloaded(true)
    }
  }

  const sevColor = { Kriittinen: '#d63030', Huomio: '#d07800', Info: '#1a8a50' }
  const sevBg = { Kriittinen: 'rgba(214,48,48,0.1)', Huomio: 'rgba(245,168,0,0.12)', Info: 'rgba(26,138,80,0.1)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 480, margin: '0 auto' }}>
      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 10px', background: '#1a2fcc', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="44" height="34" viewBox="0 0 160 115" fill="none">
            <path d="M0,0 L22,0 L44,72 L65,18 L80,18 L101,72 L123,0 L145,0 L116,105 L94,105 L80,62 L66,105 L44,105 Z" fill="white" />
            <path d="M24,6 L12,6 L38,78 L50,52 Z" fill="#1a2fcc" />
            <path d="M121,6 L133,6 L107,52 L119,78 Z" fill="#1a2fcc" />
            <circle cx="148" cy="98" r="17" fill="#f5a800" />
          </svg>
          <span style={{ fontSize: 19, fontWeight: 800, color: 'white', letterSpacing: 1 }}>WISOL</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: 500, marginLeft: 2 }}>· Vikalista</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isOnline && (
            <span style={{ fontSize: 11, color: '#1a2fcc', fontWeight: 700, background: '#f5a800', padding: '3px 8px', borderRadius: 20 }}>⚠ Offline</span>
          )}
          {syncMsg && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{syncMsg}</span>}
        </div>
      </div>

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 90 }}>

        {/* Meta */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', borderBottom: '1px solid #d0d5e8' }}>
          <select
            style={selectStyle}
            value={currentSiteKey}
            onChange={e => {
              const key = e.target.value
              setCurrentSiteKey(key)
              const found = KNOWN_SITES.find(s => s.key === key)
              setSite(found ? found.label : '')
            }}
          >
            {KNOWN_SITES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <input style={inputStyle} placeholder="Tarkastaja" value={inspector} onChange={e => setInspector(e.target.value)} />
          <input style={inputStyle} placeholder="Rivi / alue (esim. A7-45)" value={rivi} onChange={e => setRivi(e.target.value)} />
          <button onClick={newReport} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#6670a0', padding: '2px 0' }}>
            🔄 Uusi raportti
          </button>
          <button onClick={async () => { const r = await subscribeToPush('supervisor'); setAssignMsg(r.ok ? '🔔 Ilmoitukset päällä' : (r.reason || 'Ei onnistunut')); setTimeout(() => setAssignMsg(''), 3000) }}
            style={{ alignSelf: 'flex-end', background: 'none', border: 'none', fontSize: 11, color: '#6670a0', padding: '2px 0' }}>
            🔔 Salli ilmoitukset (kun asentaja korjaa)
          </button>
        </div>

        {/* DXF upload if no map */}
        {!mapData && (
          <div style={{ margin: '12px 16px', padding: 16, background: '#fff', borderRadius: 12, border: '1.5px dashed #b0b8d8', textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: '#6670a0', marginBottom: 10 }}>
              {mapError || 'Ladataan karttaa...'}
            </p>
            <button onClick={() => fileInputRef.current.click()} style={{ background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700 }}>
              📂 Lataa DXF tälle työmaalle
            </button>
            <input ref={fileInputRef} type="file" accept=".dxf,.dwg" style={{ display: 'none' }} onChange={handleDXFUpload} />
          </div>
        )}

        {mapData && (
          <div style={{ margin: '8px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => fileInputRef.current.click()} style={{ background: 'none', border: 'none', fontSize: 11, color: '#6670a0' }}>
              🗺 Vaihda kartta
            </button>
            <input ref={fileInputRef} type="file" accept=".dxf,.dwg" style={{ display: 'none' }} onChange={handleDXFUpload} />
          </div>
        )}

        {/* Observations */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {obs.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: '#6670a0' }}>
              <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>📋</div>
              <p style={{ fontSize: 14, lineHeight: 1.6 }}>Ei havaintoja.<br />Paina + lisätäksesi ensimmäisen.</p>
            </div>
          )}

          {obs.map((o, idx) => {
            if (collapsedIds.has(o.id)) {
              const rowInfo = o.pin && mapData ? findPinRow(mapData, o.pin) : null
              return (
                <div key={o.id} style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 10, padding: '9px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev], flexShrink: 0 }}>{o.sev}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#222', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.cat}</span>
                    {rowInfo && <span style={{ fontSize: 11, color: '#1a8a50', fontWeight: 700, flexShrink: 0 }}>rivi {rowInfo.label}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexShrink: 0, alignItems: 'center' }}>
                    <button onClick={() => expandObs(o.id)} style={{ background: 'none', border: 'none', color: '#1a2fcc', fontSize: 12, fontWeight: 700 }}>Avaa</button>
                    <button onClick={() => removeObs(o.id)} style={{ background: 'none', border: 'none', color: '#6670a0', fontSize: 16 }}>🗑</button>
                  </div>
                </div>
              )
            }
            return (
            <div key={o.id} style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 12, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#eef0f7', borderBottom: '1px solid #d0d5e8' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6670a0', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Havainto {idx + 1}
                  {!o.db_id && (
                    <span title="Ei vielä synkronoitu pilveen — tallessa paikallisesti" style={{ marginLeft: 6, color: '#d07800' }}>●</span>
                  )}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {o.createdAt && (
                    <span style={{ fontSize: 10, color: '#9aa2c0', fontWeight: 500 }}>
                      {new Date(o.createdAt).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                  <button onClick={() => removeObs(o.id)} style={{ background: 'none', border: 'none', color: '#6670a0', fontSize: 18 }}>🗑</button>
                </div>
              </div>

              {/* Body */}
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Category */}
                <div>
                  <div style={labelStyle}>Vika</div>
                  <select style={selectStyle} value={o.cat} onChange={e => updateObs(o.id, 'cat', e.target.value)}>
                    {CATS.map(c => <option key={c}>{c}</option>)}
                  </select>
                  {o.cat === 'Muu asia' && (
                    <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Kirjoita havainto..." value={o.muu} onChange={e => updateObs(o.id, 'muu', e.target.value)} />
                  )}
                </div>

                {/* Severity */}
                <div>
                  <div style={labelStyle}>Vakavuus</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['Kriittinen', 'Huomio', 'Info'].map(s => (
                      <button key={s} onClick={() => updateObs(o.id, 'sev', s)} style={{
                        flex: 1, padding: '8px 4px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                        border: `1px solid ${o.sev === s ? sevColor[s] : '#d0d5e8'}`,
                        background: o.sev === s ? sevBg[s] : '#eef0f7',
                        color: o.sev === s ? sevColor[s] : '#6670a0'
                      }}>{s}</button>
                    ))}
                  </div>
                </div>

                {/* Note */}
                <div>
                  <div style={labelStyle}>Lisätieto</div>
                  <textarea style={{ ...selectStyle, resize: 'none', minHeight: 56, lineHeight: 1.5 }}
                    placeholder="Tarkempi kuvaus / lisätieto..."
                    value={o.note}
                    onChange={e => updateObs(o.id, 'note', e.target.value)}
                  />
                </div>

                {/* Map */}
                {mapData && (
                  <div>
                    <div style={labelStyle}>Sijainti kartalla</div>
                    <MapView
                      mapData={mapData}
                      pin={o.pin}
                      onPin={pin => handleMapTap(o, pin)}
                      gpsCoords={gpsCoords}
                      onViewChange={view => setMapView(o.id, view)}
                    />
                    {o.pin && (() => {
                      const r = findPinRow(mapData, o.pin)
                      return r ? (
                        <div style={{ marginTop: 4, fontSize: 12, color: '#1a8a50', fontWeight: 700 }}>
                          📍 Havaittu rivi: {r.label}
                        </div>
                      ) : null
                    })()}
                    {o.pin && (
                      <div style={{ marginTop: 8 }}>
                        {quickAddId === o.id ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#eafaf0', border: '1px solid #1a8a50', borderRadius: 8, padding: '8px 10px' }}>
                            <span style={{ fontSize: 12, color: '#1a8a50', fontWeight: 700 }}>
                              📍 Pikalisäys päällä{quickAddCounts[o.id] ? ` (${quickAddCounts[o.id]} lisätty)` : ''} — napauta karttaa lisätäksesi uusia samanlaisia havaintoja
                            </span>
                            <button onClick={() => toggleQuickAdd(o.id)} style={{ background: '#1a8a50', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>Lopeta</button>
                          </div>
                        ) : (
                          <button onClick={() => toggleQuickAdd(o.id)} style={{ width: '100%', padding: 9, border: '1px dashed #1a2fcc', borderRadius: 8, background: '#fff', color: '#1a2fcc', fontSize: 12, fontWeight: 600 }}>
                            📍 Pikalisää useita samalle kartalle
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Photos */}
                <div>
                  <div style={labelStyle}>Kuvat</div>
                  <div style={{ border: '1px dashed #b0b8d8', borderRadius: 8, overflow: 'hidden' }}>
                    {o.photos.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8 }}>
                        {o.photos.map((p, pi) => (
                          <div key={pi} style={{ position: 'relative', width: 76, height: 76, borderRadius: 8, overflow: 'hidden' }}>
                            <img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                            <button onClick={() => removePhoto(o.id, pi)} style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%', width: 20, height: 20, color: '#fff', fontSize: 13 }}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <label>
                      <button onClick={e => e.currentTarget.parentElement.querySelector('input').click()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 11, color: '#6670a0', fontSize: 13, background: 'none', border: 'none', width: '100%' }}>
                        📷 Ota kuva / valitse galleriasta
                      </button>
                      <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addPhotos(o.id, e.target.files)} />
                    </label>
                  </div>
                </div>
              </div>
            </div>
            )
          })}
        </div>

        {/* Add button */}
        <div style={{ padding: '4px 16px 8px' }}>
          <button onClick={addObs} style={{ width: '100%', padding: 13, border: '1.5px dashed #b0b8d8', borderRadius: 12, background: 'none', color: '#6670a0', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            ＋ Lisää havainto
          </button>

          <button onClick={() => setAssignMode(v => !v)} style={{ width: '100%', padding: 12, border: '1px solid #d0d5e8', borderRadius: 10, background: '#fff', color: '#1a2fcc', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            👷 Lähetä asentajalle {assignMode ? '▲' : '▼'}
          </button>

          {assignMode && (
            <div style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <select value={assignInstallerId} onChange={e => { setAssignInstallerId(e.target.value); if (e.target.value) setAssignTeamId('') }} style={selectStyle}>
                <option value="">Valitse asentaja…</option>
                {installers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>

              {teams.length > 0 && (
                <>
                  <div style={{ textAlign: 'center', fontSize: 11, color: '#9aa2c0' }}>— TAI —</div>
                  <select value={assignTeamId} onChange={e => { setAssignTeamId(e.target.value); if (e.target.value) setAssignInstallerId('') }} style={selectStyle}>
                    <option value="">Valitse tiimi…</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </>
              )}

              <div style={{ display: 'flex', gap: 6 }}>
                <input placeholder="Uusi asentaja: nimi" value={newInstallerName} onChange={e => setNewInstallerName(e.target.value)}
                  style={{ ...inputStyle, flex: 2 }} />
                <input placeholder="PIN" value={newInstallerPin} onChange={e => setNewInstallerPin(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric" maxLength={6} style={{ ...inputStyle, flex: 1 }} />
                <button onClick={addInstaller} style={{ padding: '0 12px', background: '#eef0f7', border: '1px solid #d0d5e8', borderRadius: 8, color: '#1a2fcc', fontSize: 13 }}>+</button>
              </div>

              <button onClick={assignAndNotify} disabled={(!assignInstallerId && !assignTeamId) || obs.length === 0}
                style={{ padding: 12, background: (assignInstallerId || assignTeamId) ? '#1a8a50' : '#c8cce0', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 700, fontSize: 14 }}>
                📤 Lähetä {obs.length === 1 ? '1 havainto' : `${obs.length} havaintoa`}
              </button>
              {assignMsg && <div style={{ fontSize: 12, color: '#1a8a50', textAlign: 'center' }}>{assignMsg}</div>}
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', background: '#f4f6fb', borderTop: '1px solid #d0d5e8', zIndex: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px 0', fontSize: 12.5, color: '#4a5480', userSelect: 'none' }}>
          <input type="checkbox" checked={groupByCategory} onChange={e => setGroupByCategory(e.target.checked)} style={{ width: 16, height: 16 }} />
          Yhdistä samat vikatyypit samaan karttakuvaan
        </label>
        <div style={{ padding: '8px 16px env(safe-area-inset-bottom, 14px)', display: 'flex', gap: 10 }}>
          <div style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 8, padding: '0 14px', display: 'flex', alignItems: 'center', fontSize: 13, color: '#6670a0', whiteSpace: 'nowrap' }}>
            {obs.length === 1 ? '1 havainto' : `${obs.length} havaintoa`}
          </div>
          <button onClick={() => exportPDF('fi')} style={{ flex: 1, padding: 12, background: '#1a2fcc', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            📄 PDF FI
          </button>
          <button onClick={() => exportPDF('en')} style={{ flex: 1, padding: 12, background: '#fff', border: '1.5px solid #1a2fcc', borderRadius: 8, color: '#1a2fcc', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            📄 PDF EN
          </button>
        </div>
      </div>

      {/* PDF overlay */}
      {pdfMode && (
        <div style={{ position: 'fixed', inset: 0, background: '#f4f6fb', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 12px', background: '#1a2fcc' }}>
            <button onClick={() => setPdfMode(false)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: '50%', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>PDF valmis</span>
            <button onClick={sharePDF} style={{ background: '#f5a800', border: 'none', color: '#1a2fcc', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8 }}>
              {shareSupported ? '⬆ Jaa' : '⬇ Lataa PDF'}
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
            <div style={{ fontSize: 64 }}>{pdfDownloaded ? '✅' : '📄'}</div>
            {shareSupported ? (
              <p style={{ fontSize: 14, color: '#6670a0', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#0d1a6e' }}>Jaa ⬆</strong> avataksesi jakovalikon.<br />
                Valitse <strong style={{ color: '#0d1a6e' }}>WhatsApp</strong> tai <strong style={{ color: '#0d1a6e' }}>Tallenna tiedostot</strong>.
              </p>
            ) : pdfDownloaded ? (
              <p style={{ fontSize: 14, color: '#1a8a50', textAlign: 'center', lineHeight: 1.6, fontWeight: 600 }}>
                PDF ladattu koneen Lataukset-kansioon.<br />
                <span style={{ color: '#6670a0', fontWeight: 400 }}>({pdfName})</span>
              </p>
            ) : (
              <p style={{ fontSize: 14, color: '#6670a0', textAlign: 'center', lineHeight: 1.6 }}>
                Paina <strong style={{ color: '#0d1a6e' }}>Lataa PDF</strong> tallentaaksesi tiedoston koneelle.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  background: '#fff', border: '1px solid #d0d5e8', borderRadius: 8,
  color: '#0d1a6e', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none'
}

const selectStyle = {
  background: '#fff', border: '1px solid #d0d5e8', borderRadius: 8,
  color: '#0d1a6e', fontSize: 14, padding: '9px 12px', width: '100%', outline: 'none',
  WebkitAppearance: 'none', appearance: 'none'
}

const labelStyle = {
  fontSize: 11, fontWeight: 700, color: '#6670a0',
  letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5
}
