// ─────────────────────────────────────────────────────────────────────────────
// clientes.js — Gestão Armazém v6.81
// Gestão de clientes (/clientes): cache, autocomplete no modal PAT, listagem
// agrupada por cadeia na Administração, edição de coordenadas e importação Excel.
//
// DEPENDÊNCIAS:
//   utils.js   — BASE_URL, $id, $el, escapeHtml, showToast, modalOpen,
//                modalClose, loadXlsx
//   auth.js    — authUrl
//   tools.js   — openConfirmModal
//   pat-map.js — _geocodeCache, _normEstabKey
//   app.js     — apiFetch
// ─────────────────────────────────────────────────────────────────────────────

// CLIENTES — autocomplete Nº Cliente no modal PAT
const CLIENTES_URL = `${BASE_URL}/clientes.json`;
const _clientesCache = { data: null, lastFetch: 0 };

async function _fetchClientes(force = false) {
    const now = Date.now();
    if (!force && _clientesCache.data && now - _clientesCache.lastFetch < 300000) return _clientesCache.data;
    try {
        const url = await authUrl(CLIENTES_URL);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        _clientesCache.data = await res.json() || {};
        _clientesCache.lastFetch = now;
    } catch(_e) { _clientesCache.data = _clientesCache.data || {}; }
    return _clientesCache.data;
}

let _clienteDropdownIdx = -1;

function patClientSearch(val) {
    _clienteDropdownIdx = -1;
    $id('pat-cliente-id').value = ''; // limpar ao escrever
    const dd = $id('pat-client-dropdown');
    const q  = val.trim();
    if (!q) { dd.innerHTML = ''; _removeClientOutsideListener(); return; }

    const data = _clientesCache.data || {};

    // Injectar _fbId em cada cliente para uso no dropdown
    const dataComId = Object.entries(data).reduce((acc, [fbId, c]) => {
        acc[fbId] = { ...c, _fbId: fbId };
        return acc;
    }, {});

    // Número exacto — verifica quantos clientes partilham esse NR
    if (/^\d{1,3}$/.test(q)) {
        const exactMatches = Object.values(dataComId).filter(c => c.numero === q);
        if (exactMatches.length === 1) {
            $id('pat-estabelecimento').value = exactMatches[0].nome;
            $id('pat-cliente-id').value      = exactMatches[0]._fbId;
            dd.innerHTML = '';
            _removeClientOutsideListener();
            return;
        }
        if (exactMatches.length > 1) {
            _renderClientDropdown(dd, exactMatches, true);
            _addClientOutsideListener();
            return;
        }
    }

    // Sugestões parciais
    const matches = Object.values(dataComId)
        .filter(c => c.numero.startsWith(q) || c.nome.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 10);

    if (matches.length === 0) {
        dd.innerHTML = '<div class="pat-dd-empty">Sem resultados</div>';
        _removeClientOutsideListener();
        return;
    }
    _renderClientDropdown(dd, matches, false);
    _addClientOutsideListener();
}

function _renderClientDropdown(dd, matches, isExact) {
    dd.innerHTML = '';
    if (isExact) {
        const hdr = $el('div', { className: 'pat-dd-header' });
        hdr.textContent = matches.length + ' estabelecimentos com este Nº — escolhe:';
        dd.appendChild(hdr);
    }
    matches.forEach((c, i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        const codeEl = $el('span'); codeEl.className = 'pat-dd-code'; codeEl.textContent = c.numero;
        const nameEl = $el('span'); nameEl.className = 'pat-dd-name';  nameEl.textContent = c.nome;
        opt.appendChild(codeEl); opt.appendChild(nameEl);
        opt.onmousedown = (e) => {
            e.preventDefault();
            $id('pat-cliente-num').value     = c.numero;
            $id('pat-estabelecimento').value  = c.nome;
            $id('pat-cliente-id').value       = c._fbId || '';
            dd.innerHTML = '';
            _removeClientOutsideListener();
        };
        dd.appendChild(opt);
    });
}

function _clientOutsideHandler(e) {
    const wrap = document.querySelector('.pat-client-wrap');
    if (wrap && !wrap.contains(e.target)) {
        $id('pat-client-dropdown').innerHTML = '';
        _removeClientOutsideListener();
    }
}
function _addClientOutsideListener() {
    document.removeEventListener('click', _clientOutsideHandler);
    document.addEventListener('click', _clientOutsideHandler);
}
function _removeClientOutsideListener() {
    document.removeEventListener('click', _clientOutsideHandler);
}

function patClientKeydown(e) {
    const dd   = $id('pat-client-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _clienteDropdownIdx = Math.min(_clienteDropdownIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _clienteDropdownIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _clienteDropdownIdx = Math.max(_clienteDropdownIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _clienteDropdownIdx));
    } else if (e.key === 'Enter' && _clienteDropdownIdx >= 0) {
        e.preventDefault();
        opts[_clienteDropdownIdx]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

// ── Lista de clientes no Admin ─────────────────────────────────────────────
async function renderClientesList() {
    const container = $id('clientes-list');
    if (!container) return;
    container.innerHTML = '<div class="pat-loading">A carregar...</div>';
    const data = await _fetchClientes(true);

    function _cadeia(nome) {
        return (nome || '').trim().split(/\s+/)[0].toUpperCase();
    }

    const entries = Object.entries(data || {})
        .sort(([, a], [, b]) => {
            const cadA = _cadeia(a.nome), cadB = _cadeia(b.nome);
            const cadCmp = cadA.localeCompare(cadB, 'pt');
            if (cadCmp !== 0) return cadCmp;
            const locA = (a.lat != null && a.lng != null) ? 0 : 1;
            const locB = (b.lat != null && b.lng != null) ? 0 : 1;
            if (locA !== locB) return locA - locB;
            return (a.nome || '').localeCompare(b.nome || '', 'pt');
        });

    if (entries.length === 0) {
        container.innerHTML = '<div class="empty-msg">Nenhum cliente. Usa o botão acima para importar.</div>';
        return;
    }

    container.innerHTML = '';
    const totalComLoc = entries.filter(([, c]) => c.lat != null && c.lng != null).length;

    // ── Stats ────────────────────────────────────────────────────────────
    const stats = $el('div', { className: 'clientes-stats' });
    stats.innerHTML = `
        <span class="clientes-stat"><span class="clientes-stat-num">${entries.length}</span> clientes</span>
        <span class="clientes-stat-dot"></span>
        <span class="clientes-stat"><span class="clientes-stat-num" style="color:#16a34a">${totalComLoc}</span> com localização</span>`;
    container.appendChild(stats);

    // ── Pesquisa ─────────────────────────────────────────────────────────
    const searchWrap = $el('div', { className: 'clientes-search-wrap' });
    searchWrap.innerHTML = `
        <svg class="clientes-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="clientes-search-input" placeholder="Pesquisar por número ou nome..." id="clientes-search-inp">`;
    container.appendChild(searchWrap);

    // ── Área de grupos ────────────────────────────────────────────────────
    const groupsArea = $el('div');
    groupsArea.id = 'clientes-groups-area';
    container.appendChild(groupsArea);

    // Agrupar por cadeia
    const groups = {};
    entries.forEach(([id, c]) => {
        const k = _cadeia(c.nome);
        if (!groups[k]) groups[k] = [];
        groups[k].push([id, c]);
    });

    function _buildGroups(filter = '') {
        const q = filter.trim().toLowerCase();
        groupsArea.innerHTML = '';
        let totalVisible = 0;

        Object.entries(groups).forEach(([cadeia, items]) => {
            const filtered = q
                ? items.filter(([, c]) =>
                    c.nome.toLowerCase().includes(q) ||
                    String(c.numero || '').includes(q))
                : items;
            if (filtered.length === 0) return;
            totalVisible += filtered.length;

            const withLoc = filtered.filter(([, c]) => c.lat != null && c.lng != null).length;

            // Wrapper do grupo
            const grp = $el('div', { className: 'clientes-group' });

            // Header do grupo
            const hdr = $el('div', { className: 'clientes-group-header' });
            hdr.innerHTML = `
                <span class="clientes-group-name">${cadeia}</span>
                ${withLoc > 0 ? `<span class="clientes-group-loc visible"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>${withLoc}</span>` : ''}
                <span class="clientes-group-count">${filtered.length}</span>
                <span class="clientes-group-chevron"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;

            hdr.onclick = () => grp.classList.toggle('collapsed');

            // Body com linhas
            const body = $el('div', { className: 'clientes-group-body' });

            filtered.forEach(([id, c]) => {
                const hasCoords = c.lat != null && c.lng != null;
                const row = $el('div', { className: 'cliente-row' });

                const numEl = $el('span', { className: 'cliente-row-num' });
                numEl.textContent = String(c.numero || '').padStart(3, '0');

                const nomeWrap = $el('div');
                nomeWrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;';

                const dot = $el('span');
                dot.className = `cliente-loc-dot ${hasCoords ? 'has-loc' : 'no-loc'}`;
                dot.title = hasCoords ? `${parseFloat(c.lat).toFixed(5)}, ${parseFloat(c.lng).toFixed(5)}` : 'Sem localização';

                const nomeEl = $el('span');
                nomeEl.className = `cliente-row-nome${hasCoords ? '' : ' sem-loc'}`;
                nomeEl.textContent = c.nome || '—';
                nomeEl.title = c.nome || '';

                nomeWrap.appendChild(dot);
                nomeWrap.appendChild(nomeEl);

                const actions = $el('div', { className: 'cliente-row-actions' });

                const editBtn = $el('button', { className: 'cliente-row-edit' });
                editBtn.title = 'Editar';
                editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
                editBtn.onclick = (e) => { e.stopPropagation(); openEditClienteModal(id, c); };

                const delBtn = $el('button', { className: 'cliente-row-del' });
                delBtn.title = 'Apagar';
                delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    openConfirmModal({
                        title: 'Apagar cliente?', type: 'danger',
                        desc: `${escapeHtml(c.numero)} — ${escapeHtml(c.nome)}`,
                        onConfirm: async () => {
                            try {
                                await apiFetch(`${BASE_URL}/clientes/${id}.json`, { method: 'DELETE' });
                                delete _clientesCache.data[id];
                                renderClientesList();
                                showToast('Cliente apagado');
                            } catch(_e) { showToast('Erro ao apagar', 'error'); }
                        }
                    });
                };

                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
                row.appendChild(numEl);
                row.appendChild(nomeWrap);
                row.appendChild(actions);
                body.appendChild(row);
            });

            grp.appendChild(hdr);
            grp.appendChild(body);
            groupsArea.appendChild(grp);
        });

        // Sem resultados
        if (totalVisible === 0 && q) {
            groupsArea.innerHTML = `<div class="clientes-empty-search">Nenhum cliente encontrado para "${escapeHtml(q)}"</div>`;
        }
    }

    _buildGroups();

    // Pesquisa em tempo real
    const searchInp = $id('clientes-search-inp');
    if (searchInp) {
        let _st;
        searchInp.addEventListener('input', e => {
            clearTimeout(_st);
            _st = setTimeout(() => _buildGroups(e.target.value), 180);
        });
    }
}

// ── Modal Editar Cliente ───────────────────────────────────────────────────
function _ecInitials(nome) {
    const words = (nome || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function ecUpdatePreview() {
    const nome = $id('edit-cliente-nome')?.value || '';
    const disp = $id('ec-nome-display');
    const avt  = $id('ec-avatar');
    if (disp) disp.textContent = nome || '—';
    if (avt)  avt.textContent  = _ecInitials(nome);
}

function ecUpdateLocStatus() {
    const lat = $id('edit-cliente-lat')?.value?.trim();
    const lng = $id('edit-cliente-lng')?.value?.trim();
    const el  = $id('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status editing-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg> Coordenadas definidas — a guardar ao clicar em Guardar`;
    } else if (!lat && !lng) {
        // Mostrar estado original (repor ao que estava ao abrir)
        _ecSetInitialLocStatus();
    }
}

function _ecSetInitialLocStatus(lat, lng) {
    const el = $id('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status has-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> Localização guardada · ${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`;
    } else {
        el.className = 'ec-loc-status no-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Sem localização — será geocodificada automaticamente`;
    }
}

function openEditClienteModal(id, c) {
    $id('edit-cliente-id').value  = id;
    $id('edit-cliente-numero').value = c.numero || '';
    $id('edit-cliente-nome').value   = c.nome   || '';
    $id('edit-cliente-lat').value    = c.lat    || '';
    $id('edit-cliente-lng').value    = c.lng    || '';

    // Preview no header
    const nomeDisplay = $id('ec-nome-display');
    const numDisplay  = $id('ec-numero-display');
    const avatar      = $id('ec-avatar');
    if (nomeDisplay) nomeDisplay.textContent = c.nome  || '—';
    if (numDisplay)  numDisplay.textContent  = `Nº ${(c.numero || '').padStart(3, '0')}`;
    if (avatar)      avatar.textContent      = _ecInitials(c.nome);

    // Estado da localização
    _ecSetInitialLocStatus(c.lat, c.lng);

    modalOpen('modal-edit-cliente');
    setTimeout(() => $id('edit-cliente-nome').focus(), 120);
}

async function saveEditCliente() {
    const id     = $id('edit-cliente-id').value;
    const numero = $id('edit-cliente-numero').value.trim(); // readonly, só para payload
    const nome   = $id('edit-cliente-nome').value.trim();
    const latVal = $id('edit-cliente-lat').value.trim();
    const lngVal = $id('edit-cliente-lng').value.trim();
    const previousNome = _clientesCache.data?.[id]?.nome || '';

    if (!nome) { showToast('O nome não pode estar vazio', 'error'); return; }

    // Só alterar nome (número fica inalterado)
    const payload = { nome };

    if (latVal !== '' && lngVal !== '') {
        const lat = parseFloat(latVal);
        const lng = parseFloat(lngVal);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            showToast('Coordenadas inválidas', 'error'); return;
        }
        payload.lat = lat;
        payload.lng = lng;
    } else {
        payload.lat = null;
        payload.lng = null;
    }

    try {
        await apiFetch(`${BASE_URL}/clientes/${id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (_clientesCache.data) {
            _clientesCache.data[id] = { ..._clientesCache.data[id], ...payload };
        }
        const cacheKey = _normEstabKey(nome);
        const previousKey = _normEstabKey(previousNome);
        if (previousKey && previousKey !== cacheKey) {
            delete _geocodeCache[previousKey];
        }
        if (payload.lat != null && payload.lng != null && cacheKey) {
            _geocodeCache[cacheKey] = { lat: payload.lat, lng: payload.lng };
        } else if (cacheKey) {
            _geocodeCache[cacheKey] = null;
        }
        modalClose('modal-edit-cliente');
        renderClientesList();
        showToast('Cliente guardado');
    } catch(_e) { showToast('Erro ao guardar', 'error'); }
}

// ── Importar Excel de clientes ─────────────────────────────────────────────
async function importClientesExcel(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const preview = $id('clientes-import-preview');
    preview.innerHTML = '<div class="pat-loading">A processar ficheiro...</div>';

    try {
        await loadXlsx();
        const buf  = await file.arrayBuffer();
        const wb   = XLSX.read(buf, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        const clientes = {};
        let count = 0;
        rows.forEach(row => {
            const num  = String(row[0] || '').trim();
            const nome = String(row[1] || '').trim();
            if (!num || !nome || isNaN(Number(num))) return;
            const id = `c${num.padStart(3, '0')}`;
            clientes[id] = { numero: num, nome };
            count++;
        });

        if (count === 0) {
            preview.innerHTML = '<div class="clientes-preview-error">Nenhum cliente encontrado. Verifica o formato do ficheiro.</div>';
            return;
        }

        preview.innerHTML = `<div class="clientes-preview-info">✓ ${count} clientes encontrados. A importar...</div>`;

        // Guardar no Firebase (merge — preserva coords existentes)
        const existing = await _fetchClientes(true);
        const merged = {};
        for (const [id, c] of Object.entries(clientes)) {
            merged[id] = { ...c };
            // Preservar lat/lng se já existia
            if (existing[id]?.lat) merged[id].lat = existing[id].lat;
            if (existing[id]?.lng) merged[id].lng = existing[id].lng;
        }

        await apiFetch(`${BASE_URL}/clientes.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged)
        });

        _clientesCache.data = merged;
        _clientesCache.lastFetch = Date.now();
        preview.innerHTML = `<div class="clientes-preview-info">✓ ${count} clientes importados com sucesso.</div>`;
        renderClientesList();
        input.value = '';
    } catch(e) {
        console.error('[clientes] importar:', e);
        preview.innerHTML = `<div class="clientes-preview-error">Erro ao processar ficheiro: ${e.message}</div>`;
    }
}
