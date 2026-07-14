// Parse DXF file and return map data as SVG-ready shapes
//
// IMPORTANT PARSING NOTE: this walks the file as STRICT alternating
// group-code / value pairs (code, value, code, value, ...) from start to
// finish. DXF's ASCII format guarantees this alternation holds throughout
// the entire file — it's a hard format rule, not a convention that can be
// violated. An earlier version of this parser instead scanned line-by-line
// looking for a line whose CONTENT equalled "0" to detect where an entity
// ends. That breaks silently whenever an entity's own data contains the
// literal value "0" before its actual geometry — which is extremely common
// (e.g. a polyline's "closed" flag, group code 70, is almost always written
// as plain "0" for an open polyline, and it appears *before* the vertex
// coordinates in the DXF). When that happened, the old parser thought the
// entity had already ended and silently produced zero points for it. In
// practice this meant most Road/Aitaus/Aluejako polylines came out empty.
// Reading strict code/value pairs by POSITION rather than by content never
// has this problem, because a value that happens to read "0" is still
// consumed as a value (odd position), never mistaken for a new entity's
// code (even position).
export function parseDXF(text) {
  const lines = text.split(/\r?\n/)
  const n = lines.length

  // Get bounding box from header (unaffected by the entity-boundary bug —
  // this only ever reads fixed relative offsets from a literal '$EXTMIN' /
  // '$EXTMAX' marker line, not an open-ended boundary scan).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n - 4; i++) {
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

  const W = 1000, H = Math.round((maxY - minY) / (maxX - minX) * 1000)
  const tx = x => (x - minX) / (maxX - minX) * W
  const ty = y => H - (y - minY) / (maxY - minY) * H

  // Parse entities
  const pvAreas = []
  const roads = []
  const boundaries = []
  const inserts = [] // panel tables
  const rowNumbers = []

  let curType = null
  let curLayer = ''
  let curBlock = ''
  let curRot = 0
  let curText = ''
  let curHeight = 5
  let curPx = null, curPy = null   // pending INSERT/TEXT insertion point
  let curPts = []                  // accumulated LWPOLYLINE vertices (raw, untransformed)
  let pendingVx = null             // pending LWPOLYLINE vertex X waiting for its paired Y

  function flushEntity() {
    if (curType === 'LWPOLYLINE') {
      const pts = []
      for (const [px, py] of curPts) {
        if (px >= minX - 500 && px <= maxX + 500 && py >= minY - 500 && py <= maxY + 500) {
          pts.push([tx(px), ty(py)])
        }
      }
      if (pts.length > 2) {
        if (curLayer === 'PVcase PV Area') pvAreas.push(pts)
        else if (curLayer === 'Aluejako') pvAreas.push(pts)
        else if (curLayer === 'Road' || curLayer === 'PVcase Road') roads.push(pts)
        else if (curLayer === 'Aitaus') boundaries.push(pts)
      }
    } else if (curType === 'INSERT') {
      if (curPx !== null && curPy !== null && curLayer === 'PVcase PV Modules (full frames)') {
        if (curPx >= minX && curPx <= maxX && curPy >= minY && curPy <= maxY) {
          const m = curBlock.match(/2P(\d+)/)
          const panels = m ? parseInt(m[1]) : 22
          // Rotation is encoded in the block name like "2P44@30DEG ..."
          // rather than the DXF rotation group code (50), which is absent here.
          const degMatch = curBlock.match(/@(-?\d+(?:\.\d+)?)DEG/i)
          const blockRot = degMatch ? parseFloat(degMatch[1]) : 0
          inserts.push({ x: tx(curPx), y: ty(curPy), panels, rot: curRot || blockRot, block: curBlock })
        }
      }
    } else if (curType === 'TEXT') {
      if (curText && curPx !== null && curPy !== null && curLayer === 'Address') {
        if (curPx >= minX && curPx <= maxX && curPy >= minY && curPy <= maxY) {
          rowNumbers.push({ x: tx(curPx), y: ty(curPy), text: curText, height: curHeight })
        }
      }
    }
    curType = null
    curLayer = ''
    curBlock = ''
    curRot = 0
    curText = ''
    curHeight = 5
    curPx = null
    curPy = null
    curPts = []
    pendingVx = null
  }

  // Walk the whole file as strict (code, value) pairs.
  let i = 0
  while (i + 1 < n) {
    const code = lines[i]?.trim()
    const value = lines[i + 1]?.trim() ?? ''

    if (code === '0') {
      flushEntity()
      curType = value
      i += 2
      continue
    }

    if (curType === 'LWPOLYLINE') {
      if (code === '8') curLayer = value
      else if (code === '10') {
        const px = parseFloat(value)
        if (!isNaN(px)) pendingVx = px
      } else if (code === '20') {
        const py = parseFloat(value)
        if (!isNaN(py) && pendingVx !== null) {
          curPts.push([pendingVx, py])
          pendingVx = null
        }
      }
    } else if (curType === 'INSERT') {
      if (code === '8') curLayer = value
      else if (code === '2') curBlock = value
      else if (code === '10') { const p = parseFloat(value); if (!isNaN(p)) curPx = p }
      else if (code === '20') { const p = parseFloat(value); if (!isNaN(p)) curPy = p }
      else if (code === '50') { const r = parseFloat(value); if (!isNaN(r)) curRot = r }
    } else if (curType === 'TEXT') {
      if (code === '8') curLayer = value
      else if (code === '1') curText = value
      else if (code === '40') { const h = parseFloat(value); if (!isNaN(h)) curHeight = h }
      else if (code === '10') { const p = parseFloat(value); if (!isNaN(p)) curPx = p }
      else if (code === '20') { const p = parseFloat(value); if (!isNaN(p)) curPy = p }
    }

    i += 2
  }
  flushEntity() // catch the final entity in the file

  return { W, H, pvAreas, roads, boundaries, inserts, rowNumbers, minX, minY, maxX, maxY }
}
