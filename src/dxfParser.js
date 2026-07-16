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
          else if (layer === 'Aluejako') pvAreas.push(pts)
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

  return { W, H, pvAreas, roads, boundaries, inserts, panelAreas, rowNumbers, minX, minY, maxX, maxY }
}
