document.addEventListener('DOMContentLoaded', () => {
    
    const clubSelect = document.getElementById('clubSelect');
    let tomSelectInstance = null;

    // 1. Načtení klubů z ORISu přes správnou metodu getCSOSClubList
    fetch('https://oris.ceskyorientak.cz/API/?format=json&method=getCSOSClubList')
        .then(response => response.json())
        .then(data => {
            if (data.Status === 'OK') {
                clubSelect.innerHTML = '<option value="" disabled selected>Vyberte nebo vyhledejte klub...</option>';
                
                // ABECEDNÍ SEŘAZENÍ PODLE ZKRATKY (Abbr)
                const clubs = Object.values(data.Data).sort((a, b) => (a.Abbr || '').localeCompare(b.Abbr || ''));
                
                clubs.forEach(club => {
                    const option = document.createElement('option');
                    option.value = club.ID;
                    // FORMÁT: "SJC - Sportcentrum Jičín"
                    option.textContent = `${club.Abbr} - ${club.Name}`;
                    clubSelect.appendChild(option);
                });

                // Aktivace vyhledávání v roletce (umožní psát zkratku i název)
                tomSelectInstance = new TomSelect('#clubSelect', {
                    create: false,
                    placeholder: 'Začněte psát (např. SJC nebo Jičín)...',
                    searchField: ['text']
                });
            }
        })
        .catch(error => {
            console.error('Chyba při načítání klubů:', error);
            clubSelect.innerHTML = '<option value="" disabled>Chyba načítání. Zkuste obnovit stránku.</option>';
        });

    // 2. Obsluha odeslání formuláře
    document.getElementById('debtForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        const submitBtn = document.getElementById('submitBtn');
        const loadingMsg = document.getElementById('loadingMsg');
        
        submitBtn.disabled = true;
        loadingMsg.style.display = 'block';

        const selectedLevels = [];
        document.querySelectorAll('input[type="checkbox"]:not(#lateFeeRule):not(#absenceRule):checked').forEach(cb => {
            selectedLevels.push(cb.value);
        });

        const payload = {
            clubId: clubSelect.value,
            dateFrom: document.getElementById('dateFrom').value,
            dateTo: document.getElementById('dateTo').value,
            levels: selectedLevels,
            servicesRule: document.querySelector('input[name="servicesRule"]:checked').value,
            lateFeeRule: document.getElementById('lateFeeRule').checked,
            absenceRule: document.getElementById('absenceRule').checked
        };

        fetch('api.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
        .then(async response => {
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.error || `Chyba na serveru (HTTP ${response.status})`);
            }
            return response.blob();
        })
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Dluhy_zavody_ORIS.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
        })
        .catch(error => {
            console.error('Chyba při generování:', error);
            alert(`Nastala chyba při zpracování: ${error.message}`);
        })
        .finally(() => {
            submitBtn.disabled = false;
            loadingMsg.style.display = 'none';
        });
    });
});
