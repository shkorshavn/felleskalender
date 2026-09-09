/**
 * fetch.js — henter politiske møtedata fra alle 53 kilder i Innlandet
 * og skriver meetings.json.
 *
 * Kjøres av GitHub Actions ukentlig, eller manuelt: node fetch.js
 * Krever: npm install && npx playwright install chromium
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// KONFIGURASJON
// ─────────────────────────────────────────────

const MIN_DATO     = new Date().toISOString().slice(0, 10);
const MAX_AAR      = new Date().getFullYear() + 3;
const RETRY        = 3;
const RETRY_DELAY  = 5000;
const PAGE_TIMEOUT = 30000;
const NAV_TIMEOUT  = 60000;
const EC_MAANEDER  = 15;

const MAANEDER = {
  januar:1, februar:2, mars:3, april:4, mai:5, juni:6,
  juli:7, august:8, september:9, oktober:10, november:11, desember:12,
};
const MND_KORT = { Jan:1,Feb:2,Mar:3,Apr:4,Mai:5,Jun:6,Jul:7,Aug:8,Sep:9,Okt:10,Nov:11,Des:12 };

/** Forventet minimum møteantall per kilde — brukes til kvalitetssjekk */
const FORVENTET = {
  innlandet:15, gjovik:25, ostretoten:15, vestretoten:12, sondre_land:12, nordre_land:10, ipr:2,
  hamar:15, loten:10, stange:10, ringsaker:8,
  kongsvinger:12, ipr_kv:2, eidskog:5, grue:5, nordodal:10, sorodal:10, asnes:10,
  gausdal:8, oyer:8, lillehammer:15,
  elverum:15, ipr_se:1, engerdal:3, storelvdal:8, trysil:10, amot:10, valer:5,
  nordaurdal:5, soraurdal:5, vang:5, etnedal:5, vestreslidre:5, oystreslidre:5, ipr_valdres:2,
  tynset:3, ipr_no:2, alvdal:5, folldal:3, os:3, rendalen:5, tolga:5,
  ipr_mg:1, ringebu:5, sorfron:5, nordfron:5,
  dovre:8, lesja:8, lom:5, skjak:8, sel:8, vaga:5, ipr_ng:2,
};

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
  if (/\butvalg\b|\butval\b|komité|komite|hovedutvalg|hovudutval|nemnd|nemd|styre\b/.test(l)) return 'utvalg';
  if (/\bipr\b|representantskap|interkommunalt politisk|regionråd|regionstyr|kongsvingerregionen|søipr|sør-østerdal ipr/.test(l)) return 'ipr';
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
  return d >= MIN_DATO;
}

function lagMote(dato, tittel, tid, mun) {
  if (!gyldigDato(dato)) return null;
  if (!tittel || tittel.trim().length < 2) return null;
  if (tid && !/^\d{2}:\d{2}$/.test(tid)) tid = '';
  return {
    date: dato, time: tid || '', municipality: mun,
    committee: tittel.trim(), category: kategoriser(tittel), day: dagnavn(dato),
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
    try { return await fn(); }
    catch (err) {
      log('error', `  ${navn}: forsøk ${i}/${RETRY} feilet — ${err.message}`);
      if (i < RETRY) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  return [];
}

// ─────────────────────────────────────────────
// GENERISKE HENTEFUNKSJONER (gjenbrukes av alle kilder)
// ─────────────────────────────────────────────

/** BK-innsyn: kort-basert visning med klasse .bc-content-teaser--innsyn-mote */
async function hentBkInnsyn(page, url, mun, iprRegex = null, iprMun = 'ipr') {
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
        dag: deler[di].replace('.',''), mnd: deler[di+1]||'', aar: deler[di+2]||'',
        tittel: deler[di+3]||'', tid: ti>=0 ? (deler[ti+1]||'') : '',
      };
    }).filter(Boolean)
  );

  const moter = [];
  for (const r of raa) {
    const mnd = MAANEDER[r.mnd.toLowerCase()];
    if (!r.dag || !mnd || !r.aar) continue;
    const dato = `${r.aar}-${String(mnd).padStart(2,'0')}-${String(+r.dag).padStart(2,'0')}`;
    const effMun = (iprRegex && iprRegex.test(r.tittel)) ? iprMun : mun;
    const m = lagMote(dato, r.tittel, r.tid, effMun);
    if (m) moter.push(m);
  }
  return moter;
}

/** ElementsCloud: navigerer måned for måned, aria-label på lenker */
async function hentElementsCloud(page, url, mun) {
  await page.goto(url, { waitUntil:'networkidle', timeout:NAV_TIMEOUT });
  await page.waitForSelector('a.dmb-class', { timeout:PAGE_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2500);

  const alle = new Set();
  const hentSide = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('a.dmb-class'))
      .map(a => a.getAttribute('aria-label') || '').filter(Boolean)
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

/** WF-innsyn: tabell med utvalgsnavn i th, datoer i td per måned-kolonne */
async function hentWfInnsynTabell(page, url, mun, aar, iprRegex = null, iprMun = null) {
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT });
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
          ut.push({ dato: `${aarstall}-${String(mnd).padStart(2,'0')}-${String(+dag).padStart(2,'0')}`, navn });
        });
      });
    }
    return ut;
  }, aar);

  return raa
    .map(r => {
      const effMun = (iprRegex && iprRegex.test(r.navn)) ? iprMun : mun;
      return lagMote(r.dato, r.navn, '', effMun);
    })
    .filter(Boolean);
}

/** WF-innsyn: per-utvalg visning (h2 + lenker med dato/tid) — for Ringsaker */
async function hentWfInnsynPerUtvalg(page, baseUrl, mun, maksUtvalg = 25) {
  await page.goto(baseUrl, { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT });

  const raa = await page.evaluate(async (maks) => {
    const ut = [];
    for (let id = 1; id <= maks; id++) {
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
      } catch { /* tomt utvalg */ }
    }
    return ut;
  }, maksUtvalg);

  return raa.map(r => lagMote(r.dato, r.navn, r.tid, mun)).filter(Boolean);
}

// ─────────────────────────────────────────────
// SPESIALKILDER
// ─────────────────────────────────────────────

/** Innlandet fylkeskommune — egen HTML-struktur på innlandetfylke.no */
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

/** Kongsvinger — WF-innsyn årsoversikt, med regional IPR skilt ut */
async function hentKongsvinger(page) {
  const aar = new Date().getFullYear();
  const moter = [];
  for (const y of [aar, aar + 1]) {
    const url = `https://websak.kongsvinger.kommune.no/innsyn_mote/wfinnsyn.ashx?response=moteplan&fradato=${y}-01-01T00:00:00`;
    const del = await hentWfInnsynTabell(page, url, 'kongsvinger', y, /kongsvingerregionen|representantskap/i, 'ipr_kv');
    moter.push(...del);
  }
  return moter;
}

/** Sør-Østerdal IPR — fast vedtatt møteplan, publiseres ikke i innsynsløsning */
function hentIprSe() {
  const datoer = [
    { date:'2026-10-15', committee:'Representantskapet – Sør-Østerdal IPR' },
    { date:'2026-10-29', committee:'Styret – Sør-Østerdal IPR' },
    { date:'2026-11-26', committee:'Styret – Sør-Østerdal IPR' },
    { date:'2026-12-10', committee:'Styret – Sør-Østerdal IPR' },
  ];
  return datoer.map(m => lagMote(m.date, m.committee, '', 'ipr_se')).filter(Boolean);
}

/** Valdres IPR — fast oversikt fra valdres.no (statisk tabell, sjeldent oppdatert) */
function hentIprValdres() {
  const datoer = [
    { date:'2026-09-14', committee:'Regionrådet i Valdres IPR' },
    { date:'2026-10-19', committee:'Regionrådet i Valdres IPR' },
    { date:'2026-10-19', committee:'Valdres Natur- og Kulturpark - KO' },
    { date:'2026-10-19', committee:'Valdres friluftsråd' },
    { date:'2026-11-16', committee:'Valdresrådet' },
    { date:'2026-12-07', committee:'Regionrådet i Valdres IPR' },
    { date:'2026-12-07', committee:'Valdres Natur- og Kulturpark - KO' },
    { date:'2026-12-07', committee:'Valdres friluftsråd' },
  ];
  return datoer.map(m => lagMote(m.date, m.committee, '', 'ipr_valdres')).filter(Boolean);
}

/** IPR Nord-Østerdal — publiseres sammen med Tynset sine egne møter (samme BK-innsyn-kilde) */
async function hentTynset(page) {
  const url = 'https://www.tynset.kommune.no/innsyn/moteoversikt/';
  const alle = await hentBkInnsyn(page, url, 'tynset', /interkommunalt politisk råd/i, 'ipr_no');
  return alle;
}

/** Sel — inneholder også felles kontrollutvalgsmøter for regionen, beholdes under Sel */
async function hentSel(page) {
  return hentElementsCloud(page, 'https://prod01.elementscloud.no/publikum/939617671_PROD-939617671-SEL/Dmb', 'sel');
}

/** IPR Nord-Gudbrandsdal — egen ElementsCloud-instans */
async function hentIprNg(page) {
  return hentElementsCloud(page, 'https://prod01.elementscloud.no/publikum/976634845_PROD-976634845/Dmb', 'ipr_ng');
}

/** IPR Midt-Gudbrandsdal — filtrert BK-innsyn-visning på Nord-Fron sin side */
async function hentIprMg(page) {
  const url = 'https://www.nord-fron.kommune.no/innsyn/moteplan/#/?Datasource=00d022ac-084b-4e7c-8e0a-f6630dd9e230&Dato=2026-02-05&Dato=ComingMeetings&UtvalgID=u-00d022ac__084b__4e7c__8e0a__f6630dd9e230-29%21D3f6ej';
  return hentBkInnsyn(page, url, 'ipr_mg');
}

/**
 * Våler — Digdem GraphQL-app (React SPA, introspection blokkert).
 * Henter møter og utvalgsnavn direkte fra Apollo Client-cachen etter sidelast,
 * siden GraphQL-spørringen selv er ukjent men appen bygger cachen uansett.
 */
async function hentValer(page) {
  await page.goto('https://valer.digdem.no/motekalender', { waitUntil:'networkidle', timeout:NAV_TIMEOUT });
  await page.waitForTimeout(5000); // vent til Apollo har hentet og cachet data

  const raa = await page.evaluate(() => {
    const client = window.__APOLLO_CLIENT__;
    if (!client) return null;
    const cache = client.cache.extract();

    const commissions = {};
    Object.keys(cache).forEach(k => {
      if (k.startsWith('Commission:')) commissions[k.replace('Commission:','')] = cache[k].name;
    });

    const moter = [];
    Object.keys(cache).forEach(k => {
      if (!k.startsWith('Meeting:')) return;
      const m = cache[k];
      if (!m.date || !m.commission) return;
      const commId = m.commission.__ref
        ? m.commission.__ref.replace('Commission:','')
        : m.commission.id;
      moter.push({ date: m.date, commissionId: commId });
    });
    return { moter, commissions };
  });

  if (!raa || !raa.moter) return [];

  const out = [];
  for (const r of raa.moter) {
    const dt = new Date(r.date);
    // UTC -> norsk lokaltid (grov sommertid-tilnærming: mars-okt = +2, ellers +1)
    const offset = (dt.getUTCMonth() + 1 >= 3 && dt.getUTCMonth() + 1 <= 10) ? 2 : 1;
    dt.setUTCHours(dt.getUTCHours() + offset);
    const dato = dt.toISOString().slice(0, 10);
    const tid = dt.toISOString().slice(11, 16);
    const navn = raa.commissions[r.commissionId] || 'Ukjent utvalg';
    const m = lagMote(dato, navn, tid, 'valer');
    if (m) out.push(m);
  }
  return out;
}

// ─────────────────────────────────────────────
// KILDELISTE
// ─────────────────────────────────────────────

const BK_KILDER = [
  { mun:'gjovik',       url:'https://www.gjovik.kommune.no/politikk-planer-og-organisasjon/postliste-dokumenter-og-vedtak/politisk-moteplan/#/?page=1&pageSize=100', iprRegex:/interkommunal|koordineringsutvalg|\bipr\b/i, iprMun:'ipr' },
  { mun:'ostretoten',   url:'https://www.ototen.no/innsyn/moteplan/#/?page=1&pageSize=100' },
  { mun:'sondre_land',  url:'https://innsynpluss.onacos.no/sondre-land/moteoversikt/#/?page=1&pageSize=100' },
  { mun:'nordre_land',  url:'https://innsynpluss.onacos.no/nordre-land/moteoversikt/#/?page=1&pageSize=100' },
  { mun:'elverum',      url:'https://www.elverum.kommune.no/vare-tjenester/politikk-planer-og-organisasjon/politikk/politisk-moteplan/#/?page=1&pageSize=100' },
  { mun:'eidskog',      url:'https://www.eidskog.kommune.no/innsyn/moteplan/#/?page=1&pageSize=100' },
  { mun:'nordaurdal',   url:'https://www.nord-aurdal.kommune.no/ofte-brukt-lenker/politikk/moteplan-og-saksliste/' },
  { mun:'soraurdal',    url:'https://www.sor-aurdal.kommune.no/undermeny/politikk/moteplan-og-saksdokumenter/' },
  { mun:'vang',         url:'https://www.vang.kommune.no/undermeny/politikk/moteplan-og-sakspapirer/' },
  { mun:'etnedal',      url:'https://www.etnedal.kommune.no/undermeny/politikk-valg-direktesending-av-kommunestyremote/moteplan-for-kommunestyre-formannskap-m-fl-og-protokoll-referat/' },
  { mun:'oystreslidre', url:'https://www.oystre-slidre.kommune.no/oystre-slidre/politikk-val/moteplan-og-sakspapir/' },
  { mun:'alvdal',       url:'https://www.alvdal.kommune.no/motekalender-politiske-moter/' },
  { mun:'folldal',      url:'https://www.folldal.kommune.no/innsyn/moteoversikt/' },
  { mun:'rendalen',     url:'https://www.rendalen.kommune.no/innsyn/moteoversikt/' },
  { mun:'tolga',        url:'https://www.tolga.kommune.no/politikk/motekalender/' },
  { mun:'ringebu',      url:'https://www.ringebu.kommune.no/politikk-og-samfunnsutvikling/politikk/politiske-moter/' },
  { mun:'sorfron',      url:'https://www.sor-fron.kommune.no/innsyn-post-og-saker/moteoversikt/' },
  { mun:'nordfron',     url:'https://www.nord-fron.kommune.no/innsyn/moteplan/' },
];

const EC_KILDER = [
  { mun:'vestretoten', url:'https://prod01.elementscloud.no/publikum/971028300/Dmb' },
  { mun:'hamar',       url:'https://prod02.elementscloud.no/publikum/970540008_PROD-970540008/Dmb' },
  { mun:'loten',       url:'https://prod02.elementscloud.no/publikum/964950679_PROD-964950679/Dmb' },
  { mun:'stange',      url:'https://prod02.elementscloud.no/publikum/970169717_PROD-970169717/Dmb' },
  { mun:'gausdal',     url:'https://prod02.elementscloud.no/publikum/961381274_PROD-961381274/Dmb' },
  { mun:'oyer',        url:'https://prod02.elementscloud.no/publikum/961381185_PROD-961381185/Dmb' },
  { mun:'lillehammer', url:'https://prod02.elementscloud.no/publikum/945578564_PROD-945578564/Dmb' },
  { mun:'dovre',       url:'https://prod01.elementscloud.no/publikum/939849831_PROD-939849831-DOVRE/Dmb' },
  { mun:'lesja',       url:'https://prod01.elementscloud.no/publikum/964949204_PROD-964949204-LESJA/Dmb' },
  { mun:'lom',         url:'https://prod01.elementscloud.no/publikum/959377677_PROD-959377677-LOM/Dmb' },
  { mun:'skjak',       url:'https://prod01.elementscloud.no/publikum/961381096_PROD-961381096/Dmb' },
  { mun:'vaga',        url:'https://prod01.elementscloud.no/publikum/939607706_PROD-939607706-VAGA/Dmb' },
  { mun:'engerdal',    url:'https://prod01.elementscloud.no/publikum/964948976_PROD-964948976/Dmb' },
  { mun:'storelvdal',  url:'https://prod01.elementscloud.no/publikum/964948887_PROD-964948887/Dmb' },
  { mun:'trysil',      url:'https://prod01.elementscloud.no/publikum/864948502_PROD-864948502/Dmb' },
  { mun:'amot',        url:'https://prod01.elementscloud.no/publikum/940152496_PROD-940152496/Dmb' },
];

const WF_TABELL_KILDER = [
  { mun:'sorodal', url:'https://innsyn.onacos.no/sorodal/wfinnsyn.ashx?response=moteplan&fradato=2026-01-01T00:00:00' },
  { mun:'asnes',   url:'https://innsyn.onacos.no/asnes/wfinnsyn.ashx?response=moteplan&MId1=146&' },
  { mun:'grue',    url:'https://innsyn.onacos.no/grue/wfinnsyn.ashx?response=moteplan' },
  { mun:'nordodal',url:'https://innsyn.onacos.no/nordodal/mote/wfinnsyn.ashx?response=moteplan&' },
  { mun:'vestreslidre', url:'https://www.vestre-slidre.kommune.no/administrasjon/politikk-rad-og-utval/motekalender/' },
];

// ─────────────────────────────────────────────
// HOVEDPROGRAM
// ─────────────────────────────────────────────

(async () => {
  log('info', '═══════════════════════════════════════════');
  log('info', 'Henting av politiske møtedata – hele Innlandet');
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
  const aarNaa = new Date().getFullYear();

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

  // ── BK-innsyn-kilder ──
  for (const k of BK_KILDER) {
    alle.push(...await kjor(`${k.mun} (BK-innsyn)`, p => hentBkInnsyn(p, k.url, k.mun, k.iprRegex, k.iprMun)));
  }

  // ── ElementsCloud-kilder ──
  for (const k of EC_KILDER) {
    alle.push(...await kjor(`${k.mun} (ElementsCloud)`, p => hentElementsCloud(p, k.url, k.mun)));
  }

  // ── WF-innsyn tabellbaserte kilder ──
  for (const k of WF_TABELL_KILDER) {
    alle.push(...await kjor(`${k.mun} (WF-innsyn)`, p => hentWfInnsynTabell(p, k.url, k.mun, aarNaa)));
  }

  // ── Spesialkilder ──
  alle.push(...await kjor('innlandet (innlandetfylke.no)', hentInnlandet));
  alle.push(...await kjor('ringsaker (WF-innsyn per utvalg)', p => hentWfInnsynPerUtvalg(p, 'https://innsyn.ringsaker.kommune.no/wfinnsyn.ashx?response=moteplan_utvalg&fradato=2026-01-01T00:00:00&utvalg=1&', 'ringsaker')));
  alle.push(...await kjor('kongsvinger + ipr_kv (WF-innsyn)', hentKongsvinger));
  alle.push(...await kjor('sel (ElementsCloud, inkl. felles kontrollutvalg)', hentSel));
  alle.push(...await kjor('ipr_ng (ElementsCloud)', hentIprNg));
  alle.push(...await kjor('ipr_mg (BK-innsyn filtrert)', hentIprMg));
  alle.push(...await kjor('tynset + ipr_no (BK-innsyn)', hentTynset));
  alle.push(...await kjor('valer (Digdem GraphQL/Apollo cache)', hentValer));

  await browser.close();

  // ── Faste møteplaner (ikke maskinlesbare kilder) ──
  log('info', '\n── ipr_se (fast møteplan) ──');
  const iprSe = hentIprSe();
  log('info', `  → ${iprSe.length} møter`);
  alle.push(...iprSe);

  log('info', '\n── ipr_valdres (fast oversikt) ──');
  const iprValdres = hentIprValdres();
  log('info', `  → ${iprValdres.length} møter`);
  alle.push(...iprValdres);

  // ── Samle, sortere, validere ──
  const moter = dedupliser(alle).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const teller = {};
  moter.forEach(m => { teller[m.municipality] = (teller[m.municipality] || 0) + 1; });

  log('info', '\n═══════════════════════════════════════════');
  log('info', 'KVALITETSSJEKK');
  log('info', '═══════════════════════════════════════════');

  let tomme = 0;
  for (const [mun, min] of Object.entries(FORVENTET)) {
    const n = teller[mun] || 0;
    if (n === 0) { log('error', `  ✗ ${mun.padEnd(14)}: INGEN MØTER — kilden feilet`); tomme++; }
    else if (n < min) log('warn', `  ⚠ ${mun.padEnd(14)}: ${n} møter (forventet minst ${min})`);
    else log('info', `  ✓ ${mun.padEnd(14)}: ${n} møter`);
  }

  log('info', `\nTotalt: ${moter.length} møter fra ${Object.keys(teller).length} kilder`);

  for (const mun of Object.keys(teller)) {
    fs.writeFileSync(path.join(raaMappe, `${mun}.json`), JSON.stringify(moter.filter(m => m.municipality === mun), null, 2));
  }

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
