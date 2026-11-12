# O-info – výpis přihlášek

## Pro uživatele (stručně)

Aplikace na [o-info.cz](https://o-info.cz/) vypíše z ORISu přihlášky na závody pro zadané závodníky nebo celý klub. U každého závodníka ukáže kategorii, startovní čas, parametry tratě a odkazy na pokyny, startovku a mapu.

**Zadání:**

| Zadání | Příklad | Co se vypíše |
|---|---|---|
| Registrační číslo | `SJC8102` | přihlášky jednoho závodníka |
| Více reg. čísel | `SJC8102,SJC8351` | přihlášky všech uvedených |
| Zkratka klubu | `SJC` | všechny přihlášky klubu (nebo výběr z roletky) |

- Odkaz `https://o-info.cz/?SJC8102,SJC8351` nebo `https://o-info.cz/?SJC` výpis rovnou načte.
- Roletka *poslední hodnoty* nabízí 5 posledních hledání.

**Období** (sekce *Upřesnit výběr*):
- následujících 30 dní (výchozí),
- vlastní období od–do,
- konkrétní závod z následujících 30 dní nebo z celého roku, volitelně i neoficiální závody.

**Ve výpisu:**
- závody podle data, u každého závodníci podle startovního času,
- kategorie (při přeřazení *původní → nová*), reg. číslo, SI, startovní čas, parametry tratě,
- odkazy *Pokyny*, *Parametry*, *Soupisky* (štafety) a *Tisk* (stránka k vytištění se startovními časy),
- rankingová kategorie (H/D 20 a 21 vč. podkategorií na závodě s rankingem) je odkazem na **přihlášené podle rankingu**:
  - zobrazí se závod a údaje o rankingu: lesní/sprintový, rozhodné datum, koeficient, PB, KS,
  - seznam kategorie je seřazený podle pořadí v rankingu, s rankingovým číslem a body; ★ označuje závodníky započtené do PB,
- závody s **více než 6 přihlášenými** jsou sbalené na jeden řádek:
  - rozbalí se šipkou na začátku řádku nebo kliknutím na počet,
  - u rozbaleného závodu zůstává název při rolování nahoře,
  - nad výpisem jsou tlačítka *Rozbalit vše* a *Sbalit vše*,
- na mobilu karty místo tabulky; přepínač světlého a tmavého režimu.

**Na co si dát pozor:**
- Finálové závody (jen startovka, bez přihlášek) se u klubu zobrazí vždy, u reg. čísel jen při výběru konkrétního závodu.
- Štafety: u klubu se vypíší týmy, u reg. čísel jednotliví závodníci.
- Startovní časy, parametry a pokyny se objeví, až je pořadatel zveřejní.

Aplikace neukládá žádné osobní údaje. V prohlížeči si pamatuje historii hledání, režim zobrazení a kvůli šetření ORISu také zřídka měněná veřejná data: kluby, detaily závodů a seznam závodů. Přihlášky, startovky a výsledky jsou vždy čerstvé. Server dočasně ukládá jen veřejný export rankingu.

Podrobná nápověda pro uživatele je na stránce [napoveda.html](napoveda.html). Na hlavní stránce zůstává i rozbalovací stručná nápověda.

---

## Pro administrátora (podrobně a technicky)

### Soubory

| Soubor | Účel |
|---|---|
| `/index.html` | Stránka výpisu (kořen webu), rozbalovací stručná nápověda, Google Analytics, odkaz na podrobnou nápovědu. |
| `/prihlasky/js/main.js` | Logika výpisu (načítá se jako modul). |
| `/prihlasky/js/oris-cache.js` | Volání ORIS API a cache v prohlížeči (sdílí `main.js` i `ranking.js`). |
| `/prihlasky/css/styles.css` | Styly včetně tmavého režimu. Používá je i `/projekty/`. |
| `/prihlasky/napoveda.html` | Podrobná nápověda. Obsah odpovídá tomuto README, při změnách je potřeba upravit obojí. |
| `/prihlasky/data/` | Ikona Mapy.com. |
| `/prihlasky/ranking.html`, `/prihlasky/js/ranking.js` | Přihlášení v kategorii podle rankingu (`?event=<ID>&class=<ID nebo název kategorie>`). |
| `/prihlasky/ranking.php` | Serverový prostředník pro `ranking_export` z ORIS (nemá CORS). |
| `/prihlasky/m/index.html` | Soukromý seznam reg. čísel. **Je veřejně dostupný**, zvažte odstranění nebo přejmenování. |

Výpis přihlášek volá veřejné ORIS API přímo z prohlížeče. Jedinou serverovou částí je `ranking.php`: vyžaduje PHP 8.1 a novější s `curl` a `mbstring`, stejně jako dluhy.

### Ranking

- **Proč prostředník:** `https://oris.ceskyorientak.cz/ranking_export?date=…&sport=1&gender=M|F&ranktype=2|8&csv=1` neposílá `Access-Control-Allow-Origin`, takže ho prohlížeč nesmí stáhnout. API tuto hlavičku posílá.
- **`ranking.php?date=YYYY-MM-DD&gender=M|F&ranktype=2|8`:**
  - ověří vstup a stáhne CSV (`Poradi;Prijmeni;Jmeno;Reg. c.;Body;Rank.c;Minule Ran…`, UTF-8),
  - vrátí JSON `{items:[{rank, lastName, firstName, regNo, points, rankNumber}]}`,
  - cache je v `sys_get_temp_dir()/oinfo_ranking/`: minulé datum 30 dní, dnešní/budoucí 6 hodin; při výpadku ORIS se vrátí i starší cache.
- **`ranking.js`:**
  - Typ rankingu: disciplína `SP`/`KO` → `ranktype=8` (sprintový), jinak 2 (lesní). Pohlaví z kategorie: H/M → M, D/W → F.
  - Pořadí a body podle stavu k `RankingDecisionDate`. Když chybí, použije se poslední den měsíce před závodem.
  - PB = průměr 4 nejvyšších `Rank.c` podle stavu k poslednímu dni měsíce před závodem (SŘ kap. V):
    - z dokončivších podle `getEventResults` (bez DISK/DNS/DNF/MP),
    - před zveřejněním výsledků odhad z přihlášených.
  - KS z `RankingKS`, koeficient z `RankingKoef`.
  - Závodníci: `getEventStartLists` s `classid` (respektuje přeřazení), jinak `getEventEntries` s `classid`.
- **Odkaz ve výpisu** (`buildClassHtml`) je aktivní jen pro OB, `Ranking = 1`, neštafetovou disciplínu a kategorii `^[HDMW]2`. Nahrazuje nefunkční odkaz na o-tools.rouman.eu.
- **Ověřeno (jsdom proti ORIS, CSV převedené stejně jako v PHP):**
  - 9583 D21C (lesní): PB 7 227 z výsledků,
  - 9577 D21C: 20 závodníků, 16 v rankingu,
  - 8220 W21E (ČP sprint): sprintový ranking, KZ 1,06,
  - nerankingová kategorie ukáže hlášku.
  - `ranking.php` lokálně spustit nešlo (bez PHP).

### Struktura `main.js`

| Část | Obsah |
|---|---|
| Pomocné funkce | `esc()` (escapování HTML), `asList()`, `localIsoDate()` (místní datum bez posunu UTC), bezpečné `storageGet/Set`. |
| Komunikace s ORIS | `oris(method, params)` (kontrola HTTP i `Status`), `mapLimit()` (omezení souběhu), `fetchStartList()` (chyba není fatální). |
| Transformace | `buildClassMap`, `indexStartList` (podle UserID i reg. čísla), `buildEventMeta` (pokyny, parametry, štafeta), `buildRows`. |
| Vykreslení | `renderTable` a `renderCards` (HTML se skládá jednou). Každý závod je vlastní `<tbody>` (`renderGroupTbody`) a karta (`renderCard`). Delegovaná obsluha kliknutí: `data-print-event` (Tisk), `data-toggle-event` (rozbalení), `data-group-action` (rozbalit/sbalit vše). |
| Sbalování | `COLLAPSE_THRESHOLD` (6), stav v `expandedEvents` (po novém hledání se vynuluje), `toggleGroup` překreslí jen jeden závod. Přilepení údajů o závodu: `.sticky-cell` (`position: sticky`); tabulka má `overflow: clip`, protože `hidden` by sticky vypnul. Při změně prahu upravte i text v `#groupControls` v `index.html`. |
| Načítání | `loadRegsMultiEvent`, `loadRegsSingleEvent`, `loadClubMultiEvent`, `loadClubSingleEvent`, vstupní bod `handleLoad`. |
| Ostatní | Seznam závodů do roletky (`loadEvents`), kluby, historie, vstup z URL, téma. |

### Volání ORIS podle režimu

| Režim | Volání |
|---|---|
| Reg. čísla + období | 1. `getUser` (každé reg. č.)<br>2. `getUserEventEntries` (období)<br>3. pro každý závod `getEvent` a `getEventStartLists` s `clubid` závodníků |
| Reg. čísla + závod | 1. `getEvent`, celá `getEventStartLists`, `getUser`<br>2. `getUserEventEntries` jen ke dni závodu (funguje pro štafety i etapy)<br>3. finále: závodníci ze startovky |
| Klub + období | 1. `getEventList` s `all=1` a `myClubId`; jen závody s `ClubEntryCount` nebo `ClubStartCount` > 0<br>2. pro každý `getEventEntries`, `getEvent`, `getEventStartLists`, vše s `clubid`<br>3. finále: závodníci ze startovky |
| Klub + závod | 1. `getEventEntries` s `clubid`, `getEvent`, celá startovka<br>2. finále: členové klubu ze startovky (podle `ClubID` nebo začátku reg. čísla) |

- Konstanty na začátku souboru: `MAX_CONCURRENCY` (6), `HISTORY_SIZE` (5), `COLLAPSE_THRESHOLD` (6), `RELAY_DISCIPLINES`. Platnosti cache jsou v `TTL` v `oris-cache.js`.
- Úložiště prohlížeče: `oInfoHistory`, `theme` a cache ORIS `oInfoCache:v2:<metoda>?<parametry>` (viz níže).

### Cache v prohlížeči (`oris-cache.js`)

Společný modul pro `main.js` i `ranking.js`: `oris()` (bez cache), `cachedOris()` a konkrétní funkce:

| Funkce | Data | Platnost |
|---|---|---|
| `getClubsCached` | `getCSOSClubList` (ID, zkratka, název) | 1 den (mění se jen na začátku sezóny) |
| `getUserIdCached` | `getUser` reg. č. → ID | 1 den; neexistující 10 min (nové reg. č. po přestupu = jiný klíč, načte se hned) |
| `getEventCached` | `getEvent` zmenšený na používaná pole | 10 min dnešní a budoucí (pokyny a parametry co nejdřív) / 1 den proběhlý |
| `getEventListCached` | `getEventList` pro roletku | 30 min |

- Přihlášky, startovky, výsledky a `getEventList` s `myClubId` se **necachují**.
- Při startu se mažou prošlé položky a staré klíče (`eventListCache_*`, `oInfoEventListCache`, `oInfoCache:v1:`). Při plném úložišti se smaže starší polovina cache.
- Souběžné stejné dotazy se spojí do jednoho.
- Změna formátu dat = zvýšit verzi v `CACHE_PREFIX`.
- Detail závodu se sdílí mezi výpisem a stránkou rankingu.
- Ověřeno (klub SJC, 2 týdny): 2. hledání 45 dotazů místo 67; reg. čísla po hledání klubu 9 → 6; konkrétní závod 3 dotazy; 22 závodů v cache ≈ 93 kB.

### Ověřené chování ORIS API

- `getEventList` s `myClubId` vrací `ClubEntryCount`, `ClubStartCount`, `ClubResultCount`, i bez parametru `sport`.
- `getEventStartLists` s `clubid` je výrazně menší (Český pohár: 14 kB místo 327 kB).
- `getUserEventEntries` vrací `ClubID` a u etapových závodů i přihlášky na jednotlivé etapy s vlastním `EventID`.
- Všechny zkratky klubů v `getCSOSClubList` mají 3 písmena (odpovídá kontrole vstupu `^[A-Z]{3}$`).

### Ověřeno proti ORIS (11/2026, původní vs. nová verze v jsdom)

| Zadání | Původní | Nová |
|---|---|---|
| 2 reg. čísla, období | 11 řádků, 1 097 kB | 11 řádků (shodné), 300 kB |
| Reg. čísla + konkrétní závod / štafeta | „Chyba při načítání“ | funguje |
| Klub + konkrétní závod | 7 řádků | 7 řádků (shodné) |
| Klub, 2 týdny | 284 řádků, 101 dotazů, 3 MB | 284 řádků, 68 dotazů, 0,7 MB |

### Změny oproti původní verzi (11/2026)

- **Opraveno:**
  - režim reg. čísla + konkrétní závod nefungoval (`startNumbers is not defined`),
  - posun dat o den kvůli `toISOString()`: rok začínal 31. 12. předchozího roku a končil 30. 12., stejně datum rankingu,
  - cache závodů se ukládala pod stále novým klíčem a mohla zaplnit úložiště,
  - data z ORIS se vkládala do HTML neescapovaná,
  - u nevybraného závodu se tiše nic nestalo,
  - `loadEvents` vypínal indikátor načítání při jiném běžícím načítání.
- **Zrychleno:**
  - u klubu se nestahují přihlášky všech závodů (dřív stovky souběžných dotazů),
  - startovky jsou filtrované podle klubu,
  - souběh je omezený,
  - rok je jeden dotaz místo 12,
  - tabulka se skládá jedním zápisem místo opakovaného `innerHTML +=`,
  - *Tisk* znovu nestahuje startovku.
- **Nové:** finále u klubu i ve výpisu za období, kontrola zadaného období, historie se obnoví hned a ukládá i kluby, Mapy.com přes https.
- **Kód:** 1 609 → asi 750 řádků; čtyři téměř shodné bloky sestavení řádků nahradila funkce `buildRows`.
- Záloha původní verze: `../_backup_2026-11-12/prihlasky/` a `../_backup_2026-11-12/index_root.html`.
