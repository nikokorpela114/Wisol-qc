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
  'Poraruuvi puuttuu': 'Drill screw missing',
  'Koropalojen suoristus': 'Spacer blocks need straightening',
  'Shimmi levy puuttuu': 'Shim plate missing',
  'Paalu pultti löysällä': 'Pile bolt loose',
  'Paalu pultti puuttuu': 'Pile bolt missing',
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
    if (psx >= ins.x - 3 && psx <= ins.x + tw + 3 && psy >= ins.y - th - 3 && psy <= ins.y + 3) hitIdx = idx
  })
  // Fallback: joillain työmailla rivit on aseteltu hyvin tiheään (ks.
  // kommentti alempana "rivit 61/63/65 lähes päällekkäin"), jolloin
  // napautus voi osua muutaman pikselin päähän kahden pöydän välisestä
  // rajasta eikä täsmällinen ±3 yksikön tarkistus löydä mitään —
  // "Havaittu rivi" katosi tällöin kokonaan sen sijaan että olisi näyttänyt
  // lähimmän, todennäköisesti oikean rivin. Jos tarkkaa osumaa ei löydy,
  // valitaan lähin pöytä (X-suunnassa napautuksen kohdalla oleva, Y-etäisyys
  // pienin) kohtuullisen etäisyyden sisältä sen sijaan että luovutetaan.
  if (hitIdx < 0) {
    let bestDist = Infinity
    mapData.inserts.forEach((ins, idx) => {
      const tw = ins.panels * PANEL_W_M * sxm
      if (psx < ins.x - 3 || psx > ins.x + tw + 3) return // X-suunnassa oltava edes lähellä pöytää
      const center = ins.y - th / 2
      const d = Math.abs(psy - center)
      if (d < bestDist) { bestDist = d; hitIdx = idx }
    })
    if (bestDist > th * 1.2) hitIdx = -1 // liian kaukana ollakseen luotettava arvaus
  }
  if (hitIdx < 0) return null
  const hit = mapData.inserts[hitIdx]

  // 2. Kerää looginen rivi = lohkot samalla Y-korkeudella JA X-suunnassa
  //    peräkkäin. Pelkkä Y-korkeus ei riitä: jos rivi katkeaa esim. tien
  //    (Road 03/04) kohdalla, tien toisella puolella oleva lohko voi sattua
  //    olemaan täsmälleen samalla korkeudella mutta kuulua ihan eri,
  //    kauempana olevaan riviin/numerointiin. Ketjutetaan lähtien pinnin
  //    lohkosta naapureihin, ja ketju katkeaa jos:
  //    (a) väli on epätavallisen suuri (paljon isompi kuin tavallinen
  //        pöytien välinen rako), TAI
  //    (b) tien viiva (mapData.roads) kulkee kahden peräkkäisen lohkon
  //        välistä — tämä on tarkempi tapa tunnistaa nimenomaan tien
  //        ylitys erotuksena tavallisesta, isommastakin pöytävälistä
  //        (esim. huoltokäytävä rivin sisällä).
  // HUOM: joillain työmailla rivit on aseteltu poikkeuksellisen lähekkäin
  // pystysuunnassa (esim. tämä alue, jossa rivit 61/63/65 ja 70/72/74 ovat
  // lähes päällekkäin kartalla). Liian väljä Y-toleranssi sekoitti tällöin
  // eri fyysiset rivit samaksi ketjuksi. Toleranssi on siksi tiukka — vain
  // saman rivin omien lohkojen pieni mittausvaihtelu, ei naapuririvin väli.
  const yTol = th * 0.25
  const gapTol = 25 * sxm // reilusti isompi kuin tavallinen pöytäväli, jotta rivin sisäiset huoltokäytävät ym. eivät katkaise ketjua turhaan
  const rowY = hit.y - th / 2

  // Tarkistaa kulkeeko jokin "raja-viiva" kahden lohkon välistä. Tähän
  // lasketaan sekä tiet (mapData.roads) että aluerajat — dxfParser.js lukee
  // DXF:n "Aluejako"-tason (eri numeroitujen alueiden väliset rajaviivat,
  // esim. A5/A6-alueiden raja) samaan pvAreas-joukkoon kuin itse
  // paneelialueiden ulkoreunat, koska molemmat ovat "alue"-tyyppisiä
  // polygoneja DXF:ssä. Ilman tätä kaksi vierekkäistä mutta itsenäisesti
  // numeroitua aluetta (esim. rivit 61/63/65 alueella A5 ja 70/72/74
  // alueella A6) saattoivat ketjuuntua samaksi riviksi, koska niiden
  // välissä oleva aluerajaviiva ei ollut "tie" eikä siis pysäyttänyt ketjua.
  const boundaryPolylines = [...mapData.roads, ...mapData.pvAreas]
  const crossesBoundary = (xA, xB) => {
    const lo = Math.min(xA, xB), hi = Math.max(xA, xB)
    return boundaryPolylines.some(pts => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
        if ((y1 - rowY) * (y2 - rowY) > 0) continue // segmentti ei ylitä rivin Y-tasoa
        if (y1 === y2) continue
        const t = (rowY - y1) / (y2 - y1)
        const cx = x1 + t * (x2 - x1)
        if (cx >= lo && cx <= hi) return true
      }
      return false
    })
  }

  const sameY = mapData.inserts
    .map((ins, idx) => ({ idx, ins, left: ins.x, right: ins.x + ins.panels * PANEL_W_M * sxm }))
    .filter(e => Math.abs(e.ins.y - hit.y) <= yTol)
    .sort((a, b) => a.left - b.left)

  const hitPos = sameY.findIndex(e => e.idx === hitIdx)
  const chain = [sameY[hitPos]]
  for (let i = hitPos - 1; i >= 0; i--) {
    const edge = chain[0].left
    if (sameY[i].right >= edge - gapTol && !crossesBoundary(sameY[i].right, edge)) chain.unshift(sameY[i])
    else break
  }
  for (let i = hitPos + 1; i < sameY.length; i++) {
    const edge = chain[chain.length - 1].right
    if (sameY[i].left <= edge + gapTol && !crossesBoundary(edge, sameY[i].left)) chain.push(sameY[i])
    else break
  }

  // 3. Rivin oma oikea reuna = suurin (ins.x + leveys) vain ketjuun kuuluvista lohkoista
  const rowRightX = Math.max(...chain.map(e => e.right))
  const targetX = rowRightX
  const targetY = hit.y - th / 2

  // 4. Etsi lähin numerolappu VAIN saman Y-kaistan sisältä, ja hylkää jos
  //    lähinkin on epäuskottavan kaukana (esim. toiselta puolelta karttaa).
  //    Numerolapun oma Y-toleranssi on tarkoituksella löysempi kuin rivin
  //    ketjutuksen yTol yllä — labelin tekstianckeri ei aina osu tasan
  //    pöydän keskikohtaan, mutta silti on selvästi lähempänä omaa riviään
  //    kuin naapuririviä.
  const labelYTol = th * 0.6
  const maxLabelDist = th * 4 // n. rivin syvyyden nelinkertainen etäisyys riittää kattamaan reunan epätarkkuudet
  let best = Infinity, label = null
  mapData.rowNumbers.forEach(t => {
    if (Math.abs(t.y - targetY) > labelYTol) return // eri Y-kaista → ei voi olla saman rivin numero
    const d = Math.hypot(t.x - targetX, t.y - targetY)
    if (d < best) { best = d; label = t.text }
  })
  if (!label || best > maxLabelDist) return null

  // Palautetaan myös koko rivin (ketjun) lohkojen indeksit — näitä tarvitaan
  // kun halutaan korostaa/rajata koko rivi eikä vain sitä yhtä lohkoa johon
  // pinni sattui osumaan (esim. PDF:n karttakuvassa ja usean pinnin
  // yhteiskartassa).
  const rowInsertIdxs = chain.map(e => e.idx)

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
  const highlightIdx = new Set(info ? info.rowInsertIdxs : [])

  // Crop around the pin's ENTIRE detected row (every segment of it), not
  // just a fixed radius around the pin point — a tight radius-only crop
  // showed a single anonymous colour block with no row number and no way
  // to tell where along a long row the pin actually sat. Showing the whole
  // row (plus its number label) instead always gives that context.
  let minX = psx, maxX = psx, minY = psy, maxY = psy
  highlightIdx.forEach(idx => {
    const ins = mapData.inserts[idx]
    const left = ins.x, right = ins.x + ins.panels * PANEL_W_M * sxm
    if (left < minX) minX = left
    if (right > maxX) maxX = right
    if (ins.y - th < minY) minY = ins.y - th
    if (ins.y > maxY) maxY = ins.y
  })

  const padX = Math.max(6 * sxm, (maxX - minX) * 0.05)
  const padY = Math.max(9 * sym, (maxY - minY) * 0.2)
  const svgX0 = Math.max(0, minX - padX), svgX1 = Math.min(mapData.W, maxX + padX)
  const svgY0 = Math.max(0, minY - padY), svgY1 = Math.min(mapData.H, maxY + padY)
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

  mapData.inserts.forEach((ins, idx) => {
    const right = ins.x + ins.panels * PANEL_W_M * sxm
    const left = ins.x
    if (right < svgX0 || left > svgX1 || ins.y < svgY0 || ins.y - th > svgY1) return // skip off-screen tables
    const tw = ins.panels * PANEL_W_M * sxm * kx, thpx = TABLE_DEPTH_M * sym * ky
    const isHi = highlightIdx.has(idx)
    ctx.fillStyle = isHi ? 'rgba(214,48,48,0.30)' : 'rgba(26,47,204,0.18)'
    ctx.strokeStyle = isHi ? '#d63030' : '#1a2fcc'
    ctx.lineWidth = isHi ? 1.4 : 0.5
    ctx.fillRect(px(ins.x), py(ins.y) - thpx, tw, thpx)
    ctx.strokeRect(px(ins.x), py(ins.y) - thpx, tw, thpx)
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

// Renders one combined map image containing ALL pins from `items` (a list of
// observations that share a fault category), so an installer can see every
// occurrence of that fault on one picture instead of paging through a
// separate map per observation. Crops to a bounding box that covers all the
// pins (plus padding), highlights every row that contains at least one pin,
// and draws each pin as a small numbered circle (1, 2, 3…) matching the
// numbered list printed under the image in the PDF.
//
// Siirretty tänne App.jsx:stä, koska InstallerView.jsx tarvitsee saman
// funktion eikä App.jsx:ää voi tuoda sieltä (circular import -riski, sama
// syy miksi tämä tiedosto ylipäätään on olemassa — ks. tiedoston alun
// kommentti). Nyt sekä App.jsx että InstallerView.jsx tuovat tämän täältä.
export function renderGroupMapImage(mapData, items) {
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
  // point. HUOM: ins.y on pöydän ALAREUNA (sama konventio kuin muualla
  // tässä tiedostossa ja elävässä MapView.jsx:ssä) — pöytä ulottuu siis
  // ylöspäin ins.y:stä, ei alaspäin.
  highlightIdx.forEach(idx => {
    const ins = mapData.inserts[idx]
    const left = ins.x, right = ins.x + ins.panels * PANEL_W_M * sxm
    if (left < minX) minX = left
    if (right > maxX) maxX = right
    if (ins.y - th < minY) minY = ins.y - th
    if (ins.y > maxY) maxY = ins.y
  })

  // Aiemmin marginaali oli hyvin pieni (5 % / kiinteä 6 yksikköä), jolloin
  // rajaus näytti VAIN itse pisteiden rivin ilman mitään ympäröivää
  // kontekstia — asentajan oli mahdotonta hahmottaa mihin kohtaan koko
  // riviä tai työmaata tämä pätkä sijoittuu, koska yhtään naapuririvin
  // numerolappua ei näkynyt vertailukohdaksi. Pystysuunnassa marginaali on
  // nyt sidottu pöydän syvyyteen (th) niin että ainakin osa rivin ylä- ja
  // alapuolisesta naapuririvistä (numerolappuineen) jää aina näkyviin,
  // vaakasuunnassa marginaali on reilusti suurempi jotta rivin päät/jatko
  // hahmottuvat paremmin.
  const padX = Math.max(40 * sxm, (maxX - minX) * 0.15)
  const padY = Math.max(th * 1.8, (maxY - minY) * 0.35)
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
    // ins.y = pöydän alareuna, pöytä ulottuu ylöspäin siitä.
    mctx.fillRect(px(ins.x), py(ins.y) - thpx, tw, thpx)
    mctx.strokeRect(px(ins.x), py(ins.y) - thpx, tw, thpx)
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
