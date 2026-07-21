// src/PaalutusView.jsx
// Paalutajien oma näkymä — TÄYSIN ERILLINEN InstallerView.jsx:stä (eri
// käyttäjäryhmä, eri kirjautuminen: pile_operators-taulu, ei installers).
// Avataan osoitteella ?paalutus.
import React, { useState, useEffect, useCallback } from 'react'
import { sb } from './supabaseClient.js'
import { KNOWN_SITES } from './shared.js'

const SESSION_KEY = 'wisol_pile_operator_session'

const PILE_TYPES = [
  { code: 'A', label: 'A — 2500×100' },
  { code: 'B', label: 'B — 2500×150' },
  { code: 'BB', label: 'BB — 2500×250' },
  { code: 'C', label: 'C — 3000×100' },
  { code: 'D', label: 'D — 3500×100' },
  { code: 'E', label: 'E — 3500×150' },
  { code: 'EE', label: 'EE — 3500×250' },
  { code: 'F', label: 'F — 4000×150' },
  { code: 'G', label: 'G — 4500×100' },
  { code: 'H', label: 'H — 5000×300' },
  { code: 'I', label: 'I — 5000×150 (+jatko 2500)' },
]

const EXTRA_ACTIONS = [
  { code: '', label: 'Ei lisätoimenpidettä' },
  { code: 'jatkopala_1650', label: 'Jatkopala 1650 mm' },
  { code: 'jatkopala_2200', label: 'Jatkopala 2200 mm' },
  { code: 'ankkurointi', label: 'Ankkurointi kallioon/kiveen + 1,45 m putki' },
  { code: 'katkaisu', label: 'Paalun katkaisu ja reikien teko' },
  { code: 'vaihto', label: 'Paalun vaihto' },
  { code: 'kiven_poisto', label: 'Pienen kiven poisto' },
]

function extraLabel(code) {
  return EXTRA_ACTIONS.find(e => e.code === code)?.label || code || ''
}
function typeLabel(code) {
  return PILE_TYPES.find(t => t.code === code)?.label || code || ''
}

// Pieni suhteellinen kartta rivin paaluista — pohjoinen ylöspäin (maailman
// Y kasvaa pohjoiseen), säilyttää oikean kuvasuhteen (rivi on yleensä pitkä
// ja kapea). Paalu numeroitu samalla numerolla kuin listassa alla, väritetty
// tilan mukaan, ja tapista voi avata saman muokkauksen kuin listasta.
function RowMiniMap({ piles, editingId, onSelect }) {
  if (!piles || piles.length === 0) return null
  const xs = piles.map(p => p.x), ys = piles.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)

  // Todenmukainen mittakaava (px/metri) — EI venytetä täyttämään laatikkoa,
  // koska rivi on hyvin pitkä (esim. 100 m) ja kapea (n. 2-3 m): täyttöön
  // venytetty kuva menisi aina paalut päällekkäin. Sen sijaan piirretään
  // oikeassa suhteessa ja annetaan leveän rivin vierittyä sivusuunnassa.
  const PX_PER_M = 14
  const pad = 24
  const boxH = 140
  const drawW = spanX * PX_PER_M
  const drawH = spanY * PX_PER_M
  const boxW = Math.max(320, drawW + pad * 2)
  const offX = pad
  const offY = pad + Math.max(0, (boxH - pad * 2 - drawH) / 2)

  const tx = x => offX + (x - minX) * PX_PER_M
  const ty = y => offY + (drawH - (y - minY) * PX_PER_M) // pohjoinen (suurempi Y) ylöspäin

  const editingPile = piles.find(p => p.id === editingId)
  const editingIdx = editingPile ? piles.indexOf(editingPile) : -1

  return (
    <div style={{ overflowX: 'auto', marginBottom: 12, borderRadius: 8, background: '#eef4ec' }}>
      <svg viewBox={`0 0 ${boxW} ${boxH}`} width={boxW} height={boxH} style={{ display: 'block' }}>
        <text x={boxW - 8} y={16} textAnchor="end" fontSize="11" fill="#666">N ↑</text>
        {piles.map((p, idx) => {
          const isEditing = editingId === p.id
          const color = p.status === 'done' ? '#1a7a45' : '#999'
          return (
            <g key={p.id} onClick={() => onSelect(p)} style={{ cursor: 'pointer' }}>
              {isEditing && <circle cx={tx(p.x)} cy={ty(p.y)} r={9} fill="none" stroke="#1a2fcc" strokeWidth={2} />}
              <circle cx={tx(p.x)} cy={ty(p.y)} r={5} fill={color} stroke="#fff" strokeWidth={1} />
            </g>
          )
        })}
        {editingIdx >= 0 && (
          <text x={tx(editingPile.x)} y={ty(editingPile.y) - 13} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#1a2fcc">
            #{editingIdx + 1}
          </text>
        )}
      </svg>
    </div>
  )
}

export default function PaalutusView() {
  const [session, setSession] = useState(null)
  const [operators, setOperators] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [pin, setPin] = useState('')
  const [loginErr, setLoginErr] = useState('')

  const [siteKey, setSiteKey] = useState('isoneva')
  const [rowSummary, setRowSummary] = useState(null) // null = ladataan, kaikki alueet+rivit tälle työmaalle
  const [selectedArea, setSelectedArea] = useState(null)
  const [selectedRow, setSelectedRow] = useState(null)
  const [rowPiles, setRowPiles] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [formType, setFormType] = useState('')
  const [formExtra, setFormExtra] = useState('')
  const [formKn, setFormKn] = useState('')
  const [saving, setSaving] = useState(false)
  const [exportMsg, setExportMsg] = useState('')

  // --- Kirjautuminen ---
  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY)
    if (saved) { try { setSession(JSON.parse(saved)) } catch {} }
    sb.from('pile_operators').select('id, name').order('name').then(({ data }) => {
      if (data) setOperators(data)
    })
  }, [])

  function login() {
    setLoginErr('')
    sb.from('pile_operators').select('id, name, pin').eq('id', selectedId).single().then(({ data }) => {
      if (data && String(data.pin) === String(pin)) {
        const s = { id: data.id, name: data.name }
        setSession(s)
        localStorage.setItem(SESSION_KEY, JSON.stringify(s))
      } else {
        setLoginErr('Väärä PIN')
      }
    })
  }

  function logout() {
    setSession(null)
    localStorage.removeItem(SESSION_KEY)
    setSelectedId(''); setPin('')
  }

  // --- Rivilistan lataus (kaikki alueet+rivit kerralla tälle työmaalle) ---
  const loadRowSummary = useCallback(() => {
    setRowSummary(null)
    sb.from('pile_rows_summary').select('*').eq('site', siteKey).order('area').order('row_number').then(({ data, error }) => {
      setRowSummary(error ? [] : (data || []))
    })
  }, [siteKey])

  useEffect(() => {
    if (session) loadRowSummary()
  }, [session, loadRowSummary])

  useEffect(() => { setSelectedArea(null); setSelectedRow(null) }, [siteKey])

  // Alueiden yhteenveto lasketaan rowSummary:sta (ei erillistä kyselyä)
  const areaSummary = React.useMemo(() => {
    if (!rowSummary) return null
    const byArea = new Map()
    for (const r of rowSummary) {
      if (!byArea.has(r.area)) byArea.set(r.area, { area: r.area, rows: 0, rowsDone: 0, total: 0, done: 0 })
      const a = byArea.get(r.area)
      a.rows += 1
      if (r.row_complete) a.rowsDone += 1
      a.total += r.total_piles
      a.done += r.done_piles
    }
    return [...byArea.values()].sort((a, b) => a.area.localeCompare(b.area))
  }, [rowSummary])

  // --- Yksittäisen rivin paalujen lataus (aina alueen sisällä) ---
  function openRow(rowNumber) {
    setSelectedRow(rowNumber)
    setRowPiles(null)
    setEditingId(null)
    sb.from('piles').select('*').eq('site', siteKey).eq('area', selectedArea).eq('row_number', rowNumber).order('id')
      .then(({ data, error }) => {
        if (error || !data) { setRowPiles([]); return }
        // HUOM: tietokannan järjestys on DXF:n piirtojärjestys, EI fyysinen
        // sijainti — ilman tätä "Paalu #3" ja "Paalu #67" voisivat olla
        // vierekkäin kartalla, mikä on hämmentävää. Järjestetään rivin
        // pidemmän suunnan mukaan (yleensä länsi-itä, joskus pohjois-etelä).
        const xs = data.map(p => p.x), ys = data.map(p => p.y)
        const spanX = Math.max(...xs) - Math.min(...xs)
        const spanY = Math.max(...ys) - Math.min(...ys)
        const sorted = [...data].sort((a, b) => spanX >= spanY ? (a.x - b.x) : (b.y - a.y))
        setRowPiles(sorted)
      })
  }

  function closeRow() {
    setSelectedRow(null)
    setRowPiles(null)
    setEditingId(null)
    loadRowSummary()
  }

  function closeArea() {
    setSelectedArea(null)
    setSelectedRow(null)
    setRowPiles(null)
  }

  function startEdit(pile) {
    setEditingId(pile.id)
    setFormType(pile.pile_type || '')
    setFormExtra(pile.extra_action || '')
    setFormKn(pile.pull_test_kn ?? '')
  }

  async function savePile(pileId) {
    if (!formType) { alert('Valitse paalukoko'); return }
    setSaving(true)
    const { data, error } = await sb.from('piles').update({
      pile_type: formType,
      extra_action: formExtra || null,
      pull_test_kn: formKn === '' ? null : parseFloat(formKn),
      status: 'done',
      installed_by: session.name,
      installed_at: new Date().toISOString()
    }).eq('id', pileId).select().single()
    setSaving(false)
    if (!error && data) {
      setRowPiles(prev => prev.map(p => p.id === pileId ? data : p))
      setEditingId(null)
    } else {
      alert('Tallennus epäonnistui, tarkista verkkoyhteys.')
    }
  }

  // --- Vienti PDF + CSV kun rivi valmis ---
  async function exportRow() {
    if (!rowPiles || rowPiles.length === 0) return
    setExportMsg('Luodaan tiedostoja...')
    const rowLabel = `${selectedArea} rivi ${selectedRow}`
    const siteLabel = KNOWN_SITES.find(s => s.key === siteKey)?.label || siteKey
    const dateStr = new Date().toLocaleDateString('fi-FI')

    // CSV (avautuu suoraan Exceliin)
    const csvHeader = 'Paalu #;Paalukoko;Lisätoimenpide;Vetotesti (kN);Asentaja;Aika\n'
    const csvRows = rowPiles.map((p, idx) =>
      [idx + 1, typeLabel(p.pile_type), extraLabel(p.extra_action), p.pull_test_kn ?? '', p.installed_by || '', p.installed_at ? new Date(p.installed_at).toLocaleString('fi-FI') : '']
        .map(v => String(v).replace(/;/g, ',')).join(';')
    ).join('\n')
    const csvBlob = new Blob(['\uFEFF' + csvHeader + csvRows], { type: 'text/csv;charset=utf-8' })
    const csvUrl = URL.createObjectURL(csvBlob)
    const csvLink = document.createElement('a')
    csvLink.href = csvUrl
    csvLink.download = `${siteLabel} - ${rowLabel} - ${dateStr}.csv`
    csvLink.click()
    URL.revokeObjectURL(csvUrl)

    // PDF
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ unit: 'mm', format: 'a4' })
    doc.setFontSize(14)
    doc.text(`${siteLabel} — ${rowLabel}`, 14, 16)
    doc.setFontSize(10)
    doc.text(`Pvm: ${dateStr}`, 14, 23)
    let y = 32
    doc.setFontSize(9)
    doc.text('#', 14, y); doc.text('Koko', 24, y); doc.text('Lisätoimenpide', 50, y)
    doc.text('Vetotesti kN', 110, y); doc.text('Asentaja', 140, y)
    y += 5
    doc.line(14, y - 3, 196, y - 3)
    rowPiles.forEach((p, idx) => {
      if (y > 280) { doc.addPage(); y = 16 }
      doc.text(String(idx + 1), 14, y)
      doc.text(typeLabel(p.pile_type) || '-', 24, y)
      doc.text(extraLabel(p.extra_action) || '-', 50, y, { maxWidth: 58 })
      doc.text(p.pull_test_kn != null ? String(p.pull_test_kn) : '-', 110, y)
      doc.text(p.installed_by || '-', 140, y)
      y += 6
    })
    doc.save(`${siteLabel} - ${rowLabel} - ${dateStr}.pdf`)

    setExportMsg('✅ PDF ja CSV ladattu — lähetä ne työnjohdolle esim. sähköpostilla tai WhatsAppilla.')
  }

  // --- Kirjautumisnäkymä ---
  if (!session) {
    return (
      <div style={{ maxWidth: 420, margin: '0 auto', padding: 20, fontFamily: 'sans-serif' }}>
        <h2>Paalutus — kirjaudu</h2>
        <label style={{ display: 'block', marginBottom: 6, fontWeight: 'bold' }}>Nimi</label>
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
          style={{ width: '100%', padding: 10, fontSize: 16, marginBottom: 12 }}>
          <option value="">Valitse nimesi</option>
          {operators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <label style={{ display: 'block', marginBottom: 6, fontWeight: 'bold' }}>PIN-koodi</label>
        <input type="tel" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value)}
          style={{ width: '100%', padding: 10, fontSize: 16, marginBottom: 12 }} />
        {loginErr && <div style={{ color: '#b02828', marginBottom: 12 }}>{loginErr}</div>}
        <button onClick={login} disabled={!selectedId || !pin}
          style={{ width: '100%', padding: 12, fontSize: 16, fontWeight: 'bold', background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8 }}>
          Kirjaudu
        </button>
      </div>
    )
  }

  // --- Yksittäisen rivin näkymä ---
  if (selectedRow != null) {
    const doneCount = rowPiles ? rowPiles.filter(p => p.status === 'done').length : 0
    const allDone = rowPiles && rowPiles.length > 0 && doneCount === rowPiles.length
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 16, fontFamily: 'sans-serif', paddingBottom: 80 }}>
        <button onClick={closeRow} style={{ marginBottom: 12, padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff' }}>
          ← Takaisin riveihin
        </button>
        <h2>{selectedArea} — rivi {selectedRow}</h2>
        {rowPiles == null ? <p>Ladataan...</p> : (
          <>
            <RowMiniMap piles={rowPiles} editingId={editingId} onSelect={p => editingId === p.id ? setEditingId(null) : startEdit(p)} />
            <p style={{ color: '#666' }}>{doneCount} / {rowPiles.length} paalua merkitty</p>
            {rowPiles.map((p, idx) => (
              <div key={p.id} style={{
                border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 8,
                background: p.status === 'done' ? '#e8f5e9' : '#fff'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={() => editingId === p.id ? setEditingId(null) : startEdit(p)}>
                  <div>
                    <b>Paalu #{idx + 1}</b>
                    {p.status === 'done' && (
                      <div style={{ fontSize: 13, color: '#1a7a45' }}>
                        {typeLabel(p.pile_type)}{p.extra_action ? ` · ${extraLabel(p.extra_action)}` : ''}{p.pull_test_kn != null ? ` · ${p.pull_test_kn} kN` : ''}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 20 }}>{p.status === 'done' ? '✅' : '⬜'}</span>
                </div>

                {editingId === p.id && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
                    <label style={{ fontSize: 13, fontWeight: 'bold' }}>Paalukoko</label>
                    <select value={formType} onChange={e => setFormType(e.target.value)}
                      style={{ width: '100%', padding: 8, fontSize: 15, marginBottom: 8 }}>
                      <option value="">Valitse...</option>
                      {PILE_TYPES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                    </select>

                    <label style={{ fontSize: 13, fontWeight: 'bold' }}>Lisätoimenpide</label>
                    <select value={formExtra} onChange={e => setFormExtra(e.target.value)}
                      style={{ width: '100%', padding: 8, fontSize: 15, marginBottom: 8 }}>
                      {EXTRA_ACTIONS.map(e => <option key={e.code} value={e.code}>{e.label}</option>)}
                    </select>

                    <label style={{ fontSize: 13, fontWeight: 'bold' }}>Vetotesti (kN)</label>
                    <input type="number" inputMode="decimal" value={formKn} onChange={e => setFormKn(e.target.value)}
                      style={{ width: '100%', padding: 8, fontSize: 15, marginBottom: 10 }} />

                    <button onClick={() => savePile(p.id)} disabled={saving}
                      style={{ width: '100%', padding: 10, fontWeight: 'bold', background: '#1a7a45', color: '#fff', border: 'none', borderRadius: 6 }}>
                      {saving ? 'Tallennetaan...' : '✓ Tallenna'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {allDone && (
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: 12, background: '#fff', borderTop: '1px solid #ddd' }}>
            <button onClick={exportRow}
              style={{ width: '100%', maxWidth: 480, margin: '0 auto', display: 'block', padding: 14, fontSize: 16, fontWeight: 'bold', background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8 }}>
              📤 Rivi valmis — vie PDF + Excel
            </button>
            {exportMsg && <p style={{ textAlign: 'center', fontSize: 13, marginTop: 6 }}>{exportMsg}</p>}
          </div>
        )}
      </div>
    )
  }

  // --- Aluevalintanäkymä ---
  if (selectedArea == null) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 16, fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Paalutus — {session.name}</h2>
          <button onClick={logout} style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', fontSize: 13 }}>
            Vaihda käyttäjä
          </button>
        </div>

        <select value={siteKey} onChange={e => setSiteKey(e.target.value)}
          style={{ width: '100%', padding: 8, fontSize: 15, marginBottom: 12 }}>
          {KNOWN_SITES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>

        {areaSummary == null ? <p>Ladataan alueita...</p> :
          areaSummary.length === 0 ? <p>Ei paalutietoja tälle työmaalle. Onko tuonti (?paalutuonti) ajettu?</p> :
          areaSummary.map(a => {
            const complete = a.rowsDone === a.rows
            return (
              <div key={a.area} onClick={() => setSelectedArea(a.area)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: 14, marginBottom: 6, borderRadius: 8, cursor: 'pointer',
                  background: complete ? '#e8f5e9' : '#f7f7f7', border: '1px solid #e0e0e0'
                }}>
                <b>{a.area}</b>
                <span style={{ color: complete ? '#1a7a45' : '#666', fontSize: 14 }}>
                  {a.rowsDone}/{a.rows} riviä · {a.done}/{a.total} paalua {complete ? '✅' : ''}
                </span>
              </div>
            )
          })
        }
      </div>
    )
  }

  // --- Rivilistanäkymä (valitun alueen sisällä) ---
  const areaRows = (rowSummary || []).filter(r => r.area === selectedArea)
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 16, fontFamily: 'sans-serif' }}>
      <button onClick={closeArea} style={{ marginBottom: 12, padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff' }}>
        ← Takaisin alueisiin
      </button>
      <h2 style={{ marginTop: 0 }}>{selectedArea}</h2>

      {areaRows.map(r => (
        <div key={r.row_number} onClick={() => openRow(r.row_number)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: 14, marginBottom: 6, borderRadius: 8, cursor: 'pointer',
            background: r.row_complete ? '#e8f5e9' : '#f7f7f7', border: '1px solid #e0e0e0'
          }}>
          <b>Rivi {r.row_number}</b>
          <span style={{ color: r.row_complete ? '#1a7a45' : '#666' }}>
            {r.done_piles} / {r.total_piles} {r.row_complete ? '✅' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
