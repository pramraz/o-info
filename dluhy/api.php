<?php
// api.php - Backend pro zpracování dluhů z ORIS API a generování Excelu

// PHP warnings must not be written into an XLSX response. They are logged instead.
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
ini_set('memory_limit', '256M');
set_time_limit(120);

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

function sendJsonError(int $status, string $message): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

$autoloadFile = __DIR__ . '/vendor/autoload.php';
if (!file_exists($autoloadFile)) {
    sendJsonError(500, 'Chybí vendor/autoload.php. Na hostingu nahrajte celou složku vendor.');
}
require_once $autoloadFile;

if (!class_exists('\PhpOffice\PhpSpreadsheet\Spreadsheet')) {
    sendJsonError(500, 'PhpSpreadsheet se nepodařilo načíst. Zkontrolujte PHP verzi a rozšíření zip, xml, mbstring a gd.');
}

$input = json_decode(file_get_contents('php://input'), true);

if (!$input || empty($input['clubId']) || empty($input['dateFrom']) || empty($input['dateTo'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Chybějící povinné parametry (klub, datum od/do).']);
    exit;
}

$clubId         = (int)$input['clubId'];
$dateFrom       = $input['dateFrom'];
$dateTo         = $input['dateTo'];
$selectedLevels = $input['levels'] ?? [];
$servicesRule   = $input['servicesRule'] ?? 'all';
$lateFeeRule    = !empty($input['lateFeeRule']);
$absenceRule    = !empty($input['absenceRule']);

// Registrační číslo závodníka, kterému se neúčtuje zvýšené startovné.
// Hodnotu podle potřeby změňte; prázdný řetězec výjimku vypne.
$lateFeeExemptRegNo = 'SJC8102';

function fetchOrisInBatches(array $urls, int $batchSize = 10): array {
    $results = [];
    $errors = [];

    foreach (array_chunk($urls, $batchSize, true) as $batch) {
        $mh = curl_multi_init();
        $curlArray = [];

        foreach ($batch as $key => $url) {
            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL => $url,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT => 20,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_USERAGENT => 'ORIS-Debt-Calculator/1.0',
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
            ]);
            curl_multi_add_handle($mh, $ch);
            $curlArray[$key] = $ch;
        }

        do {
            $multiStatus = curl_multi_exec($mh, $running);
            if ($multiStatus !== CURLM_OK) {
                break;
            }
            if ($running > 0 && curl_multi_select($mh, 1.0) === -1) {
                usleep(100000);
            }
        } while ($running > 0);

        foreach ($curlArray as $key => $ch) {
            $response = curl_multi_getcontent($ch);
            $curlError = curl_error($ch);
            $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $decoded = json_decode($response, true);

            if ($curlError !== '' || $httpCode !== 200 || json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
                $errors[] = sprintf('%s (%s%s)', $key, $curlError ?: 'HTTP ' . $httpCode, $curlError === '' && json_last_error() !== JSON_ERROR_NONE ? ', neplatná JSON odpověď' : '');
            } else {
                $results[$key] = $decoded;
            }

            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }

        curl_multi_close($mh);
        if ($errors) {
            break;
        }
    }

    return [$results, $errors];
}

$baseUrl = "https://oris.ceskyorientak.cz/API/?format=json&";

[$initialData, $initialErrors] = fetchOrisInBatches([
    'registration' => $baseUrl . "method=getRegistration&sport=1&club=" . $clubId,
    'events' => $baseUrl . "method=getEventList&sport=1&datefrom=" . urlencode($dateFrom) . "&dateto=" . urlencode($dateTo),
]);
if ($initialErrors) {
    sendJsonError(502, 'Nepodařilo se načíst základní data z ORIS: ' . implode('; ', $initialErrors));
}

// A) Členové klubu
$regResponse = $initialData['registration'];
$members = [];

if (!empty($regResponse['Data'])) {
    foreach ($regResponse['Data'] as $m) {
        $regNo = $m['RegNo'] ?? '';
        if ($regNo) {
            $members[$regNo] = [
                'name' => ($m['LastName'] ?? '') . ' ' . ($m['FirstName'] ?? ''),
                'regNo' => $regNo,
                'userId' => $m['UserID'] ?? null,
                'debts' => [],
                'details' => [],
                'totalDebt' => 0
            ];
        }
    }
}

// B) Závody v období
$eventsResponse = $initialData['events'];
$events = [];

if (!empty($eventsResponse['Data'])) {
    foreach ($eventsResponse['Data'] as $ev) {
        $events[$ev['ID']] = [
            'id' => $ev['ID'],
            'name' => $ev['Name'],
            'date' => $ev['Date'],
            'level' => $ev['Level']['ShortName'] ?? 'OST',
            'discipline' => $ev['Discipline']['ShortName'] ?? '',
            'baseFee' => (float)($ev['EntryFee1'] ?? 0)
        ];
    }
}

if (empty($events)) {
    http_response_code(404);
    echo json_encode(['error' => 'V zadaném období nebyly nalezeny žádné závody.']);
    exit;
}

// PARALELNÍ STAŽENÍ DETAILŮ (včetně ceníků kategorií)
$urlsToFetch = [];
foreach ($events as $eventId => $ev) {
    $urlsToFetch["entries_{$eventId}"]   = $baseUrl . "method=getEventEntries&eventid={$eventId}&clubid={$clubId}";
    $isLevelSelected = in_array($ev['level'], $selectedLevels, true);

    if ($servicesRule === 'all' || ($servicesRule === 'selected' && $isLevelSelected)) {
        $urlsToFetch["services_{$eventId}"] = $baseUrl . "method=getEventServiceEntries&eventid={$eventId}&clubid={$clubId}";
    }
    if ($absenceRule) {
        $urlsToFetch["results_{$eventId}"] = $baseUrl . "method=getEventResults&eventid={$eventId}&clubid={$clubId}";
    }
    if ($lateFeeRule) {
        $urlsToFetch["eventInfo_{$eventId}"] = $baseUrl . "method=getEvent&id={$eventId}";
    }
}

[$fetchedData, $fetchErrors] = fetchOrisInBatches($urlsToFetch);
if ($fetchErrors) {
    sendJsonError(502, 'Nepodařilo se načíst všechny detaily z ORIS. Export nebyl vytvořen, aby neobsahoval neúplná data: ' . implode('; ', array_slice($fetchErrors, 0, 10)));
}

// VÝPOČET DLUHŮ
$activeEventsWithDebt = [];

function addDebt(&$member, $eventId, $event, $reason, $amount) {
    if (!isset($member['debts'][$eventId])) {
        $member['debts'][$eventId] = 0;
    }
    $member['debts'][$eventId] += $amount;
    $member['totalDebt'] += $amount;

    $member['details'][] = [
        'eventId'   => $eventId,
        'eventDate' => $event['date'],
        'eventName' => $event['name'],
        'reason'    => $reason,
        'amount'    => $amount
    ];
}

foreach ($events as $eventId => $event) {
    $isRelay = in_array($event['discipline'], ['RE', 'TE', 'SR']);
    $isLevelSelected = in_array($event['level'], $selectedLevels);

    $entriesData   = $fetchedData["entries_{$eventId}"]['Data'] ?? [];
    $servicesData  = $fetchedData["services_{$eventId}"]['Data'] ?? [];
    $resultsData   = $fetchedData["results_{$eventId}"]['Data'] ?? [];
    $eventInfoData = $fetchedData["eventInfo_{$eventId}"]['Data'] ?? [];
    
    $classesData   = $eventInfoData['Classes'] ?? [];
    $classBaseFees = [];
    foreach ($classesData as $class) {
        if (isset($class['ID'])) {
            $classBaseFees[$class['ID']] = (float)($class['Fee'] ?? 0);
        }
    }

    $attendedRegNos = [];
    foreach ($resultsData as $res) {
        $rRegNo = $res['RegNo'] ?? $res['UserRegNo'] ?? '';
        if ($rRegNo) {
            $attendedRegNos[$rRegNo] = true;
        }
    }

    foreach ($entriesData as $entry) {
        $regNo = $entry['RegNo'] ?? '';
        if (!$regNo || !isset($members[$regNo])) continue;

        $actualFee = (float)($entry['Fee'] ?? 0);
        $classId   = $entry['ClassID'] ?? '';
        
        $baseFee = isset($classBaseFees[$classId]) ? $classBaseFees[$classId] : $event['baseFee'];
        $hasAttended = isset($attendedRegNos[$regNo]);

        if (!$isRelay) {
            if ($isLevelSelected) {
                if ($actualFee > 0) {
                    addDebt($members[$regNo], $eventId, $event, 'Plné startovné', $actualFee);
                    $activeEventsWithDebt[$eventId] = $event['name'];
                }
            } else {
                if ($absenceRule && !$hasAttended && $actualFee > 0) {
                    addDebt($members[$regNo], $eventId, $event, 'Absence na závodě (propadlé startovné)', $actualFee);
                    $activeEventsWithDebt[$eventId] = $event['name'];
                } elseif ($lateFeeRule && $regNo !== $lateFeeExemptRegNo && $actualFee > $baseFee) {
                    $extraFee = $actualFee - $baseFee;
                    addDebt($members[$regNo], $eventId, $event, 'Navýšení startovného (pozdní přihláška)', $extraFee);
                    $activeEventsWithDebt[$eventId] = $event['name'];
                }
            }
        }
    }

    $shouldCountServices = ($servicesRule === 'all') || ($servicesRule === 'selected' && $isLevelSelected);

    if ($shouldCountServices) {
        foreach ($servicesData as $service) {
            $regNo = $service['RegNo'] ?? '';
            if (!$regNo || !isset($members[$regNo])) continue;

            $serviceFee = (float)($service['TotalFee'] ?? 0);
            
            $serviceName = $service['Service']['NameCZ'] ?? $service['Service']['NameEN'] ?? '';
            $quantity    = $service['Quantity'] ?? 1; 
            
            if (!empty($serviceName)) {
                $reasonText = "Doplňková služba ({$serviceName} - {$quantity}x)";
            } else {
                $reasonText = "Doplňková služba ({$quantity}x)";
            }

            if ($serviceFee > 0) {
                addDebt($members[$regNo], $eventId, $event, $reasonText, $serviceFee);
                $activeEventsWithDebt[$eventId] = $event['name'];
            }
        }
    }
}

// SEŘAZENÍ ZÁVODNÍKŮ PODLE JMÉNA (Česká abeceda)
setlocale(LC_COLLATE, 'cs_CZ.UTF-8', 'cs_CZ', 'czech');
uasort($members, function($a, $b) {
    if (class_exists('Collator')) {
        $collator = new \Collator('cs_CZ');
        return $collator->compare($a['name'], $b['name']);
    }
    return strcoll($a['name'], $b['name']);
});


// 6. GENERUJE SE EXCEL SOUBOR
if (class_exists('\PhpOffice\PhpSpreadsheet\Spreadsheet')) {
    // Verze pro PHPSpreadsheet (XLSX)
    $spreadsheet = new \PhpOffice\PhpSpreadsheet\Spreadsheet();

    $sheet1 = $spreadsheet->getActiveSheet();
    $sheet1->setTitle('Přehled dluhů');

    $sheet1->setCellValue('A1', 'Jméno a příjmení');
    $sheet1->setCellValue('B1', 'Reg. číslo');
    $sheet1->setCellValue('C1', 'CELKEM DLUH (Kč)');

    $colIndex = 4;
    $eventColMap = [];
    foreach ($activeEventsWithDebt as $eId => $eName) {
        $colString = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($colIndex);
        $sheet1->setCellValue($colString . '1', $eName);
        $eventColMap[$eId] = $colString;
        $colIndex++;
    }

    $row = 2;
    foreach ($members as $m) {
        if ($m['totalDebt'] == 0) continue;
        $sheet1->setCellValue("A{$row}", $m['name']);
        $sheet1->setCellValue("B{$row}", $m['regNo']);
        $sheet1->setCellValue("C{$row}", $m['totalDebt']);
        foreach ($m['debts'] as $eId => $debtAmount) {
            if (isset($eventColMap[$eId])) {
                $sheet1->setCellValue($eventColMap[$eId] . $row, $debtAmount);
            }
        }
        $row++;
    }

    $sheet2 = $spreadsheet->createSheet();
    $sheet2->setTitle('Detailní rozpis položek');

    $sheet2->setCellValue('A1', 'Jméno');
    $sheet2->setCellValue('B1', 'Reg. číslo');
    $sheet2->setCellValue('C1', 'ORIS ID'); 
    $sheet2->setCellValue('D1', 'Datum');   
    $sheet2->setCellValue('E1', 'Závod');
    $sheet2->setCellValue('F1', 'Důvod');
    $sheet2->setCellValue('G1', 'Částka (Kč)');

    $row2 = 2;
    foreach ($members as $m) {
        foreach ($m['details'] as $detail) {
            $formattedDate = date('j.n.Y', strtotime($detail['eventDate']));
            
            $sheet2->setCellValue("A{$row2}", $m['name']);
            $sheet2->setCellValue("B{$row2}", $m['regNo']);
            
            $eventIdCell = "C{$row2}";
            $sheet2->setCellValueExplicit(
                $eventIdCell,
                (string) $detail['eventId'],
                \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING
            );
            $sheet2->getCell($eventIdCell)->getHyperlink()
                ->setUrl("https://oris.ceskyorientak.cz/Zavod?id=" . $detail['eventId'])
                ->setTooltip('Otevřít závod v ORIS');
            $sheet2->getStyle($eventIdCell)->getFont()
                ->setUnderline(true)
                ->getColor()->setARGB('FF0000FF');
            
            $sheet2->setCellValue("D{$row2}", $formattedDate);
            $sheet2->setCellValue("E{$row2}", $detail['eventName']);
            $sheet2->setCellValue("F{$row2}", $detail['reason']);
            $sheet2->setCellValue("G{$row2}", $detail['amount']);
            $row2++;
        }
    }

    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment;filename="Dluhy_zavody_ORIS.xlsx"');
    header('Cache-Control: max-age=0');
    $writer = new \PhpOffice\PhpSpreadsheet\Writer\Xlsx($spreadsheet);
    $writer->save('php://output');
    exit;

} else {
    // ZÁLOŽNÍ REŽIM PRO EXCEL (XML SpreadsheetML)
    header('Content-Type: application/vnd.ms-excel; charset=utf-8');
    header('Content-Disposition: attachment;filename="Dluhy_zavody_ORIS.xls"');
    
    echo '<?xml version="1.0"?>';
    echo '<?mso-application progid="Excel.Sheet"?>';
    echo '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
    echo 'xmlns:o="urn:schemas-microsoft-com:office:office" ';
    echo 'xmlns:x="urn:schemas-microsoft-com:office:excel" ';
    echo 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ';
    echo 'xmlns:html="http://www.w3.org/TR/REC-html40">';

    echo '<Styles>';
    echo '  <Style ss:ID="sLink">';
    echo '    <Font ss:Color="#0000FF" ss:Underline="Single"/>';
    echo '  </Style>';
    echo '</Styles>';

    echo '<Worksheet ss:Name="Přehled dluhů"><Table>';
    echo '<Row>';
    echo '<Cell><Data ss:Type="String">Jméno a příjmení</Data></Cell>';
    echo '<Cell><Data ss:Type="String">Reg. číslo</Data></Cell>';
    echo '<Cell><Data ss:Type="String">CELKEM (Kč)</Data></Cell>';
    foreach ($activeEventsWithDebt as $eId => $eName) {
        echo '<Cell><Data ss:Type="String">' . htmlspecialchars($eName) . '</Data></Cell>';
    }
    echo '</Row>';

    foreach ($members as $m) {
        if ($m['totalDebt'] == 0) continue;
        echo '<Row>';
        echo '<Cell><Data ss:Type="String">' . htmlspecialchars($m['name']) . '</Data></Cell>';
        echo '<Cell><Data ss:Type="String">' . htmlspecialchars($m['regNo']) . '</Data></Cell>';
        echo '<Cell><Data ss:Type="Number">' . $m['totalDebt'] . '</Data></Cell>';
        foreach ($activeEventsWithDebt as $eId => $eName) {
            $val = $m['debts'][$eId] ?? 0;
            if ($val > 0) {
                echo '<Cell><Data ss:Type="Number">' . $val . '</Data></Cell>';
            } else {
                echo '<Cell><Data ss:Type="String"></Data></Cell>';
            }
        }
        echo '</Row>';
    }
    echo '</Table></Worksheet>';

    echo '<Worksheet ss:Name="Detailní rozpis položek"><Table>';
    echo '<Row>
        <Cell><Data ss:Type="String">Jméno</Data></Cell>
        <Cell><Data ss:Type="String">Reg. číslo</Data></Cell>
        <Cell><Data ss:Type="String">ORIS ID</Data></Cell>
        <Cell><Data ss:Type="String">Datum</Data></Cell>
        <Cell><Data ss:Type="String">Závod</Data></Cell>
        <Cell><Data ss:Type="String">Důvod</Data></Cell>
        <Cell><Data ss:Type="String">Částka (Kč)</Data></Cell>
    </Row>';

    foreach ($members as $m) {
        foreach ($m['details'] as $detail) {
            $formattedDate = date('j.n.Y', strtotime($detail['eventDate']));
            $orisUrl = "https://oris.ceskyorientak.cz/Zavod?id=" . htmlspecialchars($detail['eventId']);

            echo '<Row>';
            echo '<Cell><Data ss:Type="String">' . htmlspecialchars($m['name']) . '</Data></Cell>';
            echo '<Cell><Data ss:Type="String">' . htmlspecialchars($m['regNo']) . '</Data></Cell>';
            
            echo '<Cell ss:StyleID="sLink" ss:HRef="' . $orisUrl . '"><Data ss:Type="Number">' . htmlspecialchars($detail['eventId']) . '</Data></Cell>';
            
            echo '<Cell><Data ss:Type="String">' . $formattedDate . '</Data></Cell>';
            echo '<Cell><Data ss:Type="String">' . htmlspecialchars($detail['eventName']) . '</Data></Cell>';
            echo '<Cell><Data ss:Type="String">' . htmlspecialchars($detail['reason']) . '</Data></Cell>';
            echo '<Cell><Data ss:Type="Number">' . $detail['amount'] . '</Data></Cell>';
            echo '</Row>';
        }
    }
    echo '</Table></Worksheet>';

    echo '</Workbook>';
    exit;
}
