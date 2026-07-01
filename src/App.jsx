import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import MapView from './MapView.jsx'
import { parseDXF } from './dxfParser.js'
import { latLngToTM35FIN } from './coords.js'

const SUPABASE_URL = 'https://ddgsbamrafhasrtsrsyv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZ3NiYW1yYWZoYXNydHNyc3l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODU2MzUsImV4cCI6MjA5Nzg2MTYzNX0.gsbIu5yAUA_iINCGF20p4bSAWJCaEN6UXi8_OlGC3Oc'
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const CATS = [
  'Paneeli rikki', 'Paneeli väärinpäin – ylä', 'Paneeli väärinpäin – ala',
  'Paneelikiinnikkeissä rakoja', 'Kiskon pultti löysä', 'Kiskon pultti puuttuu',
  'Paneelikiinnikkeiden momentit vajaat', 'Kiskot tasaamatta', 'Niittejä puuttuu',
  'Kannake vääntynyt / rikki', 'DC-kouru katkaisematta', 'Muu asia'
]

let idCounter = 0

const KNOWN_SITES = [
  { key: 'isoneva', label: 'Isoneva, Suonenjoki' },
  { key: 'lamminneva', label: 'Lamminneva, Lappajärvi' },
]

export default function App() {
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
  const fileInputRef = useRef(null)
  const syncTimer = useRef(null)

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
      local_id: o.id
    }
    try {
      if (o.db_id) {
        await sb.from('observations').update(data).eq('id', o.db_id)
      } else {
        const { data: res } = await sb.from('observations').insert([data]).select()
        if (res?.[0]) return res[0].id
      }
      showSync('✓ Tallennettu')
    } catch { showSync('⚠ Ei yhteyttä') }
    return null
  }

  function addObs() {
    const id = ++idCounter
    setObs(prev => [...prev, { id, cat: CATS[0], sev: 'Huomio', note: '', muu: '', photos: [], pin: null, db_id: null }])
  }

  function removeObs(id) {
    setObs(prev => {
      const o = prev.find(x => x.id === id)
      if (o?.db_id) sb.from('observations').delete().eq('id', o.db_id)
      return prev.filter(x => x.id !== id)
    })
  }

  function updateObs(id, key, val) {
    setObs(prev => prev.map(o => {
      if (o.id !== id) return o
      const updated = { ...o, [key]: val }
      clearTimeout(updated._timer)
      updated._timer = setTimeout(() => saveObs(updated, site, inspector, rivi), 1200)
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

  function setMapView(id, view) {
    setObs(prev => prev.map(o => o.id !== id ? o : { ...o, mapView: view }))
  }

  function addPhotos(id, files) {
    Array.from(files).forEach(file => {
      const reader = new FileReader()
      reader.onload = e => {
        setObs(prev => prev.map(o => {
          if (o.id !== id) return o
          return { ...o, photos: [...o.photos, { src: e.target.result }] }
        }))
      }
      reader.readAsDataURL(file)
    })
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
  async function exportPDF() {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ unit: 'mm', format: 'a4' })
    const W = 210, M = 14, CW = W - M * 2
    let y = 18
    const dateStr = new Date().toLocaleDateString('fi-FI')

    doc.setFillColor(26, 47, 204)
    doc.rect(0, 0, W, 28, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(245, 168, 0)
    doc.text('WISOL OY', M, 12)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(255, 255, 255)
    doc.text('Laadunvalvontaraportti', M, 19)
    doc.setFontSize(9); doc.setTextColor(180, 200, 255)
    doc.text(dateStr, W - M, 12, { align: 'right' })
    y = 38

    const meta = [['Työmaa', site || '–'], ['Tarkastaja', inspector || '–'], ['Rivi / alue', rivi || '–']]
    meta.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 100, 120); doc.text(k, M, y)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(20, 20, 60); doc.text(v, M + 28, y)
      y += 6
    })
    y += 4; doc.setDrawColor(200, 205, 220); doc.line(M, y, W - M, y); y += 8

    const sevCol = { 'Kriittinen': [180, 40, 40], 'Huomio': [180, 120, 0], 'Info': [30, 140, 80] }

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]
      if (i > 0) { doc.addPage(); y = 18 }
      const lbl = o.cat === 'Muu asia' && o.muu ? `Muu – ${o.muu}` : o.cat
      const col = sevCol[o.sev] || [80, 80, 80]
      doc.setFillColor(...col)
      doc.roundedRect(M, y, CW, 7, 1.5, 1.5, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255)
      doc.text(`${i + 1}.  ${lbl}`, M + 4, y + 5)
      doc.text(o.sev, W - M - 4, y + 5, { align: 'right' })
      y += 10

      if (o.note) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(40, 40, 40)
        const lines = doc.splitTextToSize(o.note, CW - 4)
        doc.text(lines, M + 2, y); y += lines.length * 5 + 3
      }

      // Map thumbnail - shows exactly the zoomed view from the app
      if (o.pin && mapData) {
        if (y + 68 > 278) { doc.addPage(); y = 18 }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(100, 100, 120)
        doc.text('Sijainti kartalla:', M + 2, y); y += 4
        try {
          // Render full map to canvas at high res
          const mapW = 1800, mapH = Math.round(mapData.H / mapData.W * 1800)
          const mapCanvas = document.createElement('canvas')
          mapCanvas.width = mapW; mapCanvas.height = mapH
          const mctx = mapCanvas.getContext('2d')
          mctx.fillStyle = '#eef4ec'; mctx.fillRect(0, 0, mapW, mapH)
          const scx = mapW / mapData.W, scy = mapH / mapData.H

          mctx.fillStyle = 'rgba(200,223,245,0.85)'; mctx.strokeStyle = '#4a90d9'; mctx.lineWidth = 1.5
          mapData.pvAreas.forEach(pts => {
            mctx.beginPath(); pts.forEach(([x,y2],i) => i===0 ? mctx.moveTo(x*scx,y2*scy) : mctx.lineTo(x*scx,y2*scy))
            mctx.closePath(); mctx.fill(); mctx.stroke()
          })
          mctx.fillStyle = 'rgba(26,47,204,0.22)'; mctx.strokeStyle = '#1a2fcc'; mctx.lineWidth = 0.8
          const PANEL_W = 1.15, TABLE_D = 4.29
          const sxm = mapData.W / (mapData.maxX - mapData.minX)
          const sym = mapData.H / (mapData.maxY - mapData.minY)
          mapData.inserts.forEach(ins => {
            const tw = ins.panels * PANEL_W * sxm * scx
            const th = TABLE_D * sym * scy
            mctx.fillRect(ins.x*scx, ins.y*scy, tw, th)
            mctx.strokeRect(ins.x*scx, ins.y*scy, tw, th)
          })
          mctx.font = 'bold 11px sans-serif'; mctx.textAlign = 'center'
          mapData.rowNumbers.forEach(t => {
            mctx.fillStyle = 'rgba(255,255,255,0.75)'
            mctx.fillRect(t.x*scx-9, t.y*scy-8, 18, 11)
            mctx.fillStyle = '#0d1a6e'
            mctx.fillText(t.text, t.x*scx, t.y*scy+2)
          })
          // Draw pin
          const pinX = o.pin.x * mapW, pinY = o.pin.y * mapH
          mctx.beginPath(); mctx.arc(pinX, pinY, 14, 0, Math.PI*2)
          mctx.fillStyle = '#d63030'; mctx.fill()
          mctx.strokeStyle = 'white'; mctx.lineWidth = 3.5; mctx.stroke()

          // Determine crop area from saved mapView (zoom/pan state).
          // containerW/containerH come from the actual on-screen map element
          // at the moment the view last changed — this varies by device width,
          // so we no longer assume a fixed size.
          const view = o.mapView || { scale: 1, tx: 0, ty: 0, containerW: 360, containerH: 240 }
          const containerW = view.containerW || 360, containerH = view.containerH || 240
          // What portion of the SVG (W×H) was visible in the container?
          // visible SVG region: x = (-view.tx)/view.scale to (containerW - view.tx)/view.scale
          const visX1 = Math.max(0, (-view.tx) / view.scale)
          const visY1 = Math.max(0, (-view.ty) / view.scale)
          const visX2 = Math.min(mapData.W, (containerW - view.tx) / view.scale)
          const visY2 = Math.min(mapData.H, (containerH - view.ty) / view.scale)
          // Convert to canvas pixels
          const cx1 = visX1 * scx, cy1 = visY1 * scy
          const cx2 = visX2 * scx, cy2 = visY2 * scy
          const cropW = Math.max(1, cx2 - cx1), cropH = Math.max(1, cy2 - cy1)

          const cropCanvas = document.createElement('canvas')
          cropCanvas.width = Math.round(cropW); cropCanvas.height = Math.round(cropH)
          cropCanvas.getContext('2d').drawImage(mapCanvas, cx1, cy1, cropW, cropH, 0, 0, cropW, cropH)

          // Fit crop into 90mm wide space keeping aspect ratio, max 70mm tall
          const pdfW = 90, pdfH = Math.min(70, pdfW * cropH / cropW)
          const cropImg = cropCanvas.toDataURL('image/jpeg', 0.92)
          if (y + pdfH > 278) { doc.addPage(); y = 18 }
          doc.addImage(cropImg, 'JPEG', M, y, pdfW, pdfH)
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
        const sc = Math.min(CW / nw, 150 / nh)
        const dw = nw * sc, dh = nh * sc
        if (y + dh > 278) { doc.addPage(); y = 18 }
        try { doc.addImage(corrected, 'JPEG', M, y, dw, dh) } catch {}
        y += dh + 4
      }
    }

    const tp = doc.getNumberOfPages()
    for (let p = 1; p <= tp; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160, 160, 160)
      doc.text(`Wisol Oy · QC-raportti · ${dateStr}`, M, 292)
      doc.text(`${p} / ${tp}`, W - M, 292, { align: 'right' })
    }

    const blob = doc.output('blob')
    const fn = `QC_${(site || 'työmaa').replace(/\s+/g, '_')}_${dateStr.replace(/\./g, '-')}.pdf`
    setPdfBlob(blob); setPdfName(fn); setPdfMode(true)
  }

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
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {syncMsg && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>{syncMsg}</span>}
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>Vikalista</span>
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

          {obs.map((o, idx) => (
            <div key={o.id} style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 12, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#eef0f7', borderBottom: '1px solid #d0d5e8' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6670a0', letterSpacing: 0.5, textTransform: 'uppercase' }}>Havainto {idx + 1}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                      onPin={pin => setPin(o.id, pin)}
                      gpsCoords={gpsCoords}
                      onViewChange={view => setMapView(o.id, view)}
                    />
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
          ))}
        </div>

        {/* Add button */}
        <div style={{ padding: '4px 16px 8px' }}>
          <button onClick={addObs} style={{ width: '100%', padding: 13, border: '1.5px dashed #b0b8d8', borderRadius: 12, background: 'none', color: '#6670a0', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            ＋ Lisää havainto
          </button>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', padding: '10px 16px env(safe-area-inset-bottom, 14px)', background: '#f4f6fb', borderTop: '1px solid #d0d5e8', display: 'flex', gap: 10, zIndex: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #d0d5e8', borderRadius: 8, padding: '0 14px', display: 'flex', alignItems: 'center', fontSize: 13, color: '#6670a0', whiteSpace: 'nowrap' }}>
          {obs.length === 1 ? '1 havainto' : `${obs.length} havaintoa`}
        </div>
        <button onClick={exportPDF} style={{ flex: 1, padding: 13, background: '#1a2fcc', border: 'none', borderRadius: 8, color: '#fff', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          📄 Luo PDF
        </button>
      </div>

      {/* PDF overlay */}
      {pdfMode && (
        <div style={{ position: 'fixed', inset: 0, background: '#f4f6fb', zIndex: 100, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'env(safe-area-inset-top, 12px) 16px 12px', background: '#1a2fcc' }}>
            <button onClick={() => setPdfMode(false)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: '50%', fontSize: 18 }}>✕</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>PDF valmis</span>
            <button onClick={sharePDF} style={{ background: '#f5a800', border: 'none', color: '#1a2fcc', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8 }}>⬆ Jaa</button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32 }}>
            <div style={{ fontSize: 64 }}>📄</div>
            <p style={{ fontSize: 14, color: '#6670a0', textAlign: 'center', lineHeight: 1.6 }}>
              Paina <strong style={{ color: '#0d1a6e' }}>Jaa ⬆</strong> avataksesi iOS-jakovalikon.<br />
              Valitse <strong style={{ color: '#0d1a6e' }}>WhatsApp</strong> tai <strong style={{ color: '#0d1a6e' }}>Tallenna tiedostot</strong>.
            </p>
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
