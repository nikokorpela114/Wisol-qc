// src/PileImport.jsx
// Kertaluontoinen (mutta uudelleenajettava) tuontisivu paalukartta-DXF:lle.
// Avataan osoitteella ?paalutuonti — ei linkitetty mistään näkyvästä
// valikosta, samaan tapaan kuin ?valvomo.
import React, { useState } from 'react'
import { sb } from './supabaseClient.js'
import { parsePilePoints, groupPilesIntoRows } from './dxfParser.js'
import { KNOWN_SITES } from './shared.js'

const BATCH_SIZE = 500

export default function PileImport() {
  const [siteKey, setSiteKey] = useState('isoneva')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [done, setDone] = useState(false)

  function addLog(msg) {
    setLog(prev => [...prev, msg])
  }

  async function runImport() {
    setBusy(true)
    setDone(false)
    setLog([])
    try {
      addLog(`Ladataan ${siteKey}.dxf Supabase Storagesta...`)
      const { data, error } = await sb.storage.from('maps').download(`${siteKey}.dxf`)
      if (error || !data) {
        addLog('❌ DXF:ää ei löytynyt bucketista "maps". Tarkista tiedostonimi.')
        setBusy(false)
        return
      }
      const text = await data.text()

      addLog('Parsitaan paalupisteet...')
      const rawPiles = parsePilePoints(text)
      addLog(`Löytyi ${rawPiles.length} paalupistettä.`)
      if (rawPiles.length === 0) {
        addLog('❌ Ei paalupisteitä layerilla "PVcase Poles Centres" — tarkista että DXF on oikea paalukartta.')
        setBusy(false)
        return
      }

      addLog('Ryhmitellään rivit (XDATA + jälkiklusterointi)...')
      const rows = groupPilesIntoRows(rawPiles)
      const rowCount = new Set(rows.map(r => r.rowNumber)).size
      addLog(`Muodostui ${rowCount} riviä.`)

      addLog(`Tallennetaan Supabaseen (${BATCH_SIZE} kerrallaan, upsert pole_id:n mukaan)...`)
      let saved = 0
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE).map(r => ({
          site: siteKey,
          pole_id: r.poleId,
          row_group_id: r.rowGroupId,
          row_number: r.rowNumber,
          x: r.x,
          y: r.y
        }))
        const { error: upErr } = await sb.from('piles').upsert(batch, { onConflict: 'pole_id' })
        if (upErr) {
          addLog(`❌ Virhe erässä ${i}-${i + batch.length}: ${upErr.message}`)
          setBusy(false)
          return
        }
        saved += batch.length
        addLog(`  ...${saved} / ${rows.length} tallennettu`)
      }

      addLog(`✅ Valmis! ${saved} paalua, ${rowCount} riviä tuotu työmaalle "${siteKey}".`)
      setDone(true)
    } catch (e) {
      addLog(`❌ Odottamaton virhe: ${e.message}`)
    }
    setBusy(false)
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 20, fontFamily: 'sans-serif' }}>
      <h2>Paalujen tuonti DXF:stä</h2>
      <p style={{ color: '#666', fontSize: 14 }}>
        Lukee valitun työmaan paalukartta-DXF:n Storagesta (bucket "maps"),
        parsii paalupisteet ja rivit, ja tallentaa/päivittää ne piles-tauluun.
        Tämän voi ajaa uudelleen turvallisesti (upsert pole_id:n mukaan, ei tee tuplia).
      </p>

      <label style={{ display: 'block', marginBottom: 6, fontWeight: 'bold' }}>Työmaa</label>
      <select
        value={siteKey}
        onChange={e => setSiteKey(e.target.value)}
        disabled={busy}
        style={{ width: '100%', padding: 8, marginBottom: 16, fontSize: 16 }}
      >
        {KNOWN_SITES.map(s => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>

      <button
        onClick={runImport}
        disabled={busy}
        style={{
          width: '100%', padding: 12, fontSize: 16, fontWeight: 'bold',
          background: busy ? '#ccc' : '#1a7a45', color: 'white', border: 'none', borderRadius: 6
        }}
      >
        {busy ? 'Tuodaan...' : done ? '✅ Tuo uudelleen' : 'Tuo paalut'}
      </button>

      <div style={{
        marginTop: 16, background: '#f4f4f4', borderRadius: 6, padding: 12,
        fontSize: 13, fontFamily: 'monospace', maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap'
      }}>
        {log.length === 0 ? 'Loki näkyy tässä...' : log.join('\n')}
      </div>
    </div>
  )
}
