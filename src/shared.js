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
export function findPinRow(mapData, pin) {
  if (!mapData || !pin || !mapData.inserts?.length) return null
  const sxm = mapData.W / (mapData.maxX - mapData.minX)
  const sym = mapData.H / (mapData.maxY - mapData.minY)
  const psx = pin.x * mapData.W, psy = pin.y * mapData.H
  let rowIdx = -1
  mapData.inserts.forEach((ins, idx) => {
    const tw = ins.panels * PANEL_W_M * sxm, th = TABLE_DEPTH_M * sym
    if (psx >= ins.x - 3 && psx <= ins.x + tw + 3 && psy >= ins.y - 3 && psy <= ins.y + th + 3) rowIdx = idx
  })
  if (rowIdx < 0) return null
  const ins = mapData.inserts[rowIdx]
  const targetX = ins.x + ins.panels * PANEL_W_M * sxm, targetY = ins.y + (TABLE_DEPTH_M * sym) / 2
  let best = Infinity, label = null
  mapData.rowNumbers.forEach(t => {
    const d = Math.hypot(t.x - targetX, t.y - targetY)
    if (d < best) { best = d; label = t.text }
  })
  return label ? { rowIdx, label } : null
}
