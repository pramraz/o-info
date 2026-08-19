const dateFrom = document.getElementById('dateFromInput');
const dateTo = document.getElementById('dateToInput');

const customRadio = document.querySelector('input[name="period"][value="custom"]');

function activateCustomRadio() {
    if (customRadio) customRadio.checked = true;
}

if (dateFrom) dateFrom.addEventListener('change', activateCustomRadio);
if (dateTo) dateTo.addEventListener('change', activateCustomRadio);

// Přepínač tématu: načte uložené nastavení, respektuje systémovou preferenci, přepíná kliknutím
const toggle = document.getElementById("themeToggle");

// načtení uloženého tématu
const savedTheme = localStorage.getItem("theme");

if (toggle) {
    if (savedTheme === "dark") {
        document.body.classList.add("dark");
        toggle.textContent = "☀️";
    } else {
        toggle.textContent = "🌙";
    }

    if (!savedTheme) {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        if (prefersDark) {
            document.body.classList.add("dark");
            toggle.textContent = "☀️";
        }
    }

    toggle.addEventListener("click", () => {
        document.body.classList.toggle("dark");
        const isDark = document.body.classList.contains("dark");
        toggle.textContent = isDark ? "☀️" : "🌙";
        localStorage.setItem("theme", isDark ? "dark" : "light");
    });
}


// Při přepnutí na "konkrétní závod" načte seznam závodů do výběrového seznamu
document.querySelectorAll('input[name="period"]').forEach(radio => {
    radio.addEventListener("change", () => {
        const selected = document.querySelector('input[name="period"]:checked')?.value;

        // načítáme jen pro konkrétní závody
        if (selected === "event30" || selected === "eventYear") {
            loadEvents();
        }
    });
});

// ISO datum → "YYYY-MM-DD" string
function toDateInputFormat(date) {
    return date.toISOString().split("T")[0];
}

// Referenční datum pro o-tools ranking (poslední den předchozího měsíce)
const rankDate = (() => {
    const now = new Date();
    return toDateInputFormat(new Date(now.getFullYear(), now.getMonth(), 0));
})();

let visibleRows = []; // Uchovává záznamy zobrazené v tabulce


// URL na soupisky štafet; respektuje aktivní výběr klubu
function getRelayTeamsLink(eventId) {

    const clubId = document.getElementById("clubSelect")?.value;

    // výběr klubu
    if (clubId) {
        return `https://oris.ceskyorientak.cz/PrehledPrihlasenych?id=${eventId}&club=${clubId}&teams=1`;
    }

    // individuální hledání
    return `https://oris.ceskyorientak.cz/PrehledPrihlasenych?id=${eventId}&mode=clubs&teams=1`;
}

function buildMapyComUrl(lat, lon) {
    if (!lat || !lon || String(lat) === "0" || String(lon) === "0") return "";

    const pointId = encodeURIComponent(`${lon},${lat}`);
    return `http://mapy.com/turisticka?x=${lon}&y=${lat}&z=14&source=coor&id=${pointId}`;
}

function buildMapIconHtml(mapUrl) {
    if (!mapUrl) return "";

    return `<a href="${mapUrl}" target="_blank" title="Zobrazit na Mapy.com" class="map-link"><img src="data/logo-mapy_com.png" alt="Mapa" class="map-icon"></a>`;
}

// Vykreslí HTML tabulku; seskupí záznamy po závodech, seřadí chronologicky
function renderTable(rows, startListMap = {}) {
    visibleRows = rows;

    const grouped = {};
    rows.forEach(r => (grouped[r.eventId] = grouped[r.eventId] || []).push(r));

    const sortedGrouped = Object.values(grouped).sort((a, b) =>
        a[0].dateSortable - b[0].dateSortable ||
        (a[0].start || "").localeCompare(b[0].start || "")
    );

    const tbody = document.getElementById("resultsBody");
    tbody.innerHTML = "";
    let groupIndex = 0;

    sortedGrouped.forEach(group => {
        group.sort((a, b) =>
            (a.startTime || "").localeCompare(b.startTime || "") ||
            a.name.localeCompare(b.name)
        );

        const isAlt = groupIndex % 2 === 1;
        const rowSpan = group.length;
        const eventId = group[0].eventId;
        const hasStartList = startListMap[eventId];


        group.forEach((row, idx) => {
            const tr = document.createElement("tr");


            if (isAlt) tr.classList.add("alternating");

            if (idx === 0) {
                tr.innerHTML += `<td rowspan="${rowSpan}" class="date-cell">${formatDateWithWeekday(row.date)}</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}">${row.sport}</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}"><a href="https://oris.ceskyorientak.cz/Zavod?id=${row.eventId}" target="_blank">${row.eventName}</a></td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}" class="place-cell">${row.place || ""}</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}" class="map-cell">${buildMapIconHtml(row.mapUrl)}</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}">${row.organizer} (${row.region})</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}">${row.discipline}</td>`;
                tr.innerHTML += `<td rowspan="${rowSpan}">${row.start}</td>`;
            }

            const td = document.createElement("td");
            td.className = "name-cell";
            td.textContent = row.name;
            tr.appendChild(td);

            tr.innerHTML += `<td>${buildClassHtml(row)}</td>`;

            tr.innerHTML += `<td>${row.reg}</td>`;
            tr.innerHTML += `<td>${row.si}</td>`;
            if (row.startTime) {
                tr.innerHTML += `<td><a href="https://oris.ceskyorientak.cz/Startovka?id=${row.eventId}#${row.classId}" target="_blank">${row.startTime}</a></td>`;
            } else {
                tr.innerHTML += `<td></td>`;
            }
            tr.innerHTML += `<td>${formatTrack(row.track)}</td>`;

            if (idx === 0) {
                const isRelayRow = ["RE", "TE", "SR"].includes(row.discipline);
                let detailHtml = `<td rowspan="${rowSpan}">`;

                if (row.hasInstructions && row.instructionsUrl) {
                    detailHtml += `<a href="${row.instructionsUrl}" target="_blank">Pokyny</a><br>`;
                }

                if (row.hasPreliminaryParams && row.preliminaryParamsUrl) {
                    detailHtml += `<a href="${row.preliminaryParamsUrl}" target="_blank">Parametry</a><br>`;
                }

                if (isRelayRow) {
                    detailHtml += `<a href="${getRelayTeamsLink(row.eventId)}" target="_blank">Soupisky</a><br>`;
                }

                if (hasStartList) {
                    detailHtml += `<a href="about:blank" target="_blank" onclick="openStartListTab(event, '${row.eventId}')">Tisk</a><br>`;
                }

                detailHtml += `</td>`;
                tr.innerHTML += detailHtml;
            }

            tbody.appendChild(tr);
        });

        groupIndex++;
    });

    document.getElementById("resultsTable").style.display = "table";
}

// Naformátuje parametry tratě (vzdálenost, převýšení, kontroly) do jednoho řetězce
function formatTrack(track) {
    if (!track || !track.distance) return "";

    const dist = track.distance
        .toFixed(1)
        .replace(".", ",");

    return `${dist} km | ${track.climbing} m | ${track.controls} k`;
}

// Sestaví mapu classId → {distance, climbing, controls} z dat závodu
function buildClassMap(event) {
    const map = {};

    const classes = event.Classes || {};

    Object.values(classes).forEach(c => {
        map[String(c.ID)] = {
            distance: parseFloat(c.Distance || 0),
            climbing: c.Climbing || "",
            controls: c.Controls || ""
        };
    });

    return map;
}

// Indexuje startovní listinu závodu podle userId: startovní čas a kategorie
function buildStartListMaps(startData) {
    const startTimes = {};
    const startTimesByReg = {};
    const startClassMap = {};
    const startClassMapByReg = {};
    const startClassIdMap = {};
    const startClassIdMapByReg = {};

    startData.forEach(s => {
        const userId = s.UserID ? String(s.UserID) : "";
        const regNo = (s.RegNo || "").toUpperCase();

        if (s.StartTime) {
            const startTime = s.StartTime.includes(" ")
                ? s.StartTime.split(" ")[1]
                : s.StartTime;
            if (userId) startTimes[userId] = startTime;
            if (regNo) startTimesByReg[regNo] = startTime;
        }

        if (s.ClassDesc) {
            if (userId) startClassMap[userId] = s.ClassDesc;
            if (regNo) startClassMapByReg[regNo] = s.ClassDesc;
        }

        if (s.ClassID) {
            if (userId) startClassIdMap[userId] = s.ClassID;
            if (regNo) startClassIdMapByReg[regNo] = s.ClassID;
        }
    });

    return {
        startTimes,
        startTimesByReg,
        startClassMap,
        startClassMapByReg,
        startClassIdMap,
        startClassIdMapByReg
    };
}

// buildStartListMaps pro více závodů; navíc sleduje, zda startovka existuje
function buildStartListMapsByEvent(startResults) {
    const startTimesMap = {};
    const startTimesByRegMap = {};
    const startClassMap = {};
    const startClassByRegMap = {};
    const startClassIdMap = {};
    const startClassIdByRegMap = {};
    const startListMap = {};

    startResults.forEach(({ eventId, data }) => {
        startListMap[eventId] = data.length > 0;

        const maps = buildStartListMaps(data);

        startTimesMap[eventId] = maps.startTimes;
        startTimesByRegMap[eventId] = maps.startTimesByReg;
        startClassMap[eventId] = maps.startClassMap;
        startClassByRegMap[eventId] = maps.startClassMapByReg;
        startClassIdMap[eventId] = maps.startClassIdMap;
        startClassIdByRegMap[eventId] = maps.startClassIdMapByReg;
    });

    return {
        startTimesMap,
        startTimesByRegMap,
        startClassMap,
        startClassByRegMap,
        startClassIdMap,
        startClassIdByRegMap,
        startListMap
    };
}

// Zobrazí "žádné přihlášky" v tabulce i kartách
function showEmptyResult() {
    document.getElementById("resultsBody").innerHTML =
        `<tr><td colspan="15" style="text-align:center">Nenalezeny žádné přihlášky.</td></tr>`;
    document.getElementById("resultsTable").style.display = "table";
    document.getElementById("resultsCards").innerHTML =
        `<div class="card"><div class="card-section" style="text-align:center">Nenalezeny žádné přihlášky.</div></div>`;
    setLoading(false);
}

// Zjistí přítomnost pokynů (PDF), předběžných parametrů a zda jde o štafetový závod
function buildEventMeta(event) {
    const instructionDoc = Object.values(event.Documents || {})
            .find(doc => doc.SourceType?.NameCZ === "Pokyny"
                || String(doc.OtherDescCZ || "").toLowerCase().includes("pokyny"));
    const preliminaryDoc = Object.values(event.Documents || {})
        .filter(doc => {
            const desc = (doc.OtherDescCZ || "").toLowerCase();
            return desc.includes("parametry") || desc.includes("délky");
        })
        .reduce((latest, current) =>
            !latest || Number(current.ID) > Number(latest.ID) ? current : latest,
            null
        );
    return {
        hasInstructions: !!instructionDoc,
        instructionsUrl: instructionDoc?.Url || "",
        isRelay: ["RE", "TE", "SR"].includes(event?.Discipline?.ShortName),
        hasPreliminaryParams: !!preliminaryDoc,
        preliminaryParamsUrl: preliminaryDoc?.Url || ""
    };
}

// Sestaví normalizovaný řádkový objekt pro renderTable / renderCards
function buildRow(entry, event, { eventId, startTime, start, finalClassId, finalClassDesc, cls, isRelay, hasInstructions, instructionsUrl, hasPreliminaryParams, preliminaryParamsUrl }) {
    return {
        date: event.Date,
        dateSortable: new Date(event.Date),
        eventName: event.Name,
        sport: event?.Sport?.NameCZ || "",
        discipline: event?.Discipline?.ShortName || "",
        start: start ?? event.StartTime ?? "",
        startTime,
        name: entry.Name,
        class: finalClassDesc,
        reg: isRelay ? "-" : (entry.RegNo || "-"),
        si: isRelay ? "-" : (entry.SI || "-"),
        eventId,
        classId: finalClassId,
        originalClass: entry.ClassDesc,
        userId: entry.UserID,
        place: event.Place || "",
        mapUrl: buildMapyComUrl(event.GPSLat, event.GPSLon),
        organizer: event.Org1?.Abbr || "",
        region: event.Region || Object.values(event.Regions || {}).map(r => r.Name).join(", "),
        regions: Object.values(event.Regions || {}).map(r => r.Name).join(", "),
        track: cls,
        hasInstructions,
        instructionsUrl,
        hasPreliminaryParams,
        preliminaryParamsUrl
    };
}

// Vykreslí tabulku i karty
function renderResults(rows, startListMap) {
    renderTable(rows, startListMap);
    renderCards(rows);
}

// HTML pro kategorii; závodní OB třídy dostávají o-tools ranking link; přeřazení zobrazí starou → novou
function buildClassHtml(row) {
    const isOB = row.sport === "OB";
    const isTargetClass = /^(H2|D2|M21|W21)/.test(row.class);
    const isRelay = ["RE", "TE", "SR"].includes(row.discipline);

    let oldClassHtml = row.originalClass || row.class;
    let newClassHtml = row.class;

    if (isOB && isTargetClass && row.originalClass && !isRelay) {
        const oldUrl = `http://www.o-tools.rouman.eu/startujici/kategorie.php?zavodid=${row.eventId}&class=${encodeURIComponent(row.originalClass)}&vlny=0&rankdate=${rankDate}`;
        oldClassHtml = `<a title="Původní přihlášená kategorie" href="${oldUrl}" target="_blank">${oldClassHtml}</a>`;
        const newUrl = `http://www.o-tools.rouman.eu/startujici/kategorie.php?zavodid=${row.eventId}&class=${encodeURIComponent(row.class)}&vlny=0&rankdate=${rankDate}`;
        newClassHtml = `<a title="Přeřazeno pořadatelem" href="${newUrl}" target="_blank">${newClassHtml}</a>`;
    }

    if (row.originalClass && row.originalClass !== row.class) {
        return `<span class="class-old">${oldClassHtml}</span><span>→</span><span>${newClassHtml}</span>`;
    }
    return isOB && isTargetClass && !isRelay
        ? `<a href="http://www.o-tools.rouman.eu/startujici/kategorie.php?zavodid=${row.eventId}&class=${encodeURIComponent(row.class)}&vlny=0&rankdate=${rankDate}" target="_blank">${row.class}</a>`
        : row.class;
}

// Vykreslí mobilní kartové zobrazení (alternativa k tabulce)
function renderCards(rows) {
  const container = document.getElementById("resultsCards");
  container.innerHTML = "";

  // seskupení po závodech
  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.eventId]) grouped[r.eventId] = [];
    grouped[r.eventId].push(r);
  });

  // seřazení závodů chronologicky
  const sortedGroups = Object.values(grouped).sort((a, b) =>
        a[0].dateSortable - b[0].dateSortable ||
        (a[0].start || "").localeCompare(b[0].start || "")
  );

  // vykreslení karet
  sortedGroups.forEach(group => {

    // sort uvnitř závodu
    group.sort((a, b) =>
      (a.startTime || "").localeCompare(b.startTime || "") ||
      a.name.localeCompare(b.name)
    );

    const event = group[0];

    // ikona dle sportu
    let sportIcon = "🏁";
    if (event.sport === "OB") sportIcon = "🏃";
    else if (event.sport === "LOB") sportIcon = "🎿";
    else if (event.sport === "MTBO") sportIcon = "🚴";
    else if (event.sport === "Trail") sportIcon = "♿";

    // datum
    let dateLine = formatDateWithWeekdayInline(event.date);

    // odkaz na závod
    const eventNameLink = event.eventName
      ? `<a href="https://oris.ceskyorientak.cz/Zavod?id=${event.eventId}" target="_blank">${event.eventName}</a>`
      : "ORIS";

    const placeHtml = event.mapUrl && event.place
      ? `<a href="${event.mapUrl}" target="_blank">${event.place}</a>`
      : (event.place || "-");

    const eventDiv = document.createElement("div");
    eventDiv.className = "card";

    // hlavička karty
    eventDiv.innerHTML = `
      <div class="card-header">
        <div class="card-event-name">${sportIcon} ${eventNameLink}</div>
        <div>${dateLine}</div>
      </div>
<div class="card-sub">
  <span>Start:</span>
  <span class="card-value">${event.start || "-"}</span><br>

  <span>Pořadatel:</span>
  <span class="card-value">${event.organizer || "-"}</span><br>

  <span>Disciplína:</span>
  <span class="card-value">${event.discipline || "-"}</span><br>

  <span>Oblast:</span>
  <span class="card-value">${event.region || "-"}</span><br>

  <span>Místo:</span>
  <span class="card-value">${placeHtml}</span><br>
</div>
    `;
    // pokyny a soupisky (jen pokud existují)
    const isRelayEvent = ["RE", "TE", "SR"].includes(event.discipline);

    if (
      (event.hasInstructions && event.instructionsUrl) ||
      isRelayEvent ||
      (event.hasPreliminaryParams && event.preliminaryParamsUrl)
    ) {

      const links = [];

      // pokyny (PDF)
      if (event.hasInstructions && event.instructionsUrl) {
        links.push(
          `📄 <a href="${event.instructionsUrl}" target="_blank">Pokyny</a>`
        );
      }

      // předběžné parametry tratí
      if (event.hasPreliminaryParams && event.preliminaryParamsUrl) {
        links.push(
          `📈 <a href="${event.preliminaryParamsUrl}" target="_blank">Parametry</a>`
        );
      }

      // soupisky štafet
      if (isRelayEvent) {
        links.push(
          `👥 <a href="${getRelayTeamsLink(event.eventId)}" target="_blank">Soupisky</a>`
        );
      }

      const linksDiv = document.createElement("div");
      linksDiv.className = "card-section";
      linksDiv.innerHTML = links.join("<br>");

      eventDiv.appendChild(linksDiv);
    }

    // závodníci na tomto závodu
    group.forEach(row => {
      const item = document.createElement("div");
      item.className = "card-section";

      // kategorie
      const classHtml = buildClassHtml(row);


      // startovní čas
      let startHtml = "-";
      if (row.startTime) {
        startHtml = `<a href="https://oris.ceskyorientak.cz/Startovka?id=${row.eventId}#${row.classId}" target="_blank">${row.startTime}</a>`;
      }

            const trackHtml = (row.track && row.track.distance)
                ? `📈 ${formatTrack(row.track)}`
                : `📈 -`;

      item.innerHTML = `
        ${sportIcon} <strong>${row.name}</strong><br>
        Kat: ${classHtml}<br>
        Reg: ${row.reg} | SI: ${row.si}<br>
        ${trackHtml}<br>
        ⏱ ${startHtml}
      `;

      eventDiv.appendChild(item);
    });

    container.appendChild(eventDiv);
  });
}

// Zobrazí / skryje loading indikátor
function setLoading(isLoading) {
    document.getElementById("loading").style.display = isLoading ? "flex" : "none";
    document.getElementById("loadBtn").disabled = isLoading;
    document.getElementById("loadBtn2").disabled = isLoading;
}


// Uloží vstup do localStorage historie (max 5 položek, bez duplicit)
function saveRegs(input) {
    let history = JSON.parse(localStorage.getItem("oInfoHistory") || "[]");

    // odstraní duplicitní
    history = history.filter(h => h !== input);

    // přidá na začátek
    history.unshift(input);

    // limit (např. 5)
    history = history.slice(0, 5);

    localStorage.setItem("oInfoHistory", JSON.stringify(history));
}

// Vrátí {from, to} podle aktuálně vybraného přepínače období
function getEventDateRange() {
    const today = new Date();

    const selectedElement = document.querySelector('input[name="period"]:checked');
    const selected = selectedElement ? selectedElement.value : "30"; // fallback

    let from, to;

    if (selected === "30" || selected === "event30") {
        from = today.toISOString().split("T")[0];
        const d = new Date(today);
        d.setDate(d.getDate() + 30);
        to = d.toISOString().split("T")[0];

    } else if (selected === "eventYear") {
        const start = new Date(today.getFullYear(), 0, 1);
        const end = new Date(today.getFullYear(), 11, 31);

        from = start.toISOString().split("T")[0];
        to = end.toISOString().split("T")[0];

    } else if (selected === "custom") {
        from = document.getElementById("dateFromInput")?.value;
        to = document.getElementById("dateToInput")?.value;
    }

    return {
        from,
        to
    };
}


// Načte seznam závodů z ORIS pro výběrový seznam; cachuje v localStorage na 1 hodinu
async function loadEvents() {

    const { from, to } = getEventDateRange();

    const eventSelect = document.getElementById("eventSelect");
    const includeUnofficial = document.getElementById("includeUnofficial")?.checked;


    // all=1 zahrnuje neoficiální závody
    const allParam = includeUnofficial ? 1 : 0;

    eventSelect.innerHTML = "<option>Načítám závody...</option>";

    // klíč musí zahrnovat allParam, jinak by se míchaly výsledky s/bez neoficiálních závodů
    const cacheKey = `${from}_${to}_${allParam}`;
    const storageKey = "eventListCache_" + cacheKey;

    // localStorage cache
    const cached = localStorage.getItem(storageKey);

    if (cached) {
        const parsed = JSON.parse(cached);

        if (Date.now() - parsed.ts < 3600_000) {
            renderEventOptions(parsed.data);
            return;
        }
    }

    const selected = document.querySelector('input[name="period"]:checked')?.value;

    let events = [];

    try {

        if (selected === "eventYear") {
            const year = new Date().getFullYear();
            const months = Array.from({ length: 12 }, (_, i) => i);

            const promises = months.map(m => {
                const monthFrom = new Date(year, m, 1).toISOString().split("T")[0];
                const monthTo = new Date(year, m + 1, 0).toISOString().split("T")[0];

                return fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventList&all=${allParam}&datefrom=${monthFrom}&dateto=${monthTo}`)
                    .then(res => res.json())
                    .then(json => Object.values(json?.Data || {}));
            });

            const results = await Promise.all(promises);
            events = results.flat();

        } else {

            const res = await fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventList&all=${allParam}&datefrom=${from}&dateto=${to}`);
            const json = await res.json();
            events = Object.values(json?.Data || {});
        }

        // cache
        localStorage.setItem(storageKey, JSON.stringify({
            data: events,
            ts: Date.now()
        }));

        renderEventOptions(events);

    } catch (err) {
        eventSelect.innerHTML = "<option>Chyba načítání</option>";
        console.error(err);
    } finally {
        setLoading(false);
        eventSelect.disabled = false;
    }
}

// Zkrátí text na maxLength znaků
function truncate(text, maxLength) {
    if (!text) return "";
    return text.length > maxLength
        ? text.slice(0, maxLength) + "…"
        : text;
}

// Naplní výběrový seznam závody; neoficiální označí šedě
function renderEventOptions(events) {
    const eventSelect = document.getElementById("eventSelect");
    eventSelect.innerHTML = "";

    events.sort((a, b) => a.Date.localeCompare(b.Date));

    events.forEach(e => {
        const opt = document.createElement("option");
        opt.value = e.ID;

        const text = [
            formatDate(e.Date),
            e.Sport?.NameCZ,
            e.Org1?.Abbr,
            e.Name,
            e.Discipline?.ShortName,
            e.Region,
            truncate(e.Place, 80)
        ].filter(Boolean).join(", ");

        opt.textContent = text;

        // šedé označení neoficiálních závodů dle Level.ShortName
        const level = e.Level?.ShortName || "";

        const isUnofficial = /^(OST|PS|REG|ZL|TC)/.test(level);

        if (isUnofficial) {
            opt.style.color = "#999";
        }

        eventSelect.appendChild(opt);
    });
}


// Vstupní bod: ověří formát vstupu a odešle do správné načítací funkce
function handleLoad() {
    const inputRaw = document.getElementById("mainInput").value.trim().toUpperCase();
    const input = inputRaw.replace(/ /g, "");
    const selectedPeriod = document.querySelector('input[name="period"]:checked')?.value;

    if (!input) {
        return alert("Zadej registrační číslo nebo zkratku klubu");
    }

    const isClub = /^[A-Z]{3}$/.test(input);
    const isReg = /^[A-Z]{3}\d{4}(,[A-Z]{3}\d{4})*$/.test(input);

    // KLUB
    if (isClub) {
        const club = findClubByAbbr(input);
        if (!club) return alert("Klub v ČSOS neexistuje");

        if (selectedPeriod === "event30" || selectedPeriod === "eventYear") {
            // konkrétní závod
            loadClubEntries();
        } else {
            // období (multi-event)
            loadClubEntriesMultiEvent(club.ID);
        }

        return;
    }

    // REGISTRACE
    if (isReg) {
        const isEventMode = selectedPeriod === "event30" || selectedPeriod === "eventYear";

        if (isEventMode) {
            loadEntriesSingleEvent();
        } else {
            loadEntries();
        }
        return;
    }

    // CHYBA
    alert("Neplatný vstup - musí být zadán klub ve tvaru XXX nebo registrační číslo ve tvaru XXX1111, příp. více reg. čísel oddělených čárkou.");
}

let clubsCache = [];


// Načte seznam všech klubů ČSOS při startu; naplní výběrový seznam a cache
fetch("https://oris.ceskyorientak.cz/API/?format=json&method=getCSOSClubList")
    .then(res => res.json())
    .then(json => {
        const clubs = Object.values(json?.Data || {});
        clubsCache = clubs; // uložíme do paměti

        const select = document.getElementById("clubSelect");

        select.innerHTML = '<option value="">-- výběr klubu --</option>';

        clubs.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.ID;
            opt.textContent = `${c.Abbr} – ${c.Name}`;
            opt.dataset.abbr = c.Abbr;
            select.appendChild(opt);
        });
    });

// Vyhledá klub v cache podle zkratky
function findClubByAbbr(abbr) {
    return clubsCache.find(c => c.Abbr === abbr);
}

// Přihlášky reg. čísel na konkrétní závod (štafety přes getUser + getUserEventEntries)
async function loadEntriesSingleEvent() {
    setLoading(true);

    const inputRaw = document.getElementById("mainInput").value.trim().toUpperCase();
    const input = inputRaw.replace(/ /g, "");
    const selectedEventId = document.getElementById("eventSelect").value;

    if (!selectedEventId) {
        setLoading(false);
        return alert("Vyber konkrétní závod");
    }

    const registrations = input
        .split(",")
        .map(r => r.trim().toUpperCase())
        .filter(r => /^[A-Z]{3}\d{4}$/.test(r));

    if (!registrations.length) {
        setLoading(false);
        return alert("Neplatná registrace");
    }

    saveRegs(input);

    const regSet = new Set(registrations);

    try {

        // detaily závodu a startovka paralelně
        const [eventData, startDataRaw] = await Promise.all([
            fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEvent&id=${selectedEventId}`)
                .then(res => res.json()),

            fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventStartLists&eventid=${selectedEventId}`)
                .then(res => res.json())
        ]);

        const event = eventData?.Data || {};
        const { hasInstructions, instructionsUrl, isRelay, hasPreliminaryParams, preliminaryParamsUrl } = buildEventMeta(event);

        let allEntries = [];

        // individuální závod
        if (!isRelay) {

            const entriesData = await fetch(
                `https://oris.ceskyorientak.cz/API/?format=json&method=getEventEntries&eventid=${selectedEventId}`
            ).then(res => res.json());

            allEntries = Object.values(entriesData?.Data || {})
                .filter(e =>
                    regSet.has((e.RegNo || "").toUpperCase())
                );
        }

// štafety: user ID podle registrace, pak přihlášky
else {

    // 1) userId pro každou registraci
    const userResults = await Promise.all(

        registrations.map(async reg => {

            try {

                const userJson = await fetch(
                    `https://oris.ceskyorientak.cz/API/?format=json&method=getUser&rgnum=${reg}`
                ).then(res => res.json());

                return userJson?.Data?.ID || null;

            } catch (err) {

                console.error("Chyba getUser:", reg, err);
                return null;
            }
        })
    );

    // deduplicate
    const uniqueUserIds = [...new Set(
        userResults.filter(Boolean)
    )];

    // 2) přihlášky na vybraný závod
    const entryResults = await Promise.all(

        uniqueUserIds.map(async userId => {

            try {

                const entriesJson = await fetch(
                    `https://oris.ceskyorientak.cz/API/?format=json&method=getUserEventEntries&userid=${userId}`
                ).then(res => res.json());

                const entries = Object.values(entriesJson?.Data || {});

                // jen vybraný závod
                return entries.filter(e =>
                    String(e.EventID) === String(selectedEventId)
                );

            } catch (err) {

                console.error(
                    "Chyba getUserEventEntries:",
                    userId,
                    err
                );

                return [];
            }
        })
    );

    allEntries = entryResults.flat();
}

        const startData = Object.values(startDataRaw?.Data || {});
        const classMap = buildClassMap(event);

        if (!allEntries.length && startData.length) {
            allEntries = startData
                .filter(s => regSet.has((s.RegNo || "").toUpperCase()))
                .map(s => ({
                    UserID: s.UserID,
                    Name: s.Name,
                    RegNo: s.RegNo,
                    SI: s.SI,
                    ClassID: s.ClassID,
                    ClassDesc: s.ClassDesc
                }));
        }

        const {
            startTimes,
            startTimesByReg,
            startClassMap,
            startClassMapByReg,
            startClassIdMap,
            startClassIdMapByReg
        } = buildStartListMaps(startData);

        const rows = allEntries.map(e => {
            const userId = String(e.UserID);
            const regNo = (e.RegNo || "").toUpperCase();
            const finalClassId = startClassIdMap[userId] || startClassIdMapByReg[regNo] || e.ClassID;
            const finalClassDesc = startClassMap[userId] || startClassMapByReg[regNo] || e.ClassDesc;
            const cls = classMap[String(finalClassId)] || {};
            return buildRow(e, event, {
                eventId: selectedEventId,
                startTime: startTimes[userId] || startTimesByReg[regNo] || "",
                start: event.StartTime,
                finalClassId,
                finalClassDesc,
                cls,
                isRelay,
                hasInstructions,
                instructionsUrl,
                hasPreliminaryParams,
                preliminaryParamsUrl
            });
        });

        if (!rows.length) { showEmptyResult(); return; }

        const startListMap = {};
        startListMap[selectedEventId] = startData.length > 0;

        renderResults(rows, startListMap);

    } catch (err) {

        console.error(err);
        alert("Chyba při načítání");
    }

    setLoading(false);
}


// Přihlášky reg. čísel napříč závody v daném období
async function loadEntries() {
    setLoading(true);

    const inputRaw = document.getElementById("mainInput").value.trim().toUpperCase();
    const input = inputRaw.replace(/ /g, "");
    saveRegs(input);

    const registrations = input
        .split(",")
        .map(r => r.trim().toUpperCase())
        .filter(r => /^[A-Z]{3}\d{4}$/.test(r));

    if (!registrations.length) {
        setLoading(false);
        return alert("Zadej alespoň jednu platnou registraci (např. SJC8351)");
    }

    const timestamp = Date.now();
    const seenEntries = new Set();
    const allEntries = [];

    const { from: dateFrom, to: dateTo } = getEventDateRange();

    try {
        // USERS
        const userResults = await Promise.all(
            registrations.map(reg =>
                fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getUser&rgnum=${reg}`)
                    .then(res => res.json())
                    .then(data => ({
                        reg,
                        userId: data?.Data?.ID || null
                    }))
            )
        );

        const validUsers = userResults.filter(u => u.userId);
        const invalidRegistrations = userResults.filter(u => !u.userId).map(u => u.reg);

        if (!validUsers.length) {
            setLoading(false);
            return alert("Žádná ze zadaných registrací nebyla nalezena:\n" + invalidRegistrations.join(", "));
        }

        if (invalidRegistrations.length > 0) {
            alert("Některé registrace nebyly nalezeny:\n" + invalidRegistrations.join(", "));
        }

        const uniqueUserIds = [...new Set(validUsers.map(u => u.userId))];

        // ENTRIES
        const entryResults = await Promise.all(
            uniqueUserIds.map(userId =>
                fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getUserEventEntries&userid=${userId}&datefrom=${dateFrom}&dateto=${dateTo}&_=${timestamp}`)
                    .then(res => res.json())
                    .then(data => ({
                        userId,
                        entries: Object.values(data?.Data || {})
                    }))
            )
        );

        entryResults.forEach(({ userId, entries }) => {
            entries.forEach(e => {
                const key = `${e.EventID}-${userId}`;
                if (!seenEntries.has(key)) {
                    e.UserID = userId;
                    allEntries.push(e);
                    seenEntries.add(key);
                }
            });
        });

        if (!allEntries.length) { showEmptyResult(); return; }

        const eventIds = [...new Set(allEntries.map(e => e.EventID))];

        // EVENTS
        const eventResults = await Promise.all(
            eventIds.map(id =>
                fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEvent&id=${id}`)
                    .then(res => res.json())
                    .then(data => ({
                        id,
                        data: data.Data
                    }))
            )
        );

        const events = {};
        const classMaps = {};

        eventResults.forEach(e => {
            events[e.id] = e.data;
            classMaps[e.id] = buildClassMap(e.data);
        });

        // STARTLISTS
        const startResults = await Promise.all(
            eventIds.map(id =>
                fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventStartLists&eventid=${id}`)
                    .then(res => res.json())
                    .then(json => ({
                        eventId: id,
                        data: Object.values(json?.Data || {})
                    }))
            )
        );

        const {
            startTimesMap,
            startTimesByRegMap,
            startClassMap,
            startClassByRegMap,
            startClassIdMap,
            startClassIdByRegMap,
            startListMap
        } = buildStartListMapsByEvent(startResults);

        // transformace
        const rows = allEntries.map(entry => {
            const event = events[entry.EventID];
            const { hasInstructions, instructionsUrl, isRelay, hasPreliminaryParams, preliminaryParamsUrl } = buildEventMeta(event);
            const classMap = classMaps[entry.EventID] || {};
            const userId = String(entry.UserID);
            const regNo = (entry.RegNo || "").toUpperCase();
            const finalClassId = startClassIdMap[entry.EventID]?.[userId] || startClassIdByRegMap[entry.EventID]?.[regNo] || entry.ClassID;
            const finalClassDesc = startClassMap[entry.EventID]?.[userId] || startClassByRegMap[entry.EventID]?.[regNo] || entry.ClassDesc;
            const cls = classMap[String(finalClassId)] || {};
            return buildRow(entry, event, {
                eventId: entry.EventID,
                startTime: startTimesMap[entry.EventID]?.[userId] || startTimesByRegMap[entry.EventID]?.[regNo] || "",
                start: event.StartTime,
                finalClassId,
                finalClassDesc,
                cls,
                isRelay,
                hasInstructions,
                instructionsUrl,
                hasPreliminaryParams,
                preliminaryParamsUrl
            });
        });

        renderResults(rows, startListMap);

    } catch (err) {
        console.error(err);
        alert("Chyba při načítání dat");
    }

    setLoading(false);
}

// Formátování datumu z ISO na český formát
function formatDate(dateStr) {
    const [y, m, d] = dateStr.split("-");
    return `${d}. ${m}. ${y}`;
}

function formatDateWithWeekday(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const weekdays = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    const weekday = weekdays[new Date(y, m - 1, d).getDay()];

    return `${formatDate(dateStr)}<br><span class="weekday">(${weekday})</span>`;
}

function formatDateWithWeekdayInline(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const weekdays = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    const weekday = weekdays[new Date(y, m - 1, d).getDay()];

    return `${formatDate(dateStr)} (${weekday})`;
}

// Otevření startovní listiny do nového okna
async function openStartListTab(e, eventId) {
    e.preventDefault();

    const url = `https://oris.ceskyorientak.cz/API/?format=json&method=getEventStartLists&eventid=${eventId}`;
    const newWindow = window.open("", "_blank");
    if (!newWindow) {
        alert("Prohlížeč zablokoval otevření okna. Povol popup pro tuto stránku.");
        return;
    }

    newWindow.document.write(`
      <!DOCTYPE html>
      <html><head><meta charset='utf-8'>
      <title>Startovní listina</title>
      <style>
        body{font-family:sans-serif;padding:20px;}
        .user-block{margin-bottom:1em;}
        .user-block div{margin-left:1em;}
        @media print { #printBtn { display: none; } }
      </style></head><body>
    `);

    newWindow.document.write("<button id='printBtn' onclick='window.print()'>Tisk</button>");

    try {
        const response = await fetch(url);
        const json = await response.json();
        const entries = Object.values(json?.Data || {});

        // filtr na závodníky z aktuálního zobrazení
        const rowsForEvent = visibleRows.filter(r => r.eventId == eventId);
        const usersToShow = rowsForEvent.map(r => Number(r.userId));
        const regsToShow = rowsForEvent.map(r => (r.reg || "").toUpperCase());

        const eventInfo = rowsForEvent[0];
        const instructionsUrl = eventInfo?.instructionsUrl || "";
const hasInstructions = eventInfo?.hasInstructions;

        // userId → row pro přístup k parametrům tratě
        const rowMap = {};
        const rowMapByReg = {};
        rowsForEvent.forEach(r => {
            rowMap[String(r.userId)] = r;
            rowMapByReg[(r.reg || "").toUpperCase()] = r;
        });

        newWindow.document.write(`<h2>${formatDate(eventInfo.date)} – ${eventInfo.eventName}</h2>`);
        newWindow.document.write(`<p>Druh: ${eventInfo.sport}<br>Typ: ${eventInfo.discipline}</p>`);
        newWindow.document.write(`<p>Pořadatel: ${eventInfo.organizer} (${eventInfo.regions})<br>Místo: ${eventInfo.place}<br>Start 00: ${eventInfo.start}</p>`);

let pokynyHtml = "—";

if (hasInstructions && instructionsUrl) {
    pokynyHtml = `<a href="${instructionsUrl}" target="_blank">zde</a>`;
}

newWindow.document.write(`
  <p>
    Vzdálenost z parkoviště:<br>
    Vzdálenost na start:<br>
    Vzdálenost z cíle:<br>
    Pokyny: ${pokynyHtml}
  </p>
`);

        const filteredEntries = entries.filter(entry =>
            usersToShow.includes(Number(entry.UserID)) ||
            regsToShow.includes((entry.RegNo || "").toUpperCase())
        );

        filteredEntries.sort((a, b) => {
            const timeA = (a.StartTime || "").split(" ")[1] || "99:99";
            const timeB = (b.StartTime || "").split(" ")[1] || "99:99";
            return timeA.localeCompare(timeB);
        });

        for (const entry of filteredEntries) {
            const name = entry.Name || "";
            const cls = entry.ClassDesc || "";
            const reg = entry.RegNo || "";
            const si = entry.SI || "";

            const startTimeFull = entry.StartTime || "";
            const startTime = startTimeFull.includes(" ")
                ? startTimeFull.split(" ")[1]
                : startTimeFull;

            // vezmi trať z rowMap
            const row = rowMap[String(entry.UserID)] || rowMapByReg[(entry.RegNo || "").toUpperCase()];
            const trackText = row?.track ? formatTrack(row.track) : "—";

            newWindow.document.write(`
                <div class='user-block'>
                    <strong>${name} (${cls}, ${reg}, ${si})</strong>
                    <div>${cls}: ${trackText}</div>
                    <div>startovní čas: ${startTime}</div>
                </div>
            `);
        }

        newWindow.document.write("</body></html>");
        newWindow.document.close();

    } catch (err) {
        console.error("Chyba při načítání startovní listiny:", err);
        newWindow.document.write("<p>Chyba při načítání startovní listiny.</p></body></html>");
        newWindow.document.close();
    }
}

window.openStartListTab = openStartListTab;

// Přihlášky klubu napříč závody; detaily táhne jen pro závody, kde klub startuje
async function loadClubEntriesMultiEvent(clubId) {
    setLoading(true);

    const { from, to } = getEventDateRange();
    const timestamp = Date.now();

    try {
        // 1. seznam závodů v období
        const res = await fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventList&all=1&datefrom=${from}&dateto=${to}`);
        const json = await res.json();
        const allEvents = Object.values(json?.Data || {});

        if (!allEvents.length) {
            alert("Žádné závody v období");
            setLoading(false);
            return;
        }

        // 2. přihlášky klubu pro všechny závody paralelně
        const entryResults = await Promise.all(
            allEvents.map(e =>
                fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventEntries&eventid=${e.ID}&clubid=${clubId}&_=${timestamp}`)
                    .then(res => res.json())
                    .then(data => ({ event: e, entries: Object.values(data?.Data || {}) }))
            )
        );

        // 3. filtr – jen závody, kde má klub přihlášky
        const relevantResults = entryResults.filter(r => r.entries.length > 0);

        if (!relevantResults.length) { showEmptyResult(); return; }

        const relevantEventIds = relevantResults.map(r => r.event.ID);

        // 4. detaily + startovky jen pro relevantní závody (paralelně)
        const [detailResults, startResults] = await Promise.all([
            Promise.all(
                relevantEventIds.map(id =>
                    fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEvent&id=${id}`)
                        .then(res => res.json())
                        .then(data => ({ id, data: data?.Data || {} }))
                )
            ),
            Promise.all(
                relevantEventIds.map(id =>
                    fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventStartLists&eventid=${id}`)
                        .then(res => res.json())
                        .then(json => ({ eventId: id, data: Object.values(json?.Data || {}) }))
                )
            )
        ]);

        const eventDetailsMap = {};
        const classMaps = {};
        detailResults.forEach(({ id, data }) => {
            eventDetailsMap[id] = data;
            classMaps[id] = buildClassMap(data);
        });

        const { startTimesMap, startTimesByRegMap, startClassMap, startClassByRegMap, startClassIdMap, startClassIdByRegMap, startListMap } =
            buildStartListMapsByEvent(startResults);

        // 5. sestavení řádků
        const rows = [];
        relevantResults.forEach(({ event, entries }) => {
            const eventDetail = eventDetailsMap[event.ID] || {};
            const classMap = classMaps[event.ID] || {};
            const { hasInstructions, instructionsUrl, isRelay, hasPreliminaryParams, preliminaryParamsUrl } = buildEventMeta(eventDetail);

            entries.forEach(e => {
                const userId = String(e.UserID);
                const regNo = (e.RegNo || "").toUpperCase();
                const finalClassId = startClassIdMap[event.ID]?.[userId] || startClassIdByRegMap[event.ID]?.[regNo] || e.ClassID;
                const finalClassDesc = startClassMap[event.ID]?.[userId] || startClassByRegMap[event.ID]?.[regNo] || e.ClassDesc;
                const cls = classMap[String(finalClassId)] || {};
                rows.push(buildRow(e, eventDetail, {
                    eventId: event.ID,
                    startTime: startTimesMap[event.ID]?.[userId] || startTimesByRegMap[event.ID]?.[regNo] || "",
                    start: eventDetail.StartTime,
                    finalClassId,
                    finalClassDesc,
                    cls,
                    isRelay,
                    hasInstructions,
                    instructionsUrl,
                    hasPreliminaryParams,
                    preliminaryParamsUrl
                }));
            });
        });

        renderResults(rows, startListMap);

    } catch (err) {
        console.error(err);
        alert("Chyba při načítání klubových dat");
    }

    setLoading(false);
}

// Přihlášky klubu na konkrétní vybraný závod
async function loadClubEntries() {
    const clubSelect = document.getElementById("clubSelect");
    const clubId = clubSelect.value;

    if (!clubId) {
        return alert("Vyber klub");
    }

    const eventId = document.getElementById("eventSelect").value;

    if (!eventId) return;  // clubId check je už výše — stačí jen eventId

    setLoading(true);

    const timestamp = Date.now();

    try {
        const res = await fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventEntries&eventid=${eventId}&clubid=${clubId}&_=${timestamp}`);
        const json = await res.json();
        const entries = Object.values(json?.Data || {});
        let finalEntries = [...entries];

        // event info + startovka paralelně (startovka potřebná i pro fallback)
        const [evData, startJson] = await Promise.all([
            fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEvent&id=${eventId}`).then(r => r.json()),
            fetch(`https://oris.ceskyorientak.cz/API/?format=json&method=getEventStartLists&eventid=${eventId}`).then(r => r.json())
        ]);
        const event = evData.Data;

        // mapa tříd (jen 1×)
        const classMap = buildClassMap(event);

        const startData = Object.values(startJson?.Data || {});

        // fallback pro finále bez přihlášek: filtruj startovku dle zkratky klubu
        if (!finalEntries.length && startData.length) {
            const clubAbbr = clubSelect.selectedOptions[0]?.dataset?.abbr || "";
            finalEntries = startData
                .filter(s => (s.RegNo || "").toUpperCase().startsWith(clubAbbr))
                .map(s => ({
                    UserID: s.UserID,
                    Name: s.Name,
                    RegNo: s.RegNo,
                    SI: s.SI,
                    ClassID: s.ClassID,
                    ClassDesc: s.ClassDesc
                }));
        }

        if (!finalEntries.length) { showEmptyResult(); return; }

        const { startTimes, startTimesByReg, startClassMap, startClassMapByReg, startClassIdMap, startClassIdMapByReg } =
            buildStartListMaps(startData);

        const { hasInstructions, instructionsUrl, isRelay, hasPreliminaryParams, preliminaryParamsUrl } = buildEventMeta(event);

        // transformace
        const rows = finalEntries.map(e => {
            const userId = String(e.UserID);
            const regNo = (e.RegNo || "").toUpperCase();
            const finalClassId = startClassIdMap[userId] || startClassIdMapByReg[regNo] || e.ClassID;
            const finalClassDesc = startClassMap[userId] || startClassMapByReg[regNo] || e.ClassDesc;
            const cls = classMap[String(finalClassId)] || {};
            return buildRow(e, event, {
                eventId,
                startTime: startTimes[userId] || startTimesByReg[regNo] || "",
                start: event.StartTime,
                finalClassId,
                finalClassDesc,
                cls,
                isRelay,
                hasInstructions,
                instructionsUrl,
                hasPreliminaryParams,
                preliminaryParamsUrl
            });
        });

        const startListMap = {};
        startListMap[eventId] = startData.length > 0;

        renderResults(rows, startListMap);

    } catch (err) {
        console.error(err);
        alert("Chyba při načítání");
    }

    setLoading(false);
}

// Inicializace: napojí event listenery, nastaví výchozí datový rozsah, načte historii vstupů
window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("loadBtn");
    if (btn) btn.addEventListener("click", handleLoad);

    const btn2 = document.getElementById("loadBtn2");
    if (btn2) btn2.addEventListener("click", handleLoad);

    const input = document.getElementById("mainInput");
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            btn?.click();
        }
    });
    const history = JSON.parse(localStorage.getItem("oInfoHistory") || "[]");
    const select = document.getElementById("historySelect");

    document.getElementById("includeUnofficial")
        .addEventListener("change", loadEvents);

    select.innerHTML = '<option value="">-- poslední hodnoty --</option>';

    history.forEach(item => {
        const opt = document.createElement("option");
        opt.value = item;
        opt.textContent = item;
        select.appendChild(opt);
    });


    const today = new Date();
    const fromDate = today.toISOString().split("T")[0];
    const d = new Date(today.getFullYear(), 11, 31);

    const endDate =
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");

    document.getElementById("dateFromInput").value = fromDate;
    document.getElementById("dateToInput").value = endDate;


    document.getElementById("historySelect").addEventListener("change", function () {
        if (this.value) {
            document.getElementById("mainInput").value = this.value;
        }
    });


    document.getElementById("mainInput").addEventListener("input", function () {
        const val = this.value.trim().toUpperCase();

        if (!/^[A-Z]{3}$/.test(val)) return;

        const select = document.getElementById("clubSelect");

        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].dataset.abbr === val) {
                select.selectedIndex = i;
                break;
            }
        }
    });


    document.getElementById("clubSelect").addEventListener("change", function () {
        const selectedOption = this.selectedOptions[0];
        if (!selectedOption) return;

        const abbr = selectedOption.dataset.abbr;

        if (abbr) {
            document.getElementById("mainInput").value = abbr;
        }
    });
});
