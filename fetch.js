/**
 * fetch.js
 * Henter politiske møtedata fra 13 kilder og skriver meetings.json.
 * Kjøres av GitHub Actions ukentlig, eller manuelt: node fetch.js
 *
 * Krav: npm install playwright && npx playwright install chromium
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// KONFIGURASJON
// ─────────────────────────────────────────────

const MIN_YEAR      = 2026; // Hent ikke møter fra før 2026
const RETRY         = 3;
const RETRY_DELAY   = 5000;
const PAGE_TIMEOUT  = 30000;
const NAV_TIMEOUT   = 60000;

/** Forventede møteantall per kilde – brukes til å advare ved avvik */
const EXPECTED = {
  innlandet:   { min: 25, max: 55 },
  gjovik:      { min: 40, max: 110 },
  ostretoten:  { min: 25, max: 65 },
  vestretoten: { min: 25, max: 65 },
  sondre_land: { min: 20, max: 55 },
  nordre_land: { min: 20, max: 55 },
  ipr:         { min: 2,  max: 20 },
  hamar:       { min: 20, max: 60 },
  stange:      { min: 15, max: 50 },
  ringsaker:   { min: 10, max: 40 },
  lillehammer: { min: 30, max: 80 },
  elverum:     { min: 5,  max: 30 },
  kongsvinger: { min: 20, max: 70 },
};

// ─────────────────────────────────────────────
// NORSKE MÅNEDSNAVN
// ─────────────────────────────────────────────

const MÅNEDER = {
  januar:1, februar:2, mars:3, april:4, mai:5, juni:6,
  juli:7, august:8, september:9, oktober:10, november:11, desember:12,
};

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────

const logLines = [];
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function saveLog() {
  fs.writeFileSync(
    path.join(__dirname, 'fetch-log.txt'),
    logLines.join('\n') + '\n',
  );
}

// ─────────────────────────────────────────────
// KATEGORISERING
// ─────────────────────────────────────────────

function kategoriser(tittel) {
  const l = tittel.toLowerCase();
  if (/kommunestyre|fylkesting/.test(l))                                              return 'kst';
  if (/formannskap|fylkesutvalg/.test(l))                                            return 'fsk';
  if (/\butvalg\b|komité|komite|komité|hovedutvalg|nemnd/.test(l))                   return 'utvalg';
  if (/ipr|interkommunalt politisk|koordineringsutvalg|representantskap|kongsvingerregionen/.test(l)) return 'ipr';
  return 'andre';
}

// ─────────────────────────────────────────────
// VALIDERING
// ─────────────────────────────────────────────

function validerDato(d) {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, da] = m.map(Number);
  if (y < MIN_YEAR || y > MIN_YEAR + 5) return false; // Godta 5 år frem
  if (mo < 1 || mo > 12) return false;
  return da >= 1 && da <= new Date(y, mo, 0).getDate();
}

function validerTid(t) {
  return !t || /^\d{2}:\d{2}$/.test(t);
}

function dedupliser(liste) {
  const seen = new Set();
  return liste.filter(m => {
    const k = `${m.date}|${m.committee}|${m.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function byggMøte(dato, tittel, tid, mun) {
  if (!validerDato(dato)) { log('warn', `  Ugyldig dato: ${dato} for "${tittel}"`); return null; }
  if (!validerTid(tid))   { log('warn', `  Ugyldig tid: "${tid}" for "${tittel}"`); return null; }
  return {
    date:        dato,
    time:        tid || '',
    municipality: mun,
    committee:   tittel,
    category:    kategoriser(tittel),
  };
}

// ─────────────────────────────────────────────
// RETRY-WRAPPER
// ─────────────────────────────────────────────

async function medRetry(navn, fn) {
  for (let i = 1; i <= RETRY; i++) {
    try {
      return await fn();
    } catch (err) {
      log('error', `  Forsøk ${i}/${RETRY} feilet for ${navn}: ${err.message}`);
      if (i < RETRY) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  log('error', `  Alle forsøk feilet for ${navn} – returnerer tom liste`);
  return [];
}

// ─────────────────────────────────────────────
// HENTING: BK-innsyn (Gjøvik, ØT, SL, NL, Elverum)
// Bruker ?page=1&pageSize=100 – alt på én side, ingen navigering.
// ─────────────────────────────────────────────

async function hentBkInnsyn(page, url, mun) {
  log('info', `  Henter BK-innsyn: ${mun}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForSelector('.bc-content-teaser--innsyn-mote', { timeout: PAGE_TIMEOUT });

  const rådata = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bc-content-teaser--innsyn-mote')).map(el => {
      const parts = el.innerText.replace(/\n+/g, '|').split('|').map(p => p.trim()).filter(Boolean);
      const di = parts.findIndex(p => /^\d+\.$/.test(p));
      if (di < 0) return null;
      const tidIdx = parts.indexOf('Tid');
      return {
        dag:     parts[di].replace('.', ''),
        mnd:     parts[di + 1] || '',
        aar:     parts[di + 2] || '',
        tittel:  parts[di + 3] || '',
        tid:     tidIdx >= 0 ? (parts[tidIdx + 1] || '') : '',
        href:    el.querySelector('a')?.href || '',
      };
    }).filter(Boolean)
  );

  const møter = [];
  for (const r of rådata) {
    const mndNr = MÅNEDER[r.mnd.toLowerCase()];
    if (!r.dag || !mndNr || !r.aar) continue;
    const dato = `${r.aar}-${String(mndNr).padStart(2,'0')}-${String(+r.dag).padStart(2,'0')}`;

    // IPR/koordinering fra Gjøvik → egen kolonne
    const effMun = /interkommunal|koordineringsutvalg|\bipr\b/i.test(r.tittel) ? 'ipr' : mun;
    const m = byggMøte(dato, r.tittel, r.tid, effMun);
    if (m) møter.push(m);
  }
  return møter;
}

// ─────────────────────────────────────────────
// HENTING: ElementsCloud prod01/prod02
// Navigerer måned for måned med «Neste»-knapp.
// ─────────────────────────────────────────────

async function hentElementsCloud(page, url, mun) {
  log('info', `  Henter ElementsCloud: ${mun}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForSelector('a.dmb-class', { timeout: PAGE_TIMEOUT });

  const alle = new Set();
  const hentSide = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('a.dmb-class'))
      .map(a => a.getAttribute('aria-label') || '')
      .filter(Boolean)
  );

  (await hentSide()).forEach(l => alle.add(l));

  // Naviger frem til siste tilgjengelige måned (maks 18 klikk = 1,5 år)
  for (let i = 0; i < 18; i++) {
    const nesteBtn = page.locator('button', { hasText: 'Neste' });
    if (await nesteBtn.count() === 0) break;
    await nesteBtn.click();
    await page.waitForTimeout(2000);
    (await hentSide()).forEach(l => alle.add(l));
  }

  // Parse aria-label: "Formannskap 3.6.2026 09:00"
  const re = /^(.+?)\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{2}:\d{2})$/;
  const møter = [];
  for (const label of alle) {
    const m = label.match(re);
    if (!m) { log('warn', `  Kan ikke parse aria-label: "${label}"`); continue; }
    const [, tittel, dag, mnd, aar, tid] = m;
    const dato = `${aar}-${String(+mnd).padStart(2,'0')}-${String(+dag).padStart(2,'0')}`;
    const møte = byggMøte(dato, tittel.trim(), tid, mun);
    if (møte) møter.push(møte);
  }
  return møter;
}

// ─────────────────────────────────────────────
// HENTING: innlandetfylke.no (Innlandet FK)
// Enkel statisk HTML-liste – ingen navigering.
// ─────────────────────────────────────────────

async function hentInnlandet(page) {
  const url = 'https://innlandetfylke.no/Kalender/CalendarEvents.aspx?lang=1&kategori=83&dir=ComingEvents&MId1=7&pageSize=100';
  log('info', '  Henter innlandetfylke.no');
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  await page.waitForSelector('.cc-teaser-body-content', { timeout: PAGE_TIMEOUT });

  const rådata = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cc-teaser-body-content')).map(card => ({
      tittel:    card.querySelector('h2,h3,.cc-teaser-title')?.innerText.trim() || '',
      datoFelt:  (card.innerText.match(/Dato\s*\n?([^\n]+)/) || [])[1]?.trim() || '',
      tidFelt:   (card.innerText.match(/Tidspunkt\s*\n?([^\n]+)/) || [])[1]?.trim() || '',
    }))
  );

  const MNDR = { januar:1, februar:2, mars:3, april:4, mai:5, juni:6,
                 juli:7, august:8, september:9, oktober:10, november:11, desember:12 };

  function parseDato(felt) {
    const treff = [...felt.matchAll(/(\d{1,2})\.\s*(\w+)\s*(\d{4})/g)];
    if (!treff.length) return null;
    const [, d, mNavn, y] = treff[0];
    const mNr = MNDR[mNavn.toLowerCase()];
    if (!mNr) return null;
    return `${y}-${String(mNr).padStart(2,'0')}-${String(+d).padStart(2,'0')}`;
  }
  function parseTid(felt) {
    const m = felt.match(/kl\.\s*(\d{1,2})\.(\d{2})/);
    return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
  }

  const møter = [];
  for (const r of rådata) {
    if (!/fylkesting|fylkesutvalg|hovedutvalg/i.test(r.tittel)) continue;
    const dato = parseDato(r.datoFelt);
    if (!dato) { log('warn', `  Kan ikke parse dato for "${r.tittel}": "${r.datoFelt}"`); continue; }
    const m = byggMøte(dato, r.tittel, parseTid(r.tidFelt), 'innlandet');
    if (m) møter.push(m);
  }
  return møter;
}

// ─────────────────────────────────────────────
// HENTING: Ringsaker (WF-innsyn same-origin fetch)
// ─────────────────────────────────────────────

async function hentRingsaker(page) {
  log('info', '  Henter Ringsaker (WF-innsyn)');
  await page.goto(
    'https://innsyn.ringsaker.kommune.no/wfinnsyn.ashx?response=moteplan_utvalg&fradato=2026-01-01T00:00:00&utvalg=1&',
    { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
  );

  const UTVALG_IDS = Array.from({ length: 20 }, (_, i) => i + 1);
  const alle = [];

  for (const id of UTVALG_IDS) {
    const url = `/wfinnsyn.ashx?response=moteplan_utvalg&fradato=2026-01-01T00:00:00&utvalg=${id}&`;
    try {
      const møter = await page.evaluate(async (u) => {
        const resp = await fetch(u);
        const text = await resp.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const h2 = doc.querySelector('h2');
        if (!h2) return [];
        const navn = h2.innerText.trim();
        if (!navn || navn.length < 2) return [];
        return Array.from(doc.querySelectorAll('a')).map(a => {
          const t = a.innerText.trim();
          const m = t.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})/);
          return m ? { dato: `${m[3]}-${m[2]}-${m[1]}`, tid: m[4], utvalg: navn } : null;
        }).filter(Boolean);
      }, url);
      alle.push(...møter);
    } catch {
      // Tomt utvalg – ignorer
    }
  }

  return alle
    .filter(r => r.dato >= `${YEAR}-01-01`)
    .map(r => byggMøte(r.dato, r.utvalg, r.tid, 'ringsaker'))
    .filter(Boolean);
}

// ─────────────────────────────────────────────
// HENTING: Kongsvinger (WF-innsyn oversiktstabell)
// ─────────────────────────────────────────────

async function hentKongsvinger(page) {
  log('info', '  Henter Kongsvinger (WF-innsyn)');
  await page.goto(
    'https://websak.kongsvinger.kommune.no/innsyn_mote/wfinnsyn.ashx?response=moteplan&fradato=2026-01-01T00:00:00',
    { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
  );

  const møter = await page.evaluate((year) => {
    const MNDR = { Jan:1, Feb:2, Mar:3, Apr:4, Mai:5, Jun:6, Jul:7, Aug:8, Sep:9, Okt:10, Nov:11, Des:12 };
    const table = document.querySelector('table');
    if (!table) return [];
    const rows = table.querySelectorAll('tr');
    const headers = Array.from(rows[0]?.querySelectorAll('th') || []).map(h => h.innerText.trim());
    const alle = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const navnEl = row.querySelector('th');
      if (!navnEl) continue;
      const navn = navnEl.innerText.trim();
      if (!navn || navn.length < 2 || navn.includes('Vis ')) continue;
      const tds = row.querySelectorAll('td');
      Array.from(tds).forEach((td, idx) => {
        const mnd = MNDR[headers[idx + 1]];
        if (!mnd) return;
        const tekst = td.innerText.trim();
        if (!tekst) return;
        tekst.split(/[,\s]+/).filter(d => /^\d{1,2}$/.test(d.trim())).forEach(dag => {
          const dato = `${year}-${String(mnd).padStart(2,'0')}-${String(+dag).padStart(2,'0')}`;
          alle.push({ dato, tittel: navn });
        });
      });
    }
    return alle;
  }, YEAR);

  return møter
    .filter(r => r.dato >= `${YEAR}-01-01`)
    .map(r => byggMøte(r.dato, r.tittel, '', 'kongsvinger'))
    .filter(Boolean);
}

// ─────────────────────────────────────────────
// KVALITETSSIKRING
// ─────────────────────────────────────────────

function kvalitetssikre(mun, møter) {
  const exp = EXPECTED[mun];
  if (!exp) return;
  if (møter.length < exp.min)
    log('warn', `⚠  ${mun}: ${møter.length} møter – under forventet minimum (${exp.min})`);
  if (møter.length > exp.max)
    log('warn', `⚠  ${mun}: ${møter.length} møter – over forventet maksimum (${exp.max})`);
}

// ─────────────────────────────────────────────
// HOVED
// ─────────────────────────────────────────────

(async () => {
  log('info', '════════════════════════════════════════════');
  log('info', 'Politisk møtekalender – datahenting starter');
  log('info', `Tidspunkt: ${new Date().toISOString()}`);
  log('info', '════════════════════════════════════════════');

  if (!fs.existsSync(path.join(__dirname, 'raw')))
    fs.mkdirSync(path.join(__dirname, 'raw'));

  const browser = await chromium.launch({ headless: true });
  const alleMøter = [];
  const sourcesMeta = {};

  const BK_SOURCES = [
    { mun: 'gjovik',      url: 'https://www.gjovik.kommune.no/politikk-planer-og-organisasjon/postliste-dokumenter-og-vedtak/politisk-moteplan/#/?page=1&pageSize=100' },
    { mun: 'ostretoten',  url: 'https://www.ototen.no/innsyn/moteplan/#/?page=1&pageSize=100' },
    { mun: 'sondre_land', url: 'https://innsynpluss.onacos.no/sondre-land/moteoversikt/#/?page=1&pageSize=100' },
    { mun: 'nordre_land', url: 'https://innsynpluss.onacos.no/nordre-land/moteoversikt/#/?page=1&pageSize=100' },
    { mun: 'elverum',     url: 'https://www.elverum.kommune.no/vare-tjenester/politikk-planer-og-organisasjon/politikk/politisk-moteplan/#/?page=1&pageSize=100' },
  ];

  const EC_SOURCES = [
    { mun: 'vestretoten', url: 'https://prod01.elementscloud.no/publikum/971028300/Dmb' },
    { mun: 'hamar',       url: 'https://prod02.elementscloud.no/publikum/970540008_PROD-970540008/Dmb' },
    { mun: 'stange',      url: 'https://prod02.elementscloud.no/publikum/970169717_PROD-970169717/Dmb' },
    { mun: 'lillehammer', url: 'https://prod02.elementscloud.no/publikum/945578564_PROD-945578564/Dmb' },
  ];

  // BK-innsyn
  for (const src of BK_SOURCES) {
    log('info', `\n── ${src.mun} (BK-innsyn) ──`);
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    const møter = await medRetry(src.mun, () => hentBkInnsyn(page, src.url, src.mun));
    await page.close();
    const dedup = dedupliser(møter);
    kvalitetssikre(src.mun, dedup);
    fs.writeFileSync(path.join(__dirname, 'raw', `${src.mun}.json`), JSON.stringify(dedup, null, 2));
    sourcesMeta[src.mun] = { count: dedup.length, fetched: new Date().toISOString() };
    alleMøter.push(...dedup);
    log('info', `  → ${dedup.length} møter`);
  }

  // ElementsCloud
  for (const src of EC_SOURCES) {
    log('info', `\n── ${src.mun} (ElementsCloud) ──`);
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    const møter = await medRetry(src.mun, () => hentElementsCloud(page, src.url, src.mun));
    await page.close();
    const dedup = dedupliser(møter);
    kvalitetssikre(src.mun, dedup);
    fs.writeFileSync(path.join(__dirname, 'raw', `${src.mun}.json`), JSON.stringify(dedup, null, 2));
    sourcesMeta[src.mun] = { count: dedup.length, fetched: new Date().toISOString() };
    alleMøter.push(...dedup);
    log('info', `  → ${dedup.length} møter`);
  }

  // Innlandet FK
  {
    log('info', '\n── innlandet (innlandetfylke.no) ──');
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    const møter = await medRetry('innlandet', () => hentInnlandet(page));
    await page.close();
    const dedup = dedupliser(møter);
    kvalitetssikre('innlandet', dedup);
    // Legg til IPR-møter fra Gjøvik som er tagget mun='ipr'
    const iprMøter = alleMøter.filter(m => m.municipality === 'ipr');
    fs.writeFileSync(path.join(__dirname, 'raw', 'innlandet.json'), JSON.stringify(dedup, null, 2));
    fs.writeFileSync(path.join(__dirname, 'raw', 'ipr.json'), JSON.stringify(iprMøter, null, 2));
    sourcesMeta['innlandet'] = { count: dedup.length, fetched: new Date().toISOString() };
    sourcesMeta['ipr'] = { count: iprMøter.length, fetched: new Date().toISOString() };
    alleMøter.push(...dedup);
    log('info', `  → ${dedup.length} møter`);
    log('info', `  → ${iprMøter.length} IPR-møter (fra Gjøvik)`);
  }

  // Ringsaker
  {
    log('info', '\n── ringsaker (WF-innsyn) ──');
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    const møter = await medRetry('ringsaker', () => hentRingsaker(page));
    await page.close();
    const dedup = dedupliser(møter);
    kvalitetssikre('ringsaker', dedup);
    fs.writeFileSync(path.join(__dirname, 'raw', 'ringsaker.json'), JSON.stringify(dedup, null, 2));
    sourcesMeta['ringsaker'] = { count: dedup.length, fetched: new Date().toISOString() };
    alleMøter.push(...dedup);
    log('info', `  → ${dedup.length} møter`);
  }

  // Kongsvinger
  {
    log('info', '\n── kongsvinger (WF-innsyn) ──');
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    const møter = await medRetry('kongsvinger', () => hentKongsvinger(page));
    await page.close();
    const dedup = dedupliser(møter);
    kvalitetssikre('kongsvinger', dedup);
    fs.writeFileSync(path.join(__dirname, 'raw', 'kongsvinger.json'), JSON.stringify(dedup, null, 2));
    sourcesMeta['kongsvinger'] = { count: dedup.length, fetched: new Date().toISOString() };
    alleMøter.push(...dedup);
    log('info', `  → ${dedup.length} møter`);
  }

  await browser.close();

  // Sorter
  alleMøter.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  const output = {
    generated: new Date().toISOString(),
    totalCount: alleMøter.length,
    sources: sourcesMeta,
    meetings: alleMøter,
  };

  fs.writeFileSync(path.join(__dirname, 'meetings.json'), JSON.stringify(output, null, 2));

  log('info', '\n════════════════════════════════════════════');
  log('info', `Ferdig. ${alleMøter.length} møter lagret i meetings.json`);
  Object.entries(sourcesMeta).forEach(([k, v]) => log('info', `  ${k.padEnd(14)}: ${v.count} møter`));
  log('info', '════════════════════════════════════════════');

  saveLog();
})();
