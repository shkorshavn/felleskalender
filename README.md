# Politisk møtekalender – hele Innlandet

Automatisk oppdatert møtekalender som dekker **Innlandet fylkeskommune, alle 46 kommuner,
og 6 regionale interkommunale politiske råd (IPR)**. Driftes som statisk nettside på
GitHub Pages. Data hentes automatisk hver mandag via GitHub Actions.

---

## Filer i denne pakken

| Fil | Beskrivelse |
|---|---|
| `index.html` | Nettsiden — sidepanel med filter til venstre, tabell til høyre, med fast overskriftsrad og dynamiske kolonner |
| `meetings.json` | Strukturert møtedata — 1018 møter fra 53 kilder |
| `fetch.js` | Playwright-skript som henter data fra alle 53 kilder automatisk |
| `package.json` / `package-lock.json` | Node.js-avhengigheter |
| `.github/workflows/oppdater.yml` | GitHub Actions workflow (cron hver mandag + manuell kjøring) |

---

## Opplasting til GitHub

1. Åpne GitHub Desktop
2. **Pull origin** først (hent ned eventuelle endringer fra GitHub)
3. Kopier alle filene fra denne pakken inn i repo-mappen din — erstatt eksisterende
4. **Commit** med en beskrivende melding, f.eks. `Fullført alle 53 kilder i Innlandet`
5. **Push origin**

Etter push bygger GitHub Pages automatisk, og siden er oppdatert innen 1–2 minutter.

---

## Dekning — alle 10 regioner

| Region | Kilder | Status |
|---|---|---|
| Innlandet fylkeskommune | 1 | ✅ |
| Gjøvik-regionen | 6 kommuner + IPR | ✅ |
| Hamar-regionen | 4 kommuner | ✅ |
| Kongsvinger-regionen | 6 kommuner + IPR | ✅ |
| Lillehammer-regionen | 3 kommuner | ✅ |
| Sør-Østerdal | 6 kommuner + IPR | ✅ |
| Valdres | 6 kommuner + IPR | ✅ |
| Midt-Gudbrandsdal | 3 kommuner + IPR | ✅ |
| Nord-Gudbrandsdal | 6 kommuner + IPR | ✅ |
| Nord-Østerdal | 6 kommuner + IPR (delt kilde med Tynset) | ✅ |

**Totalt: 53 kilder, 1018 fremtidige møter** (tallet synker naturlig etter hvert som møter
passerer, og øker igjen når kommunene publiserer nye).

---

## Datakilder og teknikk

| System | Brukes av | Teknikk i `fetch.js` |
|---|---|---|
| **BK-innsyn** | Gjøvik, Østre Toten, Søndre Land, Nordre Land, Elverum, Eidskog, Nord-Aurdal, Sør-Aurdal, Vang, Etnedal, Øystre Slidre, Alvdal, Folldal, Rendalen, Tolga, Ringebu, Sør-Fron, Nord-Fron | `hentBkInnsyn()` — kort med klasse `.bc-content-teaser--innsyn-mote` |
| **ElementsCloud** | Vestre Toten, Hamar, Løten, Stange, Gausdal, Øyer, Lillehammer, Dovre, Lesja, Lom, Skjåk, Vågå, Sel, Engerdal, Stor-Elvdal, Trysil, Åmot | `hentElementsCloud()` — navigerer måned for måned, leser `aria-label` |
| **WF-innsyn (tabell)** | Sør-Odal, Åsnes, Grue, Nord-Odal, Vestre Slidre | `hentWfInnsynTabell()` — årsoversikt med utvalg i rader |
| **WF-innsyn (per utvalg)** | Ringsaker | `hentWfInnsynPerUtvalg()` — henter hvert utvalg separat |
| **Digdem (GraphQL/React)** | Våler | `hentValer()` — leser Apollo Client-cachen direkte etter sidelast, siden introspection er blokkert |
| **innlandetfylke.no** | Innlandet FK | `hentInnlandet()` — egen kortstruktur |
| **Faste møteplaner** | Sør-Østerdal IPR, Valdres IPR | Hardkodede datoer — disse kildene publiserer ikke i maskinlesbart format og må oppdateres manuelt i `fetch.js` når ny møteplan vedtas |

### Spesialtilfeller

- **Gjøvik**: IPR/koordineringsutvalg-møter skilles automatisk ut i egen `ipr`-kolonne
- **Kongsvinger**: Regionale IPR-møter skilles ut i `ipr_kv`
- **Tynset**: Egen kilde henter både kommunens møter OG regionens IPR-møter (`ipr_no`) fra samme side
- **Sel**: Kilden inneholder også felles kontrollutvalgsmøter for Dovre, Lom, Skjåk, Lesja og Vågå — disse forblir under `sel` siden det er der de publiseres
- **Nord-Fron**: Egen filtrert URL brukes for å hente Midt-Gudbrandsdal IPR (`ipr_mg`) fra samme BK-innsyn-system

---

## Kvalitetssikring i `fetch.js`

Etter hver kjøring:
- Hver av de 53 kildene logges med ✓ (OK), ⚠ (færre møter enn forventet) eller ✗ (ingen møter — kilden feilet)
- Hvis en kjøring gir **under halvparten** så mange møter totalt som forrige kjøring, avbrytes jobben og `meetings.json` overskrives IKKE — dette hindrer at en midlertidig feil på én eller flere kilder ødelegger hele datasettet
- Rådata per kilde lagres i `raw/<kilde>.json` for feilsøking

---

## Feilsøking

**En kilde slutter å gi treff:** Sjekk `raw/<kilde>.json` i repoet etter siste kjøring, og se om URL-en fortsatt er riktig — kommuner endrer nettsidestruktur fra tid til annen.

**Digdem/Våler slutter å fungere:** Dette er den mest sårbare kilden siden den er avhengig av intern Apollo-cache-struktur. Hvis den feiler, sjekk om `window.__APOLLO_CLIENT__` fortsatt eksisterer på siden (endring i Digdem sin app kan fjerne dette).

**Faste møteplaner (IPR Sør-Østerdal og Valdres) blir utdaterte:** Disse må oppdateres manuelt i `fetch.js` når ny årlig møteplan vedtas — søk etter `hentIprSe()` og `hentIprValdres()` i filen.

**GitHub Actions feiler:** Gå til **Actions**-fanen → klikk på jobben → se loggene. Se etter `KVALITETSSJEKK`-seksjonen for å se nøyaktig hvilke kilder som feilet.
