// O-info – přihlášení v rankingové kategorii seřazení podle rankingu.
// URL: /prihlasky/ranking.html?event=<ID závodu>&class=<ID kategorie nebo název, např. D21C>

import { oris, getEventCached } from "./oris-cache.js";

const ORIS_WEB = "https://oris.ceskyorientak.cz";
const RANKING_PROXY = "/prihlasky/ranking.php";   // ORIS ranking_export nemá CORS
const SPRINT_DISCIPLINES = ["SP", "KO"];           // sprint, knock-out sprint → sprintový ranking
const RANK_TYPE = { forest: 2, sprint: 8 };
const RANKING_CLASS_RE = /^[HDMW]2/;               // H20, H21, D20, D21 (a M21/W21) vč. podkategorií
const PB_COUNT = 4;
const WEEKDAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

const $ = id => document.getElementById(id);

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const asList = data => (data && typeof data === "object" ? Object.values(data) : []);

/** Ranking přes prostředníka na serveru; vrací Map regNo → položka. */
async function fetchRanking(date, gender, rankType) {
    const res = await fetch(`${RANKING_PROXY}?${new URLSearchParams({ date, gender, ranktype: rankType })}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.items) throw new Error(json?.error || `Ranking: HTTP ${res.status}`);
    return new Map(json.items.map(item => [item.regNo, item]));
}

const isIsoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function formatDate(iso) {
    const [y, m, d] = String(iso || "").split("-");
    return d ? `${Number(d)}. ${Number(m)}. ${y}` : "";
}

function weekday(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

/** Poslední den měsíce předcházejícího danému datu (stav rankingu pro PB podle SŘ). */
function lastDayOfPreviousMonth(iso) {
    const [y, m] = iso.split("-").map(Number);
    const d = new Date(y, m - 1, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const formatNumber = n => new Intl.NumberFormat("cs-CZ").format(n);
const formatDecimal = (value, digits = 2) => {
    const n = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(n) ? n.toFixed(digits).replace(".", ",") : "";
};
const startTimeOnly = v => (String(v || "").includes(" ") ? v.split(" ")[1] : v || "");

function showError(message) {
    $("loading").style.display = "none";
    $("error").textContent = message;
    $("error").hidden = false;
}

function dl(items) {
    return items.filter(([, v]) => v !== "" && v != null)
        .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
}

/** Průměr PB_COUNT nejvyšších rankingových čísel. */
function computePB(rankNumbers) {
    const top = rankNumbers.filter(n => n > 0).sort((a, b) => b - a).slice(0, PB_COUNT);
    if (!top.length) return null;
    return { value: Math.round(top.reduce((s, n) => s + n, 0) / top.length), count: top.length, top };
}

async function main() {
    const params = new URLSearchParams(location.search);
    const eventId = params.get("event");
    const classParam = params.get("class");
    if (!/^\d+$/.test(eventId || "") || !classParam) {
        return showError("Chybí závod nebo kategorie. Otevřete stránku odkazem z výpisu přihlášek.");
    }

    const event = await getEventCached(eventId);
    const classes = asList(event.Classes);
    const cls = classes.find(c => String(c.ID) === classParam)
        || classes.find(c => String(c.Name).toUpperCase() === classParam.toUpperCase());
    if (!cls) return showError("Kategorie v závodě neexistuje.");

    document.title = `${cls.Name} – ${event.Name} – O-info ranking`;
    const discipline = event.Discipline?.ShortName || "";
    const isSprint = SPRINT_DISCIPLINES.includes(discipline);
    const rankType = isSprint ? RANK_TYPE.sprint : RANK_TYPE.forest;
    const rankName = isSprint ? "Sprintový ranking" : "Lesní ranking";

    // --- hlavička závodu
    $("eventTitle").innerHTML = `<a href="${ORIS_WEB}/Zavod?id=${esc(event.ID)}" target="_blank" rel="noopener">${esc(event.Name)}</a>`;
    const region = event.Region || asList(event.Regions).map(r => r.Name).join(", ");
    $("eventInfo").innerHTML = dl([
        ["Datum", `${esc(formatDate(event.Date))} (${esc(weekday(event.Date))})${event.StartTime ? `, start 00: ${esc(event.StartTime)}` : ""}`],
        ["Místo", esc(event.Place || "")],
        ["Pořadatel", esc([event.Org1?.Abbr, event.Org1?.Name].filter(Boolean).join(" – ")) + (region ? ` (${esc(region)})` : "")],
        ["Sport / disciplína", esc([event.Sport?.NameCZ, event.Discipline?.NameCZ || discipline].filter(Boolean).join(", "))],
        ["Úroveň", esc(event.Level?.NameCZ || event.Level?.ShortName || "")],
    ]);
    $("eventBox").hidden = false;

    if (event.Sport?.NameCZ !== "OB" || String(event.Ranking) !== "1") {
        return showError("Tento závod se do rankingu nezapočítává.");
    }
    if (!RANKING_CLASS_RE.test(cls.Name)) {
        return showError(`Kategorie ${cls.Name} není rankingová (ranking se počítá v kategoriích H20, H21, D20, D21).`);
    }

    const gender = /^[HM]/.test(cls.Name) ? "M" : "F";
    const decisionDate = isIsoDate(event.RankingDecisionDate) ? event.RankingDecisionDate : lastDayOfPreviousMonth(event.Date);
    const pbDate = lastDayOfPreviousMonth(event.Date);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // --- data paralelně: ranking k rozhodnému datu (+ k datu pro PB), startovka, přihlášky, výsledky
    const optional = p => p.catch(err => { console.warn(err); return null; });
    const [rankDecision, rankPB, startList, entries, results] = await Promise.all([
        optional(fetchRanking(decisionDate, gender, rankType)),
        pbDate === decisionDate ? Promise.resolve(null) : optional(fetchRanking(pbDate, gender, rankType)),
        optional(oris("getEventStartLists", { eventid: eventId, classid: cls.ID }).then(asList)),
        optional(oris("getEventEntries", { eventid: eventId, classid: cls.ID }).then(asList)),
        event.Date <= today ? optional(oris("getEventResults", { eventid: eventId, classid: cls.ID }).then(asList)) : Promise.resolve(null),
    ]);
    const rankingForPB = rankPB || rankDecision;

    // startovka respektuje přeřazení do podkategorií; bez ní se použijí přihlášky
    const useStartList = startList && startList.length > 0;
    const runners = (useStartList ? startList : entries || []).map(r => ({
        name: r.Name || "",
        regNo: String(r.RegNo || "").toUpperCase(),
        startTime: startTimeOnly(r.StartTime),
    }));

    // --- PB: z dokončivších (jsou-li výsledky), jinak odhad z přihlášených
    const finished = (results || []).filter(r => r.Place && !/^(DISK|DNS|DNF|MP)/i.test(String(r.Time || "")));
    const pbBase = finished.length ? finished.map(r => String(r.RegNo || "").toUpperCase()) : runners.map(r => r.regNo);
    const pb = rankingForPB ? computePB(pbBase.map(reg => rankingForPB.get(reg)?.rankNumber || 0)) : null;
    const pbMembers = new Set(pb && rankingForPB
        ? pbBase.filter(reg => pb.top.includes(rankingForPB.get(reg)?.rankNumber)).slice(0, PB_COUNT) : []);

    const ks = Number(String(event.RankingKS ?? "0").replace(",", "."));
    $("rankingTitle").textContent = rankName;
    $("rankingInfo").innerHTML = dl([
        ["Rozhodné datum", esc(formatDate(decisionDate)) + (isIsoDate(event.RankingDecisionDate) ? "" : " <span class=\"rank-hint\">(neuvedeno, použit konec předchozího měsíce)</span>")],
        ["Koeficient (KZ)", esc(event.RankingKoef || "")],
        ["PB", pb
            ? `${esc(formatNumber(pb.value))} <span class="rank-hint">(${finished.length ? "z výsledků" : "odhad z přihlášených"}, stav k ${esc(formatDate(pbDate))}${pb.count < PB_COUNT ? `, jen ${pb.count} závodníci v rankingu` : ""})</span>`
            : "<span class=\"rank-hint\">nelze určit</span>"],
        ["KS", `${esc(formatDecimal(ks))} <span class="rank-hint">(${ks > 0 ? "hromadný start" : "intervalový / handicapový start"})</span>`],
    ]);
    $("rankingHint").innerHTML =
        "PB – průměrná hodnota 4 nejvyšších rankingových čísel závodníků (podle stavu k poslednímu dni měsíce předcházejícího konání závodu), kteří se zúčastnili závodu. "
        + "KS – faktor ovlivňující výpočet bodů (hromadný start – 0,15; start intervalový a handicapový – 0,00). "
        + "Body závodníka: BZ = (2 – CZ/PC) · PB · (1 – KS · (U – 1)/(N – 1)) · KZ (Soutěžní řád, kap. V).";
    $("rankingBox").hidden = false;

    // --- kategorie
    const rows = runners.map(r => ({ ...r, rank: rankDecision?.get(r.regNo) || null }))
        .sort((a, b) => (a.rank ? 0 : 1) - (b.rank ? 0 : 1)
            || (a.rank?.rank ?? 0) - (b.rank?.rank ?? 0)
            || a.name.localeCompare(b.name, "cs"));
    const inRanking = rows.filter(r => r.rank).length;

    $("classTitle").textContent = `Kategorie ${cls.Name}`;
    $("classHint").innerHTML = [
        `${rows.length} ${useStartList ? "ve startovce" : "přihlášených"}, z toho ${inRanking} v rankingu (stav k ${esc(formatDate(decisionDate))}).`,
        pbMembers.size ? "★ = započteni do PB." : "",
        rankDecision ? "" : `<span class="rank-error">Ranking se nepodařilo načíst, zobrazen je jen seznam závodníků.</span>`,
    ].filter(Boolean).join(" ");

    $("classBody").innerHTML = rows.length
        ? rows.map(r => `<tr class="${[r.rank ? "" : "unranked", pbMembers.has(r.regNo) ? "pb-member" : ""].join(" ").trim()}">
            <td class="num">${r.rank ? esc(r.rank.rank) : "–"}</td>
            <td>${esc(r.name)}</td>
            <td>${esc(r.regNo || "–")}</td>
            <td class="num">${r.rank ? esc(formatNumber(r.rank.rankNumber)) : ""}</td>
            <td class="num opt">${r.rank ? esc(formatNumber(r.rank.points)) : ""}</td>
            <td class="opt">${esc(r.startTime)}</td>
        </tr>`).join("")
        : `<tr><td colspan="6" style="text-align:center">V kategorii nejsou žádní přihlášení.</td></tr>`;
    $("classBox").hidden = false;
    $("loading").style.display = "none";
}

// „← Výpis přihlášek“: když jsme přišli z výpisu, vrátit se v historii (výpis zůstane načtený)
$("backLink")?.addEventListener("click", e => {
    let fromSameSite = false;
    try { fromSameSite = document.referrer && new URL(document.referrer).origin === location.origin; } catch { /* neplatný referrer */ }
    if (fromSameSite && history.length > 1) {
        e.preventDefault();
        history.back();
    }
});

main().catch(err => {
    console.error(err);
    showError("Data se nepodařilo načíst z ORIS. Zkuste stránku obnovit.");
});
