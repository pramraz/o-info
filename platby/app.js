'use strict';

// O-info – Platby: převod CSV výpisu z Fio banky na seznam plateb pro ORIS.
// Vše běží v prohlížeči, data se nikam neodesílají.

const HEADER_SCAN_ROWS = 30;   // hlavička nemusí být na 1. řádku (Fio přidává údaje o účtu)
// U zahraničních (SEPA, Revolut…) plateb bývá ve VS bankovní reference a skutečný VS
// je ve zprávě za "/URI/" (strukturovaná zpráva SWIFT/SEPA).
const URI_VS = /\/URI\/\s*(\d{6,})/;
const MIN_VALID_VS_LENGTH = 6;

/** Dekóduje soubor: UTF-8, a pokud to nejde, Windows-1250. */
function decodeFile(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1250').decode(buffer);
  }
  return text.replace(/^﻿/, '');
}

/** Oddělovač podle prvního neprázdného řádku (mimo uvozovky). */
function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ';';
}

/** CSV parser s podporou uvozovek, zdvojených uvozovek a zalomení řádku uvnitř hodnoty. */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cur.trim()); cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      rows.push(row); row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

const normalizeHeader = h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/["'#]/g, '').trim();

/** Najde řádek hlavičky a indexy sloupců. Vrací null, pokud to nevypadá jako výpis z Fio. */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const h = rows[r].map(normalizeHeader);
    const find = pred => h.findIndex(pred);
    const cols = {
      date: find(x => x === 'datum' || x.startsWith('datum ')),
      amount: find(x => x === 'objem' || x.startsWith('objem ')),
      vs: find(x => x === 'vs' || x.includes('variabilni')),
      message: find(x => x.startsWith('zprava pro prijemce')),
      note: find(x => x === 'poznamka'),
    };
    if (cols.date !== -1 && cols.amount !== -1) {
      return { headerRow: r, cols };
    }
  }
  return null;
}

/** "3.5.2025", "03.05.2025 10:15" nebo "2025-05-03" → "2025-05-03"; jinak null. */
function parseDate(value) {
  const s = (value || '').trim();
  let m = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  let y, mo, d;
  if (m) { [, d, mo, y] = m; } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) { [, y, mo, d] = m; } else { return null; }
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1 234,50", "1234.5", "1.234,50" → číslo; jinak NaN. */
function parseAmount(value) {
  let s = (value || '').replace(/[\s ]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return /^[-+]?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Text do výstupu: bez středníků a zalomení (rozbily by formát pro ORIS). */
const cleanText = s => (s || '').replace(/[;\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

const formatAmount = n => String(Math.round(n * 100) / 100);

/**
 * Hlavní zpracování. Vrací { valid, suspicious, stats } nebo vyhodí Error s českou zprávou.
 * @param {string} text obsah CSV
 * @param {{fromDate?: string, vsPrefix: string}} options fromDate ve formátu YYYY-MM-DD
 */
function processStatement(text, { fromDate = '', vsPrefix }) {
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const header = findHeader(rows);
  if (!header) {
    throw new Error('V souboru jsem nenašel hlavičku výpisu z Fio banky (sloupce Datum a Objem).');
  }
  const { cols } = header;
  // Sloupce exportu si ve Fio volí uživatel – bez VS nelze nic přiřadit do ORISu.
  const missingVs = cols.vs === -1;
  const result = { valid: [], suspicious: [] };
  const stats = { processed: 0, outgoing: 0, beforeDate: 0, unreadable: 0, duplicates: 0, vsFromMessage: 0 };
  const seen = new Set();

  for (const row of rows.slice(header.headerRow + 1)) {
    if (!row.some(c => c !== '')) continue;

    const date = parseDate(row[cols.date]);
    const amount = parseAmount(row[cols.amount]);
    if (!date || Number.isNaN(amount)) { stats.unreadable++; continue; }
    if (amount <= 0) { stats.outgoing++; continue; }
    if (fromDate && date < fromDate) { stats.beforeDate++; continue; }

    const vs = (missingVs ? '' : row[cols.vs] || '').replace(/\s/g, '').replace(/^0+(?=\d)/, '');
    const message = cleanText(row[cols.message] || '') || cleanText(row[cols.note] || '');
    const isValidVs = v => /^\d+$/.test(v) && v.startsWith(vsPrefix) && v.length >= MIN_VALID_VS_LENGTH;
    const amountStr = formatAmount(amount);
    stats.processed++;

    // Neplatný VS → zkusíme ho dohledat ve zprávě za /URI/; původní VS necháme ve zprávě pro kontrolu.
    let finalVs = vs;
    let finalMessage = message;
    if (!isValidVs(vs)) {
      const candidate = (message.match(URI_VS) || [])[1];
      if (candidate && isValidVs(candidate)) {
        finalVs = candidate;
        finalMessage = cleanText(`${message} (VS doplněn ze zprávy, VS v bance: ${vs || 'prázdný'})`);
        stats.vsFromMessage++;
      }
    }

    const line = `${date};${finalVs};${amountStr};;${finalMessage}`;
    if (isValidVs(finalVs)) {
      const key = `${date};${finalVs};${amountStr}`;
      if (seen.has(key)) stats.duplicates++;
      seen.add(key);
      result.valid.push(line);
    } else {
      result.suspicious.push(line);
    }
  }
  return { ...result, stats: { ...stats, missingVs } };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const info = $('debugInfo');

    const showInfo = (html, type = 'info') => {
      info.className = `alert alert-${type} mt-3 mb-0`;
      info.innerHTML = html;
      info.hidden = false;
    };

    const clearOutputs = () => {
      ['validOutput', 'suspiciousOutput'].forEach(id => { $(id).value = ''; });
      info.hidden = true;
    };

    $('fileInput').addEventListener('change', clearOutputs);

    $('processBtn').addEventListener('click', async () => {
      const file = $('fileInput').files[0];
      const vsPrefix = $('vsPrefix').value.trim();
      if (!file) { showInfo('Nejprve vyberte soubor s výpisem.', 'warning'); return; }
      if (!/^\d{2,}$/.test(vsPrefix)) { showInfo('Začátek VS musí být alespoň dvouciferné číslo.', 'warning'); return; }

      try {
        const text = decodeFile(await file.arrayBuffer());
        const { valid, suspicious, stats } = processStatement(text, { fromDate: $('fromDate').value, vsPrefix });

        $('validOutput').value = valid.join('\n');
        $('suspiciousOutput').value = suspicious.join('\n');

        const notes = [];
        if (stats.beforeDate) notes.push(`před zvoleným datem: ${stats.beforeDate}`);
        if (stats.outgoing) notes.push(`odchozí platby: ${stats.outgoing}`);
        if (stats.unreadable) notes.push(`nečitelné řádky: ${stats.unreadable}`);
        const missingVs = stats.missingVs
          ? '<div class="mt-1">⚠️ Výpis neobsahuje sloupec <b>VS</b>, takže všechny platby jsou mezi podezřelými. Při exportu z Fio zapněte sloupec VS.</div>'
          : '';
        const fromMsg = stats.vsFromMessage
          ? `<div class="mt-1">ℹ️ U ${stats.vsFromMessage} plateb byl VS doplněn ze zprávy (zahraniční platby) – v seznamu pro ORIS jsou označené „VS doplněn ze zprávy“, zkontrolujte je.</div>`
          : '';
        const dup = stats.duplicates
          ? `<div class="mt-1">⚠️ V platbách pro ORIS se ${stats.duplicates}× opakuje stejné datum + VS + částka – zkontrolujte, zda nejde o duplicitu.</div>`
          : '';
        showInfo(
          `<strong>Zpracováno plateb:</strong> ${stats.processed} &nbsp;|&nbsp; ` +
          `<strong>ORIS:</strong> <span class="badge bg-success">${valid.length}</span> &nbsp;|&nbsp; ` +
          `<strong>Podezřelé:</strong> <span class="badge bg-warning text-dark">${suspicious.length}</span>` +
          (notes.length ? `<div class="small text-muted mt-1">Přeskočeno – ${notes.join(', ')}</div>` : '') + missingVs + fromMsg + dup,
          stats.duplicates || stats.unreadable || stats.missingVs ? 'warning' : 'info'
        );
      } catch (error) {
        clearOutputs();
        showInfo(error.message, 'danger');
      }
    });

    document.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const textarea = $(btn.dataset.copy);
        try {
          await navigator.clipboard.writeText(textarea.value);
        } catch {
          textarea.select();
          document.execCommand('copy');
        }
        const original = btn.innerHTML;
        btn.innerHTML = '✓ Zkopírováno';
        btn.disabled = true;
        setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1500);
      });
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = { decodeFile, detectDelimiter, parseCsv, findHeader, parseDate, parseAmount, processStatement };
}
