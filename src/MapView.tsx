import React, { useRef, useEffect, useState, useCallback } from 'react'

const PANEL_W_M = 1.15   // meters per panel (width along X)
const TABLE_DEPTH_M = 4.29  // meters deep (Y direction, always fixed)

// HUOM: käytetään SAMAA tyhjää taulukkoa oletusarvona joka renderöinnillä.
// Jos oletusarvo olisi kirjoitettu suoraan `focusPins = []` parametrina,
// JavaScript loisi UUDEN taulukko-olion joka ikinen renderöinti — vaikka
// sisältö on aina tyhjä, olion REFERENSSI muuttuu, mikä sai alla olevan
// useEffect-riippuvuuslistan [W, H, focusPins] laukeamaan uudelleen JOKA
// renderöinnillä. Se puolestaan resetoi näkymän takaisin alkuperäiseksi
// välittömästi käyttäjän oman panoroinnin/zoomauksen jälkeen, jolloin
// karttaa ei voinut enää liikuttaa itse ollenkaan.
const EMPTY_PINS = []

export default function MapView({ mapData, pin, onPin, gpsCoords, height = 240, readOnly = false, extraPins = EMPTY_PINS, onViewChange, focusPins = EMPTY_PINS }) {
  const containerRef = useRef(null)
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 })
  const stateRef = useRef({ scale: 1, tx: 0, ty: 0 })
  const autoCenteredRef = useRef(false) // estää GPS-keskityksen toistumisen/ohittamisen käyttäjän oman panoroinnin jälkeen

  const { W, H, pvAreas, roads, boundaries, inserts, rowNumbers, minX, minY, maxX, maxY } = mapData

  // Sovittaa näkymän annettujen pisteiden (normalisoitu 0..1) ympärille,
  // reilulla marginaalilla — käytetään sekä asentajan yleiskartan
  // "kohdista vikojen alueeseen" -toiminnossa (focusPins) että se on
  // yleiskäyttöinen apu jota voi hyödyntää muuallakin jatkossa.
  function fitToPoints(points, cw, ch) {
    const xs = points.map(p => p.x * W), ys = points.map(p => p.y * H)
    const minPX = Math.min(...xs), maxPX = Math.max(...xs)
    const minPY = Math.min(...ys), maxPY = Math.max(...ys)
    const w = Math.max(1, maxPX - minPX), h = Math.max(1, maxPY - minPY)
    // Kiinteä minimimarginaali (esim. yhden pisteen tapaus, w/h≈0) plus
    // suhteellinen marginaali isommille alueille.
    const padX = Math.max(40, w * 0.35), padY = Math.max(40, h * 0.35)
    const bw = w + 2 * padX, bh = h + 2 * padY
    const scale = Math.min(8, Math.max(0.3, Math.min(cw / bw, ch / bh)))
    const cx = (minPX + maxPX) / 2, cy = (minPY + maxPY) / 2
    return { scale, tx: cw / 2 - cx * scale, ty: ch / 2 - cy * scale }
  }

  // Init: fit map in container — joko koko työmaan mukaan (oletus) tai
  // focusPins-pisteiden ympärille (asentajan yleiskartta, "kohdista
  // vikojen alueeseen" jottei tarvitse itse zoomata koko työmaasta).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth, ch = el.clientHeight
    let s
    if (focusPins.length > 0) {
      s = fitToPoints(focusPins, cw, ch)
    } else {
      const scale = Math.min(cw / W, ch / H) * 0.95
      s = { scale, tx: (cw - W * scale) / 2, ty: (ch - H * scale) / 2 }
    }
    stateRef.current = s
    setTransform(s)
    // PDF:n yksittäiskartturi (App.jsx) lukee o.mapView.containerW/H, joten
    // välitetään myös kontin mitat, ei pelkkää scale/tx/ty:tä.
    if (onViewChange) onViewChange({ ...s, containerW: cw, containerH: ch })
  }, [W, H, focusPins])

  // Kertaluontoinen GPS-keskitys UUDELLE (pin=null) havainnolle — ilman
  // tätä työnjohtaja joutui aina zoomailemaan/etsimään itsensä koko
  // työmaan kartalta. Kun GPS-sijainti ensimmäisen kerran saadaan, ja
  // havainnolla ei vielä ole pinniä eikä focusPins-tilaa ole käytössä
  // (silloin alustus hoiti jo kohdistuksen), keskitetään näkymä lähelle
  // omaa sijaintia kohtuullisen läheisellä zoomilla. Tämä tapahtuu vain
  // KERRAN (autoCenteredRef) — ei väkisin vedä näkymää takaisin jos
  // käyttäjä on jo ehtinyt itse panoroida/zoomata (merkitään "käytetyksi"
  // myös manuaalisen vuorovaikutuksen alkaessa, ks. alempana).
  useEffect(() => {
    if (autoCenteredRef.current || pin || focusPins.length > 0 || !gpsCoords) return
    const el = containerRef.current
    if (!el) return
    autoCenteredRef.current = true
    const cw = el.clientWidth, ch = el.clientHeight
    const scale = Math.min(8, Math.max(1.5, Math.min(cw / W, ch / H) * 5))
    const gx = gpsCoords.x * W, gy = gpsCoords.y * H
    const s = clamp({ scale, tx: cw / 2 - gx * scale, ty: ch / 2 - gy * scale })
    stateRef.current = s
    setTransform(s)
    if (onViewChange) onViewChange({ ...s, containerW: cw, containerH: ch })
  }, [gpsCoords, pin])

  const applyTransform = useCallback((s) => {
    stateRef.current = s
    setTransform({ ...s })
    if (onViewChange) {
      const el = containerRef.current
      onViewChange({ ...s, containerW: el?.clientWidth, containerH: el?.clientHeight })
    }
  }, [onViewChange])

  const clamp = useCallback((s) => {
    const el = containerRef.current
    if (!el) return s
    const cw = el.clientWidth, ch = el.clientHeight
    const iw = W * s.scale, ih = H * s.scale
    let tx = s.tx, ty = s.ty
    if (iw > cw) { tx = Math.min(0, Math.max(cw - iw, tx)) }
    else { tx = (cw - iw) / 2 }
    if (ih > ch) { ty = Math.min(0, Math.max(ch - ih, ty)) }
    else { ty = (ch - ih) / 2 }
    return { ...s, tx, ty }
  }, [W, H])

  // Touch handling
  const touchRef = useRef(null)

  const onTouchStart = useCallback((e) => {
    e.preventDefault()
    autoCenteredRef.current = true // käyttäjä koski karttaa itse — GPS-autokeskitys ei saa enää yrittää vetää näkymää
    const s = stateRef.current
    if (e.touches.length === 1) {
      touchRef.current = {
        type: 'pan', moved: false,
        startX: e.touches[0].clientX, startY: e.touches[0].clientY,
        tx: s.tx, ty: s.ty
      }
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      touchRef.current = {
        type: 'pinch',
        dist: Math.hypot(dx, dy),
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        scale: s.scale, tx: s.tx, ty: s.ty
      }
    }
  }, [])

  const onTouchMove = useCallback((e) => {
    e.preventDefault()
    const t = touchRef.current
    const s = stateRef.current
    if (!t) return

    if (e.touches.length === 1 && t.type === 'pan') {
      const dx = e.touches[0].clientX - t.startX
      const dy = e.touches[0].clientY - t.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) t.moved = true
      applyTransform(clamp({ scale: s.scale, tx: t.tx + dx, ty: t.ty + dy }))
    } else if (e.touches.length === 2 && t.type === 'pinch') {
      const dx = e.touches[1].clientX - e.touches[0].clientX
      const dy = e.touches[1].clientY - e.touches[0].clientY
      const dist = Math.hypot(dx, dy)
      const newScale = Math.min(8, Math.max(0.1, t.scale * (dist / t.dist)))
      const rect = containerRef.current.getBoundingClientRect()
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      applyTransform(clamp({
        scale: newScale,
        tx: midX - (midX - t.tx) * (newScale / t.scale),
        ty: midY - (midY - t.ty) * (newScale / t.scale)
      }))
    }
  }, [applyTransform, clamp])

  const onTouchEnd = useCallback((e) => {
    e.preventDefault()
    const t = touchRef.current
    const s = stateRef.current
    if (t?.type === 'pan' && !t.moved && e.changedTouches.length === 1) {
      const rect = containerRef.current.getBoundingClientRect()
      const cx = e.changedTouches[0].clientX - rect.left
      const cy = e.changedTouches[0].clientY - rect.top
      const mapX = (cx - s.tx) / s.scale / W
      const mapY = (cy - s.ty) / s.scale / H
      onPin({ x: Math.max(0, Math.min(1, mapX)), y: Math.max(0, Math.min(1, mapY)) })
    }
    touchRef.current = null
  }, [W, H, onPin])

  // Desktop click
  const onClick = useCallback((e) => {
    if (e.target.tagName === 'BUTTON') return
    const rect = containerRef.current.getBoundingClientRect()
    const s = stateRef.current
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const mapX = (cx - s.tx) / s.scale / W
    const mapY = (cy - s.ty) / s.scale / H
    onPin({ x: Math.max(0, Math.min(1, mapX)), y: Math.max(0, Math.min(1, mapY)) })
  }, [W, H, onPin])

  // --- Desktop mouse drag-to-pan ---
  const mouseRef = useRef(null)

  const onMouseDown = useCallback((e) => {
    if (e.target.tagName === 'BUTTON') return
    autoCenteredRef.current = true
    const s = stateRef.current
    mouseRef.current = { startX: e.clientX, startY: e.clientY, tx: s.tx, ty: s.ty, moved: false }
  }, [])

  const onMouseMove = useCallback((e) => {
    const m = mouseRef.current
    if (!m) return
    const dx = e.clientX - m.startX
    const dy = e.clientY - m.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) m.moved = true
    if (m.moved) {
      const s = stateRef.current
      applyTransform(clamp({ scale: s.scale, tx: m.tx + dx, ty: m.ty + dy }))
    }
  }, [applyTransform, clamp])

  const onMouseUp = useCallback((e) => {
    const m = mouseRef.current
    if (m && !m.moved) {
      // Treat as a click — place pin
      onClick(e)
    }
    mouseRef.current = null
  }, [onClick])

  const onMouseLeave = useCallback(() => {
    mouseRef.current = null
  }, [])

  // --- Desktop scroll wheel zoom ---
  const onWheel = useCallback((e) => {
    e.preventDefault()
    autoCenteredRef.current = true
    const el = containerRef.current
    if (!el) return
    const s = stateRef.current
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.15 : 0.87
    const newScale = Math.min(8, Math.max(0.1, s.scale * factor))
    applyTransform(clamp({
      scale: newScale,
      tx: cx - (cx - s.tx) * (newScale / s.scale),
      ty: cy - (cy - s.ty) * (newScale / s.scale)
    }))
  }, [applyTransform, clamp])

  const zoom = useCallback((factor) => {
    const el = containerRef.current
    if (!el) return
    const s = stateRef.current
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2
    const newScale = Math.min(8, Math.max(0.1, s.scale * factor))
    applyTransform(clamp({
      scale: newScale,
      tx: cx - (cx - s.tx) * (newScale / s.scale),
      ty: cy - (cy - s.ty) * (newScale / s.scale)
    }))
  }, [applyTransform, clamp])

  // Compute GPS dot position
  const gpsDot = gpsCoords ? {
    x: gpsCoords.x * W * transform.scale + transform.tx,
    y: gpsCoords.y * H * transform.scale + transform.ty
  } : null

  const pinDot = pin ? {
    x: pin.x * W * transform.scale + transform.tx,
    y: pin.y * H * transform.scale + transform.ty
  } : null

  const extraDots = extraPins.filter(Boolean).map(p => ({
    x: p.x * W * transform.scale + transform.tx,
    y: p.y * H * transform.scale + transform.ty
  }))

  // Rivinumerot lasketaan RUUTUPIKSELEINÄ (samaan tapaan kuin gpsDot/pinDot
  // yllä), EI SVG:n sisäisenä fontSize-arvona. Tämä on toinen kierros
  // samaan ongelmaan: "yksinkertainen" scaledFontSize = 10/scale -kaava
  // NÄYTTI toimivan yhdessä tietyssä zoomitilanteessa (referenssikuva),
  // mutta se on täsmälleen se alkuperäinen bugi josta koko tämä korjaus-
  // sarja lähti liikkeelle — lähelle zoomatessa (scale iso) paikallinen
  // arvo menee pieneksi mutta SVG:n oma CSS-skaalaus (scale(transform.scale))
  // kertoo sen takaisin isoksi, ja numerot paisuvat jättimäisiksi ja
  // menevät päällekkäin. Kun laatikko lasketaan suoraan lopulliseksi
  // ruutupikseliksi (kuten pin/GPS-pisteet), koko pysyy AINA samana
  // riippumatta zoomista — ei voi koskaan mennä liian isoksi eikä liian
  // pieneksi, riippumatta miten kauas tai lähelle zoomataan.
  const rowLabelDots = rowNumbers.map(t => ({
    x: t.x * transform.scale + transform.tx,
    y: t.y * transform.scale + transform.ty,
    text: t.text,
  }))
  // Päällekkäisyyssuoja — kun kaukaa zoomatessa satoja kiinteän kokoisia
  // lappuja ajautuu lähelle toisiaan, ne muuttuvat luettavan numeron
  // sijaan tiheäksi "kohinakuvioksi". Koska sijainnit ovat jo tässä
  // vaiheessa LOPULLISIA ruutupikseleitä, päällekkäisyys voidaan
  // tarkistaa suoraan ja luotettavasti: piilotetaan vain ne yksittäiset
  // laput jotka oikeasti osuisivat kiinni jo näytettäväksi valittuun
  // naapuriinsa — rivit joilla on tilaa näkyvät aina normaalisti.
  const visibleRowLabelDots = (() => {
    const sorted = [...rowLabelDots].sort((a, b) => (a.y - b.y) || (a.x - b.x))
    const kept = []
    for (const d of sorted) {
      const overlaps = kept.some(k => Math.abs(d.x - k.x) < 26 && Math.abs(d.y - k.y) < 16)
      if (!overlaps) kept.push(d)
    }
    return kept
  })()
  const strokeW = Math.max(0.3, 1 / transform.scale)

  return (
    <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#eef4ec', height: typeof height === 'string' ? '100%' : undefined, display: typeof height === 'string' ? 'flex' : undefined, flexDirection: typeof height === 'string' ? 'column' : undefined }}>
      <div
        ref={containerRef}
        style={{ height, flex: typeof height === 'string' ? 1 : undefined, position: 'relative', overflow: 'hidden', touchAction: 'none', userSelect: 'none', cursor: 'grab' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
      >
        {/* SVG Map */}
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          style={{
            position: 'absolute',
            transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
            willChange: 'transform'
          }}
        >
          <rect width={W} height={H} fill="#eef4ec" />

          {/* PV areas */}
          {pvAreas.map((pts, i) => (
            <polygon
              key={`pv${i}`}
              points={pts.map(p => p.join(',')).join(' ')}
              fill="#c8dff5"
              stroke="#4a90d9"
              strokeWidth={strokeW}
              opacity={0.8}
            />
          ))}

          {/* Roads */}
          {roads.map((pts, i) => (
            <polyline
              key={`r${i}`}
              points={pts.map(p => p.join(',')).join(' ')}
              fill="none"
              stroke="#c8a000"
              strokeWidth={strokeW * 2}
              opacity={0.9}
            />
          ))}

          {/* Boundaries */}
          {boundaries.map((pts, i) => (
            <polygon
              key={`b${i}`}
              points={pts.map(p => p.join(',')).join(' ')}
              fill="none"
              stroke="#8B4513"
              strokeWidth={strokeW * 1.5}
            />
          ))}

          {/* Panel tables: width = panels × 1.15m along X, depth = 4.29m along Y */}
          {inserts.map((ins, i) => {
            const scaleXm = W / (maxX - minX)
            const scaleYm = H / (maxY - minY)
            const tw = ins.panels * PANEL_W_M * scaleXm
            const th = TABLE_DEPTH_M * scaleYm
            // HUOM: block-nimen "@30DEG" on paneelin ASENNUS-/KALLISTUSKULMA
            // (kuinka jyrkässä kulmassa paneeli on aurinkoon nähden), EI
            // pöydän kiertoa pohjapiirroksen X/Y-tasossa. Tämä tulkittiin
            // aiemmin virheellisesti tasokierroksi, mikä siirsi/limitti
            // pöytiä väärin — siksi ins.rot:ia EI käytetä piirrossa.
            return (
              <rect
                key={`ins${i}`}
                x={ins.x}
                y={ins.y}
                width={tw}
                height={th}
                fill="#1a2fcc"
                fillOpacity={0.32}
                stroke="#1a2fcc"
                strokeWidth={strokeW * 0.5}
              />
            )
          })}

        </svg>

        {/* Row number labels — HTML-elementteinä, kiinteä CSS-pikselikoko.
            EI koskaan SVG:n sisällä, jotta koko pysyy aina samana zoomista
            riippumatta (ks. rowLabelDots-laskennan selitys yllä). */}
        {visibleRowLabelDots.map((d, i) => (
          <div
            key={`rl${i}`}
            style={{
              position: 'absolute', left: d.x, top: d.y,
              transform: 'translate(-50%,-50%)',
              background: 'rgba(255,255,255,0.85)',
              color: '#0d1a6e',
              fontFamily: 'sans-serif', fontWeight: 700, fontSize: 12,
              padding: '1px 4px', borderRadius: 3,
              pointerEvents: 'none', whiteSpace: 'nowrap',
              lineHeight: 1.3,
            }}
          >
            {d.text}
          </div>
        ))}

        {/* GPS dot overlay */}
        {gpsDot && (
          <>
            <div style={{
              position: 'absolute', left: gpsDot.x, top: gpsDot.y,
              width: 28, height: 28, borderRadius: '50%',
              background: 'rgba(26,47,204,0.15)',
              transform: 'translate(-50%,-50%)',
              pointerEvents: 'none'
            }} />
            <div style={{
              position: 'absolute', left: gpsDot.x, top: gpsDot.y,
              width: 13, height: 13, borderRadius: '50%',
              background: '#1a2fcc', border: '2.5px solid white',
              boxShadow: '0 1px 5px rgba(0,0,0,0.3)',
              transform: 'translate(-50%,-50%)',
              pointerEvents: 'none'
            }} />
          </>
        )}

        {/* Pikalisäyksessä jo lisätyt havainnot — pienempinä oransseina
            pisteinä, jotta näkee millä kohtaa on jo käynyt, ilman että ne
            sekoittuvat itse aktiiviseen (punaiseen) pinniin */}
        {extraDots.map((d, i) => (
          <div key={i} style={{
            position: 'absolute', left: d.x, top: d.y,
            width: 11, height: 11, borderRadius: '50%',
            background: '#e8890c', border: '2px solid white',
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
            transform: 'translate(-50%,-50%)',
            pointerEvents: 'none', zIndex: 4
          }} />
        ))}

        {/* Pin dot overlay */}
        {pinDot && (
          <div style={{
            position: 'absolute', left: pinDot.x, top: pinDot.y,
            width: 15, height: 15, borderRadius: '50%',
            background: '#d63030', border: '2.5px solid white',
            boxShadow: '0 1px 5px rgba(0,0,0,0.4)',
            transform: 'translate(-50%,-50%)',
            pointerEvents: 'none', zIndex: 5
          }} />
        )}

        {/* Zoom buttons */}
        <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10 }}>
          <button onClick={(e) => { e.stopPropagation(); zoom(1.5) }} style={zoomBtnStyle}>+</button>
          <button onClick={(e) => { e.stopPropagation(); zoom(0.67) }} style={zoomBtnStyle}>−</button>
        </div>
      </div>

      {/* Bottom bar */}
      {!readOnly && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 10px', background: '#eef0f7', borderTop: '0.5px solid #d0d5e8' }}>
          <span style={{ fontSize: 11, color: '#6670a0' }}>🔵 GPS · Napauta = punainen piste</span>
          <button onClick={() => onPin(null)} style={{ background: 'none', border: 'none', fontSize: 11, color: '#d63030', padding: '2px 0' }}>Poista</button>
        </div>
      )}
    </div>
  )
}

const zoomBtnStyle = {
  width: 32, height: 32,
  background: 'rgba(255,255,255,0.92)',
  border: '1px solid #ccc',
  borderRadius: 7,
  fontSize: 20, fontWeight: 600,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#333'
}
