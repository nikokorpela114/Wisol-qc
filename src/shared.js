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

// HUOM: dxfParser.js tallentaa jokaiselle INSERT:lle ins.rot-kentän
// block-nimen "@30DEG"-osasta (esim. "2P22@30DEG..."). Tämä EI ole
// pöydän kierto pohjapiirroksen X/Y-tasossa — se on paneelin
// asennus-/kallistuskulma (tuttu esim. "30 asteen kallistus" aurinko-
// paneeliasennuksista), joka ei vaikuta pöydän sijaintiin tai muotoon
// ylhäältä katsottuna. Tätä kokeiltiin virheellisesti tulkita tasokiertona
// kerran, mikä siirsi/limitti kaikki 1051 pöytää väärin — ins.rot:ia ei
// siis käytetä missään piirrossa tai osumatunnistuksessa.

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

// Ray-casting point-in-polygon testi. Käytetään findPinRow:ssa tunnistamaan
// kun pinni osuu polygonina piirrettyyn paneelialueeseen (mapData.panelAreas
// — layerit '665 Wp' / '670 Wp' / 'Extra panels', ks. dxfParser.js) jolla ei
// ole samaa säännöllistä INSERT-rivirakennetta kuin tavallisilla pöydillä.
function pointInPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
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

  // 1. Etsi insert-lohko johon pinni osuu. HUOM: ins.y on pöydän
  //    YLÄREUNA (todistetusti oikea konventio — vahvistettu vertaamalla
  //    aiemmin oikeasti toimineeseen Netlify-julkaisuun), pöytä ulottuu
  //    ALASPÄIN siitä. (ins.rot ei ole pöydän pohjapiirroskierto vaan
  //    paneelin kallistuskulma — ei käytetä tässä.)
  let hitIdx = -1
  mapData.inserts.forEach((ins, idx) => {
    const tw = ins.panels * PANEL_W_M * sxm
    if (psx >= ins.x - 3 && psx <= ins.x + tw + 3 && psy >= ins.y - 3 && psy <= ins.y + th + 3) hitIdx = idx
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
      const center = ins.y + th / 2
      const d = Math.abs(psy - center)
      if (d < bestDist) { bestDist = d; hitIdx = idx }
    })
    if (bestDist > th * 1.2) hitIdx = -1 // liian kaukana ollakseen luotettava arvaus
  }
  if (hitIdx < 0) {
    // Napautus voi osua paneelialueeseen joka on piirretty POLYGONINA
    // eikä INSERT-lohkoina (mapData.panelAreas — '665 Wp' / '670 Wp' /
    // 'Extra panels', ks. dxfParser.js). Näillä ei ole samaa säännöllistä
    // rivirakennetta kuin tavallisilla pöydillä, joten emme voi ketjuttaa
    // niitä riviksi samalla logiikalla — mutta pinni osuu silti oikeaan
    // paneelialueeseen, joten näytetään lähin uskottava rivinumero sen
    // sijaan että näytetään ei mitään ("Havaittu rivi" katoaa) tai
    // arvataan täysin väärä, kaukainen INSERT-rivi (esim. "65" kun
    // fyysisesti ollaan rivin 29 kohdalla).
    const insidePanelArea = mapData.panelAreas?.some(pts => pointInPolygon(psx, psy, pts))
    if (insidePanelArea) {
      let best = Infinity, label = null
      mapData.rowNumbers.forEach(t => {
        const d = Math.hypot(t.x - psx, t.y - psy)
        if (d < best) { best = d; label = t.text }
      })
      if (label && best <= th * 6) return { rowIdx: -1, label, rowInsertIdxs: [] }
    }
    return null
  }
  const hit = mapData.inserts[hitIdx]

  // 1b. Mitataan TODELLINEN rivi-väli tällä alueella heti, hit.x:n
  //     ympäriltä — käytetään sitä JOHDONMUKAISESTI kaikkialla (rowY,
  //     targetY, labelYTol) kiinteän th:n (TABLE_DEPTH_M-oletus) sijaan.
  //     Aiemmin th:tä käytettiin rowY/targetY:hen mutta localPitch:iä vain
  //     labelYTol:iin — tämä epäjohdonmukaisuus sai targetY:n osumaan
  //     väärään kohtaan aina kun todellinen väli poikkesi th:sta, mikä
  //     työnsi oikean numerolapun tiukan labelYTol-kaistan ulkopuolelle ja
  //     haku napsahti sen sijaan johonkin kauempana olevaan, väärään
  //     numeroon — juuri tämä aiheutti tulosten "hyppimisen" pienestäkin
  //     napautuskohdan muutoksesta.
  const pitchWindow = mapData.rowNumbers.filter(t => Math.abs(t.x - hit.x) < th * 8)
  const pitchYs = [...new Set(pitchWindow.map(t => Math.round(t.y * 100) / 100))].sort((a, b) => b - a)
  let localPitch = th
  if (pitchYs.length >= 2) {
    const gaps = []
    for (let i = 0; i < pitchYs.length - 1; i++) gaps.push(pitchYs[i] - pitchYs[i + 1])
    gaps.sort((a, b) => a - b)
    localPitch = gaps[Math.floor(gaps.length / 2)] // mediaani
    // HUOM: jos lähellä (th*8-ikkunan sisällä) on sattumalta vain muutama
    // numerolappu — esim. tien reunalla tai harvaan numeroidulla alueella
    // — mediaani voi osua kahden KAUKAISEN, harvinaisen rivin välisen raon
    // kohdalle todellisen tiheän rivivälin sijaan (havaittu: 603 yksikköä
    // kun todellinen on ~15). Tämä paisutti labelYTol:in niin isoksi että
    // haku hyväksyi täysin väärän, kaukaisen rivin numeron. Rivinväli ei voi
    // koskaan olla montaa kertaa suurempi kuin pöydän oma syvyys (th) —
    // jos mitattu arvo on epäuskottava, ei luoteta siihen.
    if (localPitch > th * 3 || localPitch < th * 0.3) localPitch = th
  }

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
  // HUOM: 6 m osoittautui liian tiukaksi — havaittiin oikea, laillinen
  // 48 yksikön huoltokäytävä saman rivin kahden pöytäryhmän välissä, jota
  // ei enää ketjutettu yhteen, jolloin vasen pätkä ei löytänyt rivin
  // OMAA numerolappua (se on vain rivin oikeassa päässä) ja haku napsahti
  // väärään, lähimpään sattumanvaraiseen numeroon. Aiempi "455 yksikön
  // jättiketju" -bugi ei itse asiassa johtunut suuresta gapTol:sta vaan
  // PÄÄLLEKKÄISISTÄ/duplikoituneista DXF-lohkoista — se on jo erikseen
  // estetty alla olevalla "gap >= -1" tarkistuksella, joten gapTol voi
  // taas olla reilusti isompi ilman että sama bugi palaa.
  const gapTol = 45 * sxm
  const rowY = hit.y + localPitch / 2

  // Tarkistaa kulkeeko jokin "raja-viiva" kahden pisteen välistä. Tähän
  // lasketaan sekä tiet (mapData.roads) että aluerajat — dxfParser.js lukee
  // DXF:n "Aluejako"-tason (eri numeroitujen alueiden väliset rajaviivat,
  // esim. A5/A6-alueiden raja) samaan pvAreas-joukkoon kuin itse
  // paneelialueiden ulkoreunat, koska molemmat ovat "alue"-tyyppisiä
  // polygoneja DXF:ssä. Ilman tätä kaksi vierekkäistä mutta itsenäisesti
  // numeroitua aluetta (esim. rivit 61/63/65 alueella A5 ja 70/72/74
  // alueella A6) saattoivat ketjuuntua samaksi riviksi, koska niiden
  // välissä oleva aluerajaviiva ei ollut "tie" eikä siis pysäyttänyt ketjua.
  //
  // HUOM: tämä on YLEINEN jana-jana-leikkaustesti, ei enää oleteta että
  // kysytty jana on vaakasuora kiinteällä rivin Y-korkeudella (yA/yB
  // oletusarvoisesti rowY, joten INSERT-ketjutuksen vanhat kutsut
  // toimivat ennallaan). Tätä tarvittiin koska monet tiet KIERTÄVÄT
  // nimettyjen alueiden reunoja viistosti sen sijaan että ylittäisivät
  // suoraan täsmälleen rivin oman vaakatason — pelkkä "ylittääkö tie
  // juuri tämän Y-tason" -testi ei nähnyt niitä, vaikka tie kulki
  // selvästi rivin ja kaukaisen numerolapun välissä.
  const boundaryPolylines = [...mapData.roads, ...mapData.pvAreas]
  const cross2 = (ax, ay, bx, by) => ax * by - ay * bx
  const crossesBoundary = (xA, xB, yA = rowY, yB = rowY) => {
    return boundaryPolylines.some(pts => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
        const d1 = cross2(x2 - x1, y2 - y1, xA - x1, yA - y1)
        const d2 = cross2(x2 - x1, y2 - y1, xB - x1, yB - y1)
        const d3 = cross2(xB - xA, yB - yA, x1 - xA, y1 - yA)
        const d4 = cross2(xB - xA, yB - yA, x2 - xA, y2 - yA)
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
      }
      return false
    })
  }

  const sameY = mapData.inserts
    .map((ins, idx) => ({ idx, ins, left: ins.x, right: ins.x + ins.panels * PANEL_W_M * sxm }))
    .filter(e => Math.abs(e.ins.y - hit.y) <= yTol)
    .sort((a, b) => a.left - b.left)

  const hitPos = sameY.findIndex(e => e.idx === hitIdx)

  // HUOM: kokeiltiin aiemmin erillistä "ohita tie numeron haussa" -ketjua,
  // mutta se osoittautui vääräksi — tiet OIKEASTI rajoittavat rivejä
  // useilla alueilla (havaittu suoraan kartalta: pinni tien toisella
  // puolella löysi väärän, kaukaisen rivin numeron kun tie-tarkistus
  // ohitettiin). Käytetään siis yhtä ja samaa tie-/aluerajan huomioivaa
  // ketjua sekä korostukseen että numeron hakuun — jos jollain TOISELLA
  // työmaalla rivi oikeasti jatkuu saman numeroisena tien yli, se pitää
  // ratkaista erikseen (esim. tarkistamalla onko molemmin puolin sama
  // numero), ei sivuuttamalla tie-tarkistus kokonaan kaikkialla.
  const chain = [sameY[hitPos]]
  for (let i = hitPos - 1; i >= 0; i--) {
    const edge = chain[0].left
    const gap = edge - sameY[i].right
    // gap < -1: lohkot ovat selvästi päällekkäin (esim. DXF:n duplikoitu/
    // limittyvä data) — ei ketjuteta tällaisen läpi.
    if (gap >= -1 && gap <= gapTol && !crossesBoundary(sameY[i].right, edge)) chain.unshift(sameY[i])
    else break
  }
  for (let i = hitPos + 1; i < sameY.length; i++) {
    const edge = chain[chain.length - 1].right
    const gap = sameY[i].left - edge
    if (gap >= -1 && gap <= gapTol && !crossesBoundary(edge, sameY[i].left)) chain.push(sameY[i])
    else break
  }

  // 3. Rivin oma oikea reuna = suurin (ins.x + leveys) vain ketjuun kuuluvista lohkoista
  const rowRightX = Math.max(...chain.map(e => e.right))
  const targetX = rowRightX
  const targetY = hit.y + localPitch / 2

  // 4. Etsi lähin numerolappu VAIN saman Y-kaistan sisältä, ja hylkää jos
  //    lähinkin on epäuskottavan kaukana (esim. toiselta puolelta karttaa).
  //    localPitch (mitattu vaiheessa 1b) käytetään sekä targetY:n keskitykseen
  //    että toleranssin pohjana — molemmat käyttävät nyt SAMAA mitattua
  //    riviväliä, ei kiinteää TABLE_DEPTH_M-oletusta, jotta ne eivät voi
  //    ajautua ristiriitaan keskenään.
  const labelYTol = Math.max(th * 0.6, localPitch * 0.45)
  const maxLabelDist = Math.max(th * 4, localPitch * 3)
  let best = Infinity, label = null
  mapData.rowNumbers.forEach(t => {
    if (Math.abs(t.y - targetY) > labelYTol) return // eri Y-kaista → ei voi olla saman rivin numero
    // HUOM: pelkkä Y-kaista ei riitä silloin kun kaksi ITSENÄISESTI
    // numeroitua nimettyä aluetta (esim. "Keski-suora" ja "Logistiikka",
    // ks. Aluejako-layer) kohtaavat lähes samassa pisteessä — näiden
    // numerolaput voivat olla geometrisesti hyvin lähellä toisiaan vaikka
    // kuuluvat eri riviin/alueeseen. Sama crossesBoundary-tarkistus jota
    // jo käytetään INSERT-lohkojen ketjutuksessa estämään rivin
    // muodostuminen yli aluerajan, käytetään nyt myös tässä: numerolappu
    // hylätään jos sen ja rivin kohdepisteen välissä kulkee Aluejako-raja.
    if (crossesBoundary(targetX, t.x, targetY, t.y)) return
    const d = Math.hypot(t.x - targetX, t.y - targetY)
    if (d < best) { best = d; label = t.text }
  })
  const strictLabel = label, strictBest = best
  // Fallback: jos tiukka Y-kaista ei löydä yhtään lappua (esim. label on
  // hieman odotettua kauempana Y-suunnassa jollain työmaalla), etsitään
  // lähin lappu ILMAN Y-kaistarajoitusta mutta silti maxLabelDist-säteen
  // sisältä — parempi näyttää lähin uskottava numero kuin ei mitään.
  if (!label || best > maxLabelDist) {
    let best2 = Infinity, label2 = null
    mapData.rowNumbers.forEach(t => {
      const d = Math.hypot(t.x - targetX, t.y - targetY)
      if (d < best2) { best2 = d; label2 = t.text }
    })
    if (label2 && best2 <= maxLabelDist * 1.5) { best = best2; label = label2 }
  }
  // TILAPÄINEN DEBUG — näyttää lopullisen (fallbackin jälkeisen) tuloksen
  console.log('[findPinRow] pin=(' + psx.toFixed(1) + ',' + psy.toFixed(1) + ') hitIdx=' + hitIdx +
    ' hit=(' + hit.x.toFixed(1) + ',' + hit.y.toFixed(1) + ') chainLen=' + chain.length +
    ' chainX=[' + chain.map(e => e.left.toFixed(0) + '-' + e.right.toFixed(0)).join(',') + ']' +
    ' targetX=' + targetX.toFixed(1) + ' targetY=' + targetY.toFixed(1) +
    ' localPitch=' + localPitch.toFixed(2) + ' labelYTol=' + labelYTol.toFixed(2) +
    ' strict->' + strictLabel + '@' + strictBest.toFixed(1) +
    ' FINAL->' + label + '@' + best.toFixed(1))
  if (!label || best > maxLabelDist * 1.5) return null

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

  // Automaattinen rivintunnistus/-korostus poistettu käytöstä kokonaan
  // (osoittautui epäluotettavaksi paikoin, ks. keskustelu) — kartta
  // näyttää nyt vain pinnin ja sitä ympäröivät pöydät kiinteän kokoisena
  // rajauksena, ilman minkäänlaista "tämä on oikea rivi" -päättelyä tai
  // -korostusta.
  const cropHalfW = th * 12, cropHalfH = th * 4
  const minX = psx - cropHalfW, maxX = psx + cropHalfW
  const minY = psy - cropHalfH, maxY = psy + cropHalfH

  const svgX0 = Math.max(0, minX), svgX1 = Math.min(mapData.W, maxX)
  const svgY0 = Math.max(0, minY), svgY1 = Math.min(mapData.H, maxY)
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

  mapData.inserts.forEach((ins) => {
    const right = ins.x + ins.panels * PANEL_W_M * sxm
    const left = ins.x
    if (right < svgX0 || left > svgX1 || ins.y + th < svgY0 || ins.y > svgY1) return // skip off-screen tables
    const tw = ins.panels * PANEL_W_M * sxm * kx, thpx = TABLE_DEPTH_M * sym * ky
    ctx.fillStyle = 'rgba(26,47,204,0.18)'
    ctx.strokeStyle = '#1a2fcc'
    ctx.lineWidth = 0.5
    ctx.fillRect(px(ins.x), py(ins.y), tw, thpx)
    ctx.strokeRect(px(ins.x), py(ins.y), tw, thpx)
  })

  // Muun wattiluokan / polygonina piirretyt paneelipöydät (665 Wp / 670 Wp /
  // Extra panels) — ks. selitys MapView.jsx:ssä/dxfParser.js:ssä.
  ;(mapData.panelAreas || []).forEach(pts => {
    ctx.fillStyle = 'rgba(26,47,204,0.18)'
    ctx.strokeStyle = '#1a2fcc'
    ctx.lineWidth = 0.5
    ctx.beginPath(); pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y)))
    ctx.closePath(); ctx.fill(); ctx.stroke()
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

  // Rivin tunnistus: käytetään SAMAA huolella hiottua ketjutuslogiikkaa
  // (findPinRow, tässä samassa tiedostossa) jota käytetään jo muualla
  // rivinumeron päättelyyn napautuksesta — se osaa jo oikein ketjuttaa
  // rivin pöytälohkot yhteen ja pysähtyä tien/aluerajan kohdalla, toisin
  // kuin pelkkä Y-läheisyys (joka voisi vahingossa yhdistää kaksi eri
  // riviä tien vastakkaisilta puolilta). o.pin on normalisoidussa
  // (0..1) koordinaatistossa, sama muoto jota findPinRow odottaa.
  const rowInsertIdxSet = new Set()
  items.forEach(o => {
    const found = findPinRow(mapData, o.pin)
    if (found?.rowInsertIdxs?.length) found.rowInsertIdxs.forEach(i => rowInsertIdxSet.add(i))
  })

  let minX, maxX, minY, maxY
  if (rowInsertIdxSet.size > 0) {
    const chainInserts = [...rowInsertIdxSet].map(i => mapData.inserts[i])
    const rowMinX = Math.min(...chainInserts.map(e => e.x))
    const rowMaxX = Math.max(...chainInserts.map(e => e.x + e.panels * PANEL_W_M * sxm))
    const rowMinY = Math.min(...chainInserts.map(e => e.y))
    const rowMaxY = Math.max(...chainInserts.map(e => e.y + th))
    minX = Math.min(rowMinX, ...pins.map(p => p.x))
    maxX = Math.max(rowMaxX, ...pins.map(p => p.x))
    minY = Math.min(rowMinY, ...pins.map(p => p.y))
    maxY = Math.max(rowMaxY, ...pins.map(p => p.y))
  } else {
    // Varalla: findPinRow ei löytänyt ketjutettavaa riviä (esim. testipinni
    // ilman oikeaa sijaintia, tai osui polygonina piirrettyyn alueeseen)
    // — näytetään ainakin pinnien oma sijainti.
    minX = Math.min(...pins.map(p => p.x)); maxX = Math.max(...pins.map(p => p.x))
    minY = Math.min(...pins.map(p => p.y)); maxY = Math.max(...pins.map(p => p.y))
  }

  const padX = th * 3
  const svgX0 = Math.max(0, minX - padX)
  const svgX1 = Math.min(mapData.W, maxX + padX)
  const svgCropW = Math.max(1, svgX1 - svgX0)

  // Pitkä rivi (100+ m) on hyvin kapea (pöydän syvyys vain muutama metri)
  // — jos pystysuunta rajattaisiin tiukasti vain rivin syvyyteen, kuvasta
  // tulisi käytännössä lukukelvoton ohut nauha PDF:ssä (kuvasuhde venyy
  // äärimmäiseksi). Varmistetaan siis ETTEI kuvasuhde (leveys/korkeus)
  // ylitä n. 9:1 — laajennetaan tarvittaessa pystysuuntaa rivin
  // keskikohdan ympärille, jotta pinnit/pöydät pysyvät luettavina vaikka
  // rivi olisi hyvin pitkä. Rivin koko pituus näkyy silti aina.
  const MAX_ASPECT = 9
  const minCropH = svgCropW / MAX_ASPECT
  const rawCropH = Math.max(1, (maxY - minY) + th * 6) // rivin oma syvyys + pieni marginaali
  const svgCropH = Math.max(minCropH, rawCropH)
  const midY = (minY + maxY) / 2
  let svgY0 = midY - svgCropH / 2
  let svgY1 = midY + svgCropH / 2
  // Siirretään ikkuna kartan sisään jos se osuisi reunan yli (ei
  // pienennetä korkeutta, vain siirretään).
  if (svgY0 < 0) { svgY1 -= svgY0; svgY0 = 0 }
  if (svgY1 > mapData.H) { svgY0 -= (svgY1 - mapData.H); svgY1 = mapData.H }
  svgY0 = Math.max(0, svgY0)

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

  mapData.inserts.forEach((ins) => {
    const tw = ins.panels * PANEL_W_M * sxm * kx
    const thpx = TABLE_DEPTH_M * sym * ky
    mctx.fillStyle = 'rgba(26,47,204,0.18)'
    mctx.strokeStyle = '#1a2fcc'
    mctx.lineWidth = 0.6
    mctx.fillRect(px(ins.x), py(ins.y), tw, thpx)
    mctx.strokeRect(px(ins.x), py(ins.y), tw, thpx)
  })

  // Muun wattiluokan / polygonina piirretyt paneelipöydät (665 Wp / 670 Wp /
  // Extra panels) — ks. selitys MapView.jsx:ssä/dxfParser.js:ssä.
  ;(mapData.panelAreas || []).forEach(pts => {
    mctx.fillStyle = 'rgba(26,47,204,0.18)'
    mctx.strokeStyle = '#1a2fcc'
    mctx.lineWidth = 0.6
    mctx.beginPath(); pts.forEach(([x, y2], i) => i === 0 ? mctx.moveTo(px(x), py(y2)) : mctx.lineTo(px(x), py(y2)))
    mctx.closePath(); mctx.fill(); mctx.stroke()
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

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), outW, outH }
}

// Downscale + re-encode an image file straight away. Raw phone photos can be
// several MB — compressing to a reasonable max dimension keeps PDF exports
// and Supabase storage light. Used by both App.jsx (havainnon omat kuvat)
// and InstallerView.jsx (korjauskuva).
export function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height)
          width = Math.round(width * scale); height = Math.round(height * scale)
        }
        const c = document.createElement('canvas')
        c.width = width; c.height = height
        c.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(c.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => resolve(e.target.result)
      img.src = e.target.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
