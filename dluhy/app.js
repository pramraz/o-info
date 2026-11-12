document.addEventListener('DOMContentLoaded', () => {
    const ORIS_CLUBS_URL = 'https://oris.ceskyorientak.cz/API/?format=json&method=getCSOSClubList';
    const MAX_RANGE_DAYS = 400; // stejný limit jako v api.php

    const form = document.getElementById('debtForm');
    const clubSelect = document.getElementById('clubSelect');
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    const submitBtn = document.getElementById('submitBtn');
    const loadingMsg = document.getElementById('loadingMsg');
    const resultMsg = document.getElementById('resultMsg');

    // 1. Seznam klubů z ORIS (seřazený podle zkratky, vyhledávání přes TomSelect)
    fetch(ORIS_CLUBS_URL)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then(data => {
            if (data.Status !== 'OK') throw new Error(`ORIS: ${data.Status}`);

            const clubs = Object.values(data.Data)
                .sort((a, b) => (a.Abbr || '').localeCompare(b.Abbr || '', 'cs'));

            const fragment = document.createDocumentFragment();
            fragment.appendChild(new Option('Vyberte nebo vyhledejte klub...', '', true, true));
            fragment.firstChild.disabled = true;
            clubs.forEach(club => fragment.appendChild(new Option(`${club.Abbr} - ${club.Name}`, club.ID)));
            clubSelect.replaceChildren(fragment);

            new TomSelect(clubSelect, {
                create: false,
                placeholder: 'Začněte psát (např. SJC nebo Jičín)...',
                searchField: ['text'],
            });
        })
        .catch(error => {
            console.error('Chyba při načítání klubů:', error);
            clubSelect.replaceChildren(new Option('Chyba načítání klubů. Zkuste obnovit stránku.', ''));
        });

    // 2. "Označit vše" u skupin úrovní – včetně zpětné synchronizace stavu
    [['toggleOfficial', 'groupOfficial'], ['toggleOther', 'groupOther']].forEach(([toggleId, groupId]) => {
        const toggle = document.getElementById(toggleId);
        const boxes = [...document.querySelectorAll(`#${groupId} .level-cb`)];
        const sync = () => {
            const checked = boxes.filter(cb => cb.checked).length;
            toggle.checked = checked === boxes.length;
            toggle.indeterminate = checked > 0 && checked < boxes.length;
        };
        toggle.addEventListener('change', () => boxes.forEach(cb => { cb.checked = toggle.checked; }));
        boxes.forEach(cb => cb.addEventListener('change', sync));
        sync();
    });

    // 3. Odeslání formuláře
    const fileNameFromResponse = (response, fallback) => {
        const header = response.headers.get('Content-Disposition') || '';
        const match = header.match(/filename="?([^";]+)"?/i);
        return match ? match[1] : fallback;
    };

    const showResult = (text, type) => {
        resultMsg.textContent = text;
        resultMsg.className = `alert alert-${type} mt-3`;
        resultMsg.hidden = !text;
    };

    form.addEventListener('submit', async e => {
        e.preventDefault();
        showResult('', 'info');

        if (!clubSelect.value) {
            showResult('Vyberte klub.', 'warning');
            return;
        }
        const days = (new Date(dateTo.value) - new Date(dateFrom.value)) / 86400000;
        if (days < 0) {
            showResult('Datum „od“ musí být před datem „do“.', 'warning');
            return;
        }
        if (days > MAX_RANGE_DAYS) {
            showResult(`Období může mít nejvýše ${MAX_RANGE_DAYS} dní.`, 'warning');
            return;
        }

        const payload = {
            clubId: clubSelect.value,
            dateFrom: dateFrom.value,
            dateTo: dateTo.value,
            levels: [...document.querySelectorAll('input.level-cb:checked')].map(cb => cb.value),
            servicesRule: document.getElementById('servicesRule').checked ? 'all' : 'selected',
            lateFeeRule: document.getElementById('lateFeeRule').checked,
            absenceRule: document.getElementById('absenceRule').checked,
        };

        submitBtn.disabled = true;
        loadingMsg.hidden = false;

        try {
            const response = await fetch('api.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.error || `Chyba na serveru (HTTP ${response.status})`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileNameFromResponse(response, 'Dluhy_zavody_ORIS.xlsx');
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);

            const warnings = Number(response.headers.get('X-Warnings-Count') || 0);
            const relayIssues = Number(response.headers.get('X-Relay-Issues-Count') || 0);
            const notes = [];
            if (warnings > 0) notes.push(`U ${warnings} závodů nemusí být výpočet úplný – viz list „Upozornění“.`);
            if (relayIssues > 0) notes.push(`${relayIssues} přihlášených štafet nemá výsledek – viz list „Štafety bez výsledku“.`);
            showResult(['Excel byl stažen.', ...notes].join(' '), notes.length ? 'warning' : 'success');
        } catch (error) {
            console.error('Chyba při generování:', error);
            showResult(`Nastala chyba při zpracování: ${error.message}`, 'danger');
        } finally {
            submitBtn.disabled = false;
            loadingMsg.hidden = true;
        }
    });
});
