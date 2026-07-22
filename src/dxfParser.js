// Parse DXF file and return map data as SVG-ready shapes

export function parseDXF(text) {
  const lines = text.split(/\r?\n/)
  const n = lines.length

  // Get bounding box from header
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (let i = 0; i < n - 2; i++) {
    if (lines[i].trim() === '$EXTMIN') {
      minX = parseFloat(lines[i + 2])
      minY = parseFloat(lines[i + 4])
    }
    if (lines[i].trim() === '$EXTMAX') {
      maxX = parseFloat(lines[i + 2])
      maxY = parseFloat(lines[i + 4])
    }
  }

  if (!isFinite(minX)) return null

  const W = 3000, H = Math.round((maxY - minY) / (maxX - minX) * 3000)
  const tx = x => (x - minX) / (maxX - minX) * W
  const ty = y => H - (y - minY) / (maxY - minY) * H

  // Parse entities
  const pvAreas = []
  // Aluejako-tason rajat KAHDESTI tallennettuna: kerran pvAreas-joukkoon
  // (piirtoa varten, ennallaan) ja erikseen tähän omaan taulukkoon —
  // findPinRow (shared.js) tarvitsee juuri Aluejako-rajat erillään
  // 'PVcase PV Area' -kentän ULKOREUNASTA, koska jälkimmäinen on koko
  // paneelikentän oma (usein mutkikas/koverakin) ääriviiva, joka voi
  // ylittää rivin ilman että kyseessä on oikeasti kaksi eri riviä/aluetta
  // — vain Aluejako-raja tarkoittaa aidosti eri nimettyä aluetta.
  const aluejako = []
  const roads = []
  const boundaries = []
  const inserts = [] // panel tables (drawn as INSERT blocks)
  const panelAreas = [] // panel tables drawn as raw polygons instead of INSERT
                         // blocks — some sites (e.g. isoneva.dxf) mix panel
                         // wattage classes, and the non-default classes come
                         // through as LWPOLYLINE outlines on their own layer
                         // ('665 Wp', '670 Wp', 'Extra panels') rather than as
                         // '2P..' INSERT blocks. Skipping these silently
                         // dropped whole rows of tables from the map even
                         // though the DXF data for them was present and valid.
  const rowNumbers = []

  let i = 0
  while (i < n) {
    const code = lines[i]?.trim()
    const val = lines[i + 1]?.trim() || ''

    if (code === '0') {
      const etype = val

      if (etype === 'LWPOLYLINE') {
        let layer = '', pts = []
        let j = i + 2
        // HUOM (korjattu bugi): tämä silmukka luki aiemmin riviä kerrallaan
        // (j++), mikä tarkoitti että j saattoi osua minkä tahansa ryhmän
        // ARVO-riville, ei vain koodiriville. Lopetusehto `lines[j] === '0'`
        // tulkitsi silloin virheellisesti minkä tahansa ARVON joka sattui
        // olemaan kirjaimellisesti "0" (esim. koodi 70 "onko polyline
        // suljettu" = 0, hyvin yleinen arvo avoimille poly-linjoille) uuden
        // entiteetin alkuna, ja katkaisi koko loput entiteetin luvun ennen
        // kuin päästiin edes 10/20-kärkipisteisiin. Tästä syystä esim.
        // 'Road', 'Aitaus' ja 'Water' -layerit palautuivat aina tyhjinä.
        // Korjaus: askelletaan aina koodi+arvo-pareittain (j += 2), jolloin
        // j osoittaa AINA ryhmäkoodiriville silmukan alussa — sama tapa jota
        // INSERT-lohko käytti jo entuudestaan oikein.
        while (j < n && lines[j]?.trim() !== '0') {
          const c = lines[j]?.trim()
          const v = lines[j + 1]?.trim() || ''
          if (c === '8') layer = v
          if (c === '10') {
            try {
              const px = parseFloat(v)
              if (lines[j + 2]?.trim() === '20') {
                const py = parseFloat(lines[j + 3]?.trim())
                if (px >= minX - 500 && px <= maxX + 500 && py >= minY - 500 && py <= maxY + 500) {
                  pts.push([tx(px), ty(py)])
                }
              }
            } catch {}
          }
          j += 2
        }
        if (pts.length > 2) {
          if (layer === 'PVcase PV Area') pvAreas.push(pts)
          else if (layer === 'Aluejako') { pvAreas.push(pts); aluejako.push(pts) }
          else if (layer === 'Road' || layer === 'PVcase Road') roads.push(pts)
          else if (layer === 'Aitaus') boundaries.push(pts)
          else if (layer === '665 Wp' || layer === '670 Wp' || layer === 'Extra panels') panelAreas.push(pts)
        }
        i = j
        continue
      }

      if (etype === 'INSERT') {
        let layer = '', block = '', px = null, py = null, rot = 0
        let j = i + 2
        while (j < n && lines[j]?.trim() !== '0') {
          const c = lines[j]?.trim()
          const v = lines[j + 1]?.trim() || ''
          if (c === '8') layer = v
          if (c === '2') block = v
          if (c === '10') { try { px = parseFloat(v) } catch {} }
          if (c === '20') { try { py = parseFloat(v) } catch {} }
          if (c === '50') { try { rot = parseFloat(v) } catch {} }
          j += 2
        }
        if (px !== null && py !== null && layer === 'PVcase PV Modules (full frames)') {
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
            const m = block.match(/2P(\d+)/)
            const panels = m ? parseInt(m[1]) : 22
            // The "@30DEG" in the block name is the panel TILT angle (mounting angle),
            // not a rotation in the XY plane — tables are laid out axis-aligned.
            inserts.push({ x: tx(px), y: ty(py), panels, rot: rot || 0, block })
          }
        }
        i = j
        continue
      }

      if (etype === 'TEXT') {
        let layer = '', text = '', px = null, py = null, height = 5
        let j = i + 2
        // Sama j += 2 -korjaus kuin LWPOLYLINE:ssä yllä — muuten rivinumero-
        // tekstit joiden korkeusarvo (koodi 40) tms. sattuu olemaan "0"
        // voisivat kadota samasta syystä.
        while (j < n && lines[j]?.trim() !== '0') {
          const c = lines[j]?.trim()
          const v = lines[j + 1]?.trim() || ''
          if (c === '8') layer = v
          if (c === '1') text = v
          if (c === '40') { try { height = parseFloat(v) } catch {} }
          if (c === '10') { try { px = parseFloat(v) } catch {} }
          if (c === '20') { try { py = parseFloat(v) } catch {} }
          j += 2
        }
        if (text && px !== null && py !== null && layer === 'Address') {
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
            rowNumbers.push({ x: tx(px), y: ty(py), text, height })
          }
        }
        i = j
        continue
      }
    }
    i++
  }

  return { W, H, pvAreas, aluejako, roads, boundaries, inserts, panelAreas, rowNumbers, minX, minY, maxX, maxY }
}

// ---------------------------------------------------------------------------
// Paalutus (piling) support — paalukartat (esim. Isoneva) sisältävät VAIN
// POINT-entiteettejä layerilla 'PVcase Poles Centres', EI tekstirivinumeroita.
// Rivitieto on kuitenkin piilossa jokaisen pisteen XDATA:ssa (group code
// 1001 = kentän nimi, seuraava 1000 = arvo), kenttänä 'PVCaseBlockID'.
// Tämä funktio lukee raa'at paalupisteet ja niiden XDATA:n. Rivien
// muodostus (groupPilesIntoRows) on erillinen funktio, koska ~99.8%
// BlockID-ryhmistä on suoraan käyttökelpoisia riveinä, mutta muutama
// poikkeus vaatii jälkiklusteroinnin sijainnin perusteella.
export function parsePilePoints(text) {
  const lines = text.split(/\r?\n/)
  const n = lines.length
  const piles = []

  let i = 0
  while (i < n) {
    const code = lines[i]?.trim()
    const val = lines[i + 1]?.trim() || ''

    if (code === '0' && val === 'POINT') {
      let layer = '', x = null, y = null
      let lastAppField = ''
      const xdata = {}
      let j = i + 2
      // Sama code+value pareittain -askellus (j += 2) kuin muuallakin tässä
      // tiedostossa — XDATA:ssa 1001 (kentän nimi) ja sitä seuraava 1000
      // (arvo) ovat kumpikin omia group code -rivejään, joten tämä toimii
      // suoraan ilman erikoiskäsittelyä.
      while (j < n && lines[j]?.trim() !== '0') {
        const c = lines[j]?.trim()
        const v = lines[j + 1]?.trim() || ''
        if (c === '8') layer = v
        if (c === '10') { try { x = parseFloat(v) } catch {} }
        if (c === '20') { try { y = parseFloat(v) } catch {} }
        if (c === '1001') lastAppField = v
        if (c === '1000' && lastAppField) { xdata[lastAppField] = v; lastAppField = '' }
        j += 2
      }
      if (layer === 'PVcase Poles Centres' && x !== null && y !== null) {
        // HUOM: PVCasePoleId EI ole aina yksilöllinen — yhdessä sotkuisessa
        // "roskakori"-BlockID-ryhmässä (ks. groupPilesIntoRows) sama
        // PoleId toistuu useilla eri koordinaateilla, luultavasti PVcasen
        // sisäinen oletus-/malli-ID. Liitetään koordinaatti mukaan
        // varmuuden vuoksi, jotta poleId on aina aidosti yksilöllinen
        // (piles-taulun 'pole_id' on unique).
        const rawId = xdata.PVCasePoleId || 'p'
        piles.push({
          poleId: `${rawId}_${x.toFixed(3)}_${y.toFixed(3)}`,
          blockId: xdata.PVCaseBlockID || 'unknown',
          x, y
        })
      }
      i = j
      continue
    }
    i++
  }
  return piles
}

// Kevyt CSV-muoto paalupisteille (pole_id,block_id,x,y) — käytetään ison
// raa'an DXF:n sijaan, koska DXF (n. 100 MB+ XDATA:n takia) ylittää
// Supabasen ilmaistason 50 MB tallennusrajan. CSV luodaan kerran
// paikallisesti parsePilePoints():n avulla ja ladataan Storageen pienenä
// tiedostona. Palauttaa saman muodon kuin parsePilePoints, joten
// groupPilesIntoRows() toimii suoraan kummallakin.
// Kevyt CSV-muoto paalupisteille — UUSI MUOTO (pole_id,area,row_number,x,y).
// Rivinumerot ja aluejako ovat nyt OIKEITA, työmaan omia rivinumeroita
// (sama 'Address'-layerin numerointi kuin paneelipöydissä, esim. 1,3,5,7...),
// poimittu paikallisesti kahdeksasta erillisestä aluekohtaisesta
// paalutuskartta-DXF:stä (CIRCLE-pisteet + lähin samalla Y-korkeudella oleva
// rivinumero — sama periaate kuin findPinRow shared.js:ssä). EI enää tarvita
// BlockID-arvailua tai jälkiklusterointia, koska rivi on jo tiedossa.
export function parsePileCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  const piles = []
  // Ensimmäinen rivi on otsikko (pole_id,area,row_number,x,y) — ohitetaan
  for (let i = 1; i < lines.length; i++) {
    const [poleId, area, rowStr, xStr, yStr] = lines[i].split(',')
    const rowNumber = parseInt(rowStr, 10)
    const x = parseFloat(xStr), y = parseFloat(yStr)
    if (poleId && area && !isNaN(rowNumber) && !isNaN(x) && !isNaN(y)) {
      piles.push({ poleId, area, rowNumber, x, y })
    }
  }
  return piles
}
// Ryhmittää parsePilePoints():n (tai parsePileCSV():n) palauttamat raa'at
// pisteet ihmisluettaviksi riveiksi. Palauttaa litteän listan paaluja,
// joissa jokaisella on row_number (juokseva, sijainnin mukaan lajiteltu)
// ja row_group_id (alkuperäinen tai jälkiklusteroitu tunniste).
export function groupPilesIntoRows(piles) {
  // 1) Ryhmittele BlockID:n mukaan
  const byBlock = new Map()
  for (const p of piles) {
    if (!byBlock.has(p.blockId)) byBlock.set(p.blockId, [])
    byBlock.get(p.blockId).push(p)
  }

  const rowGroups = [] // { key, points: [...] }

  for (const [blockId, pts] of byBlock) {
    // Tarkista onko ryhmä "siisti" (korkeintaan 2 erillistä Y-linjaa,
    // esim. paalutaulukon etu- ja takarivi) — sama tarkistus jolla
    // 1093/1095 ryhmästä todettiin toimivan suoraan sellaisenaan.
    const ys = [...new Set(pts.map(p => Math.round(p.y)))].sort((a, b) => a - b)
    let yClusters = 1
    for (let k = 1; k < ys.length; k++) {
      if (ys[k] - ys[k - 1] > 3) yClusters++
    }

    if (yClusters <= 2) {
      rowGroups.push({ key: blockId, points: pts })
      continue
    }

    // "Sotkuinen" ryhmä (esim. BlockID uudelleenkäytetty eri puolilla
    // työmaata) — klusteroidaan uudelleen sijainnin perusteella
    // (union-find, kynnysarvo 15m — isompi kuin paalujen normaali väli
    // rivillä ~2-5m, pienempi kuin etäisyys eri riviryhmien välillä).
    const THRESH = 15
    const parent = pts.map((_, idx) => idx)
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y
        if (Math.sqrt(dx * dx + dy * dy) < THRESH) union(a, b)
      }
    }
    const subGroups = new Map()
    pts.forEach((p, idx) => {
      const root = find(idx)
      if (!subGroups.has(root)) subGroups.set(root, [])
      subGroups.get(root).push(p)
    })
    let sub = 0
    for (const subPts of subGroups.values()) {
      rowGroups.push({ key: `${blockId}__${sub++}`, points: subPts })
    }
  }

  // 2) Järjestä ryhmät sijainnin mukaan (pohjoisesta etelään, sitten
  // lännestä itään) ja anna juokseva rivinumero.
  rowGroups.forEach(g => {
    g.avgX = g.points.reduce((s, p) => s + p.x, 0) / g.points.length
    g.avgY = g.points.reduce((s, p) => s + p.y, 0) / g.points.length
  })
  rowGroups.sort((a, b) => (b.avgY - a.avgY) || (a.avgX - b.avgX))

  const result = []
  rowGroups.forEach((g, idx) => {
    const rowNumber = idx + 1
    for (const p of g.points) {
      result.push({
        poleId: p.poleId,
        rowGroupId: g.key,
        rowNumber,
        x: p.x,
        y: p.y
      })
    }
  })
  return result
}
