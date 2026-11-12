// O-info – výpis přihlášek z ORIS (podle registračních čísel nebo klubu).
// Vše běží v prohlížeči, data se čtou přímo z veřejného ORIS API.

import { oris, getEventCached, getClubsCached, getUserIdCached, getEventListCached } from "./oris-cache.js";

const ORIS_WEB = "https://oris.ceskyorientak.cz";
const RELAY_DISCIPLINES = ["RE", "TE", "SR"];
const MAX_CONCURRENCY = 6;                 // souběžné požadavky na ORIS
const HISTORY_KEY = "oInfoHistory";
const HISTORY_SIZE = 5;
const REG_RE = /^[A-Z]{3}\d{4}$/;
const CLUB_RE = /^[A-Z]{3}$/;
const WEEKDAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

/** Escapuje text pro vložení do HTML (data z ORIS zadávají pořadatelé a uživatelé). */
function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** ORIS vrací seznamy jako objekt { "Entry_1": {...} } nebo [] – sjednotí na pole. */
const asList = data => (data && typeof data === "object" ? Object.values(data) : []);

const isRelayDiscipline = d => RELAY_DISCIPLINES.includes(d);

/** Datum v místním čase jako "YYYY-MM-DD" (toISOString by kolem půlnoci posunul den kvůli UTC). */
function localIsoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// Rankingové kategorie (H20, H21, D20, D21, příp. M21/W21 vč. podkategorií) – odkaz na stránku rankingu
const RANKING_CLASS_RE = /^[HDMW]2/;

function storageGet(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // plné úložiště nebo soukromý režim – cache/historie není nutná
    }
}

/** Promise.all s omezeným počtem souběžných požadavků. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

/** Startovka závodu; chyba není fatální (startovka nemusí existovat). */
async function fetchStartList(eventId, clubId = null) {
    try {
        const params = { eventid: eventId };
        if (clubId) params.clubid = clubId;
        return asList(await oris("getEventStartLists", params));
    } catch (err) {
        console.warn("Startovku se nepodařilo načíst:", eventId, err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Formátování
// ---------------------------------------------------------------------------

function formatDate(dateStr) {
    const [y, m, d] = String(dateStr || "").split("-");
    return d ? `${d}. ${m}. ${y}` : "";
}

function weekdayOf(dateStr) {
    const [y, m, d] = String(dateStr || "").split("-").map(Number);
    return d ? WEEKDAYS[new Date(y, m - 1, d).getDay()] : "";
}

const formatDateWithWeekday = s => `${formatDate(s)}<br><span class="weekday">(${weekdayOf(s)})</span>`;
const formatDateWithWeekdayInline = s => `${formatDate(s)} (${weekdayOf(s)})`;

function formatTrack(track) {
    if (!track || !track.distance) return "";
    return `${track.distance.toFixed(1).replace(".", ",")} km | ${track.climbing} m | ${track.controls} k`;
}

function truncate(text, maxLength) {
    if (!text) return "";
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

const startTimeOnly = value => (String(value || "").includes(" ") ? value.split(" ")[1] : value || "");

function buildMapyComUrl(lat, lon) {
    if (!lat || !lon || String(lat) === "0" || String(lon) === "0") return "";
    const pointId = encodeURIComponent(`${lon},${lat}`);
    return `https://mapy.com/turisticka?x=${lon}&y=${lat}&z=14&source=coor&id=${pointId}`;
}

function buildMapIconHtml(mapUrl) {
    if (!mapUrl) return "";
    return `<a href="${esc(mapUrl)}" target="_blank" rel="noopener" title="Zobrazit na Mapy.com" class="map-link"><img src="/prihlasky/data/logo-mapy_com.png" alt="Mapa" class="map-icon"></a>`;
}

/** URL na soupisky štafet; respektuje aktivní výběr klubu. */
function getRelayTeamsLink(eventId) {
    const clubId = $("clubSelect")?.value;
    return clubId
        ? `${ORIS_WEB}/PrehledPrihlasenych?id=${eventId}&club=${clubId}&teams=1`
        : `${ORIS_WEB}/PrehledPrihlasenych?id=${eventId}&mode=clubs&teams=1`;
}

const rankingUrl = (eventId, classId) =>
    `/prihlasky/ranking.html?event=${encodeURIComponent(eventId)}&class=${encodeURIComponent(classId)}`;

/**
 * HTML kategorie. Rankingové kategorie OB na závodě započítávaném do rankingu (Ranking = 1)
 * odkazují na stránku s přihlášenými seřazenými podle rankingu. Přeřazení se zobrazí jako stará → nová.
 */
function buildClassHtml(row) {
    const linkable = cls => row.sport === "OB" && row.ranking && !isRelayDiscipline(row.discipline) && RANKING_CLASS_RE.test(cls || "");
    const link = (cls, classId, title) => (linkable(cls) && classId
        ? `<a title="${title}" href="${esc(rankingUrl(row.eventId, classId))}">${esc(cls)}</a>`
        : esc(cls));

    if (row.originalClass && row.originalClass !== row.class) {
        return `<span class="class-old">${link(row.originalClass, row.originalClassId, "Původní přihlášená kategorie – přihlášení podle rankingu")}</span>`
            + `<span>→</span><span>${link(row.class, row.classId, "Přeřazeno pořadatelem – přihlášení podle rankingu")}</span>`;
    }
    return link(row.class, row.classId, "Přihlášení podle rankingu");
}

// ---------------------------------------------------------------------------
// Transformace dat
// ---------------------------------------------------------------------------

/** classId → parametry tratě. */
function buildClassMap(event) {
    const map = {};
    asList(event?.Classes).forEach(c => {
        map[String(c.ID)] = {
            distance: parseFloat(c.Distance || 0),
            climbing: c.Climbing || "",
            controls: c.Controls || ""
        };
    });
    return map;
}

/** Indexuje startovku podle UserID i registračního čísla. */
function indexStartList(startData) {
    const byUser = {};
    const byReg = {};
    startData.forEach(s => {
        const info = {
            startTime: startTimeOnly(s.StartTime),
            classId: s.ClassID || "",
            classDesc: s.ClassDesc || "",
            startNumber: s.StartNumber && s.StartNumber !== "0" ? s.StartNumber : ""
        };
        if (s.UserID) byUser[String(s.UserID)] = info;
        if (s.RegNo) byReg[String(s.RegNo).toUpperCase()] = info;
    });
    return { byUser, byReg, hasData: startData.length > 0 };
}

/** Pokyny, předběžné parametry, štafeta. */
function buildEventMeta(event) {
    const documents = asList(event?.Documents);
    // Oficiální dokument „Pokyny“ má přednost před soubory, které mají „pokyny“ jen v popisu.
    const instructionDoc = documents.find(doc => doc.SourceType?.NameCZ === "Pokyny")
        || documents.find(doc => String(doc.OtherDescCZ || "").toLowerCase().includes("pokyny"));
    const preliminaryDoc = documents
        .filter(doc => /parametry|délky/.test(String(doc.OtherDescCZ || "").toLowerCase()))
        .reduce((latest, cur) => (!latest || Number(cur.ID) > Number(latest.ID) ? cur : latest), null);
    return {
        instructionsUrl: instructionDoc?.Url || "",
        preliminaryParamsUrl: preliminaryDoc?.Url || "",
        isRelay: isRelayDiscipline(event?.Discipline?.ShortName)
    };
}

/** Přihlášky jednoho závodu → řádky pro tabulku a karty. */
function buildRows(entries, event, eventId, startIndex) {
    const meta = buildEventMeta(event);
    const classMap = buildClassMap(event);
    const regions = asList(event.Regions).map(r => r.Name).join(", ");

    return entries.map(entry => {
        const regNo = String(entry.RegNo || "").toUpperCase();
        const start = startIndex.byUser[String(entry.UserID)] || startIndex.byReg[regNo] || {};
        const classId = start.classId || entry.ClassID;
        return {
            date: event.Date,
            eventName: event.Name,
            sport: event.Sport?.NameCZ || "",
            discipline: event.Discipline?.ShortName || "",
            start: event.StartTime || "",
            startTime: start.startTime || "",
            startNumber: start.startNumber || "",
            name: entry.Name || "",
            class: start.classDesc || entry.ClassDesc || "",
            originalClass: entry.ClassDesc || "",
            originalClassId: entry.ClassID || "",
            ranking: String(event.Ranking) === "1",
            reg: meta.isRelay ? "-" : (entry.RegNo || "-"),
            si: meta.isRelay ? "-" : (entry.SI || "-"),
            eventId: String(eventId),
            classId,
            userId: entry.UserID,
            place: event.Place || "",
            mapUrl: buildMapyComUrl(event.GPSLat, event.GPSLon),
            organizer: event.Org1?.Abbr || "",
            region: event.Region || regions,
            regions,
            track: classMap[String(classId)] || {},
            instructionsUrl: meta.instructionsUrl,
            preliminaryParamsUrl: meta.preliminaryParamsUrl
        };
    });
}

/** Řádek startovky jako náhradní „přihláška“ (finále bez přihlášek v ORIS). */
const startListAsEntry = s => ({
    UserID: s.UserID, Name: s.Name, RegNo: s.RegNo, SI: s.SI, ClassID: s.ClassID, ClassDesc: s.ClassDesc
});

// ---------------------------------------------------------------------------
// Vykreslení
// ---------------------------------------------------------------------------

let visibleRows = [];                 // řádky aktuálního výpisu (pro tisk)
const startListCache = new Map();     // eventId → data startovky z posledního načtení (pro tisk)

function groupByEvent(rows) {
    const grouped = new Map();
    rows.forEach(r => {
        if (!grouped.has(r.eventId)) grouped.set(r.eventId, []);
        grouped.get(r.eventId).push(r);
    });
    const groups = [...grouped.values()].sort((a, b) =>
        a[0].date.localeCompare(b[0].date) || (a[0].start || "").localeCompare(b[0].start || ""));
    groups.forEach(g => g.sort((a, b) =>
        (a.startTime || "").localeCompare(b.startTime || "") || a.name.localeCompare(b.name, "cs")));
    return groups;
}

function detailLinks(row, hasStartList, { icons = false } = {}) {
    const links = [];
    const icon = s => (icons ? `${s} ` : "");
    if (row.instructionsUrl) links.push(`${icon("📄")}<a href="${esc(row.instructionsUrl)}" target="_blank" rel="noopener">Pokyny</a>`);
    if (row.preliminaryParamsUrl) links.push(`${icon("📈")}<a href="${esc(row.preliminaryParamsUrl)}" target="_blank" rel="noopener">Parametry</a>`);
    if (isRelayDiscipline(row.discipline)) links.push(`${icon("👥")}<a href="${esc(getRelayTeamsLink(row.eventId))}" target="_blank" rel="noopener">Soupisky</a>`);
    if (hasStartList) links.push(`${icon("🖨️")}<a href="#" data-print-event="${esc(row.eventId)}">Tisk</a>`);
    return links;
}

const startTimeLink = row => (row.startTime
    ? `<a href="${ORIS_WEB}/Startovka?id=${esc(row.eventId)}#${esc(row.classId)}" target="_blank" rel="noopener">${esc(row.startTime)}</a>`
    : "");

const nameWithNumber = row => esc(row.name) + (row.startNumber ? ` (${esc(row.startNumber)})` : "");

const COLLAPSE_THRESHOLD = 6;           // závody s více přihlášenými se zobrazí sbalené
const expandedEvents = new Set();       // eventId rozbalených velkých závodů
let renderedGroups = new Map();         // eventId → skupina řádků (pro překreslení jednoho závodu)
let renderedStartListMap = {};

const isLargeGroup = group => group.length > COLLAPSE_THRESHOLD;
const isCollapsed = group => isLargeGroup(group) && !expandedEvents.has(group[0].eventId);
const pluralEntries = n => (n >= 2 && n <= 4 ? `${n} přihlášení` : `${n} přihlášených`);

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toggleButton(group) {
    const expanded = !isCollapsed(group);
    const label = expanded ? "Sbalit závodníky" : `Rozbalit – ${pluralEntries(group.length)}`;
    return `<button type="button" class="group-toggle" data-toggle-event="${esc(group[0].eventId)}" aria-expanded="${expanded}" title="${label}" aria-label="${label}">${CHEVRON_SVG}</button>`;
}

function summaryButton(group, { card = false } = {}) {
    const collapsed = isCollapsed(group);
    const text = collapsed ? `▸ ${pluralEntries(group.length)} – zobrazit` : (card ? "▴ Sbalit závodníky" : "");
    return `<button type="button" class="group-summary-btn" data-toggle-event="${esc(group[0].eventId)}" aria-expanded="${!collapsed}">${text}</button>`;
}

/** Jeden závod jako samostatný <tbody> – dá se překreslit nezávisle na ostatních. */
function renderGroupTbody(group, groupIndex, startListMap) {
    const first = group[0];
    const large = isLargeGroup(group);
    const collapsed = isCollapsed(group);
    const span = collapsed ? 1 : group.length;
    const alt = groupIndex % 2 === 1 ? ' class="alternating"' : "";
    // u rozbaleného velkého závodu zůstávají údaje o závodu při rolování viditelné
    const wrap = html => (large && !collapsed ? `<div class="sticky-cell">${html}</div>` : html);
    const cell = (cls, html) => `<td rowspan="${span}" class="${cls}">${wrap(html)}</td>`;

    const eventName = `<a href="${ORIS_WEB}/Zavod?id=${esc(first.eventId)}" target="_blank" rel="noopener">${esc(first.eventName)}</a>`
        + (large && !collapsed ? `<div class="group-count">${pluralEntries(group.length)}</div>` : "");
    const eventCells =
        cell("date-cell event-cell", (large ? toggleButton(group) : "") + formatDateWithWeekday(first.date))
        + cell("event-cell", esc(first.sport))
        + cell("event-cell", eventName)
        + cell("place-cell event-cell", esc(first.place))
        + cell("map-cell event-cell", buildMapIconHtml(first.mapUrl))
        + cell("event-cell", `${esc(first.organizer)} (${esc(first.region)})`)
        + cell("event-cell", esc(first.discipline))
        + cell("event-cell", esc(first.start));
    const detailCell = cell("event-cell", detailLinks(first, startListMap[first.eventId]).join("<br>"));

    const html = collapsed
        ? `<tr${alt}>${eventCells}<td colspan="6" class="group-summary">${summaryButton(group)}</td>${detailCell}</tr>`
        : group.map((row, idx) =>
            `<tr${alt}>${idx === 0 ? eventCells : ""}`
            + `<td class="name-cell">${nameWithNumber(row)}</td>`
            + `<td>${buildClassHtml(row)}</td>`
            + `<td>${esc(row.reg)}</td>`
            + `<td>${esc(row.si)}</td>`
            + `<td>${startTimeLink(row)}</td>`
            + `<td>${formatTrack(row.track)}</td>`
            + `${idx === 0 ? detailCell : ""}</tr>`).join("");

    const classes = ["event-group", large ? "is-large" : "", collapsed ? "is-collapsed" : ""].filter(Boolean).join(" ");
    return `<tbody class="${classes}" data-event-id="${esc(first.eventId)}" data-group-index="${groupIndex}">${html}</tbody>`;
}

function clearTable() {
    $("resultsTable").querySelectorAll("tbody.event-group").forEach(t => t.remove());
    $("resultsBody").innerHTML = "";
}

function renderTable(groups, startListMap) {
    clearTable();
    $("resultsTable").insertAdjacentHTML("beforeend",
        groups.map((group, i) => renderGroupTbody(group, i, startListMap)).join(""));
    $("resultsTable").style.display = "table";
}

const SPORT_ICONS = { OB: "🏃", LOB: "🎿", MTBO: "🚴", Trail: "♿" };

function renderCard(group, startListMap) {
    const ev = group[0];
    const icon = SPORT_ICONS[ev.sport] || "🏁";
    const placeHtml = ev.mapUrl && ev.place
        ? `<a href="${esc(ev.mapUrl)}" target="_blank" rel="noopener">${esc(ev.place)}</a>`
        : esc(ev.place || "-");
    const links = detailLinks(ev, startListMap[ev.eventId], { icons: true });

    const runners = isCollapsed(group) ? "" : group.map(row => `
        <div class="card-section">
            ${icon} <strong>${nameWithNumber(row)}</strong><br>
            Kat: ${buildClassHtml(row)}<br>
            Reg: ${esc(row.reg)} | SI: ${esc(row.si)}<br>
            📈 ${formatTrack(row.track) || "-"}<br>
            ⏱ ${startTimeLink(row) || "-"}
        </div>`).join("");

    return `
        <div class="card" data-event-id="${esc(ev.eventId)}">
            <div class="card-header">
                <div class="card-event-name">${icon} <a href="${ORIS_WEB}/Zavod?id=${esc(ev.eventId)}" target="_blank" rel="noopener">${esc(ev.eventName || "ORIS")}</a></div>
                <div>${formatDateWithWeekdayInline(ev.date)}</div>
            </div>
            <div class="card-sub">
                <span>Start:</span> <span class="card-value">${esc(ev.start || "-")}</span><br>
                <span>Pořadatel:</span> <span class="card-value">${esc(ev.organizer || "-")}</span><br>
                <span>Disciplína:</span> <span class="card-value">${esc(ev.discipline || "-")}</span><br>
                <span>Oblast:</span> <span class="card-value">${esc(ev.region || "-")}</span><br>
                <span>Místo:</span> <span class="card-value">${placeHtml}</span><br>
            </div>
            ${links.length ? `<div class="card-section">${links.join("<br>")}</div>` : ""}
            ${runners}
            ${isLargeGroup(group) ? `<div class="card-section">${summaryButton(group, { card: true })}</div>` : ""}
        </div>`;
}

function renderCards(groups, startListMap) {
    $("resultsCards").innerHTML = groups.map(group => renderCard(group, startListMap)).join("");
}

/** Tlačítka „Rozbalit vše / Sbalit vše“ – jen když je ve výpisu aspoň jeden velký závod. */
function updateGroupControls() {
    const controls = $("groupControls");
    if (!controls) return;
    const large = [...renderedGroups.values()].filter(isLargeGroup);
    controls.hidden = large.length === 0;
    controls.querySelector('[data-group-action="expand"]').disabled = !large.some(isCollapsed);
    controls.querySelector('[data-group-action="collapse"]').disabled = !large.some(g => !isCollapsed(g));
}

/** Přepne jeden závod a překreslí jen jeho řádky a kartu. */
function toggleGroup(eventId, sourceEl) {
    const group = renderedGroups.get(eventId);
    if (!group) return;
    if (expandedEvents.has(eventId)) expandedEvents.delete(eventId);
    else expandedEvents.add(eventId);

    const sel = `[data-event-id="${String(eventId).replace(/["\\]/g, "\\$&")}"]`;
    const tbody = $("resultsTable").querySelector(`tbody${sel}`);
    if (tbody) tbody.outerHTML = renderGroupTbody(group, Number(tbody.dataset.groupIndex), renderedStartListMap);
    const card = $("resultsCards").querySelector(`.card${sel}`);
    if (card) card.outerHTML = renderCard(group, renderedStartListMap);

    // po sbalení se vrátit na začátek závodu, ať se uživatel neztratí
    if (!expandedEvents.has(eventId)) {
        const container = sourceEl?.closest("#resultsCards") ? $("resultsCards") : $("resultsTable");
        const target = container.querySelector(sel);
        if (target && target.getBoundingClientRect().top < 0) target.scrollIntoView({ block: "start" });
    }
    updateGroupControls();
}

function setAllGroups(expand) {
    renderedGroups.forEach((group, eventId) => {
        if (!isLargeGroup(group)) return;
        if (expand) expandedEvents.add(eventId);
        else expandedEvents.delete(eventId);
    });
    const groups = [...renderedGroups.values()];
    renderTable(groups, renderedStartListMap);
    renderCards(groups, renderedStartListMap);
    updateGroupControls();
}

function renderResults(rows, startListMap) {
    visibleRows = rows;
    expandedEvents.clear();
    if (!rows.length) {
        showEmptyResult();
        return;
    }
    const groups = groupByEvent(rows);
    renderedGroups = new Map(groups.map(g => [g[0].eventId, g]));
    renderedStartListMap = startListMap;
    renderTable(groups, startListMap);
    renderCards(groups, startListMap);
    updateGroupControls();
}

function showEmptyResult() {
    visibleRows = [];
    renderedGroups = new Map();
    clearTable();
    updateGroupControls();
    $("resultsBody").innerHTML = `<tr><td colspan="15" style="text-align:center">Nenalezeny žádné přihlášky.</td></tr>`;
    $("resultsTable").style.display = "table";
    $("resultsCards").innerHTML = `<div class="card"><div class="card-section" style="text-align:center">Nenalezeny žádné přihlášky.</div></div>`;
}

function setLoading(isLoading) {
    $("loading").style.display = isLoading ? "flex" : "none";
    $("loadBtn").disabled = isLoading;
    $("loadBtn2").disabled = isLoading;
}

// ---------------------------------------------------------------------------
// Tisk startovních časů
// ---------------------------------------------------------------------------

async function openStartListTab(eventId) {
    // okno otevřít hned (synchronně v obsluze kliknutí), jinak ho prohlížeč zablokuje
    const win = window.open("", "_blank");
    if (!win) {
        alert("Prohlížeč zablokoval otevření okna. Povol popup pro tuto stránku.");
        return;
    }
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Startovní listina</title>
        <style>body{font-family:sans-serif;padding:20px}.user-block{margin-bottom:1em}.user-block div{margin-left:1em}
        @media print{#printBtn{display:none}}</style></head><body>
        <button id="printBtn" onclick="window.print()">Tisk</button><p id="msg">Načítám…</p>`);

    try {
        const rowsForEvent = visibleRows.filter(r => r.eventId === String(eventId));
        const info = rowsForEvent[0];
        const entries = startListCache.get(String(eventId)) || await fetchStartList(eventId);

        const byUser = new Map(rowsForEvent.map(r => [String(r.userId), r]));
        const byReg = new Map(rowsForEvent.map(r => [String(r.reg || "").toUpperCase(), r]));
        const findRow = s => byUser.get(String(s.UserID)) || byReg.get(String(s.RegNo || "").toUpperCase());

        const shown = entries
            .filter(findRow)
            .sort((a, b) => (startTimeOnly(a.StartTime) || "99:99").localeCompare(startTimeOnly(b.StartTime) || "99:99"));

        let html = `<h2>${esc(formatDate(info.date))} – ${esc(info.eventName)}</h2>
            <p>Druh: ${esc(info.sport)}<br>Typ: ${esc(info.discipline)}</p>
            <p>Pořadatel: ${esc(info.organizer)} (${esc(info.regions)})<br>Místo: ${esc(info.place)}<br>Start 00: ${esc(info.start)}</p>
            <p>Vzdálenost z parkoviště:<br>Vzdálenost na start:<br>Vzdálenost z cíle:<br>
            Pokyny: ${info.instructionsUrl ? `<a href="${esc(info.instructionsUrl)}" target="_blank">zde</a>` : "—"}</p>`;

        shown.forEach(s => {
            const row = findRow(s);
            html += `<div class="user-block">
                <strong>${esc(s.Name)} (${esc(s.ClassDesc)}, ${esc(s.RegNo)}, ${esc(s.SI)})</strong>
                <div>${esc(s.ClassDesc)}: ${formatTrack(row?.track) || "—"}</div>
                <div>startovní čas: ${esc(startTimeOnly(s.StartTime))}</div>
            </div>`;
        });

        win.document.getElementById("msg").remove();
        win.document.write(html + "</body></html>");
    } catch (err) {
        console.error("Chyba při načítání startovní listiny:", err);
        win.document.write("<p>Chyba při načítání startovní listiny.</p></body></html>");
    }
    win.document.close();
}

// ---------------------------------------------------------------------------
// Období a výběr závodu
// ---------------------------------------------------------------------------

const getSelectedPeriod = () => document.querySelector('input[name="period"]:checked')?.value || "30";
const isEventMode = period => period === "event30" || period === "eventYear";

function getDateRange(period = getSelectedPeriod()) {
    const today = new Date();
    if (period === "30" || period === "event30") {
        return { from: localIsoDate(today), to: localIsoDate(addDays(today, 30)) };
    }
    if (period === "eventYear") {
        const y = today.getFullYear();
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    return { from: $("dateFromInput").value, to: $("dateToInput").value };
}

/** Ověří ručně zadané období; vrací chybovou hlášku nebo "". */
function validateRange({ from, to }) {
    if (!from || !to) return "Zadej datum od i do.";
    if (from > to) return "Datum „od“ musí být před datem „do“.";
    return "";
}

/** Seznam závodů do výběru (jeden dotaz, cache 1 h v prohlížeči – viz oris-cache.js). */
async function loadEvents() {
    const period = getSelectedPeriod();
    if (!isEventMode(period)) return;

    const { from, to } = getDateRange(period);
    const all = $("includeUnofficial")?.checked ? 1 : 0;
    const eventSelect = $("eventSelect");

    eventSelect.innerHTML = "<option value=\"\">Načítám závody...</option>";
    eventSelect.disabled = true;
    try {
        renderEventOptions(await getEventListCached({ all, datefrom: from, dateto: to }));
    } catch (err) {
        console.error(err);
        eventSelect.innerHTML = "<option value=\"\">Chyba načítání závodů</option>";
    } finally {
        eventSelect.disabled = false;
    }
}

function renderEventOptions(events) {
    const eventSelect = $("eventSelect");
    const previous = eventSelect.value;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(new Option("-- vyber závod --", ""));

    [...events].sort((a, b) => a.Date.localeCompare(b.Date)).forEach(e => {
        const text = [formatDate(e.Date), e.Sport?.NameCZ, e.Org1?.Abbr, e.Name, e.Discipline?.ShortName, e.Region, truncate(e.Place, 80)]
            .filter(Boolean).join(", ");
        const opt = new Option(text, e.ID);
        // neoficiální závody šedě
        if (/^(OST|PS|REG|ZL|TC)/.test(e.Level?.ShortName || "")) opt.style.color = "#999";
        fragment.appendChild(opt);
    });

    eventSelect.replaceChildren(fragment);
    if (previous && [...eventSelect.options].some(o => o.value === previous)) eventSelect.value = previous;
}

// ---------------------------------------------------------------------------
// Kluby a historie
// ---------------------------------------------------------------------------

let clubsCache = [];

const clubsReady = getClubsCached()
    .then(data => {
        clubsCache = asList(data).sort((a, b) => (a.Abbr || "").localeCompare(b.Abbr || ""));
        const select = $("clubSelect");
        const fragment = document.createDocumentFragment();
        fragment.appendChild(new Option("-- výběr klubu --", ""));
        clubsCache.forEach(c => {
            const opt = new Option(`${c.Abbr} – ${c.Name}`, c.ID);
            opt.dataset.abbr = c.Abbr;
            fragment.appendChild(opt);
        });
        select.replaceChildren(fragment);
        return clubsCache;
    })
    .catch(err => {
        console.error("Chyba při načítání klubů:", err);
        $("clubSelect").innerHTML = '<option value="">Kluby se nepodařilo načíst</option>';
        return [];
    });

const findClubByAbbr = abbr => clubsCache.find(c => c.Abbr === abbr);

function selectClubByAbbr(abbr) {
    const select = $("clubSelect");
    const option = [...select.options].find(o => o.dataset.abbr === abbr);
    if (option) select.value = option.value;
    return !!option;
}

function saveHistory(input) {
    const history = [input, ...storageGet(HISTORY_KEY, []).filter(h => h !== input)].slice(0, HISTORY_SIZE);
    storageSet(HISTORY_KEY, history);
    renderHistory(history);
}

function renderHistory(history = storageGet(HISTORY_KEY, [])) {
    const select = $("historySelect");
    select.replaceChildren(new Option("-- poslední hodnoty --", ""), ...history.map(h => new Option(h, h)));
}

// ---------------------------------------------------------------------------
// Načítání přihlášek
// ---------------------------------------------------------------------------

/** Registrační čísla → UserID (neexistující hlásí). */
async function resolveUsers(registrations) {
    const users = await mapLimit(registrations, MAX_CONCURRENCY, async reg => {
        try {
            return { reg, userId: await getUserIdCached(reg) };
        } catch {
            return { reg, userId: null };
        }
    });
    const invalid = users.filter(u => !u.userId).map(u => u.reg);
    if (invalid.length === users.length) {
        throw new UserError("Žádná ze zadaných registrací nebyla nalezena:\n" + invalid.join(", "));
    }
    if (invalid.length) alert("Některé registrace nebyly nalezeny:\n" + invalid.join(", "));
    return [...new Set(users.filter(u => u.userId).map(u => String(u.userId)))];
}

/** Chyba se srozumitelnou hláškou pro uživatele. */
class UserError extends Error {}

/** Přihlášky uživatelů v období (deduplikované po závodě a uživateli). */
async function fetchUserEntries(userIds, from, to) {
    const results = await mapLimit(userIds, MAX_CONCURRENCY, async userId =>
        asList(await oris("getUserEventEntries", { userid: userId, datefrom: from, dateto: to, _: Date.now() }))
            .map(e => ({ ...e, UserID: e.UserID || userId })));
    const seen = new Set();
    return results.flat().filter(e => {
        const key = `${e.EventID}-${e.UserID}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Registrační čísla, období: přihlášky napříč závody. */
async function loadRegsMultiEvent(registrations) {
    const range = getDateRange();
    const rangeError = validateRange(range);
    if (rangeError) throw new UserError(rangeError);

    const userIds = await resolveUsers(registrations);
    const entries = await fetchUserEntries(userIds, range.from, range.to);
    if (!entries.length) return renderResults([], {});

    const byEvent = new Map();
    entries.forEach(e => {
        const id = String(e.EventID);
        if (!byEvent.has(id)) byEvent.set(id, []);
        byEvent.get(id).push(e);
    });
    const eventIds = [...byEvent.keys()];

    // detaily závodů + startovky jen pro kluby zadaných závodníků (výrazně menší než celé startovky)
    const startRequests = [];
    eventIds.forEach(id => {
        const clubIds = [...new Set(byEvent.get(id).map(e => e.ClubID || ""))];
        clubIds.forEach(clubId => startRequests.push({ id, clubId }));
    });
    const [details, startLists] = await Promise.all([
        mapLimit(eventIds, MAX_CONCURRENCY, id => getEventCached(id)),
        mapLimit(startRequests, MAX_CONCURRENCY, r => fetchStartList(r.id, r.clubId || null))
    ]);

    const startByEvent = new Map();
    startRequests.forEach((r, i) => startByEvent.set(r.id, [...(startByEvent.get(r.id) || []), ...startLists[i]]));

    const rows = [];
    const startListMap = {};
    startListCache.clear();
    eventIds.forEach((id, i) => {
        const startData = startByEvent.get(id) || [];
        const index = indexStartList(startData);
        startListMap[id] = index.hasData;
        startListCache.set(id, startData);
        rows.push(...buildRows(byEvent.get(id), details[i] || {}, id, index));
    });
    renderResults(rows, startListMap);
}

/** Registrační čísla, konkrétní závod (individuální i štafety). */
async function loadRegsSingleEvent(registrations, eventId) {
    const regSet = new Set(registrations);
    const [event, startData, userIds] = await Promise.all([
        getEventCached(eventId),
        fetchStartList(eventId),
        resolveUsers(registrations)
    ]);

    // přihlášky jen z data závodu – místo stažení všech přihlášek závodu
    const date = event?.Date;
    let entries = (await fetchUserEntries(userIds, date, date)).filter(e => String(e.EventID) === String(eventId));

    // finále bez přihlášek: závodníci ze startovky
    if (!entries.length && startData.length) {
        entries = startData.filter(s => regSet.has(String(s.RegNo || "").toUpperCase())).map(startListAsEntry);
    }

    startListCache.clear();
    startListCache.set(String(eventId), startData);
    const index = indexStartList(startData);
    renderResults(buildRows(entries, event, eventId, index), { [eventId]: index.hasData });
}

/** Klub, období: jen závody, kde má klub přihlášky nebo startující (myClubId). */
async function loadClubMultiEvent(club) {
    const range = getDateRange();
    const rangeError = validateRange(range);
    if (rangeError) throw new UserError(rangeError);

    const events = asList(await oris("getEventList", { all: 1, datefrom: range.from, dateto: range.to, myClubId: club.ID }));
    const count = (e, field) => (e[field] === undefined ? null : Number(e[field]) || 0);
    // údaj chybí → raději stáhnout; ClubStartCount zachytí i finále bez přihlášek
    const relevant = events.filter(e => count(e, "ClubEntryCount") !== 0 || (count(e, "ClubStartCount") || 0) > 0);
    if (!relevant.length) return renderResults([], {});

    const results = await mapLimit(relevant, MAX_CONCURRENCY, async e => {
        const id = String(e.ID);
        const [entries, detail, startData] = await Promise.all([
            oris("getEventEntries", { eventid: id, clubid: club.ID, _: Date.now() }).then(asList),
            getEventCached(id),
            fetchStartList(id, club.ID)
        ]);
        return { id, entries: entries.length ? entries : startData.map(startListAsEntry), detail, startData };
    });

    const rows = [];
    const startListMap = {};
    startListCache.clear();
    results.forEach(({ id, entries, detail, startData }) => {
        const index = indexStartList(startData);
        startListMap[id] = index.hasData;
        startListCache.set(id, startData);
        rows.push(...buildRows(entries, detail || {}, id, index));
    });
    renderResults(rows, startListMap);
}

/** Klub, konkrétní závod. */
async function loadClubSingleEvent(club, eventId) {
    const [entriesRaw, event, startData] = await Promise.all([
        oris("getEventEntries", { eventid: eventId, clubid: club.ID, _: Date.now() }).then(asList),
        getEventCached(eventId),
        fetchStartList(eventId)
    ]);

    let entries = entriesRaw;
    // finále bez přihlášek: členové klubu ze startovky
    if (!entries.length && startData.length) {
        entries = startData
            .filter(s => String(s.ClubID) === String(club.ID) || String(s.RegNo || "").toUpperCase().startsWith(club.Abbr))
            .map(startListAsEntry);
    }

    startListCache.clear();
    startListCache.set(String(eventId), startData);
    const index = indexStartList(startData);
    renderResults(buildRows(entries, event, eventId, index), { [eventId]: index.hasData });
}

/** Vstupní bod: ověří vstup a zavolá správný způsob načtení. */
async function handleLoad() {
    const input = $("mainInput").value.toUpperCase().replace(/\s+/g, "");
    const period = getSelectedPeriod();

    if (!input) return alert("Zadej registrační číslo nebo zkratku klubu");

    const registrations = input.split(",").filter(Boolean);
    const isClub = CLUB_RE.test(input);
    const isRegs = registrations.length > 0 && registrations.every(r => REG_RE.test(r));
    if (!isClub && !isRegs) {
        return alert("Neplatný vstup - musí být zadán klub ve tvaru XXX nebo registrační číslo ve tvaru XXX1111, příp. více reg. čísel oddělených čárkou.");
    }

    const eventId = $("eventSelect").value;
    if (isEventMode(period) && !eventId) return alert("Vyber konkrétní závod");

    setLoading(true);
    try {
        if (isClub) {
            await clubsReady;
            const club = findClubByAbbr(input);
            if (!club) throw new UserError("Klub v ČSOS neexistuje");
            selectClubByAbbr(input);
            saveHistory(input);
            await (isEventMode(period) ? loadClubSingleEvent(club, eventId) : loadClubMultiEvent(club));
        } else {
            const unique = [...new Set(registrations)];
            saveHistory(unique.join(","));
            $("clubSelect").value = "";
            await (isEventMode(period) ? loadRegsSingleEvent(unique, eventId) : loadRegsMultiEvent(unique));
        }
    } catch (err) {
        console.error(err);
        alert(err instanceof UserError ? err.message : "Chyba při načítání dat z ORIS. Zkus to prosím znovu.");
    } finally {
        setLoading(false);
    }
}

// ---------------------------------------------------------------------------
// Vstup z URL: ?SJC8102,SJC8351, ?SJC, ?q=… nebo #…
// ---------------------------------------------------------------------------

function normalizeUrlInput(value) {
    try {
        value = decodeURIComponent(value);
    } catch {
        // neplatné % kódování – použije se tak, jak je
    }
    return value.replace(/\+/g, " ").toUpperCase().replace(/\s+/g, "");
}

function getInputFromUrl() {
    const search = window.location.search.slice(1);
    const hash = window.location.hash.slice(1);
    if (search) {
        const params = new URLSearchParams(search);
        const named = params.get("q") || params.get("search") || params.get("input") || params.get("regs");
        if (named) return normalizeUrlInput(named);
        if (!search.includes("=")) return normalizeUrlInput(search);
    }
    if (hash && !hash.includes("=")) return normalizeUrlInput(hash);
    return "";
}

// ---------------------------------------------------------------------------
// Přepínač tématu
// ---------------------------------------------------------------------------

function initTheme() {
    const toggle = $("themeToggle");
    if (!toggle) return;
    let saved = null;
    try { saved = localStorage.getItem("theme"); } catch { /* bez úložiště */ }
    const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.body.classList.toggle("dark", dark);
    toggle.textContent = dark ? "☀️" : "🌙";

    toggle.addEventListener("click", () => {
        const isDark = document.body.classList.toggle("dark");
        toggle.textContent = isDark ? "☀️" : "🌙";
        try { localStorage.setItem("theme", isDark ? "dark" : "light"); } catch { /* bez úložiště */ }
    });
}

// ---------------------------------------------------------------------------
// Inicializace
// ---------------------------------------------------------------------------

function init() {
    initTheme();
    renderHistory();

    const input = $("mainInput");
    $("loadBtn").addEventListener("click", handleLoad);
    $("loadBtn2").addEventListener("click", handleLoad);
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleLoad();
        }
    });
    input.addEventListener("input", () => {
        const val = input.value.trim().toUpperCase();
        if (CLUB_RE.test(val)) clubsReady.then(() => selectClubByAbbr(val));
    });

    $("clubSelect").addEventListener("change", e => {
        const abbr = e.target.selectedOptions[0]?.dataset.abbr;
        if (abbr) input.value = abbr;
    });
    $("historySelect").addEventListener("change", e => {
        if (e.target.value) input.value = e.target.value;
    });

    // výchozí ruční období: dnes – konec roku
    const today = new Date();
    $("dateFromInput").value = localIsoDate(today);
    $("dateToInput").value = `${today.getFullYear()}-12-31`;
    const customRadio = document.querySelector('input[name="period"][value="custom"]');
    ["dateFromInput", "dateToInput"].forEach(id =>
        $(id).addEventListener("change", () => { if (customRadio) customRadio.checked = true; }));

    document.querySelectorAll('input[name="period"]').forEach(radio => radio.addEventListener("change", loadEvents));
    $("includeUnofficial").addEventListener("change", loadEvents);

    // „Tisk“, rozbalení závodů a „Rozbalit / Sbalit vše“ (delegovaná obsluha)
    document.addEventListener("click", e => {
        const printLink = e.target.closest("[data-print-event]");
        if (printLink) {
            e.preventDefault();
            openStartListTab(printLink.dataset.printEvent);
            return;
        }
        const toggle = e.target.closest("[data-toggle-event]");
        if (toggle) {
            toggleGroup(toggle.dataset.toggleEvent, toggle);
            return;
        }
        const action = e.target.closest("[data-group-action]");
        if (action) setAllGroups(action.dataset.groupAction === "expand");
    });

    const urlInput = getInputFromUrl();
    if (urlInput) {
        input.value = urlInput;
        input.dispatchEvent(new Event("input"));
        handleLoad();
    }
}

// modul se spouští až po načtení DOM (type="module" je odložený)
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
