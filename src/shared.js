// src/shared.js
// Yhteiset vakiot ja apufunktiot App.jsx:n (työnjohtaja) ja InstallerView.jsx:n
// (asentaja) välillä — tässä tiedostossa jotta kumpikaan ei tuo toistaan
// suoraan (circular import -riski build-vaiheessa).

export const PANEL_W_M = 1.15
export const TABLE_DEPTH_M = 4.29

export const KNOWN_SITES = [
  { key: 'isoneva', label: 'Isoneva, Suonenjoki' },
  { key: 'lamminneva', label: 'Lamminneva, Lappajärvi' },
]

// Englanninkieliset käännökset (PDF + asentajanäkymä). Tallennetut arvot
// (o.cat, o.sev) pysyvät suomeksi Supabasessa — vain näyttöteksti vaihtuu.
export const CAT_EN = {
  'Paneeli rikkoutunut': 'Panel broken',
  'Paneeli väärinpäin, yläreuna': 'Panel upside down – top edge',
  'Paneeli väärinpäin, alareuna': 'Panel upside down – bottom edge',
  'Paneelikiinnikkeissä rakoja': 'Gaps in panel clamps',
  'Kiskon pultti löysällä': 'Rail bolt loose',
  'Kiskon pultti puuttuu': 'Rail bolt missing',
  'Paneelikiinnikkeiden kiristysmomentit vajaat': 'Panel clamp torque insufficient',
  'Kiskot tasaamatta': 'Rails not aligned',
  'Niittejä puuttuu': 'Rivets missing',
  'Kannake vääntynyt tai rikki': 'Bracket bent or broken',
  'DC-kouru katkaisematta': 'DC conduit not cut open',
  'Tupla poraruuvit puuttuvat': 'Double drill screws missing',
  'Muu asia': 'Other',
}
export const SEV_EN = { Kriittinen: 'Critical', Huomio: 'Attention', Info: 'Info' }

export const PDF_STR = {
  fi: {
    title: 'Laadunvalvontaraportti', site: 'Työmaa', inspector: 'Tarkastaja', rivi: 'Rivi / alue',
    location: 'Sijainti kartalla:', row: 'rivi', other: 'Muu', footer: 'QC-raportti', dateLocale: 'fi-FI',
  },
  en: {
    title: 'Quality Control Report', site: 'Site', inspector: 'Inspector', rivi: 'Row / area',
    location: 'Location on map:', row: 'row', other: 'Other', footer: 'QC Report', dateLocale: 'en-GB',
  },
}

// Given mapData and a normalized pin ({x,y} as 0..1 fractions of mapData.W/H),
// find which row the pin lands in and the nearest row-number label.
//
// HUOM: yksi "rivi" koostuu kartalla useasta erillisestä INSERT-lohkosta
// (paneelipöydästä) peräkkäin samalla korkeudella, ja rivinumero on
// merkitty vain rivin oikeaan päähän. Siksi emme voi laskea kohdepistettä
// pelkän löydetyn yksittäisen lohkon reunasta — jos pinni osuu rivin
// vasempaan/keskimmäiseen lohkoon, se piste voi olla geometrisesti
// lähempänä jonkun ihan toisen rivin numerolappua (varsinkin Road 03
// -viistoviivan lähellä, jossa kaksi eri numerosarjaa ovat lähekkäin).
// Korjaus: ryhmitellään ensin samalla Y-korkeudella (± toleranssi) olevat
// insertit yhdeksi loogiseksi riviksi, käytetään koko rivin oikeaa reunaa
// kohdepisteenä, ja rajataan labelhaku saman Y-kaistan sisälle + asetetaan
// maksimietäisyys jottei koskaan arvata väärää kaukaista numeroa.
export function findPinRow(mapData, pin) {
  if (!mapData || !pin || !mapData.inserts?.length) return null
  const sxm = mapData.W / (mapData.maxX - mapData.minX)
  const sym = mapData.H / (mapData.maxY - mapData.minY)
  const psx = pin.x * mapData.W, psy = pin.y * mapData.H
  const th = TABLE_DEPTH_M * sym

  // 1. Etsi insert-lohko johon pinni osuu
  let hitIdx = -1
  mapData.inserts.forEach((ins, idx) => {
    const tw = ins.panels * PANEL_W_M * sxm
    if (psx >= ins.x - 3 && psx <= ins.x + tw + 3 && psy >= ins.y - 3 && psy <= ins.y + th + 3) hitIdx = idx
  })
  if (hitIdx < 0) return null
  const hit = mapData.inserts[hitIdx]

  // 2. Kerää kaikki insertit jotka ovat samalla Y-korkeudella (sama looginen rivi).
  //    Toleranssi puolet pöydän syvyydestä — sama rivi ei yleensä poikkea tätä enempää.
  const yTol = th * 0.6
  const rowInserts = mapData.inserts.filter(ins => Math.abs(ins.y - hit.y) <= yTol)

  // 3. Koko rivin oikea reuna = suurin (ins.x + leveys) kaikista saman rivin lohkoista
  let rowRightX = -Infinity
  rowInserts.forEach(ins => {
    const right = ins.x + ins.panels * PANEL_W_M * sxm
    if (right > rowRightX) rowRightX = right
  })
  const targetX = rowRightX
  const targetY = hit.y + th / 2

  // 4. Etsi lähin numerolappu VAIN saman Y-kaistan sisältä, ja hylkää jos
  //    lähinkin on epäuskottavan kaukana (esim. toiselta puolelta karttaa).
  const maxLabelDist = th * 4 // n. rivin syvyyden nelinkertainen etäisyys riittää kattamaan reunan epätarkkuudet
  let best = Infinity, label = null
  mapData.rowNumbers.forEach(t => {
    if (Math.abs(t.y - targetY) > yTol * 1.5) return // eri Y-kaista → ei voi olla saman rivin numero
    const d = Math.hypot(t.x - targetX, t.y - targetY)
    if (d < best) { best = d; label = t.text }
  })
  if (!label || best > maxLabelDist) return null

  // Palautetaan myös koko rivin kaikkien lohkojen indeksit — näitä tarvitaan
  // kun halutaan korostaa/rajata koko rivi eikä vain sitä yhtä lohkoa johon
  // pinni sattui osumaan (esim. PDF:n karttakuvassa ja usean pinnin
  // yhteiskartassa).
  const rowInsertIdxs = []
  mapData.inserts.forEach((ins, idx) => {
    if (Math.abs(ins.y - hit.y) <= yTol) rowInsertIdxs.push(idx)
  })

  return { rowIdx: hitIdx, label, rowInsertIdxs }
}

// Renders a small, STATIC (non-interactive) map snapshot cropped around a
// single pin, as a JPEG data URL. Used by InstallerView instead of the full
// interactive <MapView> component for each task in the list — with many
// open tasks (dozens), mounting one full interactive SVG map (touch/mouse
// handlers, full DXF geometry) per task was heavy enough to crash mobile
// Safari ("Toistuva ongelma verkkosivulla"). A plain <img> from a cached
// canvas snapshot is dramatically cheaper: no event listeners, no live SVG
// DOM per task, and it can be computed once and memoized.
export function renderPinMapThumb(mapData, pin, outW = 700) {
  const sxm = mapData.W / (mapData.maxX - mapData.minX)
  const sym = mapData.H / (mapData.maxY - mapData.minY)
  const th = TABLE_DEPTH_M * sym

  const psx = pin.x * mapData.W, psy = pin.y * mapData.H
  const info = findPinRow(mapData, pin)

  // Crop tightly around the pin — a handful of row-depths in each
  // direction is enough context without dragging in the whole site.
  const pad = th * 3.5
  const svgX0 = Math.max(0, psx - pad * 1.8), svgX1 = Math.min(mapData.W, psx + pad * 1.8)
  const svgY0 = Math.max(0, psy - pad), svgY1 = Math.min(mapData.H, psy + pad)
  const svgCropW = Math.max(1, svgX1 - svgX0), svgCropH = Math.max(1, svgY1 - svgY0)

  const outH = Math.round(outW * svgCropH / svgCropW)
  const canvas = document.createElement('canvas')
  canvas.width = outW; canvas.height = outH
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#eef4ec'; ctx.fillRect(0, 0, outW, outH)
  const kx = outW / svgCropW, ky = outH / svgCropH
  const px = sx => (sx - svgX0) * kx, py = sy => (sy - svgY0) * ky

  ctx.fillStyle = 'rgba(200,223,245,0.85)'; ctx.strokeStyle = '#4a90d9'; ctx.lineWidth = 1
  mapData.pvAreas.forEach(pts => {
    ctx.beginPath(); pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y)))
    ctx.closePath(); ctx.fill(); ctx.stroke()
  })

  const highlightIdx = new Set(info ? info.rowInsertIdxs : [])
  mapData.inserts.forEach((ins, idx) => {
    const right = ins.x + ins.panels * PANEL_W_M * sxm
    const left = ins.x
    if (right < svgX0 || left > svgX1 || ins.y + th < svgY0 || ins.y > svgY1) return // skip off-screen tables
    const tw = ins.panels * PANEL_W_M * sxm * kx, thpx = TABLE_DEPTH_M * sym * ky
    const isHi = highlightIdx.has(idx)
    ctx.fillStyle = isHi ? 'rgba(214,48,48,0.30)' : 'rgba(26,47,204,0.18)'
    ctx.strokeStyle = isHi ? '#d63030' : '#1a2fcc'
    ctx.lineWidth = isHi ? 1.4 : 0.5
    ctx.fillRect(px(ins.x), py(ins.y), tw, thpx)
    ctx.strokeRect(px(ins.x), py(ins.y), tw, thpx)
  })

  ctx.textAlign = 'center'
  mapData.rowNumbers.forEach(t => {
    if (t.x < svgX0 || t.x > svgX1 || t.y < svgY0 || t.y > svgY1) return
    ctx.font = 'bold 12px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillRect(px(t.x) - 9, py(t.y) - 8, 18, 11)
    ctx.fillStyle = '#0d1a6e'
    ctx.fillText(t.text, px(t.x), py(t.y) + 1)
  })

  const cx = px(psx), cy = py(psy)
  ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2)
  ctx.fillStyle = '#d63030'; ctx.fill()
  ctx.strokeStyle = 'white'; ctx.lineWidth = 2.5; ctx.stroke()

  return canvas.toDataURL('image/jpeg', 0.85)
}
