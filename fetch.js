/**
 * fetch.js — henter politiske møtedata fra alle kilder og skriver meetings.json
 *
 * Kjøres av GitHub Actions ukentlig, eller manuelt: node fetch.js
 * Krever: npm install && npx playwright install chromium
 *
 * Ingen Chrome-utvidelse involvert — Playwright styrer en headless nettleser.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// KONFIGURASJON
// ─────────────────────────────────────────────

const MIN_DATO     = new Date().toISOString().slice(0, 10); // fra i dag
const MAX_AAR      = new Date().getFullYear() + 3;
const RETRY        = 3;
const RETRY_DELAY  = 5000;
const PAGE_TIMEOUT = 30000;
const NAV_TIMEOUT  = 60000;
const EC_MAANEDER  = 15;   // antall måneder ElementsCloud navigerer fremover

/** Forventet minimum møteantall per kilde — brukes til kvalitetssjekk */
const FORVENTET = {
  innlandet:   15, gjovik:      25,
  ostretoten:  15, vestretoten: 12,
  sondre_land: 12, nordre_land: 10,
  ipr:          2, hamar:       15,
  loten:       10, stange:      10,
  ringsaker:    8, kongsvinger: 12,
  ipr_kv:       2, gausdal:      8,
  oyer:         8, lillehammer: 15,
  elverum:     15, ipr_se:       1,
};

const MAANEDER = {
  januar:1, februar:2, mars:3, april:4, mai:5, juni:6,
  juli:7, august:8, september:9, oktober:10, november:11, desember:12,
};

// ─────────────────────────────────────────────
// KILDER
// ─────────────────────────────────────────────

/** BK-innsyn — alt på én side med pageSize=100 */
const BK_KILDER = [
  { mun:'gjovik',      url:'https://www.gjovik.kommune.no/politikk-planer-og-organisasjon/postliste-dokumenter-og-vedtak/politisk-moteplan/#/?page=1&pageSize=100' },
  { mun:'ostretoten',  url:'https://www.ototen.no/innsyn/moteplan/#/?page=1&pageSize=100' },
  { mun:'sondre_land', url:'https://innsynpluss.onacos.no/sondre-land/moteoversikt/#/?page=1&pageSize=100' },
  { mun:'nordre_land', url:'https://innsynpluss.onacos.no/nordre-land/moteoversikt/#/?page=1&pageSize=100' },
  { mun:'elverum',     url:'https://www.elverum.kommune.no/vare-tjenester/politikk-planer-og-organisasjon/politikk/politisk-moteplan/#/?page=1&pageSize=100' },
];

/** ElementsCloud — navigerer måned for måned */
const EC_KILDER = [
  { mun:'vestretoten', url:'https://prod01.elementscloud.no/publikum/971028300/Dmb' },
  { mun:'hamar',       url:'https://prod02.elementscloud.no/publikum/970540008_PROD-970540008/Dmb' },
  { mun:'loten',       url:'https://prod02.elementscloud.no/publikum/964950679_PROD-964950679/Dmb' },
  { mun:'stange',      url:'https://prod02.elementscloud.no/publikum/970169717_PROD-970169717/Dmb' },
  { mun:'gausdal',     url:'https://prod02.elementscloud.no/publikum/961381274_PROD-961381274/Dmb' },
  { mun:'oyer',        url:'https://prod02.elementscloud.no/publikum/961381185_PROD-961381185/Dmb' },
  { mun:'lillehammer', url:'https://prod02.elementscloud.no/publikum/945578564_PROD-945578564/Dmb' },
];

/** Sør-Østerdal IPR — vedtatt møteplan, publiseres ikke i innsynsløsning */
const SOIPR_FASTE = [
  { date:'2026-10-15', committee:'Representantskapet – Sør-Østerdal IPR' },
  { date:'2026-10-29', committee:'Styret – Sør-Østerdal IPR' },
  { date:'2026-11-26', committee:'Styret – Sør-Østerdal IPR' },
  { date:'2026-12-10', committee:'Styret – Sør-Østerdal IPR' },
];

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────

const logg = [];
function log(nivaa, melding) {
  const linje = `[${new Date().toISOString()}] [${nivaa.toUpperCase().padEnd(5)}] ${melding}`;
  console.log(linje);
  logg.push(linje);
}

// ─────────────────────────────────────────────
// KATEGORISERING OG VALIDERING
// ─────────────────────────────────────────────

function kategoriser(tittel) {
  const l = tittel.toLowerCase();
  if (/kommunestyre|fylkesting/.test(l)) return 'kst';
  if (/formannskap|fylkesutvalg/.test(l)) return 'fsk';
  if (/\butvalg\b|komité|komite|hovedutvalg|nemnd/.test(l)) return 'utvalg';
  if (/\bipr\b|representantskap|interkommunalt politisk|kongsvingerregionen|søipr|sør-østerdal ipr|koordineringsutvalg/.test(l)) return 'ipr';
  return 'andre';
}

function dagnavn(dato) {
  const d = new Date(dato + 'T12:00:00');
  return ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'][d.getDay()];
}

function gyldigDato(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const [, y, mo, da] = m.map(Number);
  if (y < 2020 || y > MAX_AAR) return false;
  if (mo < 1 || mo > 12) return false;
  if (da < 1 || da > new Date(y, mo, 0).getDate()) return false;
  return d >= MIN_DATO;   // kun fremtidige møter
}

function lagMote(dato, tittel, tid, mun) {
  if (!gyldigDato(dato)) return null;
  if (!tittel || tittel.trim().length < 2) return null;
  if (tid && !/^\d{2}:\d{2}$/.test(tid)) tid = '';
  return {
    date: dato,
    time: tid || '',
    municipality: mun,
    committee: tittel.trim(),
    category: kategoriser(tittel),
    day: dagnavn(dato),
  };
}

function dedupliser(liste) {
  const sett = new Set();
  return liste.filter(m => {
    const n = `${m.date}|${m.municipality}|${m.committee}|${m.time}`;
    if (sett.has(n)) return false;
    sett.add(n);
    return true;
  });
}

async function medRetry(navn, fn) {
  for (let i = 1; i <= RETRY; i++) {
    try {
      return await fn();
    } catch (err) {
      log('error', `  ${navn}: forsøk ${i}/${RETRY} feilet — ${err.message}`);
      if (i < RETRY) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  return [];
}

// ─────────────────────────────────────────────
// HENTING: BK-innsyn
// ─────────────────────────────────────────────

async function hentBkInnsyn(page, url, mun) {
  await page.goto(url, { waitUntil:'networkidle', timeout:NAV_TIMEOUT });
  await page.waitForSelector('.bc-content-teaser--innsyn-mote', { timeout:PAGE_TIMEOUT });
  await page.waitForTimeout(2000);

  const raa = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bc-content-teaser--innsyn-mote')).map(el => {
      const deler = el.innerText.replace(/\n+/g,'|').split('|').map(p=>p.trim()).filter(Boolean);
      const di = deler.findIndex(p => /^\d+\.$/.test(p));
      if (di < 0) return null;
      const ti = deler.indexOf('Tid');
      return {
        dag: deler[di].replace('.',''),
        mnd: deler[di+1] || '',
        aar: deler[di+2] || '',
        tittel: deler[di+3] || '',
        tid: ti >= 0 ? (deler[ti+1] || '') : '',
      };
    }).filter(Boolean)
  );

  const moter = [];
  for (const r of raa) {
    const mnd = MAANEDER[r.mnd.toLowerCase()];
    if (!r.dag || !mnd || !r.aar) continue;
    const dato = `${r.aar}-${String(mnd).padStart(2,'0')}-${String(+r.dag).padStart(2,'0')}`;
    // IPR-møter fra Gjøvik skilles ut i egen kolonne
    const effMun = (mun === 'gjovik' && /interkommunal|koordineringsutvalg|\bipr\b/i.test(r.tittel))
      ? 'ipr' : mun;
    const m = lagMote(dato, r.tittel, r.tid, effMun);
    if (m) moter.push(m);
  }
  return moter;
}

// ─────────────────────────────────────────────
// HENTING: ElementsCloud
// ─────────────────────────────────────────────

async function hentElementsCloud(page, url, mun) {
  await page.goto(url, { waitUntil:'networkidle', timeout:NAV_TIMEOUT });
  await page.waitForSelector('a.dmb-class', { timeout:PAGE_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2500);

  const alle = new Set();
  const hentSide = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('a.dmb-class'))
      .map(a => a.getAttribute('aria-label') || '')
      .filter(Boolean)
  );

  (await hentSide()).forEach(l => alle.add(l));

  for (let i = 0; i < EC_MAANEDER; i++) {
    const neste = page.locator('button', { hasText:'Neste' }).first();
    if (await neste.count() === 0) break;
    try {
      await neste.click({ timeout:5000 });
      await page.waitForTimeout(1800);
      (await hentSide()).forEach(l => alle.add(l));
    } catch { break; }
  }

  // aria-label har formen: "Formannskapet 3.6.2026 09:00"
  const re = /^(.+?)\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{2}:\d{2})$/;
  const moter = [];
  for (const label of alle) {
    const m = re.exec(label);
    if (!m) continue;
    const [, tittel, dag, mnd, aar, tid] = m;
    const dato = `${aar}-${String(+mnd).padStart(2,'0')}-${String(+dag).padStart(2,'0')}`;
    const mote = lagMote(dato, tittel, tid, mun);
    if (mote) moter.push(mote);
  }
  return moter;
}

// ─────────────────────────────────────────────
// HENTING: Innlandet fylkeskommune
// ─────────────────────────────────────────────

async function hentInnlandet(page) {
  const url = 'https://innlandetfylke.no/Kalender/CalendarEvents.aspx?lang=1&kategori=83&dir=ComingEvents&MId1=7&pageSize=100';
  await page.goto(url, { waitUntil:'networkidle', timeout:NAV_TIMEOUT });
  await page.waitForSelector('.cc-teaser-body-content', { timeout:PAGE_TIMEOUT });

  const raa = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cc-teaser-body-content')).map(kort => ({
      tittel: kort.querySelector('h2,h3,.cc-teaser-title')?.innerText.trim() || '',
      datoFelt: (kort.innerText.match(/Dato\s*\n?([^\n]+)/) || [])[1]?.trim() || '',
      tidFelt:  (kort.innerText.match(/Tidspunkt\s*\n?([^\n]+)/) || [])[1]?.trim() || '',
    }))
  );

  const moter = [];
  for (const r of raa) {
    if (!/fylkesting|fylkesutvalg|hovedutvalg/i.test(r.tittel)) continue;
    const dm = /(\d{1,2})\.\s*(\w+)\s*(\d{4})/.exec(r.datoFelt);
    if (!dm) continue;
    const mnd = MAANEDER[dm[2].toLowerCase()];
    if (!mnd) continue;
    const dato = `${dm[3]}-${String(mnd).padStart(2,'0')}-${String(+dm[1]).padStart(2,'0')}`;
    const tm = /kl\.\s*(\d{1,2})\.(\d{2})/.exec(r.tidFelt);
    const tid = tm ? `${tm[1].padStart(2,'0')}:${tm[2]}` : '';
    const m = lagMote(dato, r.tittel, tid, 'innlandet');
    if (m) moter.push(m);
  }
  return moter;
}

// ─────────────────────────────────────────────
// HENTING: Ringsaker (WF-innsyn, ett utvalg om gangen)
// ─────────────────────────────────────────────

async function hentRingsaker(page) {
  await page.goto(
    'https://innsyn.ringsaker.kommune.no/wfinnsyn.ashx?response=moteplan_utvalg&fradato=2026-01-01T00:00:00&utvalg=1&',
    { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT }
  );

  const raa = await page.evaluate(async () => {
    const ut = [];
    for (let id = 1; id <= 25; id++) {
      try {
        const r = await fetch(`/wfinnsyn.ashx?response=moteplan_utvalg&fradato=2026-01-01T00:00:00&utvalg=${id}&`);
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const h2 = doc.querySelector('h2');
        if (!h2 || h2.innerText.trim().length < 2) continue;
        const navn = h2.innerText.trim();
        doc.querySelectorAll('a').forEach(a => {
          const m = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})/.exec(a.innerText.trim());
          if (m) ut.push({ dato:`${m[3]}-${m[2]}-${m[1]}`, tid:m[4], navn });
        });
      } catch { /* tomt utvalg — hopp over */ }
    }
    return ut;
  });

  return raa.map(r => lagMote(r.dato, r.navn, r.tid, 'ringsaker')).filter(Boolean);
}

// ─────────────────────────────────────────────
// HENTING: Kongsvinger (WF-innsyn, årsoversikt)
// ─────────────────────────────────────────────

async function hentKongsvinger(page) {
  const aar = new Date().getFullYear();
  const moter = [];

  for (const y of [aar, aar + 1]) {
    await page.goto(
      `https://websak.kongsvinger.kommune.no/innsyn_mote/wfinnsyn.ashx?response=moteplan&fradato=${y}-01-01T00:00:00`,
      { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT }
    );
    await page.waitForTimeout(1500);

    const raa = await page.evaluate((aarstall) => {
      const MND = { Jan:1,Feb:2,Mar:3,Apr:4,Mai:5,Jun:6,Jul:7,Aug:8,Sep:9,Okt:10,Nov:11,Des:12 };
      const tabell = document.querySelector('table');
      if (!tabell) return [];
      const rader = tabell.querySelectorAll('tr');
      const kolonner = Array.from(rader[0]?.querySelectorAll('th') || []).map(h => h.innerText.trim());
      const ut = [];
      for (let i = 1; i < rader.length; i++) {
        const navnEl = rader[i].querySelector('th');
        if (!navnEl) continue;
        const navn = navnEl.innerText.trim();
        if (!navn || navn.length < 2 || navn.includes('Vis ')) continue;
        rader[i].querySelectorAll('td').forEach((td, idx) => {
          const mnd = MND[kolonner[idx + 1]];
          if (!mnd) return;
          const tekst = td.innerText.trim();
          if (!tekst) return;
          tekst.split(/[,\s]+/).filter(d => /^\d{1,2}$/.test(d)).forEach(dag => {
            ut.push({
              dato: `${aarstall}-${String(mnd).padStart(2,'0')}-${String(+dag).padStart(2,'0')}`,
              navn,
            });
          });
        });
      }
      return ut;
    }, y);

    for (const r of raa) {
      // Regionale IPR-møter skilles ut i egen kolonne
      const erIpr = /kongsvingerregionen|representantskap/i.test(r.navn);
      const m = lagMote(r.dato, r.navn, '', erIpr ? 'ipr_kv' : 'kongsvinger');
      if (m) moter.push(m);
    }
  }
  return moter;
}

// ─────────────────────────────────────────────
// HOVEDPROGRAM
// ─────────────────────────────────────────────

(async () => {
  log('info', '═══════════════════════════════════════════');
  log('info', 'Henting av politiske møtedata starter');
  log('info', `Henter møter fra og med ${MIN_DATO}`);
  log('info', '═══════════════════════════════════════════');

  const raaMappe = path.join(__dirname, 'raw');
  if (!fs.existsSync(raaMappe)) fs.mkdirSync(raaMappe);

  const browser = await chromium.launch({ headless:true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width:1400, height:1000 },
  });

  const alle = [];

  async function kjor(navn, fn) {
    log('info', `\n── ${navn} ──`);
    const page = await ctx.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    let moter = await medRetry(navn, () => fn(page));
    await page.close();
    moter = dedupliser(moter);
    log('info', `  → ${moter.length} møter`);
    return moter;
  }

  for (const k of BK_KILDER) {
    alle.push(...await kjor(`${k.mun} (BK-innsyn)`, p => hentBkInnsyn(p, k.url, k.mun)));
  }

  for (const k of EC_KILDER) {
    alle.push(...await kjor(`${k.mun} (ElementsCloud)`, p => hentElementsCloud(p, k.url, k.mun)));
  }

  alle.push(...await kjor('innlandet (innlandetfylke.no)', hentInnlandet));
  alle.push(...await kjor('ringsaker (WF-innsyn)', hentRingsaker));
  alle.push(...await kjor('kongsvinger (WF-innsyn)', hentKongsvinger));

  await browser.close();

  // Sør-Østerdal IPR — faste datoer fra vedtatt møteplan
  log('info', '\n── ipr_se (fast møteplan) ──');
  const soipr = SOIPR_FASTE
    .map(m => lagMote(m.date, m.committee, '', 'ipr_se'))
    .filter(Boolean);
  log('info', `  → ${soipr.length} møter`);
  alle.push(...soipr);

  // ── Samle, sortere, validere ──
  const moter = dedupliser(alle)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const teller = {};
  moter.forEach(m => { teller[m.municipality] = (teller[m.municipality] || 0) + 1; });

  log('info', '\n═══════════════════════════════════════════');
  log('info', 'KVALITETSSJEKK');
  log('info', '═══════════════════════════════════════════');

  let tomme = 0;
  for (const [mun, min] of Object.entries(FORVENTET)) {
    const n = teller[mun] || 0;
    if (n === 0) {
      log('error', `  ✗ ${mun.padEnd(14)}: INGEN MØTER — kilden feilet`);
      tomme++;
    } else if (n < min) {
      log('warn',  `  ⚠ ${mun.padEnd(14)}: ${n} møter (forventet minst ${min})`);
    } else {
      log('info',  `  ✓ ${mun.padEnd(14)}: ${n} møter`);
    }
  }

  log('info', `\nTotalt: ${moter.length} møter fra ${Object.keys(teller).length} kilder`);

  // Rådata per kilde for feilsøking
  for (const mun of Object.keys(teller)) {
    fs.writeFileSync(
      path.join(raaMappe, `${mun}.json`),
      JSON.stringify(moter.filter(m => m.municipality === mun), null, 2)
    );
  }

  // ── Sikkerhetsnett: ikke overskriv god data med dårlig ──
  const utfil = path.join(__dirname, 'meetings.json');
  if (fs.existsSync(utfil)) {
    const forrige = JSON.parse(fs.readFileSync(utfil, 'utf8'));
    if (forrige.totalCount && moter.length < forrige.totalCount * 0.5) {
      log('error', `AVBRYTER: ${moter.length} møter er under halvparten av forrige kjøring (${forrige.totalCount}).`);
      log('error', 'meetings.json er IKKE overskrevet. Sjekk kildene manuelt.');
      fs.writeFileSync(path.join(__dirname, 'fetch-log.txt'), logg.join('\n') + '\n');
      process.exit(1);
    }
  }

  fs.writeFileSync(utfil, JSON.stringify({
    generated: new Date().toISOString(),
    totalCount: moter.length,
    sources: Object.fromEntries(Object.keys(FORVENTET).map(m => [m, { count: teller[m] || 0 }])),
    meetings: moter,
  }, null, 2));

  log('info', 'meetings.json skrevet.');
  fs.writeFileSync(path.join(__dirname, 'fetch-log.txt'), logg.join('\n') + '\n');

  if (tomme > 0) {
    log('error', `${tomme} kilder returnerte ingen møter — se loggen over.`);
    process.exit(1);
  }
})().catch(err => {
  console.error('Uventet feil:', err);
  process.exit(1);
});
