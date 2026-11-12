# O-info – Dluhy

## Pro účetního klubu (stručně)

Nástroj z ORISu spočítá, kolik který člen klubu dluží oddílu za závody ve zvoleném období, a výsledek stáhne jako Excel.

**Jak ho použít:** vyberte klub a období (nejvýše 400 dní), zaškrtněte pravidla a klikněte na *Vygenerovat a stáhnout Excel*. Zpracování trvá od několika sekund až po zhruba minutu.

**Co se členovi započítá:**

| Položka | Kdy se účtuje |
|---|---|
| **Plné startovné** | U druhů závodů zaškrtnutých v bodu 1 (výchozí jsou „ostatní“ závody: OST, ZL, soustředění, etapové…). |
| **Navýšení startovného** | U nezaškrtnutých závodů (typicky oficiální). Účtuje se rozdíl, o který je startovné vyšší než základní, např. kvůli pozdní přihlášce. |
| **Propadlé startovné (absence)** | U nezaškrtnutých závodů, pokud člen nestartoval (ve výsledcích chybí nebo má DNS). Účtuje se celé startovné. |
| **Doplňkové služby** | Ubytování, strava, parkování atd., buď u všech závodů, nebo jen u zaškrtnutých. |
| **Půjčení čipu** | Půjčovné SI čipu podle ceníku závodu, u etapových závodů za každou etapu. Řídí se stejným pravidlem jako služby. |

Započítávají se závody OB, LOB i MTBO.

**Co najdete v Excelu:**

- **Přehled dluhů** – jeden řádek na člena: celková částka a rozpis po závodech, dole řádek součtů.
- **Detailní rozpis položek** – každá položka zvlášť (člen, závod, důvod, částka). ORIS ID je odkaz na závod.
- **Štafety bez výsledku** *(jen když nějaké jsou)* – štafety, které byly přihlášené a zaplacené, ale ve výsledcích nejsou. Do dluhů se nepočítají, slouží k prověření, proč přihláška propadla.
- **Upozornění** *(jen když nějaké jsou)* – závody, kde výpočet nemusí být úplný: chybí výsledky (absence se nevyhodnotila) nebo byl závod zrušen.

**Na co si dát pozor:**

- Služby objednané jedním člověkem pro celý klub (např. hromadné ubytování) se celé připíšou objednavateli. Rozdělení je potřeba vyřešit ručně.
- Absence se u závodů bez výsledků v ORISu nevyhodnocuje: soustředění, semináře, závody z posledních dní, kde výsledky ještě nejsou. Takové závody jsou na listu *Upozornění*. Pro jistotu je dobré export za nedávné období zopakovat po zveřejnění výsledků.
- Jeden člen (aktuálně **SJC8102**) je vyjmut z účtování navýšení startovného. Změnu provede administrátor.

---

## Pro administrátora (podrobně a technicky)

### Soubory

| Soubor | Účel |
|---|---|
| `index.html` | Formulář (Bootstrap 5.3 a TomSelect z CDN). V hlavičce je tlačítko na nápovědu. |
| `napoveda.html` | Nápověda pro uživatele. Technická část je ve sbalovací sekci. Obsah odpovídá tomuto README, při změnách je potřeba upravit obojí. |
| `app.js` | Načtení seznamu klubů přímo z ORISu, validace, odeslání na `api.php`, stažení XLSX a zobrazení hlášek. |
| `api.php` | Backend: stažení dat z ORISu, výpočet a vygenerování XLSX. |
| `vendor/` | Composer: `phpoffice/phpspreadsheet` 5.9. Na hosting je nutné nahrát celou složku. |

**Požadavky na server:** PHP **8.2 nebo novější** (vyžaduje to PhpSpreadsheet 5.x) s rozšířeními `curl`, `zip`, `xml`, `mbstring`, `gd`. Volitelné je `intl`, které zajistí správné české řazení jmen (bez něj se použije `strcoll`). Server musí mít odchozí HTTPS přístup na `oris.ceskyorientak.cz`.

### Konfigurace (konstanty na začátku `api.php`)

| Konstanta | Výchozí | Význam |
|---|---|---|
| `LATE_FEE_EXEMPT_REGNOS` | `['SJC8102']` | Registrační čísla vyjmutá z účtování navýšení startovného, z libovolného klubu. |
| `ORIS_SPORTS` | `'1,2,3'` | Sporty: 1 = OB, 2 = LOB, 3 = MTBO (4 = TRAIL se nepočítá). |
| `RELAY_DISCIPLINES` | `RE, TE, SR` | Disciplíny, se kterými se zachází jako se štafetami. |
| `MAX_RANGE_DAYS` | `400` | Nejdelší povolené období. Stejný limit je i v `app.js`. |
| `HTTP_CONCURRENCY` | `8` | Počet souběžných požadavků na ORIS. |
| `HTTP_RETRIES` | `2` | Kolikrát se neúspěšný požadavek zopakuje. |

### Průběh zpracování

1. **Seznam akcí:** `getEventList` s parametry `sport=1,2,3`, `all=1` a `myClubId=<klub>`.
   - `all=1` přidá i akce mimo oficiální kalendář (ZL, OST, SEM…). Bez něj by chyběla velká část přihlášek.
   - `myClubId` vrátí u každé akce počty přihlášek, služeb a výsledků klubu (`ClubEntryCount`, `ClubServiceEntryCount`, `ClubResultCount`). Detaily se pak stahují **jen tam, kde klub něco má**.
   - Zrušené akce (`Cancelled ≠ 0`) se přeskočí. Pokud na nich klub něco měl, objeví se v *Upozornění*.
2. **Detaily** (jen kde je potřeba):
   - `getEventEntries` – přihlášky klubu: individuální závody a štafety.
   - `getEventServiceEntries` – služby, jen když `ClubServiceEntryCount > 0` a služby se podle pravidla počítají.
   - `getEvent` – ceník kategorií pro výpočet navýšení, jen u nezaškrtnutých úrovní se zapnutým pravidlem.
   - `getEventResults` – kvůli absenci (nezaškrtnuté úrovně, proběhlé závody s výsledky) a kvůli kontrole štafet.
3. **Druhá fáze:** `getEvent` kvůli ceně půjčovného (`EntryRentSIFee`), jen u akcí, kde má někdo `RentSI = 1`.
4. **Jména:** berou se z přihlášek. Pro členy, kteří mají jen služby, se dotáhnou přes `getUser`. Případná chyba tady není fatální, místo jména se použije registrační číslo.
5. **Výpočet a XLSX.** Pokud se nepodaří načíst kterýkoli povinný údaj (ani po opakování), export se **nevytvoří** a uživatel dostane chybu. Raději žádný export než export s neúplnými daty.

### Pravidla výpočtu (přesně)

Pro každou individuální přihlášku člena s `Fee > 0` platí **první** splněná podmínka:

1. Úroveň závodu je zaškrtnutá → **plné startovné** (`Fee`).
2. Pravidlo absence je zapnuté, závod už proběhl, výsledky existují a člen v nich chybí nebo má `Time = DNS` → **celé `Fee`**. Diskvalifikace (`DISK`) se bere jako start.
3. Pravidlo navýšení je zapnuté a člen není vyjmutý → **`Fee − Fee kategorie`** (z `getEvent → Classes[].Fee`), pokud je kladné.

Nezávisle na tom se účtuje:

- **Půjčení čipu:** `RentSI = 1` → `EntryRentSIFee × počet přihlášených etap` (u jednodenních závodů × 1).
- **Služby:** `TotalFee` každé objednávky na registrační číslo objednavatele.

Obojí se řídí pravidlem 2 (u všech závodů, nebo jen u zaškrtnutých úrovní).

**Etapové závody:**
- Startovné je u nadřazené akce (ET). Přihlášky do jednotlivých etap mají `Fee = 0`, takže se nic nezapočítá dvakrát.
- Výsledky jsou jen u etap (`ParentID`). Absence se proto vyhodnocuje přes všechny etapy: stačí, když člen startoval v kterékoli z nich.
- Půjčovné se bere z nadřazené akce, protože etapy mají `EntryRentSIFee = 0`.

**Štafety** se do dluhů nepočítají. Tým se hlásí jako „bez výsledku“, pokud ve výsledcích (mimo DNS) není žádný z jeho úsekářů ani tým stejného jména v téže kategorii. Výsledky štafet ORIS vrací po jednotlivých úsekářích s registračním číslem. Když tým na poslední chvíli vymění všechny úsekáře, může vzniknout falešný nález, proto je list určený k prověření.

### Ověřené chování ORIS API (důležité pro údržbu)

- `getRegistration` **ignoruje parametr `club`** a vrací celou registraci ČR (asi 12 000 osob, 2,2 MB). Proto se už nepoužívá.
- `getEventList` bez `all=1` vynechává neoficiální akce. U ZBM za rok 2025 to bylo 43 akcí s přihláškami.
- Akce bez výsledků jsou běžné: etapové (ET) nadřazené akce, semináře, soustředění.
- Ve výsledcích jsou i nestartující s `Time = DNS`.
- `Fee` v přihlášce **neobsahuje** půjčovné čipu. To potvrzuje `getEventBalance`, kde součet přihlášek přesně sedí na `FeeEntry` a půjčovné je zvlášť ve `FeeSI`.
- Prázdný seznam vrací ORIS někdy jako `[]` a jindy jako objekt. Kód obojí sjednocuje.
- Objednávky služeb neobsahují jméno, jen `RegNo` a `UserID`.

### Výkon

- Detaily se stahují jen u akcí, kde klub něco má.
- Požadavky běží souběžně v klouzavém okně (8 najednou). Odpovědi chodí komprimované (gzip) a neúspěšný požadavek se opakuje.
- Příklad: velký klub (ZBM) a celý rok 2025 = 378 požadavků místo původních 1 278, přestože se teď prochází dvojnásobný počet akcí. Původní verze by roční přehled pravděpodobně nestihla do limitu 120 s. U menších klubů je úspora ještě výraznější.
- Limity skriptu: `set_time_limit(120)`, `memory_limit 256M`.

### Bezpečnost

- `api.php` přijímá jen `POST` s JSON tělem a kontroluje typy i formát vstupu (ID klubu, datumy, rozsah).
- Odstraněna hlavička `Access-Control-Allow-Origin: *`. Cizí weby tak nemohou používat server jako proxy na ORIS. Pokud by se `api.php` volalo z jiné domény, je potřeba CORS povolit jen pro tu konkrétní doménu.
- PHP chyby se nevypisují do odpovědi (poškodily by XLSX), jen se logují do error logu serveru.
- Data ORIS jsou veřejná a nástroj nepoužívá žádné přihlašovací údaje.

### Hlavičky odpovědi

`Content-Disposition` nese název souboru `Dluhy_ORIS_<od>_<do>.xlsx`. Hlavičky `X-Warnings-Count` a `X-Relay-Issues-Count` předávají počty pro hlášku ve formuláři.

### Změny oproti původní verzi (11/2026)

Opravené chyby, které měnily výsledek:
1. Absence účtovala celé startovné všem účastníkům akcí bez výsledků (etapové závody, semináře, soustředění).
2. Absence nepoznala nestartující (DNS se počítalo jako start).
3. Chyběly neoficiální akce (`all=1`) a sporty LOB a MTBO.
4. Členové bez aktuální registrace v ČSOS se tiše vynechávali.
5. Popisky pravidel 3 a 4 neodpovídaly chování.

Nové funkce: půjčení čipu, list štafet bez výsledku, list upozornění, řádek součtů, skutečná data v Excelu, filtry a ukotvená hlavička.

Úklid: odstraněna nefunkční záložní XML větev, Collator se vytváří jednou místo při každém porovnání, výjimka z navýšení je v konfiguraci.

Záloha původních souborů: `../_backup_2026-11-12/dluhy/`.

### Doporučený test po nasazení

1. Stejné zadání jako ve staré verzi a porovnání výsledků. Rozdíly by měly odpovídat bodům 1 až 4 výše.
2. Etapový závod s půjčeným čipem: částka = cena × počet etap.
3. Závod se štafetou a nějaký závod LOB nebo MTBO.
4. Kontrolní součty proti vyúčtování akce v ORISu (`getEventBalance` / stránka vyúčtování závodu): startovné a půjčovné klubu.

### Možná rozšíření

- Automatický kontrolní list porovnávající součty exportu s `getEventBalance` (`FeeEntry`, `FeeSI`, `FeeService`) pro každou akci.
- Volba sportů ve formuláři.
