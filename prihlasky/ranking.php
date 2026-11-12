<?php
declare(strict_types=1);

// ranking.php – prostředník pro export rankingu z ORIS.
// ORIS ranking_export neposílá hlavičku CORS, prohlížeč ho proto nemůže stáhnout přímo.
// Skript stáhne CSV, převede ho na JSON a uloží do cache (ORIS se pro stejné datum neptá opakovaně).
//
// GET ranking.php?date=YYYY-MM-DD&gender=M|F&ranktype=2|8
//   ranktype 2 = lesní ranking, 8 = sprintový ranking

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

const ORIS_RANKING_URL  = 'https://oris.ceskyorientak.cz/ranking_export';
const CACHE_TTL_PAST    = 30 * 86400;  // stav k minulému datu se už nemění
const CACHE_TTL_CURRENT = 6 * 3600;    // dnešní / budoucí datum = průběžný stav
const ALLOWED_TYPES     = [2, 8];

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

function fail(int $status, string $message): never
{
    http_response_code($status);
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

// --- vstup ------------------------------------------------------------------
$date     = (string) ($_GET['date'] ?? '');
$gender   = (string) ($_GET['gender'] ?? '');
$rankType = filter_var($_GET['ranktype'] ?? null, FILTER_VALIDATE_INT);

$dateObj = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
if (!$dateObj || $dateObj->format('Y-m-d') !== $date || $date < '2005-01-01' || $date > date('Y-m-d', strtotime('+2 years'))) {
    fail(400, 'Neplatné datum.');
}
if (!in_array($gender, ['M', 'F'], true)) {
    fail(400, 'Neplatné pohlaví (M nebo F).');
}
if (!in_array($rankType, ALLOWED_TYPES, true)) {
    fail(400, 'Neplatný typ rankingu (2 = lesní, 8 = sprintový).');
}

// --- cache ------------------------------------------------------------------
$cacheDir  = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'oinfo_ranking';
$cacheFile = $cacheDir . DIRECTORY_SEPARATOR . "{$date}_{$gender}_{$rankType}.json";
$ttl       = $date < date('Y-m-d') ? CACHE_TTL_PAST : CACHE_TTL_CURRENT;

function sendJson(string $json, int $maxAge): never
{
    header('Cache-Control: public, max-age=' . $maxAge);
    echo $json;
    exit;
}

if (is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    sendJson((string) file_get_contents($cacheFile), 3600);
}

// --- stažení z ORIS ---------------------------------------------------------
$url = ORIS_RANKING_URL . '?' . http_build_query([
    'date' => $date, 'sport' => 1, 'gender' => $gender, 'ranktype' => $rankType, 'csv' => 1,
]);
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_ENCODING       => '',
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_USERAGENT      => 'O-info-ranking/1.0',
]);
$csv      = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$curlErr  = curl_error($ch);

// --- převod CSV → JSON ------------------------------------------------------
$items = null;
if (is_string($csv) && $httpCode === 200) {
    $csv = preg_replace('/^\xEF\xBB\xBF/', '', $csv);
    if (!mb_check_encoding($csv, 'UTF-8')) {
        $csv = mb_convert_encoding($csv, 'UTF-8', 'Windows-1250');
    }
    $lines = preg_split('/\r\n|\n|\r/', trim($csv));
    // očekávaná hlavička: Poradi;Prijmeni;Jmeno;Reg. c.;Body;Rank.c;Minule Ran…
    if ($lines && stripos($lines[0], 'Poradi') === 0) {
        $items = [];
        foreach (array_slice($lines, 1) as $line) {
            $c = str_getcsv($line, ';', '"', '\\');
            if (count($c) < 6 || trim($c[3]) === '') {
                continue;
            }
            $items[] = [
                'rank'       => (int) $c[0],
                'lastName'   => trim($c[1]),
                'firstName'  => trim($c[2]),
                'regNo'      => strtoupper(trim($c[3])),
                'points'     => (int) $c[4],
                'rankNumber' => (int) $c[5],
            ];
        }
    }
}

if ($items === null) {
    error_log("ranking.php: ORIS selhal ({$url}): HTTP {$httpCode} {$curlErr}");
    // starší cache je lepší než nic
    if (is_file($cacheFile)) {
        sendJson((string) file_get_contents($cacheFile), 300);
    }
    fail(502, 'Ranking se nepodařilo načíst z ORIS.');
}

$json = json_encode([
    'date'     => $date,
    'gender'   => $gender,
    'ranktype' => $rankType,
    'fetched'  => date('c'),
    'items'    => $items,
], JSON_UNESCAPED_UNICODE);

if (is_dir($cacheDir) || @mkdir($cacheDir, 0775, true)) {
    $tmp = $cacheFile . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $json) !== false) {
        @rename($tmp, $cacheFile);
    }
}

sendJson($json, 3600);
