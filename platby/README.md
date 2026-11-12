# O-info – Platby

## Pro účetního klubu (stručně)

Aplikace z výpisu pohybů na účtu ve **Fio bance** vybere platby za závody a připraví z nich seznam pro vložení do ORISu (zadání plateb u závodu). Ostatní příchozí platby ukáže zvlášť ke kontrole.

**Data se nikam neodesílají**, soubor zpracuje jen váš prohlížeč.

**Postup:**
1. Ve Fio internetbankingu otevřete *Pohyby na účtu*, zvolte období a exportujte do **CSV**. Ve výpisu musí být sloupce **Datum**, **Objem** a **VS**. Sloupce exportu si ve Fio volíte sami.
2. V aplikaci vyberte soubor.
3. Volitelně zadejte datum „od“ (např. den posledního zadání plateb do ORISu).
4. Zadejte začátek VS plateb za závody (výchozí `11`).
5. Klikněte na *Zpracovat soubor* a zkopírujte *Platby pro ORIS* do ORISu.

**Třídění příchozích plateb:**

| Sekce | Které platby |
|---|---|
| ✅ Platby pro ORIS | VS začíná zadaným začátkem a má alespoň 6 číslic. Patří sem i zahraniční platby (SEPA, Revolut…), u kterých se platný VS najde ve zprávě za `/URI/`. Ty jsou ve zprávě označené „VS doplněn ze zprávy“. |
| ⚠️ Podezřelé platby | Všechny ostatní příchozí platby. |

**Formát výstupu:** `datum;VS;částka;;zpráva`, např. `2026-04-02;1199004;3120;;Startovné ZBM`.

**Na co si dát pozor:**
- Řádky „VS doplněn ze zprávy“ zkontrolujte. Plátce mohl za VS připsat další číslice.
- Hlášku o opakující se platbě (stejné datum, VS a částka) ověřte, může jít o duplicitu.
- Hlídejte si datum „od“, ať do ORISu nevložíte stejné platby dvakrát.

---

## Pro administrátora (podrobně a technicky)

### Soubory

| Soubor | Účel |
|---|---|
| `index.html` | Stránka aplikace (Bootstrap 5.3 z CDN). V hlavičce je odkaz na nápovědu. |
| `app.js` | Veškerá logika. Čisté funkce se exportují přes `module.exports` pro testy v Node. |
| `napoveda.html` | Nápověda pro uživatele. Obsah odpovídá tomuto README, při změnách je potřeba upravit obojí. |

Bez serverové části a bez závislostí, stačí statický hosting.

### Zpracování CSV (`app.js`)

- `decodeFile`: UTF-8 v režimu `fatal`, při chybě Windows-1250. BOM se odstraní.
- `detectDelimiter`: `;`, `,` nebo tabulátor podle prvního řádku, počítá se jen mimo uvozovky.
- `parseCsv`: uvozovky, zdvojené uvozovky, zalomení řádku uvnitř hodnoty, CRLF i LF.
- `findHeader`: hlavička v prvních 30 řádcích. Sloupce se hledají podle názvu (bez diakritiky a velikosti písmen), pořadí nehraje roli.
  - Povinné: `Datum`, `Objem`.
  - Volitelné: `VS`, `Zpráva pro příjemce`, `Poznámka`.
  - Když chybí VS, zobrazí se varování.
- `parseDate`: `d.m.rrrr` (i s časem) nebo `rrrr-mm-dd`, s kontrolou platnosti. Filtr „od“ porovnává řetězce `RRRR-MM-DD`, takže nevznikají posuny kvůli časové zóně.
- `parseAmount`: ignoruje mezery a pevné mezery. Když hodnota obsahuje čárku, tečky se berou jako oddělovač tisíců.
- Zpráva: „Zpráva pro příjemce“, nebo „Poznámka“, když je prázdná. Znaky `; \r \n \t` se nahradí mezerou.

### Pravidla třídění

1. VS jen z číslic, začíná prefixem, délka ≥ `MIN_VALID_VS_LENGTH` (6) → ORIS.
2. Jinak (jakákoli délka i prázdný VS) se hledá `URI_VS`: číslice (aspoň 6) za `/URI/` ve zprávě. Pokud splní pravidlo 1, platba jde do ORIS a do zprávy se připíše „(VS doplněn ze zprávy, VS v bance: …)“.
3. Ostatní → podezřelé.

Odchozí platby (částka ≤ 0) se přeskakují. Kontrola duplicit (stejné datum, VS a částka) běží jen nad platbami pro ORIS.

### Ověřeno na reálných výpisech (11/2026)

- Klubový účet (1 111 pohybů): 202 plateb pro ORIS = 198 shodných s původní verzí + 4 zahraniční s VS ze zprávy.
  - Rozdíly jsou jen ve zprávách: doplnění z Poznámky, sloučení dvojitých mezer.
  - 10místné VS: hlavně SEPA platby přes ČS (`0800`), VS je ve zprávě za `/URI/`. Ze 7 takových plateb aplikace u 4 našla VS, zbytek je mezi podezřelými.
- Účet O-ligy: 10místné VS ve tvaru `26MM…` z běžných českých bank (okamžité platby, VS generovaný jiným systémem) → podezřelé.
- Export bez sloupce VS: původní verze brala za VS sloupec „Poznámka“ (jména plátců), nová upozorní.

### Test v Node

```bash
node -e "const P=require('./app.js'),fs=require('fs');
console.log(P.processStatement(P.decodeFile(fs.readFileSync('vypis.csv')),{vsPrefix:'11'}).stats)"
```

### Změny oproti původní verzi (11/2026)

- **Odstraněny zbytky mBank:** hledání sloupců „Částka“ a „Popis“, pevné pozice sloupců (zpráva na pozici 5 je ve Fio konstantní symbol), nefunkční přepnutí na Windows-1250.
- **Opraveno:**
  - platby z prvního dne období se vynechávaly (porovnání UTC a místního času),
  - `1.234,50` se četlo jako 1,234,
  - středník nebo zalomení ve zprávě rozbíjelo výstup,
  - hlavička se hledala jen na 1. řádku,
  - při rychlém kliknutí se zobrazilo „Nejprve nahraj soubor“.
- **Nové:**
  - zrušena sekce „Revolut“ (předpoklad podle 10místného VS). VS se u zahraničních plateb dohledá ze zprávy a platba jde do ORIS, jinak mezi podezřelé,
  - souhrn přeskočených řádků a varování na chybějící VS a duplicity,
  - při výběru nového souboru se smažou staré výsledky,
  - logika přesunuta z HTML do `app.js`.
- Záloha původní verze: `../_backup_2026-11-12/platby/`.
