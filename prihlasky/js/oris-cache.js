// O-info – volání ORIS API s cache v prohlížeči (localStorage).
// Cachují se jen data, která se mění zřídka (kluby, ID závodníků, detail závodu, seznam závodů).
// Přihlášky, startovky a výsledky se vždy stahují čerstvé.

export const ORIS_API = "https://oris.ceskyorientak.cz/API/";

// Změna verze zneplatní celou cache (staré klíče smaže úklid při startu).
// v2: kratší platnosti (detail závodu 10 min, ID závodníka 1 den).
const CACHE_PREFIX = "oInfoCache:v2:";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TTL = {
    clubs: DAY,                 // mění se 1× ročně (začátek sezóny); změna se projeví do druhého dne
    user: DAY,                  // reg. č. → ID; nové reg. číslo po přestupu se načte hned (jiný klíč)
    userNotFound: 10 * MINUTE,  // neexistující reg. číslo (překlep, číslo ještě nepřidělené)
    eventList: 30 * MINUTE,     // roletka závodů; nově vypsané závody / finále do 30 min
    eventUpcoming: 10 * MINUTE, // dnešní a budoucí závody – pokyny a parametry do 10 min
    eventPast: DAY,             // proběhlé závody se už téměř nemění
};

/** Jedno volání ORIS API; ověří HTTP i Status a vrátí Data. */
export async function oris(method, params = {}) {
    const res = await fetch(`${ORIS_API}?${new URLSearchParams({ format: "json", method, ...params })}`);
    if (!res.ok) throw new Error(`ORIS ${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json?.Status !== "OK") throw new Error(`ORIS ${method}: ${json?.Status || "neplatná odpověď"}`);
    return json.Data;
}

// ---------------------------------------------------------------------------
// Úložiště
// ---------------------------------------------------------------------------

function cacheKey(method, params) {
    const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
    return `${CACHE_PREFIX}${method}?${sorted}`;
}

function readEntry(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function cacheKeys() {
    const keys = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
        }
    } catch { /* úložiště nedostupné */ }
    return keys;
}

/** Smaže prošlé položky; s `aggressive` navíc starší polovinu (při plném úložišti). */
function prune(aggressive = false) {
    const now = Date.now();
    const entries = cacheKeys().map(k => ({ k, e: readEntry(k) }));
    entries.forEach(({ k, e }) => {
        if (!e || e.exp <= now) {
            try { localStorage.removeItem(k); } catch { /* nic */ }
        }
    });
    if (aggressive) {
        entries.filter(({ e }) => e && e.exp > now)
            .sort((a, b) => a.e.ts - b.e.ts)
            .slice(0, Math.ceil(entries.length / 2))
            .forEach(({ k }) => { try { localStorage.removeItem(k); } catch { /* nic */ } });
    }
}

function writeEntry(key, data, ttl) {
    const value = JSON.stringify({ ts: Date.now(), exp: Date.now() + ttl, data });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            localStorage.setItem(key, value);
            return;
        } catch {
            prune(true);   // plné úložiště → uvolnit místo a zkusit znovu
        }
    }
}

/** Úklid při startu: prošlé položky a klíče starších verzí aplikace. */
function cleanupOnStart() {
    prune();
    try {
        const legacy = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith("eventListCache_") || k === "oInfoEventListCache"
                || (k.startsWith("oInfoCache:") && !k.startsWith(CACHE_PREFIX)))) legacy.push(k);
        }
        legacy.forEach(k => localStorage.removeItem(k));
    } catch { /* úložiště nedostupné */ }
}
cleanupOnStart();

// ---------------------------------------------------------------------------
// Volání s cache
// ---------------------------------------------------------------------------

const inFlight = new Map();   // souběžné stejné dotazy se spojí do jednoho

/**
 * ORIS volání s cache.
 * @param {string} method
 * @param {object} params
 * @param {{ttl: number | ((data) => number), transform?: (data) => any}} options
 *   ttl – platnost v ms (nebo funkce podle dat); transform – zmenšení dat před uložením
 */
export function cachedOris(method, params, { ttl, transform = d => d }) {
    const key = cacheKey(method, params);
    const cached = readEntry(key);
    if (cached && cached.exp > Date.now()) return Promise.resolve(cached.data);
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = oris(method, params)
        .then(raw => {
            const data = transform(raw);
            const lifetime = typeof ttl === "function" ? ttl(data) : ttl;
            if (lifetime > 0) writeEntry(key, data, lifetime);
            return data;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

// ---------------------------------------------------------------------------
// Konkrétní data
// ---------------------------------------------------------------------------

function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const pick = (obj, keys) => (obj && typeof obj === "object"
    ? Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]))
    : obj);
const mapValues = (obj, fn) => (obj && typeof obj === "object"
    ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]))
    : obj);

/** Detail závodu zmenšený na pole, která o-info používá (plný getEvent má desítky kB). */
function slimEvent(e) {
    if (!e || typeof e !== "object") return e;
    return {
        ...pick(e, ["ID", "Name", "Date", "Place", "Region", "Regions", "StartTime", "GPSLat", "GPSLon",
            "Ranking", "RankingKoef", "RankingKS", "RankingDecisionDate", "Cancelled", "ParentID"]),
        Org1: pick(e.Org1, ["ID", "Abbr", "Name"]),
        Sport: pick(e.Sport, ["ID", "NameCZ"]),
        Discipline: pick(e.Discipline, ["ID", "ShortName", "NameCZ"]),
        Level: pick(e.Level, ["ID", "ShortName", "NameCZ"]),
        Classes: mapValues(e.Classes, c => pick(c, ["ID", "Name", "Distance", "Climbing", "Controls"])),
        Documents: mapValues(e.Documents, d => ({
            ...pick(d, ["ID", "Url", "OtherDescCZ"]),
            SourceType: pick(d.SourceType, ["NameCZ"]),
        })),
    };
}

/** getEvent s cache: 10 min u dnešních a budoucích závodů, 1 den u proběhlých. */
export const getEventCached = id => cachedOris("getEvent", { id: String(id) }, {
    transform: slimEvent,
    ttl: e => (e?.Date && e.Date < localToday() ? TTL.eventPast : TTL.eventUpcoming),
});

/** getCSOSClubList s cache na den. */
export const getClubsCached = () => cachedOris("getCSOSClubList", {}, {
    ttl: TTL.clubs,
    transform: data => mapValues(data, c => pick(c, ["ID", "Abbr", "Name"])),
});

/** Reg. číslo → UserID s cache na den (null = neexistuje, ukládá se jen na 10 min). */
export async function getUserIdCached(regNo) {
    const data = await cachedOris("getUser", { rgnum: regNo }, {
        transform: d => ({ ID: d?.ID || null }),
        ttl: d => (d.ID ? TTL.user : TTL.userNotFound),
    });
    return data.ID;
}

/** getEventList pro výběr závodu s cache na 30 min (jen pole potřebná pro roletku). */
export const getEventListCached = params => cachedOris("getEventList", params, {
    ttl: TTL.eventList,
    transform: data => Object.values(data || {}).map(e => ({
        ID: e.ID, Date: e.Date, Name: e.Name, Place: e.Place, Region: e.Region,
        Sport: { NameCZ: e.Sport?.NameCZ }, Org1: { Abbr: e.Org1?.Abbr },
        Discipline: { ShortName: e.Discipline?.ShortName }, Level: { ShortName: e.Level?.ShortName },
    })),
});
