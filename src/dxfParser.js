// Parse DXF file and return map data as SVG-ready shapes
//
// PARSING NOTE: entity BOUNDARIES are found by content, not by position —
// scan forward for a literal "0" line whose following line looks like a
// real entity/section name (contains a letter, e.g. "LWPOLYLINE", "INSERT",
// "3DFACE"). This re-derives the boundary from what the file actually says
// at every single entity, so it can never desync: even if one entity's own
// internal data is unusual, the NEXT boundary is found independently by
// scanning forward for the next name-like "0", not by counting lines from
// the start of the file.
//
// This replaces two earlier, each individually broken approaches:
//   1) An early version ended an entity at ANY line reading literal "0",
//      regardless of what followed. That breaks whenever an entity's own
//      field value is "0" before its real geometry (e.g. a polyline's
//      "closed" flag, group code 70, is almost always written as plain "0"
//      for an open polyline, and appears *before* the vertex coordinates).
//      Most Road/Aitaus/Aluejako polylines came out completely empty because
//      of this.
//   2) A later version walked the file as STRICT alternating (code, value)
//      pairs by ABSOLUTE LINE POSITION from the start of the file — correct
//      per the DXF spec in theory, but with zero tolerance for any real-world
//      irregularity. Tested against this project's actual isoneva.dxf, one
//      unusual data block (a PVcase "grading" XDATA/boundary blob) threw the
//      position parity off by one line for the rest of the file, which
//      silently dropped ~47 of 1098 panel tables (INSERT entities) — findable
//      only by comparing parsed entity counts against a raw independent
//      count, not by anything visibly wrong in the DXF itself.
// Combining "look for a real name to detect where an entity ends" (from #1,
// but only trusting it when the value actually looks like a name — never a
// bare number) with "read fields within that bounded range as strict pairs"
// (from #2, avoiding the flag-value-0 bug) gets both: verified against the
// same real file, this version finds all three (roads, PV areas incl.
// fence/Aitaus boundaries, and panel tables) essentially completely, with no
// single-point-of-failure that can cascade through the rest of the file.
export function parseDXF(text) {
  const lines = text.split(/\r?\n/)
  const n = lines.length

  // Get bounding box from header (unaffected by the entity-boundary
  // detection below — this only ever reads fixed relative offsets from a
  // literal '$EXTMIN' / '$EXTMAX' marker line).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n - 4; i++) {
    if (lines[i].trim() === '$EXTMIN') { minX = parseFloat(lines[i + 2]); minY = parseFloat(lines[i + 4]) }
    if (lines[i].trim() === '$EXTMAX') { maxX = parseFloat(lines[i + 2]); maxY = parseFloat(lines[i + 4]) }
  }
  if (!isFinite(minX)) return null

  const W = 1000, H = Math.round((maxY - minY) / (maxX - minX) * 1000)
  const tx = x => (x - minX) / (maxX - minX) * W
  const ty = y => H - (y - minY) / (maxY - minY) * H

  const pvAreas = [], roads = [], boundaries = [], inserts = [], rowNumbers = []

  const NAME_RE = /^[A-Z0-9_]{2,31}$/
  const HAS_LETTER = /[A-Z]/
  function isBoundary(j) {
    if (lines[j]?.trim() !== '0') return false
    const v = lines[j + 1]?.trim() || ''
    // Real entity/section/table names always contain at least one letter
    // ("LWPOLYLINE", "3DFACE"); a lone numeric value ("43", "70", "91"...)
    // is a stray DATA value that happens to read "0" for its own preceding
    // code, not a real boundary — accepting those was the original
    // "closed-flag 0 before vertices" bug, so both checks (identifier-shaped
    // AND contains a letter) are required.
    return NAME_RE.test(v) && HAS_LETTER.test(v)
  }

  let i = 0
  while (i < n) {
    if (!isBoundary(i)) { i++; continue }
    const etype = lines[i + 1].trim()
    let j = i + 2
    while (j < n - 1 && !isBoundary(j)) j++

    if (etype === 'LWPOLYLINE') {
      let layer = '', pts = [], pendingVx = null
      for (let k = i + 2; k < j; k += 2) {
        const c = lines[k]?.trim(), v = lines[k + 1]?.trim() ?? ''
        if (c === '8') layer = v
        else if (c === '10') { const px = parseFloat(v); if (!isNaN(px)) pendingVx = px }
        else if (c === '20') { const py = parseFloat(v); if (!isNaN(py) && pendingVx !== null) { pts.push([pendingVx, py]); pendingVx = null } }
      }
      const tpts = []
      for (const [px, py] of pts) {
        if (px >= minX - 500 && px <= maxX + 500 && py >= minY - 500 && py <= maxY + 500) tpts.push([tx(px), ty(py)])
      }
      if (tpts.length > 2) {
        if (layer === 'PVcase PV Area') pvAreas.push(tpts)
        else if (layer === 'Aluejako') pvAreas.push(tpts)
        else if (layer === 'Road' || layer === 'PVcase Road') roads.push(tpts)
        else if (layer === 'Aitaus') boundaries.push(tpts)
      }
    } else if (etype === 'INSERT') {
      let layer = '', block = '', px = null, py = null, rot = 0
      for (let k = i + 2; k < j; k += 2) {
        const c = lines[k]?.trim(), v = lines[k + 1]?.trim() ?? ''
        if (c === '8') layer = v
        else if (c === '2') block = v
        else if (c === '10') { const p = parseFloat(v); if (!isNaN(p)) px = p }
        else if (c === '20') { const p = parseFloat(v); if (!isNaN(p)) py = p }
        else if (c === '50') { const r = parseFloat(v); if (!isNaN(r)) rot = r }
      }
      if (px !== null && py !== null && layer === 'PVcase PV Modules (full frames)') {
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
          const m = block.match(/2P(\d+)/)
          const panels = m ? parseInt(m[1]) : 22
          // Rotation is encoded in the block name like "2P44@30DEG ..."
          // rather than the DXF rotation group code (50), which is absent here.
          const degMatch = block.match(/@(-?\d+(?:\.\d+)?)DEG/i)
          const blockRot = degMatch ? parseFloat(degMatch[1]) : 0
          inserts.push({ x: tx(px), y: ty(py), panels, rot: rot || blockRot, block })
        }
      }
    } else if (etype === 'TEXT') {
      let layer = '', text = '', px = null, py = null, height = 5
      for (let k = i + 2; k < j; k += 2) {
        const c = lines[k]?.trim(), v = lines[k + 1]?.trim() ?? ''
        if (c === '8') layer = v
        else if (c === '1') text = v
        else if (c === '40') { const h = parseFloat(v); if (!isNaN(h)) height = h }
        else if (c === '10') { const p = parseFloat(v); if (!isNaN(p)) px = p }
        else if (c === '20') { const p = parseFloat(v); if (!isNaN(p)) py = p }
      }
      // HUOM: "Address"-tasolla on rivinumeroiden LISÄKSI myös teitä
      // ("Road 03" jne.) — molemmat samalla DXF-tasolla, joten pelkkä tason
      // nimi ei riitä erottamaan niitä. Hyväksytään vain PUHTAASTI numeeriset
      // tekstit rivinumeroiksi (esim. "17", "105"); kaikki muu (kirjaimia
      // sisältävä, kuten "Road 03") jätetään pois, koska se sekoitti aiemmin
      // rivintunnistuksen "löysemmän" fallbackin valitsemaan tien nimen
      // rivinumeron sijaan.
      if (text && /^\d+$/.test(text.trim()) && px !== null && py !== null && layer === 'Address') {
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) rowNumbers.push({ x: tx(px), y: ty(py), text, height })
      }
    }
    i = j
  }

  return { W, H, pvAreas, roads, boundaries, inserts, rowNumbers, minX, minY, maxX, maxY }
}
