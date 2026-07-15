// src/Dashboard.jsx
// Työnjohtajan "valvomo" — työpöytäkäyttöön tarkoitettu yleiskatsaus siitä
// kuka (henkilö tai tiimi) on korjaamassa mitä, mikä on auki, mikä korjattu.
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
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [siteFilter, setSiteFilter] = useState('')
  const [teamFilter, setTeamFilter] = useState('')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('open') // 'open' | 'fixed' | 'hidden' | 'teams'
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [newInstallerName, setNewInstallerName] = useState('')
  const [newInstallerPin, setNewInstallerPin] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState(null) // korjauskuvan suurennettu näkymä

  const load = useCallback(async () => {
    const [{ data: o, error: oErr }, { data: i, error: iErr }, { data: tm, error: tErr }] = await Promise.all([
      sb.from('observations').select('*').order('created_at', { ascending: false }).limit(3000),
      sb.from('installers').select('*').order('name'),
      sb.from('teams').select('*').order('name'),
    ])
    if (oErr) console.error('Dashboard: observations fetch failed', oErr)
    if (iErr) console.error('Dashboard: installers fetch failed', iErr)
    if (tErr) console.error('Dashboard: teams fetch failed', tErr)
    setObs(o || [])
    setInstallers(i || [])
    setTeams(tm || [])
    setLoading(false)
    setLastRefresh(new Date())
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, REFRESH_MS)
    return () => clearInterval(iv)
  }, [load])

  const installerById = useMemo(() => {
    const m = new Map(); installers.forEach(i => m.set(i.id, i)); return m
  }, [installers])
  const teamById = useMemo(() => {
    const m = new Map(); teams.forEach(t => m.set(t.id, t)); return m
  }, [teams])

  // Ryhmittelyavain jokaiselle havainnolle: tiimi (jos asentaja kuuluu
  // tiimiin, tai havainto on osoitettu suoraan tiimille), muuten
  // yksittäinen asentaja, muuten "ei lähetetty kenellekään".
  const groupInfo = useCallback(o => {
    if (o.assigned_team_id) return { key: 'team:' + o.assigned_team_id, team: teamById.get(o.assigned_team_id), installer: null }
    if (o.assigned_installer_id) {
      const inst = installerById.get(o.assigned_installer_id)
      if (inst?.team_id) return { key: 'team:' + inst.team_id, team: teamById.get(inst.team_id), installer: inst }
      return { key: 'inst:' + o.assigned_installer_id, team: null, installer: inst }
    }
    return { key: '__unassigned', team: null, installer: null }
  }, [installerById, teamById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return obs.filter(o => {
      if (siteFilter && o.site !== siteFilter) return false
      if (teamFilter) {
        const g = groupInfo(o)
        if (g.key !== 'team:' + teamFilter) return false
      }
      if (q) {
        const hay = `${o.cat || ''} ${o.note || ''} ${o.rivi || ''} ${o.inspector || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [obs, siteFilter, teamFilter, search, groupInfo])

  const openObs = useMemo(() => filtered.filter(o => o.status !== 'korjattu' && !o.hidden_at), [filtered])
  const fixedObs = useMemo(() => filtered.filter(o => o.status === 'korjattu' && !o.hidden_at), [filtered])
  const hiddenObs = useMemo(() => filtered.filter(o => !!o.hidden_at), [filtered])
  const totalCritical = useMemo(() => openObs.filter(o => o.sev === 'Kriittinen').length, [openObs])

  const openByGroup = useMemo(() => {
    const groups = new Map()
    openObs.forEach(o => {
      const g = groupInfo(o)
      if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] })
      groups.get(g.key).items.push(o)
    })
    return groups
  }, [openObs, groupInfo])

  const fixedSorted = useMemo(
    () => [...fixedObs].sort((a, b) => new Date(b.fixed_at || 0) - new Date(a.fixed_at || 0)),
    [fixedObs]
  )
  const hiddenSorted = useMemo(
    () => [...hiddenObs].sort((a, b) => new Date(b.hidden_at || 0) - new Date(a.hidden_at || 0)),
    [hiddenObs]
  )

  const fmtTime = iso => iso
    ? new Date(iso).toLocaleString('fi-FI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—'

  const toggleSelect = id => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const clearSelection = () => setSelected(new Set())

  const toggleSelectGroup = items => setSelected(prev => {
    const ids = items.map(o => o.id)
    const allSelected = ids.every(id => prev.has(id))
    const next = new Set(prev)
    ids.forEach(id => allSelected ? next.delete(id) : next.add(id))
    return next
  })

  async function hideSelected() {
    if (selected.size === 0) return
    setBusy(true)
    const { data, error } = await sb.from('observations').update({ hidden_at: new Date().toISOString() }).in('id', [...selected]).select()
    if (error) { console.error(error); alert('Piilotus epäonnistui: ' + error.message) }
    else if (!data || data.length === 0) alert('Piilotus ei muuttanut mitään — aja teams_rls_fix.sql Supabasen SQL Editorissa.')
    clearSelection(); setBusy(false); load()
  }
  async function unhideSelected() {
    if (selected.size === 0) return
    setBusy(true)
    const { data, error } = await sb.from('observations').update({ hidden_at: null }).in('id', [...selected]).select()
    if (error) { console.error(error); alert('Palautus epäonnistui: ' + error.message) }
    else if (!data || data.length === 0) alert('Palautus ei muuttanut mitään — aja teams_rls_fix.sql Supabasen SQL Editorissa.')
    clearSelection(); setBusy(false); load()
  }
  async function deleteSelected() {
    if (selected.size === 0) return
    if (!window.confirm(`Poistetaanko ${selected.size} havaintoa pysyvästi? Tätä ei voi perua.`)) return
    setBusy(true)
    const { error } = await sb.from('observations').delete().in('id', [...selected])
    if (error) { console.error(error); alert('Poisto epäonnistui: ' + error.message + '\n\nJos virhe mainitsee "permission denied", teams_schema.sql:n DELETE-oikeutta ei ole ajettu Supabaseen.') }
    clearSelection(); setBusy(false); load()
  }

  async function createTeam() {
    const name = newTeamName.trim()
    if (!name) return
    const { error } = await sb.from('teams').insert([{ name }])
    if (error) { alert('Tiimin luonti epäonnistui: ' + error.message); return }
    setNewTeamName('')
    load()
  }
  async function deleteTeam(id) {
    if (!window.confirm('Poistetaanko tiimi? Jäsenet jäävät ilman tiimiä, eivät poistu.')) return
    const { error } = await sb.from('teams').delete().eq('id', id)
    if (error) { alert('Poisto epäonnistui: ' + error.message); return }
    load()
  }
  async function setInstallerTeam(installerId, teamId) {
    const { data, error } = await sb.from('installers').update({ team_id: teamId || null }).eq('id', installerId).select()
    if (error) { alert('Tallennus epäonnistui: ' + error.message); return }
    if (!data || data.length === 0) {
      alert('Tallennus ei muuttanut mitään — todennäköisesti Row Level Security estää päivityksen. Aja teams_rls_fix.sql Supabasen SQL Editorissa.')
      return
    }
    load()
  }

  async function addInstaller() {
    const name = newInstallerName.trim(), pinVal = newInstallerPin.trim()
    if (!name || pinVal.length < 4) { alert('Anna nimi ja vähintään 4-numeroinen PIN.'); return }
    const { data, error } = await sb.from('installers').insert([{ name, pin: pinVal }]).select()
    if (error) { alert('Lisäys epäonnistui: ' + error.message); return }
    if (!data || data.length === 0) { alert('Lisäys ei tallentunut — tarkista RLS-oikeudet (teams_rls_fix.sql).'); return }
    setNewInstallerName(''); setNewInstallerPin('')
    load()
  }

  async function deleteInstaller(installer) {
    const assignedCount = obs.filter(o => o.assigned_installer_id === installer.id).length
    const warn = assignedCount > 0
      ? `${installer.name} on merkitty ${assignedCount} havainnon korjaajaksi/vastaanottajaksi. Nämä havainnot säilyvät, mutta "korjaaja"-tieto niissä tyhjenee. Poistetaanko silti?`
      : `Poistetaanko asentaja ${installer.name}?`
    if (!window.confirm(warn)) return
    const { error } = await sb.from('installers').delete().eq('id', installer.id)
    if (error) {
      alert('Poisto epäonnistui: ' + error.message + '\n\nJos virhe mainitsee viiteavaimen (foreign key), aja installer_delete_fix.sql Supabasen SQL Editorissa.')
      return
    }
    load()
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f6f7fb', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #1a2fcc, #2438e8)', padding: '20px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, boxShadow: '0 2px 12px rgba(26,47,204,0.18)' }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 21, letterSpacing: 0.2 }}>WISOL <span style={{ opacity: 0.55, fontWeight: 500 }}>·</span> Valvomo</div>
          <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12.5, marginTop: 3 }}>
            {loading ? 'Ladataan…' : `Päivitetty ${lastRefresh?.toLocaleTimeString('fi-FI')} · päivittyy automaattisesti`}
          </div>
        </div>
        <button onClick={load} style={{ background: 'rgba(255,255,255,0.16)', border: 'none', color: '#fff', borderRadius: 9, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'background 0.15s' }}>
          🔄 Päivitä nyt
        </button>
      </div>

      <div style={{ maxWidth: 1440, margin: '0 auto', padding: '26px 30px 70px' }}>
        {/* Yhteenveto */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 26, flexWrap: 'wrap' }}>
          <SummaryCard label="Avoimia" value={openObs.length} color="#1a2fcc" />
          <SummaryCard label="Joista kriittisiä" value={totalCritical} color="#b02828" />
          <SummaryCard label="Korjattu" value={fixedObs.length} color="#1a8a50" />
          <SummaryCard label="Asentajia" value={installers.length} color="#6670a0" />
          <SummaryCard label="Tiimejä" value={teams.length} color="#8a5fc9" />
        </div>

        {/* Suodattimet */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} style={selectStyle}>
            <option value="">Kaikki työmaat</option>
            {KNOWN_SITES.map(s => <option key={s.key} value={s.label}>{s.label}</option>)}
          </select>
          <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)} style={selectStyle}>
            <option value="">Kaikki tiimit</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input
            placeholder="Hae (vikatyyppi, rivi, tarkastaja)…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...selectStyle, flex: 1, minWidth: 220 }}
          />
          <div style={{ display: 'flex', gap: 3, background: '#e9ebf6', padding: 4, borderRadius: 10 }}>
            <TabButton active={tab === 'open'} onClick={() => { setTab('open'); clearSelection() }}>Avoimet ({openObs.length})</TabButton>
            <TabButton active={tab === 'fixed'} onClick={() => { setTab('fixed'); clearSelection() }}>Korjatut ({fixedObs.length})</TabButton>
            <TabButton active={tab === 'hidden'} onClick={() => { setTab('hidden'); clearSelection() }}>Piilotetut ({hiddenObs.length})</TabButton>
            <TabButton active={tab === 'teams'} onClick={() => { setTab('teams'); clearSelection() }}>Tiimit</TabButton>
          </div>
        </div>

        {/* Massatoimintopalkki */}
        {selected.size > 0 && tab !== 'teams' && (
          <div style={{ position: 'sticky', top: 12, zIndex: 10, background: '#fff', border: '1px solid #d0d5e8', borderRadius: 12, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 4px 16px rgba(20,30,80,0.10)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0d1a6e' }}>{selected.size} valittu</span>
            <div style={{ flex: 1 }} />
            {tab === 'hidden' ? (
              <ActionBtn onClick={unhideSelected} disabled={busy} color="#1a8a50">↩️ Palauta</ActionBtn>
            ) : (
              <ActionBtn onClick={hideSelected} disabled={busy} color="#a06800">🙈 Piilota</ActionBtn>
            )}
            <ActionBtn onClick={deleteSelected} disabled={busy} color="#b02828">🗑️ Poista pysyvästi</ActionBtn>
            <button onClick={clearSelection} style={{ background: 'none', border: 'none', color: '#9aa2c0', fontSize: 13, cursor: 'pointer', padding: '6px 8px' }}>Peruuta</button>
          </div>
        )}

        {tab === 'open' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 16 }}>
            {[...openByGroup.values()]
              .sort((a, b) => b.items.length - a.items.length)
              .map(g => {
                const critCount = g.items.filter(o => o.sev === 'Kriittinen').length
                const title = g.team ? `🧑‍🤝‍🧑 ${g.team.name}` : g.installer ? `👷 ${g.installer.name}` : '📋 Ei lähetetty kenellekään'
                const headerBg = g.team ? '#f1ecfb' : g.installer ? '#eef0f7' : '#fdf0d5'
                const allSelected = g.items.length > 0 && g.items.every(o => selected.has(o.id))
                return (
                  <div key={g.key} style={cardStyle}>
                    <div style={{ padding: '13px 16px', background: headerBg, borderBottom: '1px solid #e4e7f3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e' }}>{title}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: critCount > 0 ? '#b02828' : '#6670a0' }}>
                        {g.items.length} kpl{critCount > 0 ? ` · ${critCount} kriitt.` : ''}
                      </span>
                    </div>
                    {g.team && g.team.name && (
                      <div style={{ padding: '6px 16px', fontSize: 11, color: '#8a5fc9', background: '#faf8ff', borderBottom: '1px solid #f0f1f7' }}>
                        {installers.filter(i => i.team_id === g.team.id).map(i => i.name).join(', ') || 'Ei jäseniä'}
                      </div>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', fontSize: 12, color: '#6670a0', borderBottom: '1px solid #f0f1f7', cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" checked={allSelected} onChange={() => toggleSelectGroup(g.items)} />
                      {allSelected ? 'Poista kaikki valinnat' : 'Valitse kaikki'}
                    </label>
                    <div style={{ maxHeight: 440, overflowY: 'auto' }}>
                      {g.items.map(o => (
                        <ObsRow key={o.id} o={o} fmtTime={fmtTime} selected={selected.has(o.id)} onToggle={() => toggleSelect(o.id)} />
                      ))}
                    </div>
                  </div>
                )
              })}
            {openByGroup.size === 0 && <EmptyState text="Ei avoimia vikoja 🎉" />}
          </div>
        )}

        {tab === 'fixed' && (
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#eef0f7', textAlign: 'left' }}>
                  <th style={{ ...thStyle, width: 34 }}>
                    <input type="checkbox" checked={fixedSorted.length > 0 && fixedSorted.every(o => selected.has(o.id))} onChange={() => toggleSelectGroup(fixedSorted)} />
                  </th>
                  <th style={thStyle}>Vika</th>
                  <th style={thStyle}>Vakavuus</th>
                  <th style={thStyle}>Työmaa / rivi</th>
                  <th style={thStyle}>Korjaaja</th>
                  <th style={thStyle}>Havaittu</th>
                  <th style={thStyle}>Korjattu</th>
                  <th style={thStyle}>Kuva</th>
                </tr>
              </thead>
              <tbody>
                {fixedSorted.map(o => (
                  <TableRow key={o.id} o={o} installerById={installerById} fmtTime={fmtTime} selected={selected.has(o.id)} onToggle={() => toggleSelect(o.id)} onOpenPhoto={setLightboxSrc} />
                ))}
                {fixedSorted.length === 0 && (
                  <tr><td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: '#9aa2c0', padding: 40 }}>Ei vielä korjattuja</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'hidden' && (
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#eef0f7', textAlign: 'left' }}>
                  <th style={{ ...thStyle, width: 34 }}>
                    <input type="checkbox" checked={hiddenSorted.length > 0 && hiddenSorted.every(o => selected.has(o.id))} onChange={() => toggleSelectGroup(hiddenSorted)} />
                  </th>
                  <th style={thStyle}>Vika</th>
                  <th style={thStyle}>Vakavuus</th>
                  <th style={thStyle}>Työmaa / rivi</th>
                  <th style={thStyle}>Tila</th>
                  <th style={thStyle}>Piilotettu</th>
                </tr>
              </thead>
              <tbody>
                {hiddenSorted.map(o => (
                  <tr key={o.id} style={{ borderBottom: '1px solid #f0f1f7' }}>
                    <td style={tdStyle}><input type="checkbox" checked={selected.has(o.id)} onChange={() => toggleSelect(o.id)} /></td>
                    <td style={tdStyle}>{o.cat}</td>
                    <td style={tdStyle}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span></td>
                    <td style={tdStyle}>{o.site}{o.rivi ? ` · ${o.rivi}` : ''}</td>
                    <td style={tdStyle}>{o.status === 'korjattu' ? 'Korjattu' : 'Avoin'}</td>
                    <td style={tdStyle}>{fmtTime(o.hidden_at)}</td>
                  </tr>
                ))}
                {hiddenSorted.length === 0 && (
                  <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#9aa2c0', padding: 40 }}>Ei piilotettuja</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'teams' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            <div style={{ ...cardStyle, padding: 18 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e', marginBottom: 10 }}>+ Uusi tiimi</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  placeholder="Tiimin nimi (esim. Tiimi 1)"
                  value={newTeamName}
                  onChange={e => setNewTeamName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createTeam()}
                  style={{ ...selectStyle, flex: 1 }}
                />
                <button onClick={createTeam} style={{ background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Luo</button>
              </div>
            </div>

            {teams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                installers={installers}
                onDeleteTeam={deleteTeam}
                onSetInstallerTeam={setInstallerTeam}
              />
            ))}

            <div style={{ ...cardStyle, padding: 20, gridColumn: '1 / -1' }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#0d1a6e', marginBottom: 14 }}>Kaikki asentajat</div>
              {installers.length === 0 && <div style={{ fontSize: 13, color: '#9aa2c0', marginBottom: 10 }}>Ei asentajia vielä</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '4px 24px' }}>
                {installers.map(i => (
                  <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #f4f5fa', gap: 10 }}>
                    <span style={{ fontSize: 14, flex: 1, minWidth: 0 }}>{i.name}</span>
                    <select value={i.team_id || ''} onChange={e => setInstallerTeam(i.id, e.target.value || null)} style={{ ...selectStyle, padding: '6px 10px', fontSize: 12.5 }}>
                    <option value="">Ei tiimiä</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button onClick={() => deleteInstaller(i)} title="Poista asentaja" style={{ background: 'none', border: 'none', color: '#b02828', fontSize: 15, cursor: 'pointer', padding: '2px 4px' }}>🗑️</button>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, fontWeight: 700, color: '#9aa2c0', marginTop: 18, marginBottom: 8, textTransform: 'uppercase' }}>+ Uusi asentaja</div>
              <div style={{ display: 'flex', gap: 6, maxWidth: 480 }}>
                <input
                  placeholder="Nimi"
                  value={newInstallerName}
                  onChange={e => setNewInstallerName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addInstaller()}
                  style={{ ...selectStyle, flex: 2 }}
                />
                <input
                  placeholder="PIN"
                  value={newInstallerPin}
                  onChange={e => setNewInstallerPin(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && addInstaller()}
                  inputMode="numeric"
                  maxLength={6}
                  style={{ ...selectStyle, flex: 1 }}
                />
                <button onClick={addInstaller} style={{ background: '#1a2fcc', color: '#fff', border: 'none', borderRadius: 8, padding: '0 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(10,14,30,0.85)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out',
          }}
        >
          <img
            src={lightboxSrc}
            alt="Korjauskuva"
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
          />
          <button
            onClick={() => setLightboxSrc(null)}
            style={{
              position: 'absolute', top: 20, right: 20, width: 40, height: 40, borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer',
            }}
          >✕</button>
        </div>
      )}
    </div>
  )
}

function TeamCard({ team, installers, onDeleteTeam, onSetInstallerTeam }) {
  const [addId, setAddId] = useState('')
  const members = installers.filter(i => i.team_id === team.id)
  const available = installers.filter(i => i.team_id !== team.id)

  function addMember() {
    if (!addId) return
    onSetInstallerTeam(addId, team.id)
    setAddId('')
  }

  return (
    <div style={cardStyle}>
      <div style={{ padding: '13px 16px', background: '#f1ecfb', borderBottom: '1px solid #e4e7f3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#0d1a6e' }}>🧑‍🤝‍🧑 {team.name}</span>
        <button onClick={() => onDeleteTeam(team.id)} style={{ background: 'none', border: 'none', color: '#b02828', fontSize: 12, cursor: 'pointer' }}>Poista tiimi</button>
      </div>
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#9aa2c0', marginBottom: 8, textTransform: 'uppercase' }}>Jäsenet ({members.length})</div>
        {members.length === 0 && <div style={{ fontSize: 13, color: '#9aa2c0', marginBottom: 8 }}>Ei jäseniä vielä</div>}
        {members.map(m => (
          <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f4f5fa' }}>
            <span style={{ fontSize: 13 }}>{m.name}</span>
            <button onClick={() => onSetInstallerTeam(m.id, null)} style={{ background: 'none', border: 'none', color: '#9aa2c0', fontSize: 12, cursor: 'pointer' }}>Poista tiimistä</button>
          </div>
        ))}

        {available.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <select value={addId} onChange={e => setAddId(e.target.value)} style={{ ...selectStyle, flex: 1, padding: '7px 10px', fontSize: 12.5 }}>
              <option value="">+ Lisää jäsen…</option>
              {available.map(i => <option key={i.id} value={i.id}>{i.name}{i.team_id ? ' (vaihda tiimistä)' : ''}</option>)}
            </select>
            <button onClick={addMember} disabled={!addId} style={{ background: addId ? '#1a2fcc' : '#c8cce0', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: addId ? 'pointer' : 'default' }}>
              Lisää
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#c0c4d8', marginTop: 12 }}>Kaikki asentajat ovat jo tässä tiimissä</div>
        )}
      </div>
    </div>
  )
}

function ObsRow({ o, fmtTime, selected, onToggle }) {
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f1f7', display: 'flex', gap: 10, alignItems: 'flex-start', background: selected ? '#f3f5ff' : 'transparent' }}>
      <input type="checkbox" checked={selected} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
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
    </div>
  )
}

function TableRow({ o, installerById, fmtTime, selected, onToggle, onOpenPhoto }) {
  return (
    <tr style={{ borderBottom: '1px solid #f0f1f7', background: selected ? '#f3f5ff' : 'transparent' }}>
      <td style={tdStyle}><input type="checkbox" checked={selected} onChange={onToggle} /></td>
      <td style={tdStyle}>{o.cat}</td>
      <td style={tdStyle}><span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: sevBg[o.sev], color: sevColor[o.sev] }}>{o.sev}</span></td>
      <td style={tdStyle}>{o.site}{o.rivi ? ` · ${o.rivi}` : ''}</td>
      <td style={tdStyle}>{installerById.get(o.assigned_installer_id)?.name || '—'}</td>
      <td style={tdStyle}>{fmtTime(o.created_at)}</td>
      <td style={tdStyle}>{fmtTime(o.fixed_at)}</td>
      <td style={tdStyle}>
        {o.fixed_photo ? (
          <img
            src={o.fixed_photo}
            alt="Korjauskuva"
            onClick={() => onOpenPhoto(o.fixed_photo)}
            style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid #d0d5e8', cursor: 'pointer' }}
          />
        ) : (
          <span style={{ color: '#c3c8dc', fontSize: 12 }}>—</span>
        )}
      </td>
    </tr>
  )
}

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ background: '#fff', borderRadius: 14, boxShadow: '0 1px 3px rgba(20,30,80,0.06), 0 1px 2px rgba(20,30,80,0.04)', padding: '17px 22px', minWidth: 140 }}>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#6670a0', marginTop: 3 }}>{label}</div>
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7.5px 14px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
        background: active ? '#1a2fcc' : 'transparent', color: active ? '#fff' : '#4a5480',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {children}
    </button>
  )
}

function ActionBtn({ onClick, disabled, color, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: color, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px',
      fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
    }}>
      {children}
    </button>
  )
}

function EmptyState({ text }) {
  return (
    <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#6670a0', padding: 70, fontSize: 15, background: '#fff', borderRadius: 14, boxShadow: '0 1px 3px rgba(20,30,80,0.06)' }}>
      {text}
    </div>
  )
}

const cardStyle = { background: '#fff', borderRadius: 14, boxShadow: '0 1px 3px rgba(20,30,80,0.06), 0 1px 2px rgba(20,30,80,0.04)', overflow: 'hidden' }
const selectStyle = { padding: '9px 12px', borderRadius: 8, border: '1px solid #d8dbee', fontSize: 13, background: '#fff', color: '#222' }
const thStyle = { padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6670a0', textTransform: 'uppercase', letterSpacing: 0.3 }
const tdStyle = { padding: '10px 16px' }
