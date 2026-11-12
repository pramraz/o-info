<?php
declare(strict_types=1);

use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use PhpOffice\PhpSpreadsheet\Cell\DataType;
use PhpOffice\PhpSpreadsheet\Shared\Date as ExcelDate;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;

// api.php – výpočet dluhů členů klubu (startovné, služby) z ORIS API a export do XLSX.

// PHP warnings nesmí skončit uvnitř XLSX odpovědi – jen se logují.
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
ini_set('memory_limit', '256M');
set_time_limit(120);

// ---------------------------------------------------------------------------
// KONFIGURACE
// ---------------------------------------------------------------------------
const ORIS_API_URL      = 'https://oris.ceskyorientak.cz/API/';
const ORIS_EVENT_URL    = 'https://oris.ceskyorientak.cz/Zavod?id=';
const MAX_RANGE_DAYS    = 400;   // ochrana proti dotazům přes několik let
const HTTP_CONCURRENCY  = 8;     // max. souběžných požadavků na ORIS
const HTTP_RETRIES      = 2;     // počet opakování neúspěšného požadavku
const RELAY_DISCIPLINES = ['RE', 'TE', 'SR'];
const ORIS_SPORTS       = '1,2,3'; // 1 = OB, 2 = LOB, 3 = MTBO

// Registrační čísla, kterým se neúčtuje navýšení startovného (pozdní přihláška).
const LATE_FEE_EXEMPT_REGNOS = ['SJC8102'];

// ---------------------------------------------------------------------------
// POMOCNÉ FUNKCE
// ---------------------------------------------------------------------------
function sendJsonError(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function parseIsoDate(mixed $value): ?DateTimeImmutable
{
    if (!is_string($value)) {
        return null;
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    return ($date && $date->format('Y-m-d') === $value) ? $date : null;
}

/** ORIS vrací prázdný seznam jako [] i jako "" / null – sjednotíme na pole. */
function asList(mixed $data): array
{
    return is_array($data) ? $data : [];
}

/** Ověří odpověď ORIS; vrací chybový text, nebo null a naplní $data. */
function decodeOrisResponse(CurlHandle $ch, int $curlResult, mixed &$data): ?string
{
    if ($curlResult !== CURLE_OK) {
        return curl_strerror($curlResult);
    }
    $httpCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($httpCode !== 200) {
        return 'HTTP ' . $httpCode;
    }
    $json = json_decode((string) curl_multi_getcontent($ch), true);
    if (!is_array($json)) {
        return 'neplatná JSON odpověď';
    }
    if (($json['Status'] ?? '') !== 'OK') {
        return 'ORIS: ' . (string) ($json['Status'] ?? 'neznámý stav');
    }
    $data = $json['Data'] ?? [];
    return null;
}

/**
 * Stáhne více ORIS požadavků souběžně (klouzavé okno HTTP_CONCURRENCY,
 * gzip, opakování při chybě). Vrací [výsledky podle klíče, chyby podle klíče].
 * Při $stopOnError skončí po první definitivně neúspěšné položce.
 *
 * @param array<string, array<string, scalar>> $requests klíč => parametry dotazu
 */
function orisFetchAll(array $requests, bool $stopOnError = true): array
{
    $results = [];
    $errors  = [];
    $queue   = [];
    foreach ($requests as $key => $params) {
        $queue[] = [$key, $params, 0];
    }

    $mh       = curl_multi_init();
    $inFlight = [];

    $startNext = static function () use (&$queue, &$inFlight, $mh): void {
        while ($queue && count($inFlight) < HTTP_CONCURRENCY) {
            [$key, $params, $attempt] = array_shift($queue);
            $ch = curl_init(ORIS_API_URL . '?' . http_build_query(['format' => 'json'] + $params));
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_ENCODING       => '',      // přijme gzip/deflate – výrazně menší přenos
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT        => 30,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_USERAGENT      => 'O-info-dluhy/2.0',
                CURLOPT_HTTPHEADER     => ['Accept: application/json'],
            ]);
            curl_multi_add_handle($mh, $ch);
            $inFlight[spl_object_id($ch)] = [$key, $params, $attempt, $ch];
        }
    };

    $startNext();
    while ($inFlight) {
        $status = curl_multi_exec($mh, $running);
        if ($status !== CURLM_OK) {
            $errors['curl_multi'] = curl_multi_strerror($status);
            break;
        }

        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            $id = spl_object_id($ch);
            [$key, $params, $attempt] = $inFlight[$id];
            unset($inFlight[$id]);

            $data  = null;
            $error = decodeOrisResponse($ch, (int) $info['result'], $data);
            curl_multi_remove_handle($mh, $ch);

            if ($error === null) {
                $results[$key] = $data;
            } elseif ($attempt < HTTP_RETRIES) {
                usleep(300000 * ($attempt + 1));
                $queue[] = [$key, $params, $attempt + 1];
            } else {
                $errors[$key] = $error;
            }
        }

        if ($errors && $stopOnError) {
            break;
        }
        $startNext();
        if ($inFlight && curl_multi_select($mh, 1.0) === -1) {
            usleep(10000);
        }
    }

    foreach ($inFlight as [, , , $ch]) {
        curl_multi_remove_handle($mh, $ch);
    }
    curl_multi_close($mh);

    return [$results, $errors];
}

/**
 * Štafety přihlášené, ale bez výsledku (= zbytečně zaplacené startovné, k prověření).
 * Tým se považuje za odstartovaný, pokud ve výsledcích (mimo DNS) je některý jeho úsekář,
 * nebo tým se stejným názvem ve stejné kategorii.
 */
function findRelaysWithoutResult(array $event, array $entries, array $results, array &$warnings): array
{
    if (!$results) {
        $warnings[] = [$event, 'Štafety: v ORIS nejsou výsledky klubu – přihlášky štafet nebyly zkontrolovány.'];
        return [];
    }

    $teamKey = static fn(mixed $class, mixed $name): string
        => mb_strtolower(trim((string) $class)) . '|' . mb_strtolower(trim((string) $name));

    $startedRunners = [];
    $startedTeams   = [];
    foreach ($results as $res) {
        if (!is_array($res) || strtoupper(trim((string) ($res['Time'] ?? ''))) === 'DNS') {
            continue;
        }
        if (($res['RegNo'] ?? '') !== '') {
            $startedRunners[(string) $res['RegNo']] = true;
        }
        foreach (['TeamName', 'Name'] as $nameField) {
            if (($res[$nameField] ?? '') !== '') {
                $startedTeams[$teamKey($res['ClassID'] ?? '', $res[$nameField])]   = true;
                $startedTeams[$teamKey($res['ClassDesc'] ?? '', $res[$nameField])] = true;
            }
        }
    }

    $issues = [];
    foreach ($entries as $team) {
        if (!is_array($team)) {
            continue;
        }
        $started = isset($startedTeams[$teamKey($team['ClassID'] ?? '', $team['Name'] ?? '')])
            || isset($startedTeams[$teamKey($team['ClassDesc'] ?? '', $team['Name'] ?? '')]);
        $runners = [];
        foreach (asList($team['Legs'] ?? []) as $leg) {
            $runners[] = trim((string) ($leg['Name'] ?? $leg['RegNo'] ?? '?'));
            if (isset($startedRunners[(string) ($leg['RegNo'] ?? '')])) {
                $started = true;
            }
        }
        if (!$started) {
            $issues[] = [
                'event'   => $event,
                'class'   => (string) ($team['ClassDesc'] ?? ''),
                'team'    => (string) ($team['Name'] ?? ''),
                'fee'     => (float) ($team['Fee'] ?? 0),
                'runners' => $runners ? implode(', ', $runners) : '(bez obsazených úseků)',
            ];
        }
    }
    return $issues;
}

function formatErrors(array $errors, int $limit = 10): string
{
    $parts = [];
    foreach (array_slice($errors, 0, $limit, true) as $key => $message) {
        $parts[] = "{$key} ({$message})";
    }
    return implode('; ', $parts);
}

// ---------------------------------------------------------------------------
// VSTUP
// ---------------------------------------------------------------------------
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    sendJsonError(405, 'Povolena je pouze metoda POST.');
}

$autoloadFile = __DIR__ . '/vendor/autoload.php';
if (!is_file($autoloadFile)) {
    sendJsonError(500, 'Chybí vendor/autoload.php. Na hostingu nahrajte celou složku vendor.');
}
require_once $autoloadFile;

if (!class_exists(Spreadsheet::class)) {
    sendJsonError(500, 'PhpSpreadsheet se nepodařilo načíst. Zkontrolujte PHP verzi (8.1+) a rozšíření zip, xml, mbstring a gd.');
}

$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) {
    sendJsonError(400, 'Neplatný požadavek.');
}

$clubId   = filter_var($input['clubId'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
$dateFrom = parseIsoDate($input['dateFrom'] ?? null);
$dateTo   = parseIsoDate($input['dateTo'] ?? null);

if ($clubId === false || !$dateFrom || !$dateTo) {
    sendJsonError(400, 'Chybějící nebo neplatné povinné parametry (klub, datum od/do).');
}
if ($dateFrom > $dateTo) {
    sendJsonError(400, 'Datum „od“ musí být před datem „do“.');
}
if ($dateFrom->diff($dateTo)->days > MAX_RANGE_DAYS) {
    sendJsonError(400, 'Období může mít nejvýše ' . MAX_RANGE_DAYS . ' dní.');
}

$selectedLevels = array_fill_keys(array_filter((array) ($input['levels'] ?? []), 'is_string'), true);
$servicesAll    = ($input['servicesRule'] ?? 'all') !== 'selected';
$lateFeeRule    = !empty($input['lateFeeRule']);
$absenceRule    = !empty($input['absenceRule']);
$today          = (new DateTimeImmutable('today'))->format('Y-m-d');
$warnings       = [];

// ---------------------------------------------------------------------------
// 1) SEZNAM ZÁVODŮ – myClubId vrací i počty přihlášek/služeb/výsledků klubu,
//    takže detaily stahujeme jen tam, kde klub něco má.
// ---------------------------------------------------------------------------
[$listData, $listErrors] = orisFetchAll(['events' => [
    'method'   => 'getEventList',
    'sport'    => ORIS_SPORTS,
    'all'      => 1,   // i akce mimo oficiální kalendář (ZL, OST, SEM, …)
    'datefrom' => $dateFrom->format('Y-m-d'),
    'dateto'   => $dateTo->format('Y-m-d'),
    'myClubId' => $clubId,
]]);
if ($listErrors) {
    sendJsonError(502, 'Nepodařilo se načíst seznam závodů z ORIS: ' . formatErrors($listErrors));
}

/** Počet z ORIS; null = údaj chybí (pak se raději stáhne). */
$countOf = static fn(array $ev, string $field): ?int => isset($ev[$field]) ? (int) $ev[$field] : null;

$events = [];
foreach (asList($listData['events']) as $ev) {
    if (!is_array($ev) || !isset($ev['ID'])) {
        continue;
    }
    $id = (int) $ev['ID'];
    $event = [
        'id'           => $id,
        'name'         => (string) ($ev['Name'] ?? ''),
        'date'         => (string) ($ev['Date'] ?? ''),
        'level'        => $ev['Level']['ShortName'] ?? 'OST',
        'discipline'   => $ev['Discipline']['ShortName'] ?? '',
        'sport'        => (string) ($ev['Sport']['NameCZ'] ?? ''),
        'parentId'     => (int) ($ev['ParentID'] ?? 0),
        'entryCount'   => $countOf($ev, 'ClubEntryCount'),
        'serviceCount' => $countOf($ev, 'ClubServiceEntryCount'),
        'resultCount'  => $countOf($ev, 'ClubResultCount'),
    ];
    if ((int) ($ev['Cancelled'] ?? 0) !== 0) {
        if ($event['entryCount'] || $event['serviceCount']) {
            $warnings[] = [$event, 'Závod je v ORIS zrušen – přihlášky a služby nebyly započítány.'];
        }
        continue;
    }
    $events[$id] = $event;
}

if (!$events) {
    sendJsonError(404, 'V zadaném období nebyly nalezeny žádné závody.');
}

uasort($events, static fn(array $a, array $b): int => [$a['date'], $a['id']] <=> [$b['date'], $b['id']]);

// Etapy vícedenních závodů: startovné je u nadřazené akce, výsledky u etap.
$stagesOf = [];
foreach ($events as $id => $ev) {
    if ($ev['parentId'] && isset($events[$ev['parentId']])) {
        $stagesOf[$ev['parentId']][] = $id;
    }
}
foreach ($events as $id => &$ev) {
    $ev['isRelay'] = in_array($ev['discipline'], RELAY_DISCIPLINES, true);
    $ev['isStage'] = $ev['parentId'] && isset($events[$ev['parentId']]);
}
unset($ev);

// ---------------------------------------------------------------------------
// 2) DETAILY – jen pro závody, kde je to potřeba
// ---------------------------------------------------------------------------
$requests = [];
foreach ($events as $id => $ev) {
    $isSelected = isset($selectedLevels[$ev['level']]);
    $hasEntries = $ev['entryCount'] !== 0;

    // Štafety: dluhy se nepočítají (startovné je za tým), jen se hlídají týmy bez výsledku.
    if ($ev['isRelay'] && $hasEntries) {
        $requests["entries_{$id}"] = ['method' => 'getEventEntries', 'eventid' => $id, 'clubid' => $clubId];
        if ($ev['date'] <= $today && $ev['resultCount'] !== 0) {
            $requests["results_{$id}"] = ['method' => 'getEventResults', 'eventid' => $id, 'clubid' => $clubId];
        }
    }

    if (!$ev['isRelay'] && $hasEntries) {
        $requests["entries_{$id}"] = ['method' => 'getEventEntries', 'eventid' => $id, 'clubid' => $clubId];

        // Navýšení a absence se řeší jen u nevybraných úrovní (u vybraných se platí celé startovné).
        if (!$isSelected && $lateFeeRule) {
            $requests["eventInfo_{$id}"] = ['method' => 'getEvent', 'id' => $id];
        }
        if (!$isSelected && $absenceRule && $ev['date'] <= $today) {
            foreach ($stagesOf[$id] ?? [$id] as $resultEventId) {
                if ($events[$resultEventId]['resultCount'] !== 0) {
                    $requests["results_{$resultEventId}"] = ['method' => 'getEventResults', 'eventid' => $resultEventId, 'clubid' => $clubId];
                }
            }
        }
    }
    if ($ev['serviceCount'] !== 0 && ($servicesAll || $isSelected)) {
        $requests["services_{$id}"] = ['method' => 'getEventServiceEntries', 'eventid' => $id, 'clubid' => $clubId];
    }
}

[$fetched, $fetchErrors] = orisFetchAll($requests);

// Druhá fáze: cena půjčovného čipu je jen v getEvent – stahujeme ho tam, kde si někdo čip půjčil
// (u etap se půjčovné účtuje jen jednou, u nadřazené akce).
if (!$fetchErrors) {
    $rentRequests = [];
    foreach ($events as $id => $ev) {
        if ($ev['isRelay'] || $ev['isStage'] || isset($fetched["eventInfo_{$id}"])
            || !($servicesAll || isset($selectedLevels[$ev['level']]))) {
            continue;
        }
        foreach (asList($fetched["entries_{$id}"] ?? []) as $entry) {
            if ((int) ($entry['RentSI'] ?? 0) === 1) {
                $rentRequests["eventInfo_{$id}"] = ['method' => 'getEvent', 'id' => $id];
                break;
            }
        }
    }
    if ($rentRequests) {
        [$rentData, $fetchErrors] = orisFetchAll($rentRequests);
        $fetched += $rentData;
    }
}
if ($fetchErrors) {
    sendJsonError(502, 'Nepodařilo se načíst všechny detaily z ORIS. Export nebyl vytvořen, aby neobsahoval neúplná data: ' . formatErrors($fetchErrors));
}

// ---------------------------------------------------------------------------
// 3) VÝPOČET DLUHŮ
// ---------------------------------------------------------------------------
$members            = [];   // regNo => ['regNo', 'debts' => [eventId => Kč], 'details' => [], 'total']
$names              = [];   // regNo => "Příjmení Jméno"
$activeEventsWithDebt = []; // eventId => true (pořadí = pořadí závodů)

$addDebt = static function (string $regNo, array $event, string $reason, float $amount)
    use (&$members, &$activeEventsWithDebt): void {
    $members[$regNo] ??= ['regNo' => $regNo, 'debts' => [], 'details' => [], 'total' => 0.0];
    $members[$regNo]['debts'][$event['id']] = ($members[$regNo]['debts'][$event['id']] ?? 0) + $amount;
    $members[$regNo]['total'] += $amount;
    $members[$regNo]['details'][] = ['event' => $event, 'reason' => $reason, 'amount' => $amount];
    $activeEventsWithDebt[$event['id']] = true;
};

$relayIssues = [];   // přihlášené štafety bez výsledku

foreach ($events as $id => $event) {
    $isSelected = isset($selectedLevels[$event['level']]);
    $entries    = asList($fetched["entries_{$id}"] ?? []);

    if ($event['isRelay']) {
        if ($entries && $event['date'] <= $today) {
            $relayIssues = array_merge($relayIssues, findRelaysWithoutResult(
                $event, $entries, asList($fetched["results_{$id}"] ?? []), $warnings));
        }
        continue;
    }

    // Půjčovné čipu – účtuje se stejně jako doplňkové služby.
    $rentFee = (!$event['isStage'] && ($servicesAll || $isSelected))
        ? (float) ($fetched["eventInfo_{$id}"]['EntryRentSIFee'] ?? 0)
        : 0.0;

    // Základní startovné podle kategorie (pro výpočet navýšení).
    $classBaseFees = [];
    foreach (asList($fetched["eventInfo_{$id}"]['Classes'] ?? []) as $class) {
        if (isset($class['ID'])) {
            $classBaseFees[(string) $class['ID']] = (float) ($class['Fee'] ?? 0);
        }
    }

    // Kdo skutečně startoval (DNS = nestartoval). U etapových závodů stačí start v kterékoli etapě.
    $checkAbsence = false;
    $attended     = [];
    if (!$isSelected && $absenceRule && $entries) {
        if ($event['date'] > $today) {
            // budoucí závod – absenci nelze posoudit
        } else {
            $hasResults = false;
            foreach ($stagesOf[$id] ?? [$id] as $resultEventId) {
                foreach (asList($fetched["results_{$resultEventId}"] ?? []) as $res) {
                    $hasResults = true;
                    $regNo = (string) ($res['RegNo'] ?? '');
                    if ($regNo !== '' && strtoupper(trim((string) ($res['Time'] ?? ''))) !== 'DNS') {
                        $attended[$regNo] = true;
                    }
                }
            }
            $checkAbsence = $hasResults;
            if (!$hasResults) {
                $warnings[] = [$event, 'V ORIS nejsou výsledky klubu – absence nebyla vyhodnocena.'];
            }
        }
    }

    foreach ($entries as $entry) {
        $regNo = (string) ($entry['RegNo'] ?? '');
        if ($regNo === '') {
            continue;
        }
        $names[$regNo] ??= trim((string) ($entry['Name'] ?? ''));

        if ($rentFee > 0 && (int) ($entry['RentSI'] ?? 0) === 1) {
            // U etapových závodů ORIS účtuje půjčovné za každou přihlášenou etapu.
            $stageCount = isset($entry['Stages']) && is_array($entry['Stages'])
                ? count(array_filter($entry['Stages'], static fn($v): bool => (int) $v === 1))
                : 1;
            $stageCount = max(1, $stageCount);
            $addDebt($regNo, $event, $stageCount > 1 ? "Půjčení čipu ({$stageCount} etapy)" : 'Půjčení čipu', $rentFee * $stageCount);
        }

        $fee = (float) ($entry['Fee'] ?? 0);
        if ($fee <= 0) {
            continue;
        }

        if ($isSelected) {
            $addDebt($regNo, $event, 'Plné startovné', $fee);
        } elseif ($checkAbsence && !isset($attended[$regNo])) {
            $addDebt($regNo, $event, 'Absence na závodě (propadlé startovné)', $fee);
        } elseif ($lateFeeRule && !in_array($regNo, LATE_FEE_EXEMPT_REGNOS, true)) {
            $classId = (string) ($entry['ClassID'] ?? '');
            if (isset($classBaseFees[$classId]) && $fee > $classBaseFees[$classId]) {
                $addDebt($regNo, $event, 'Navýšení startovného (pozdní přihláška)', $fee - $classBaseFees[$classId]);
            }
        }
    }

    foreach (asList($fetched["services_{$id}"] ?? []) as $service) {
        $regNo = (string) ($service['RegNo'] ?? '');
        $fee   = (float) ($service['TotalFee'] ?? 0);
        if ($regNo === '' || $fee <= 0) {
            continue;
        }
        $serviceName = $service['Service']['NameCZ'] ?? $service['Service']['NameEN'] ?? '';
        $quantity    = $service['Quantity'] ?? 1;
        $reason      = $serviceName !== ''
            ? "Doplňková služba ({$serviceName} - {$quantity}x)"
            : "Doplňková služba ({$quantity}x)";
        $addDebt($regNo, $event, $reason, $fee);
    }
}

// Jména členů, kteří mají jen služby a žádnou přihlášku (nekritické – při chybě zůstane reg. číslo).
$missingNames = [];
foreach (array_keys($members) as $regNo) {
    if (($names[$regNo] ?? '') === '') {
        $missingNames["user_{$regNo}"] = ['method' => 'getUser', 'rgnum' => $regNo];
    }
}
if ($missingNames) {
    [$users] = orisFetchAll($missingNames, false);
    foreach ($users as $key => $user) {
        $names[substr($key, 5)] = trim(($user['LastName'] ?? '') . ' ' . ($user['FirstName'] ?? ''));
    }
}
foreach ($members as $regNo => &$member) {
    $member['name'] = ($names[$regNo] ?? '') !== '' ? $names[$regNo] : $regNo;
}
unset($member);

// Řazení podle jména (česká abeceda).
if (class_exists(Collator::class)) {
    $collator = new Collator('cs_CZ');
    uasort($members, static fn(array $a, array $b): int => $collator->compare($a['name'], $b['name']) ?: strcmp($a['regNo'], $b['regNo']));
} else {
    setlocale(LC_COLLATE, 'cs_CZ.UTF-8', 'cs_CZ', 'czech');
    uasort($members, static fn(array $a, array $b): int => strcoll($a['name'], $b['name']) ?: strcmp($a['regNo'], $b['regNo']));
}

// ---------------------------------------------------------------------------
// 4) EXCEL
// ---------------------------------------------------------------------------
function excelDate(string $isoDate): float|string
{
    $date  = parseIsoDate($isoDate);
    $value = $date ? ExcelDate::PHPToExcel($date) : false;
    return $value === false ? $isoDate : $value;
}

/** Tučná hlavička, ukotvení, filtr a šířky sloupců (automaticky jen prvních $autoSizeCols). */
function finishSheet(Worksheet $sheet, int $lastRow, int $lastCol, ?int $autoSizeCols = null): void
{
    $lastColStr = Coordinate::stringFromColumnIndex($lastCol);
    $sheet->getStyle("A1:{$lastColStr}1")->getFont()->setBold(true);
    $sheet->freezePane('A2');
    if ($lastRow > 1) {
        $sheet->setAutoFilter("A1:{$lastColStr}{$lastRow}");
    }
    for ($col = 1; $col <= ($autoSizeCols ?? $lastCol); $col++) {
        $sheet->getColumnDimension(Coordinate::stringFromColumnIndex($col))->setAutoSize(true);
    }
}

$spreadsheet = new Spreadsheet();
$moneyFormat = '#,##0';

// List 1: přehled (člen × závod)
$sheet1 = $spreadsheet->getActiveSheet();
$sheet1->setTitle('Přehled dluhů');

$eventIds = array_keys($activeEventsWithDebt);
$header   = ['Jméno a příjmení', 'Reg. číslo', 'CELKEM DLUH (Kč)'];
foreach ($eventIds as $eventId) {
    $ev = $events[$eventId];
    $date = parseIsoDate($ev['date']);
    $sportTag = ($ev['sport'] !== '' && $ev['sport'] !== 'OB') ? "[{$ev['sport']}] " : '';
    $header[] = ($date ? $date->format('j.n.Y') . ' ' : '') . $sportTag . $ev['name'];
}
$rows = [$header];
foreach ($members as $m) {
    $row = [$m['name'], $m['regNo'], $m['total']];
    foreach ($eventIds as $eventId) {
        $row[] = $m['debts'][$eventId] ?? null;
    }
    $rows[] = $row;
}
$rows[] = array_merge(['CELKEM', null, array_sum(array_column($members, 'total'))],
    array_map(static fn(int $eventId): float => array_sum(array_map(
        static fn(array $m): float => $m['debts'][$eventId] ?? 0, $members)), $eventIds));

$sheet1->fromArray($rows, null, 'A1', true);
$lastRow1 = count($rows);
$lastCol1 = count($header);
$sheet1->getStyle('C2:' . Coordinate::stringFromColumnIndex($lastCol1) . $lastRow1)->getNumberFormat()->setFormatCode($moneyFormat);
$sheet1->getStyle("A{$lastRow1}:" . Coordinate::stringFromColumnIndex($lastCol1) . $lastRow1)->getFont()->setBold(true);
finishSheet($sheet1, $lastRow1 - 1, $lastCol1, 3);   // filtr bez řádku součtů
if ($lastCol1 > 3) {
    // Sloupce závodů: pevná šířka a zalomený název místo extrémně širokých sloupců.
    for ($col = 4; $col <= $lastCol1; $col++) {
        $sheet1->getColumnDimension(Coordinate::stringFromColumnIndex($col))->setWidth(16);
    }
    $sheet1->getStyle('D1:' . Coordinate::stringFromColumnIndex($lastCol1) . '1')->getAlignment()->setWrapText(true)->setVertical('top');
}

// List 2: detailní rozpis
$sheet2 = $spreadsheet->createSheet();
$sheet2->setTitle('Detailní rozpis položek');
$sheet2->fromArray(['Jméno', 'Reg. číslo', 'ORIS ID', 'Datum', 'Sport', 'Závod', 'Důvod', 'Částka (Kč)'], null, 'A1');

$row2 = 2;
foreach ($members as $m) {
    foreach ($m['details'] as $detail) {
        $ev = $detail['event'];
        $sheet2->fromArray([$m['name'], $m['regNo'], null, excelDate($ev['date']), $ev['sport'], $ev['name'], $detail['reason'], $detail['amount']], null, "A{$row2}", true);
        $sheet2->setCellValueExplicit("C{$row2}", (string) $ev['id'], DataType::TYPE_STRING);
        $sheet2->getCell("C{$row2}")->getHyperlink()->setUrl(ORIS_EVENT_URL . $ev['id'])->setTooltip('Otevřít závod v ORIS');
        $row2++;
    }
}
$lastRow2 = $row2 - 1;
if ($lastRow2 >= 2) {
    $sheet2->getStyle("C2:C{$lastRow2}")->getFont()->setUnderline(true)->getColor()->setARGB('FF0000FF');
    $sheet2->getStyle("D2:D{$lastRow2}")->getNumberFormat()->setFormatCode('d.m.yyyy');
    $sheet2->getStyle("H2:H{$lastRow2}")->getNumberFormat()->setFormatCode($moneyFormat);
}
finishSheet($sheet2, $lastRow2, 8);

// List: štafety přihlášené, ale bez výsledku (k analýze – dluh se z nich nepočítá)
if ($relayIssues) {
    $sheetR = $spreadsheet->createSheet();
    $sheetR->setTitle('Štafety bez výsledku');
    $sheetR->fromArray(['ORIS ID', 'Datum', 'Sport', 'Závod', 'Kategorie', 'Tým', 'Startovné (Kč)', 'Úsekáři v přihlášce'], null, 'A1');
    $rowR = 2;
    foreach ($relayIssues as $issue) {
        $ev = $issue['event'];
        $sheetR->fromArray([null, excelDate($ev['date']), $ev['sport'], $ev['name'], $issue['class'], $issue['team'], $issue['fee'], $issue['runners']], null, "A{$rowR}", true);
        $sheetR->setCellValueExplicit("A{$rowR}", (string) $ev['id'], DataType::TYPE_STRING);
        $sheetR->getCell("A{$rowR}")->getHyperlink()->setUrl(ORIS_EVENT_URL . $ev['id']);
        $rowR++;
    }
    $sheetR->getStyle('B2:B' . ($rowR - 1))->getNumberFormat()->setFormatCode('d.m.yyyy');
    $sheetR->getStyle('G2:G' . ($rowR - 1))->getNumberFormat()->setFormatCode($moneyFormat);
    finishSheet($sheetR, $rowR - 1, 8);
}

// List 3: upozornění (závody, kde výpočet nemusí být úplný)
if ($warnings) {
    $sheet3 = $spreadsheet->createSheet();
    $sheet3->setTitle('Upozornění');
    $sheet3->fromArray(['ORIS ID', 'Datum', 'Závod', 'Upozornění'], null, 'A1');
    $row3 = 2;
    foreach ($warnings as [$ev, $message]) {
        $sheet3->fromArray([(string) $ev['id'], excelDate($ev['date']), $ev['name'], $message], null, "A{$row3}", true);
        $sheet3->getCell("A{$row3}")->getHyperlink()->setUrl(ORIS_EVENT_URL . $ev['id']);
        $row3++;
    }
    $sheet3->getStyle('B2:B' . ($row3 - 1))->getNumberFormat()->setFormatCode('d.m.yyyy');
    finishSheet($sheet3, $row3 - 1, 4);
}

$spreadsheet->setActiveSheetIndex(0);

$fileName = sprintf('Dluhy_ORIS_%s_%s.xlsx', $dateFrom->format('Y-m-d'), $dateTo->format('Y-m-d'));
header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
header('Content-Disposition: attachment; filename="' . $fileName . '"');
header('Cache-Control: no-store');
header('X-Warnings-Count: ' . count($warnings));
header('X-Relay-Issues-Count: ' . count($relayIssues));
(new Xlsx($spreadsheet))->save('php://output');
exit;
