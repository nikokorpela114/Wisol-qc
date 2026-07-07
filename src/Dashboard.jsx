// src/Dashboard.jsx
// Työnjohtajan "valvomo" — työpöytäkäyttöön tarkoitettu yleiskatsaus siitä
// kuka on korjaamassa mitä, mitä on vielä auki ja mitä on jo korjattu.
// Avataan osoitteesta /?valvomo (sama reititysperiaate kuin /?asentaja).
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { sb } from './supabaseClient.js'
import { KNOWN_SITES } from './shared.js'

const sevColor = { Kriittinen: '#b02828', Huomio: '#a06800', Info: '#1a7a45' }
const sevBg = { Kriittinen: '#fde2e2', Huomio: '#fdf0d5', Info: '#dcefe3' }
const REFRESH_MS = 30000

export default function Dashboard() {
  const [obs, setObs] = useState([])
  const [installers, setInstallers] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [siteFilter, setSiteFilter] = useState('')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('open') // 'open' | 'fixed'

  const load = useCallback(async () => {
    const [{ data: o, error: oErr }, { data: i, error: iErr }] = await Promise.all([
      sb.from('observations').select('*').order('created_at', { ascending: false }).limit(3000),
      sb.from('installers').select('*').order('name'),
    ])
    if (oErr) console.error('Dashboard: observations fetch failed', oErr)
    if (iErr) console.error('Dashboard: installers fetch failed', iErr)
    setObs(o || [])
    setInstallers(i || [])
    setLoading(false)
    setLastRefresh(new Date())
  }, [])

  // Lataa heti, ja päivittää sen jälkeen automaattisesti taustalla — tämä
  // näkymä on tarkoitus jättää auki työpöydälle, joten sen pitää pysyä
  // ajan tasalla ilman manuaalista selaimen päivitystä.
  useEffect(() => {
    load()
    const iv = setInterval(load, REFRESH_MS)
    return () => clearInterval(iv)
  }, [load])

  const installerById = useMemo(() => {
    const m = new Map()
    installers.forEach(i => m.set(i.id, i))
    return m
  }, [installers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return obs.filter(o => {
      if (siteFilter && o.site !== siteFilter) return false
      if (q) {
        const hay = `${o.cat || ''} ${o.note || ''} ${o.rivi || ''} ${o.inspector || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [obs, siteFilter, search])

  const openObs = useMemo(() => filtered.filter(o => o.status !== 'korjattu'), [filtered])
  const fixedObs = useMemo(() => filtered.filter(o => o.status === 'korjattu'), [filtered])
  const totalCritical = useMemo(() => openObs.filter(o => o.sev === 'Kriittinen').length, [openObs])

  // Avoimet ryhmiteltynä asentajan mukaan — '__unassigned' = ei vielä
  // lähetetty kenellekään asentajalle.
  const openByInstaller = useMemo(() => {
    const groups = new Map()
    openObs.forEach(o => {
      const key = o.assigned_installer_id || '__unassigned'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(o)
    })
    return groups
  }, [openObs])

  const fixedSorted = useMemo(
    () => [...fixedObs].sort((a, b) => new Date(b.fixed_at || 0) - new Date(a.fixed_at || 0)),
    [fixedObs]
  )

  const fmtTime = iso => iso
    ? new Date(iso).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6fb', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ background: '#1a2fcc', padding: '18px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 20, letterSpacing: 0.3 }}>WISOL · Valvomo</div>
          <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, marginTop: 2 }}>
            {loading ? 'Ladataan…' : `Päivitetty ${lastRefresh?.toLocaleTimeString('fi-FI')} · päivittyy automaattisesti`}
          </div>
        </div>
        <button onClick={load} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          🔄 Päivitä nyt
        </button>
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 28px 60px' }}>
        {/* Yhteenveto */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <SummaryCard label="Avoimia" value={openObs.length} color="#1a2fcc" />
          <SummaryCard label="Joista kriittisiä" value={totalCritical} color="#b02828" />
          <SummaryCard label="Korjattu" value={fixedObs.length} color="#1a8a50" />
          <SummaryCard label="Asentajia" value={installers.length} color="#6670a0" />
        </div>

        {/* Suodattimet */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} style={selectStyle}>
            <option value="">Kaikki työmaat</option>
            {KNOWN_SITES.map(s => <option key={s.key} value={s.label}>{s.label}</option>)}
          </select>
          <input
            placeholder="Hae (vikatyyppi, rivi, tarkastaja)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...selectStyle, flex: 1, minWidth: 220 }}
          />
          <div style={{ display: 'flex', gap: 4, background: '#e8ebf5', padding: 4, borderRadius: 9 }}>
            <TabButton active={tab === 'open'} onClick={() => setTab('open')}>Avoimet ({openObs.length})</TabButton>
            <TabButton active={tab === 'fixed'} onClick={() => setTab('fixed')}>Korjatut ({fixedObs.length})</TabButton>
          </div>
        </div>

        {tab === 'open' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {[...openByInstaller.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([key, items]) => {
                const installer = key === '__unassigned' ? null : installerById.get(key)
                const critCount = items.filter(o => o.sev === 'Kriittinen').length
                return (
                  <div key={key} style={{ background: '#fff', borderRadius: 12, border: '1px solid #d0d5e8', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '12px 16px', background: installer ? '#eef0f7' : '#fdf0d5', borderBottom: '1px solid #d0d5e8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e' }}>
                        {installer ? `👷 ${installer.name}` : '📋 Ei lähetetty kenellekään'}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: critCount > 0 ? '#b02828' : '#6670a0' }}>
                        {items.length} kpl{critCount > 0 ? ` · ${critCount} kriitt.` : ''}
                      </span>
                    </div>
                    <div style={{ maxHeight: 440, overflowY: 'auto' }}>
                      {items.map(o => (
                        <div key={o.id} style={{ padding: '10px 16px', borderBottom: '1px solid #f0f1f7' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#222' }}>{o.cat}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev], whiteSpace: 'nowrap', flexShrink: 0 }}>
                              {o.sev}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: '#9aa2c0', marginTop: 3 }}>
                            {o.site}{o.rivi ? ` · ${o.rivi}` : ''} · {fmtTime(o.created_at)}
                          </div>
                          {o.note && <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>{o.note}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            {openByInstaller.size === 0 && (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#6670a0', padding: 60, fontSize: 15 }}>
                Ei avoimia vikoja 🎉
              </div>
            )}
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #d0d5e8', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#eef0f7', textAlign: 'left' }}>
                  <th style={thStyle}>Vika</th>
                  <th style={thStyle}>Vakavuus</th>
                  <th style={thStyle}>Työmaa / rivi</th>
                  <th style={thStyle}>Korjaaja</th>
                  <th style={thStyle}>Havaittu</th>
                  <th style={thStyle}>Korjattu</th>
                </tr>
              </thead>
              <tbody>
                {fixedSorted.map(o => (
                  <tr key={o.id} style={{ borderBottom: '1px solid #f0f1f7' }}>
                    <td style={tdStyle}>{o.cat}</td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span>
                    </td>
                    <td style={tdStyle}>{o.site}{o.rivi ? ` · ${o.rivi}` : ''}</td>
                    <td style={tdStyle}>{installerById.get(o.assigned_installer_id)?.name || '—'}</td>
                    <td style={tdStyle}>{fmtTime(o.created_at)}</td>
                    <td style={tdStyle}>{fmtTime(o.fixed_at)}</td>
                  </tr>
                ))}
                {fixedSorted.length === 0 && (
                  <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#9aa2c0', padding: 40 }}>Ei vielä korjattuja</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #d0d5e8', padding: '16px 22px', minWidth: 150 }}>
      <div style={{ fontSize: 27, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6670a0', marginTop: 3 }}>{label}</div>
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
        background: active ? '#1a2fcc' : 'transparent', color: active ? '#fff' : '#4a5480',
      }}
    >
      {children}
    </button>
  )
}

const selectStyle = { padding: '9px 12px', borderRadius: 8, border: '1px solid #d0d5e8', fontSize: 13, background: '#fff', color: '#222' }
const thStyle = { padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6670a0', textTransform: 'uppercase', letterSpacing: 0.3 }
const tdStyle = { padding: '10px 16px' }
