// ─────────────────────────────────────────────────────────────────────────────
// pats.js — Gestão Armazém v6.82
// Pedidos PAT (/pedidos): listagem Pendentes/Histórico, cards desktop e mobile,
// criação/edição, gestão de referências, levantamento individual/em lote com
// pré-visualização e abate atómico ao stock, e retenção automática de 6 meses.
//
// DEPENDÊNCIAS:
//   utils.js    — BASE_URL, $id, $el, escapeHtml, showToast, fmtQty,
//                 modalOpen, modalClose, focusModal, _calcDias, _debounce,
//                 SVG_EDIT, SVG_DEL, SVG_CHECK, SVG_ARROW, SVG_INFO,
//                 SVG_USER, SVG_CAL, SVG_MAP
//   auth.js     — authUrl
//   reports.js  — registarMovimento, _relSalvarPatAntesDeApagar,
//                 _relSalvarSnapshotSePreciso
//   stock.js    — findStockByCodigo, _commitStockDelta, renderList
//   tools.js    — openConfirmModal
//   clientes.js — _fetchClientes
//   pat-map.js  — _findClienteByEstab, openPatMap
//   app.js      — cache, fetchCollection, apiFetch
// ─────────────────────────────────────────────────────────────────────────────

let _patProducts    = [];
let _patDropdownIdx = -1;

const _patCache = { data: null, lastFetch: 0 };

// O Histórico guarda as PATs levantadas durante 6 meses (de calendário); depois são
// apagadas automaticamente (os relatórios do mês já ficam guardados em snapshot).
const PAT_HISTORICO_MESES = 6;
function _patHistoricoExpiraEm(refTs) {
    const d = new Date(refTs);
    d.setMonth(d.getMonth() + PAT_HISTORICO_MESES);
    return d.getTime();
}

async function _fetchPats(force = false) {
    const now = Date.now();
    if (!force && _patCache.data && now - _patCache.lastFetch < 120000) return _patCache.data;
    try {
        const url = await authUrl(`${BASE_URL}/pedidos.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        _patCache.data = await res.json() || {};
        _patCache.lastFetch = now;
        // Auto-limpeza: apaga entradas de histórico com mais de 6 meses
        _autoLimparHistorico();
    } catch(_e) { _patCache.data = _patCache.data || {}; }
    return _patCache.data;
}

async function _autoLimparHistorico() {
    const agora = Date.now();
    const expirados = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === 'historico' && p.saidaEm && _patHistoricoExpiraEm(p.saidaEm) <= agora);
    if (!expirados.length) return;

    // ── FIX C1 (auditoria): agrupa por mês antes de apagar ─────────────
    // Antes: cada PAT apagada regenerava o snapshot inteiro do mês
    // (_fetchPats + movimentos + ferramentas). Com 20 PATs, 20 rebuilds.
    // Agora: 1 snapshot por mês afectado, depois batch delete.
    const mesesAfectados = new Set();
    for (const [, pat] of expirados) {
        const refTs = pat.levantadoEm || pat.saidaEm || pat.criadoEm;
        if (!refTs) continue;
        const d = new Date(refTs);
        mesesAfectados.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Um snapshot por mês afectado — PATs ainda estão na cache e Firebase
    for (const mesKey of mesesAfectados) {
        try {
            await _relSalvarSnapshotSePreciso(mesKey);
        } catch(e) {
            console.warn('[Histórico] falha snapshot antes de apagar:', mesKey, e?.message);
        }
    }

    // Agora sim, apagar todas as PATs em batch
    for (const [id] of expirados) {
        await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' })
            .catch(e => console.warn('[Histórico] falha auto-limpeza:', id, e?.message));
        delete _patCache.data[id];
    }
}

function _getPatPendingCount() {
    // _patCache é a variável module-level correcta (cache principal não inclui pedidos)
    const data = (_patCache && _patCache.data) ? _patCache.data : {};
    return Object.values(data).filter(p => p.status !== 'levantado' && p.status !== 'historico').length;
}

async function updatePatCount() {
    // Actualiza a cache de PATs — card do dashboard lê _getPatPendingCount() da cache
    await _fetchPats();
}

let _patSearchQuery  = '';
let _patTab          = 'pendentes'; // 'pendentes' | 'historico'  (levantar = vai direto para o histórico)
let _patSelMode      = false;       // modo seleção para levantar
let _patSelWorker    = '';          // funcionário escolhido
let _patSelIds       = new Set();   // IDs seleccionados

const _debouncedPatSearch = _debounce(val => {
    _patSearchQuery = (val || '').toLowerCase().trim();
    renderPats();
}, 300);

function patSearchFilter(val) { _debouncedPatSearch(val); }

// ── Popover de pedidos duplicados por estabelecimento ──────────────
let _dupPopoverEl = null;
let _dupPopoverCloseHandler = null;

function showDupPopover(badge, estabNorm) {
    // fecha se já aberto + limpa listener anterior
    if (_dupPopoverCloseHandler) { document.removeEventListener('click', _dupPopoverCloseHandler); _dupPopoverCloseHandler = null; }
    if (_dupPopoverEl) { _dupPopoverEl.remove(); _dupPopoverEl = null; }

    const pats = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico' &&
                (p.estabelecimento || '').trim().toLowerCase() === estabNorm)
        .sort((a, b) => (a[1].criadoEm || 0) - (b[1].criadoEm || 0));

    const pop = $el('div', { className: 'dup-popover' });
    pop.innerHTML = `
        <div class="dup-pop-title">PATs — ${escapeHtml(pats[0]?.[1]?.estabelecimento || estabNorm)}</div>
        ${pats.map(([, p]) => {
            const dias = _calcDias(p.criadoEm);
            const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
            const urgente = dias >= 20;
            return `<div class="dup-pop-row">
                <span class="dup-pop-pat ${urgente ? 'dup-pop-urgente' : ''}">PAT ${escapeHtml(p.numero || '—')}</span>
                <span class="dup-pop-dias">${diasLabel}</span>
            </div>`;
        }).join('')}
    `;
    _dupPopoverEl = pop;

    document.body.appendChild(pop);

    // posicionar abaixo do badge
    const rect = badge.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    let left = rect.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    pop.style.left = left + 'px';
    pop.style.top  = (rect.bottom + 6) + 'px';

    _dupPopoverCloseHandler = (e) => {
        if (!pop.contains(e.target)) {
            pop.remove(); _dupPopoverEl = null;
            document.removeEventListener('click', _dupPopoverCloseHandler);
            _dupPopoverCloseHandler = null;
        }
    };
    setTimeout(() => document.addEventListener('click', _dupPopoverCloseHandler), 0);
}

async function renderPats() {
    const el = $id('pat-list');
    if (!el) return;
    el.innerHTML = '<div class="pat-loading">A carregar...</div>';

    // Sync tab UI
    ['pendentes','historico'].forEach(t => {
        $id(`pat-tab-${t}`)?.classList.toggle('active', _patTab === t);
    });
    const histBar = $id('pat-hist-bar');
    if (histBar) histBar.style.display = _patTab === 'historico' ? 'flex' : 'none';

    const pats = await _fetchPats();
    let entries = Object.entries(pats || {})
        .filter(([, p]) => {
            if (_patTab === 'pendentes') return p.status !== 'levantado' && p.status !== 'historico';
            // Histórico = PATs levantadas (+ antigas ainda marcadas "levantado")
            if (_patTab === 'historico') return p.status === 'historico' || p.status === 'levantado';
            return false;
        })
        .filter(([, p]) => {
            if (!_patSearchQuery) return true;
            return (p.numero || '').toLowerCase().includes(_patSearchQuery) ||
                   (p.estabelecimento || '').toLowerCase().includes(_patSearchQuery);
        })
        .sort((a, b) => (b[1].criadoEm || 0) - (a[1].criadoEm || 0));

    if (entries.length === 0) {
        const msgs = { pendentes: 'Nenhum pedido pendente.', historico: 'Sem histórico.' };
        el.innerHTML = `<div class="pat-empty">${msgs[_patTab] || ''}</div>`;
        updatePatCount();
        return;
    }

    el.innerHTML = '';

    // ── Pendentes: lista plana com KPI row ─────────────────────────────
    if (_patTab === 'pendentes') {
        const estabCount = {};
        entries.forEach(([, p]) => {
            const n = (p.estabelecimento || '').trim().toLowerCase();
            if (n) estabCount[n] = (estabCount[n] || 0) + 1;
        });

        const urgentes = entries.filter(([, p]) => _calcDias(p.criadoEm) >= 20).length;
        const isMobile = window.innerWidth < 768;

        const fragP = document.createDocumentFragment();

        if (isMobile) {
            // ── KPI row mobile: pills + botão Levantar várias ──────────────
            const kpiRow = $el('div', { className: 'pat-kpi-row' });
            kpiRow.id = 'pat-kpi-row';
            kpiRow.innerHTML = `
                <div class="pat-kpi-pill">
                    <div class="pat-kpi-label">Total Pendentes</div>
                    <div class="pat-kpi-val">${entries.length}</div>
                </div>
                <div class="pat-kpi-pill">
                    <div class="pat-kpi-label">Atrasados</div>
                    <div class="pat-kpi-val${urgentes > 0 ? ' danger' : ''}">${String(urgentes).padStart(2,'0')}</div>
                </div>
                <div class="pat-kpi-lev" id="pat-kpi-lev-btn">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="13" height="13"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                    Levantar várias
                </div>`;
            // Botão levantar várias abre o modal de selecção de funcionário
            kpiRow.querySelector('#pat-kpi-lev-btn').onclick = (e) => {
                e.stopPropagation();
                openLevantarModal();
            };
            fragP.appendChild(kpiRow);
        } else {
            // ── Count bar desktop (mantém comportamento original) ──────────
            const countBar = $el('div', { className: 'pat-count-bar' });
            countBar.innerHTML = `<span class="pat-count-lbl">${entries.length} pedido${entries.length !== 1 ? 's' : ''} pendente${entries.length !== 1 ? 's' : ''}</span>`
                + (urgentes > 0 ? `<span class="pat-count-badge">${urgentes} urgente${urgentes !== 1 ? 's' : ''} (+15 dias)</span>` : '');
            fragP.appendChild(countBar);
        }

        entries.forEach(([id, pat]) => fragP.appendChild(_buildPatCard(id, pat, 'pendentes', estabCount)));
        el.appendChild(fragP);
        updatePatCount();

        // Actualizar contador na tab
        const tabEl = $id('pat-tab-pendentes');
        if (tabEl) {
            let cnt = tabEl.querySelector('.pat-tab-cnt');
            if (!cnt) { cnt = $el('span'); cnt.className = 'pat-tab-cnt'; tabEl.appendChild(cnt); }
            cnt.textContent = entries.length;
        }
        return;
    }

    // ── Histórico: agrupadas por funcionário ─────────────────────────────
    const grupos = {};
    entries.forEach(([id, pat]) => {
        const key = pat.funcionario || '—';
        if (!grupos[key]) grupos[key] = [];
        grupos[key].push([id, pat]);
    });
    const sortedGroups = Object.entries(grupos).sort(([a], [b]) => a.localeCompare(b, 'pt'));

    const fragG = document.createDocumentFragment();
    sortedGroups.forEach(([func, items]) => {
        // Cabeçalho do grupo
        const header = $el('div', { className: 'pat-group-header' });
        header.innerHTML = `
            <div class="pat-group-info">
                <span class="pat-group-avatar">${func === '—' ? '?' : func[0].toUpperCase()}</span>
                <span class="pat-group-name">${func === '—' ? 'Sem funcionário' : func}</span>
                <span class="pat-group-count">${items.length}</span>
            </div>`;
        fragG.appendChild(header);

        items.forEach(([id, pat]) => fragG.appendChild(_buildPatCard(id, pat, _patTab, {})));
    });
    el.appendChild(fragG);
    updatePatCount();
}

function _buildPatCard(id, pat, tab, estabCount) {
    const isDesktop = window.innerWidth >= 768;
    return isDesktop
        ? _buildPatCardDesktop(id, pat, tab, estabCount)
        : _buildPatCardMobile(id, pat, tab, estabCount);
}

// ── SVGs partilhados ──────────────────────────────────────────────────────────
const _PAT_EDIT_SVG  = SVG_EDIT;
const _PAT_DEL_SVG   = SVG_DEL;
const _PAT_CHECK_SVG = SVG_CHECK;
const _PAT_ARR_SVG   = SVG_ARROW;
const _PAT_INFO_SVG  = SVG_INFO;

// ── DESKTOP: layout flex row com accent, info, localização e acção ────────────
function _buildPatCardDesktop(id, pat, tab, estabCount) {
    const isHist     = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);
    const dias       = _calcDias(pat.criadoEm);
    const urgente    = tab === 'pendentes' && dias >= 20;
    const nomeNorm   = (pat.estabelecimento || '').trim().toLowerCase();

    // Cor do accent
    let accentColor = 'var(--primary)';
    if (urgente)   accentColor = '#dc2626';
    if (isHist)    accentColor = 'var(--text-muted)';

    // Classes do card
    let cardClass = 'pat-card pat-card-desktop';
    if (isSelected) cardClass += ' pat-card-selected';
    if (isHist)     cardClass += ' pat-card-historico';
    const card = $el('div');
    card.className = cardClass;

    // ── Accent bar (flex, não absolute) ──────────────────────────────────
    const accent = $el('div', { className: 'pat-card-accent' });
    accent.style.background = accentColor;
    card.appendChild(accent);

    // ── Body principal ────────────────────────────────────────────────────
    const body = $el('div', { className: 'pat-card-body-desktop' });

    // Top: badges + dias
    const topRow = $el('div', { className: 'pat-card-top' });
    const topLeft = $el('div', { className: 'pat-card-top-left' });

    // Checkbox selecção
    if (_patSelMode) {
        const cb = $el('span');
        cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');
        cb.innerHTML = isSelected ? _PAT_CHECK_SVG : '';
        topLeft.appendChild(cb);
    }

    // Badge número PAT
    const patBadge = $el('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || '—');
    topLeft.appendChild(patBadge);

    // Badge duplicados
    if (tab === 'pendentes') {
        const dupCount = estabCount[nomeNorm] || 0;
        if (dupCount > 1) {
            const dupBadge = $el('span', { className: 'pat-dup-badge' });
            dupBadge.dataset.estab = nomeNorm;
            dupBadge.textContent   = `! ${dupCount} pedidos`;
            topLeft.appendChild(dupBadge);
        }
    }

    // Dias / data
    const diasSpan = $el('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && (pat.saidaEm || pat.levantadoEm)) {
        diasSpan.textContent = new Date(pat.saidaEm || pat.levantadoEm).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    } else {
        diasSpan.textContent = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
    }
    topRow.appendChild(topLeft);
    topRow.appendChild(diasSpan);

    // Estabelecimento
    const estabDiv = $el('div', { className: 'pat-card-estab' });
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    // Meta: técnico + data criação
    const metaRow = $el('div', { className: 'pat-card-meta' });
    const USER_SVG = SVG_USER;
    const CAL_SVG  = SVG_CAL;
    if (pat.funcionario || pat.criadoEm) {
        // insertAdjacentHTML não re-parseia o conteúdo existente (innerHTML +=
        // parseia tudo e pode perder listeners).
        if (pat.funcionario) metaRow.insertAdjacentHTML('beforeend', `<span>${USER_SVG} ${escapeHtml(pat.funcionario)}</span>`);
        if (pat.criadoEm)   metaRow.insertAdjacentHTML('beforeend', `<span>${CAL_SVG} ${new Date(pat.criadoEm).toLocaleDateString('pt-PT')}</span>`);
    }

    // Produtos chips
    const prodsDiv = $el('div', { className: 'pat-card-produtos' });
    (pat.produtos || []).forEach(p => {
        const chip = $el('span', { className: 'pat-prod-chip' });
        chip.textContent = (p.codigo || '?') + ' × ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    body.appendChild(topRow);
    body.appendChild(estabDiv);
    if (metaRow.children.length > 0 || metaRow.innerHTML) body.appendChild(metaRow);

    if ((pat.produtos || []).length > 0) body.appendChild(prodsDiv);

    if (pat.obs) {
        const obsDiv = $el('div', { className: 'pat-card-obs' });
        obsDiv.textContent = pat.obs;
        body.appendChild(obsDiv);
    }

    card.appendChild(body);

    // ── Localização ───────────────────────────────────────────────────────
    if (pat.localidade || pat.morada) {
        const locDiv = $el('div', { className: 'pat-card-loc' });
        locDiv.innerHTML = `<span class="pat-card-loc-label">Localização</span>
                            <span class="pat-card-loc-val">${pat.localidade || pat.morada || ''}</span>`;
        card.appendChild(locDiv);
    }

    // ── Acção ─────────────────────────────────────────────────────────────
    const actionDiv = $el('div', { className: 'pat-card-action' });
    actionDiv.onclick   = e => e.stopPropagation();

    if (_patSelMode) {
        const btnRefs = $el('button', { className: 'pat-btn-refs' });
        btnRefs.innerHTML = _PAT_EDIT_SVG + ' Refs';
        btnRefs.onclick = e => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.innerHTML = _PAT_CHECK_SVG + ' Levantar ' + _PAT_ARR_SVG;
        btnLev.onclick   = () => marcarPatLevantado(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionDiv.appendChild(btnEdit);
        actionDiv.appendChild(btnLev);
        actionDiv.appendChild(btnDel);
    } else if (tab === 'historico') {
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionDiv.appendChild(btnDel);
    }

    if (actionDiv.children.length > 0) card.appendChild(actionDiv);

    card.onclick = e => {
        if (_patSelMode) {
            if (_patSelIds.has(id)) _patSelIds.delete(id); else _patSelIds.add(id);
            _updateLevantarBtn();
            renderPats();
            return;
        }
        const badge = e.target.closest('.pat-dup-badge');
        if (badge) { showDupPopover(badge, badge.dataset.estab); return; }
        openPatDetail(id, pat);
    };
    return card;
}

// ── MOBILE: layout original com bar absolute e acções em baixo ────────────────
function _buildPatCardMobile(id, pat, tab, estabCount) {
    const card = $el('div');
    const isHist     = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);
    const dias       = _calcDias(pat.criadoEm);
    const urgente    = tab === 'pendentes' && dias >= 20;
    const nomeNorm   = (pat.estabelecimento || '').trim().toLowerCase();

    let cardClass = 'pat-card';
    if (urgente)               cardClass += ' pat-card-urgente';
    if (isHist)                cardClass += ' pat-card-historico';
    if (isSelected)            cardClass += ' pat-card-selected';
    card.className = cardClass;

    const bar = $el('div', { className: 'pat-card-bar' });
    card.appendChild(bar);

    const body = $el('div', { className: 'pat-card-body' });

    const cardTop = $el('div', { className: 'pat-card-top' });
    const cardTopLeft = $el('div', { className: 'pat-card-top-left' });

    // Checkbox selecção (sempre visível no mobile, à direita)
    const cb = $el('div');
    cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');

    const patBadge = $el('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || '—');
    cardTopLeft.appendChild(patBadge);

    if (tab === 'pendentes') {
        const dupCount = estabCount[nomeNorm] || 0;
        if (dupCount > 1) {
            const dupBadge = $el('span', { className: 'pat-dup-badge' });
            dupBadge.dataset.estab = nomeNorm;
            dupBadge.textContent   = `! ${dupCount} pedidos`;
            cardTopLeft.appendChild(dupBadge);
        }
    }

    const diasSpan = $el('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && (pat.saidaEm || pat.levantadoEm)) {
        const refTs = pat.saidaEm || pat.levantadoEm;
        diasSpan.textContent = new Date(refTs).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
        // a expirar (faltam 7 dias ou menos para os 6 meses): data mais discreta
        const diasRestantes = Math.ceil((_patHistoricoExpiraEm(refTs) - Date.now()) / 86400000);
        if (diasRestantes <= 7) diasSpan.style.color = 'var(--text-muted)';
    } else {
        diasSpan.textContent = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
    }
    cardTop.appendChild(cardTopLeft);
    // Modo selecção: mostra checkbox; normal: mostra dias
    cardTop.appendChild(_patSelMode ? cb : diasSpan);

    const estabDiv = $el('div', { className: 'pat-card-estab' });
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    // Meta: técnico + data
    const metaMobile = $el('div', { className: 'pat-card-meta-mobile' });
    const _M_USER = SVG_USER;
    const _M_CAL  = SVG_CAL;
    if (pat.funcionario) metaMobile.insertAdjacentHTML('beforeend', `<span>${_M_USER} ${escapeHtml(pat.funcionario)}</span>`);
    if (pat.criadoEm)    metaMobile.insertAdjacentHTML('beforeend', `<span>${_M_CAL} ${new Date(pat.criadoEm).toLocaleDateString('pt-PT')}</span>`);

    const prodsDiv = $el('div', { className: 'pat-card-produtos' });
    (pat.produtos || []).forEach(p => {
        const chip = $el('span', { className: 'pat-prod-chip' });
        chip.textContent = (p.codigo || '?') + ' × ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    const MAP_SVG = SVG_MAP;

    const actionsDiv = $el('div', { className: 'pat-card-actions' });
    actionsDiv.onclick   = e => e.stopPropagation();

    if (_patSelMode) {
        const btnRefs = $el('button', { className: 'pat-btn-refs' });
        btnRefs.innerHTML = _PAT_EDIT_SVG + ' Refs';
        btnRefs.onclick = e => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionsDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.innerHTML = _PAT_CHECK_SVG + ' Levantar ' + _PAT_ARR_SVG;
        btnLev.onclick   = () => marcarPatLevantado(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        const btnMapa = $el('button', { className: 'pat-btn-mapa' });
        btnMapa.innerHTML = MAP_SVG + (pat.localidade || pat.morada || 'Mapa');
        btnMapa.onclick   = () => openPatMap();
        actionsDiv.appendChild(btnEdit);
        actionsDiv.appendChild(btnLev);
        actionsDiv.appendChild(btnDel);
        actionsDiv.appendChild(btnMapa);
    } else if (tab === 'historico') {
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionsDiv.appendChild(btnDel);
    }

    body.appendChild(cardTop);
    body.appendChild(estabDiv);
    if (metaMobile.innerHTML) body.appendChild(metaMobile);
    if (pat.obs) {
        const obsDiv = $el('div', { className: 'pat-card-obs' });
        obsDiv.textContent = pat.obs;
        body.appendChild(obsDiv);
    }
    if ((pat.produtos || []).length > 0) body.appendChild(prodsDiv);
    if (actionsDiv.children.length > 0) body.appendChild(actionsDiv);
    card.appendChild(body);

    card.onclick = e => {
        if (_patSelMode) {
            if (_patSelIds.has(id)) _patSelIds.delete(id); else _patSelIds.add(id);
            _updateLevantarBtn();
            renderPats();
            return;
        }
        const badge = e.target.closest('.pat-dup-badge');
        if (badge) { showDupPopover(badge, badge.dataset.estab); return; }
        openPatDetail(id, pat);
    };
    return card;
}

function setPatTab(tab) {
    _patTab      = tab;
    _patSelMode  = false;
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    const searchEl = $id('pat-search');
    if (searchEl) searchEl.value = '';
    _patSearchQuery = '';
    renderPats();
}

// ── Levantar PAT — menu de seleção de funcionário ─────────────
// Não se levanta nenhuma PAT sem funcionário: este menu abre SEMPRE antes.
//   openLevantarModal()                  → "Levantar várias" (entra no modo de seleção)
//   openLevantarModal(w => ..., 'PAT 1') → escolhe o funcionário para UMA PAT
async function openLevantarModal(onPick = null, subtitulo = '') {
    const modal = $id('levantar-modal');
    const list  = $id('levantar-worker-list');
    if (!modal || !list) return;
    const desc = $id('levantar-modal-desc');
    if (desc) desc.textContent = subtitulo ? `Quem vai levantar a ${subtitulo}?` : 'Quem vai levantar?';

    list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem">A carregar...</div>';
    modal.classList.add('active');

    const data = await fetchCollection('funcionarios');
    const workers = Object.values(data || {}).sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));

    list.innerHTML = '';
    if (!workers.length) {
        list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem">Sem funcionários registados — adiciona-os em Administração → Funcionários. Sem funcionário não é possível levantar PATs.</div>';
        return;
    }
    workers.forEach(w => {
        const opt = $el('div', { className: 'worker-option' });
        opt.textContent = w.nome;
        opt.onclick     = () => { closeLevantarModal(); if (onPick) onPick(w.nome); else startLevantarMode(w.nome); };
        list.appendChild(opt);
    });
}
function closeLevantarModal() {
    $id('levantar-modal')?.classList.remove('active');
}

// ── Modo de seleção para levantar ─────────────────────────
function startLevantarMode(workerNome) {
    _patTab       = 'pendentes';
    _patSelMode   = true;
    _patSelWorker = workerNome;
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'flex';
    const workerEl = $id('pat-sel-worker');
    if (workerEl) workerEl.textContent = workerNome;
    _updateLevantarBtn();
    renderPats();
}

function cancelLevantarMode() {
    _patSelMode   = false;
    _patSelWorker = '';
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    renderPats();
}

function patSelToggleAll() {
    const pats = _patCache.data || {};
    // Só selecciona PATs pendentes (tab activo no modo levantar)
    const pendentes = Object.entries(pats).filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');
    const allSelected = pendentes.length > 0 && pendentes.every(([id]) => _patSelIds.has(id));
    if (allSelected) {
        _patSelIds.clear();
    } else {
        pendentes.forEach(([id]) => _patSelIds.add(id));
    }
    _updateLevantarBtn();
    renderPats();
}

function _updateLevantarBtn() {
    const btn = $id('pat-levantar-btn');
    if (!btn) return;
    btn.textContent = `Levantar ${_patSelIds.size}`;
    btn.disabled    = _patSelIds.size === 0;
}

async function levantarSelectedPats() {
    if (_patSelIds.size === 0) return;
    const ids    = [..._patSelIds];
    const worker = _patSelWorker;
    const plural = n => n > 1 ? 's' : '';

    const prev = await _patLevantarPreview(ids);

    openConfirmModal({
        title: `Levantar ${ids.length} PAT${plural(ids.length)}?`,
        type: 'success', okLabel: 'Levantar',
        desc: `Serão marcadas como levantadas por ${worker}. O stock dos produtos de cada PAT será descontado automaticamente.`,
        onConfirm: async () => {
            // Mostrar feedback imediato
            const levBtn = $id('pat-levantar-btn');
            if (levBtn) { levBtn.disabled = true; levBtn.textContent = 'A processar...'; }
            try {
                // 1 — Marca as PATs (em paralelo). As que falharem são revertidas
                //     e não descontam stock.
                const flags = await Promise.all(ids.map(id => _patMarcarLevantado(id, { funcionario: worker })));
                const okIds = ids.filter((_, i) => flags[i]);
                if (!okIds.length) {
                    showToast('Erro ao levantar pedidos', 'error');
                    if (levBtn) { levBtn.disabled = false; levBtn.textContent = `Levantar ${_patSelIds.size}`; }
                    renderPats();
                    return;
                }

                // 2 — Desconta o stock só das PATs efectivamente levantadas
                const res = await _patDescontarStock(okIds);
                res.patFail = ids.length - okIds.length;

                cancelLevantarMode();
                renderList();
                updatePatCount();
                _patLevantarResumo(res, `${okIds.length} PAT${plural(okIds.length)} levantada${plural(okIds.length)} por ${worker}!`);
            } catch(_e) {
                showToast('Erro ao levantar pedidos', 'error');
                if (levBtn) { levBtn.disabled = false; levBtn.textContent = `Levantar ${_patSelIds.size}`; }
            }
        }
    });
    _patLevantarSlot(prev);
}

async function limparTabActual() {
    // Só existe no Histórico (inclui PATs antigas ainda marcadas "levantado")
    const alvo = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === 'historico' || p.status === 'levantado');
    if (!alvo.length) { showToast('Nada para limpar.', 'info'); return; }

    openConfirmModal({
        title: `Limpar ${alvo.length} registo${alvo.length > 1 ? 's' : ''}?`,
        type: 'danger',
        desc: 'Remove todas as PATs do histórico. Esta acção é irreversível.',
        onConfirm: async () => {
            try {
                // Guardar snapshots de todos os meses afectados ANTES de apagar.
                // Dedup por mês (local time — consistente com _mesRange/_calcDias).
                const mesesVistos = new Set();
                for (const [, pat] of alvo) {
                    const d = new Date(pat.levantadoEm || pat.saidaEm || pat.criadoEm || Date.now());
                    const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                    if (!mesesVistos.has(mk)) {
                        mesesVistos.add(mk);
                        await _relSalvarSnapshotSePreciso(mk);
                    }
                }
                for (const [id] of alvo) {
                    await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' });
                    delete _patCache.data[id];
                }
                renderPats();
                showToast(`${alvo.length} registo${alvo.length > 1 ? 's' : ''} removido${alvo.length > 1 ? 's' : ''}!`);
            } catch(_e) { showToast('Erro ao limpar', 'error'); }
        }
    });
}

// ── Editar referências de uma PAT (modo levantar) ────────────────────────
let _patRefsId  = null;
let _patRefsList = []; // {id|null, codigo, nome, quantidade}
let _patRefsDDIdx = -1;

function openPatRefsModal(id, pat) {
    _patRefsId   = id;
    _patRefsList = (pat.produtos || []).map(p => ({ ...p }));
    $id('pat-refs-title').textContent  = 'PAT ' + (pat.numero || '');
    $id('pat-refs-estab').textContent  = pat.estabelecimento || '';
    $id('pat-refs-search').value       = '';
    $id('pat-refs-dropdown').innerHTML = '';
    _renderRefsChips();
    modalOpen('pat-refs-modal');
    focusModal('pat-refs-modal');
    setTimeout(() => $id('pat-refs-search').focus(), 80);
}

function closePatRefsModal() {
    modalClose('pat-refs-modal');
    _patRefsId = null;
}

function patRefsSearch(val) {
    _patRefsDDIdx = -1;
    const dd = $id('pat-refs-dropdown');
    const q  = val.trim().toLowerCase();
    if (!q) { dd.innerHTML = ''; return; }

    const stock = cache.stock.data || {};
    const matches = Object.entries(stock)
        .filter(([id, item]) => {
            if (_patRefsList.some(p => p.id === id)) return false;
            const codigo = (item.codigo || '').toLowerCase();
            const nome   = (item.nome   || '').toLowerCase();
            return codigo.startsWith(q) || nome.includes(q);
        })
        .slice(0, 8);

    dd.innerHTML = '';

    // Opção de adicionar manualmente se não há resultado exacto
    const exactMatch = Object.values(stock).some(i => (i.codigo||'').toLowerCase() === q);
    if (!exactMatch) {
        const manual = $el('div', { className: 'pat-dd-option pat-dd-manual' });
        manual.innerHTML = `<span class="pat-dd-code">${escapeHtml(val.trim().toUpperCase())}</span><span class="pat-dd-name" style="color:var(--text-muted)">→ Adicionar manual</span>`;
        manual.onmousedown = (e) => { e.preventDefault(); patRefsAddManual(val.trim()); };
        dd.appendChild(manual);
    }

    matches.forEach(([id, item], i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        opt.innerHTML = `
            <span class="pat-dd-code">${escapeHtml((item.codigo||'SEMREF').toUpperCase())}</span>
            <span class="pat-dd-name">${escapeHtml(item.nome||'')}</span>
            <span class="pat-dd-stock">Stock: ${item.quantidade||0}</span>`;
        opt.onmousedown = (e) => { e.preventDefault(); patRefsAddFromStock(id, item); };
        dd.appendChild(opt);
    });

    if (!matches.length && exactMatch) {
        dd.innerHTML = '<div class="pat-dd-empty">Já adicionado</div>';
    }
}

function patRefsKeydown(e) {
    const dd   = $id('pat-refs-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    const val  = $id('pat-refs-search').value.trim();
    if (e.key === 'Enter') {
        e.preventDefault();
        if (_patRefsDDIdx >= 0 && opts[_patRefsDDIdx]) {
            opts[_patRefsDDIdx].dispatchEvent(new MouseEvent('mousedown'));
        } else if (val) {
            patRefsAddManual(val);
        }
        return;
    }
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _patRefsDDIdx = Math.min(_patRefsDDIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patRefsDDIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _patRefsDDIdx = Math.max(_patRefsDDIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patRefsDDIdx));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

function patRefsAddFromStock(id, item) {
    if (_patRefsList.some(p => p.id === id)) return;
    _patRefsList.push({ id, codigo: (item.codigo||'SEMREF').toUpperCase(), nome: item.nome||'', quantidade: 1 });
    $id('pat-refs-search').value = '';
    $id('pat-refs-dropdown').innerHTML = '';
    $id('pat-refs-search').focus();
    _renderRefsChips();
}

function patRefsAddManual(raw) {
    const codigo = raw.toUpperCase().trim();
    if (!codigo) return;
    // Agora que TODAS as PATs descontam stock, tenta ligar a referência ao artigo certo.
    const f = findStockByCodigo(codigo);
    if (f.status === 'one') {
        patRefsAddFromStock(f.id, f.item);
        showToast(`Ligado ao stock: ${f.item.nome || f.item.codigo}`);
        return;
    }
    if (f.status === 'multi') {
        showToast(`«${codigo}» existe ${f.count}× no stock — escolhe o artigo na lista`, 'error');
        return;
    }
    if (_patRefsList.some(p => p.codigo === codigo && !p.id)) return;
    _patRefsList.push({ id: null, codigo, nome: '', quantidade: 1 });
    $id('pat-refs-search').value = '';
    $id('pat-refs-dropdown').innerHTML = '';
    $id('pat-refs-search').focus();
    _renderRefsChips();
    showToast(`«${codigo}» não existe no stock — não vai ser descontado`, 'error');
}

function patRefsRemove(codigo) {
    _patRefsList = _patRefsList.filter(p => p.codigo !== codigo);
    _renderRefsChips();
}

function patRefsSetQty(codigo, val) {
    const p = _patRefsList.find(x => x.codigo === codigo);
    if (p) p.quantidade = Math.max(1, parseInt(val) || 1);
}

function _renderRefsChips() {
    const el = $id('pat-refs-chips');
    el.innerHTML = '';
    _patRefsList.forEach(p => {
        const chip = $el('div', { className: 'pat-chip' + (p.id ? '' : ' pat-chip-orphan') });
        chip.innerHTML = `
            <div class="pat-chip-info">
                <span class="pat-chip-code">${escapeHtml(p.codigo)}</span>
                ${p.nome ? `<span class="pat-chip-name">${escapeHtml(p.nome)}</span>` : '<span class="pat-chip-name pat-chip-warn">sem ligação — não desconta</span>'}
            </div>
            <input type="number" class="pat-chip-qty" value="${p.quantidade||1}" min="1"
                onchange="patRefsSetQty('${escapeHtml(p.codigo)}', this.value)"
                oninput="patRefsSetQty('${escapeHtml(p.codigo)}', this.value)">
            <button class="pat-chip-remove" onclick="patRefsRemove('${escapeHtml(p.codigo)}')">✕</button>`;
        el.appendChild(chip);
    });
}

async function savePatRefs() {
    if (!_patRefsId) return;
    const btn = document.querySelector('#pat-refs-modal .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'A guardar...'; }
    // Última tentativa de ligar ao stock as referências que ficaram à mão (o stock pode ter carregado depois)
    _patRefsList.forEach(p => {
        if (p.id) return;
        const f = findStockByCodigo(p.codigo);
        if (f.status === 'one') { p.id = f.id; p.nome = p.nome || f.item.nome || ''; }
    });
    const produtos = _patRefsList.map(p => ({
        id:         p.id   || null,
        codigo:     p.codigo,
        nome:       p.nome || '',
        quantidade: p.quantidade || 1
    }));
    try {
        await apiFetch(`${BASE_URL}/pedidos/${_patRefsId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ produtos }),
        });
        if (_patCache.data?.[_patRefsId]) _patCache.data[_patRefsId].produtos = produtos;
        closePatRefsModal();
        renderPats();
        showToast('Referências actualizadas!');
    } catch(_e) {
        showToast('Erro ao guardar', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
}

function openPatModal() {
    _patProducts = [];
    $id('pat-edit-id').value            = '';
    $id('pat-numero').value              = '';
    $id('pat-numero').readOnly           = false;
    $id('pat-cliente-num').value         = '';
    $id('pat-cliente-id').value          = '';
    $id('pat-client-dropdown').innerHTML = '';
    $id('pat-estabelecimento').value     = '';
    const estabDd = $id('pat-estab-dropdown');
    if (estabDd) estabDd.innerHTML = '';
    if (typeof _removeEstabOutsideListener === 'function') _removeEstabOutsideListener();
    $id('pat-product-search').value      = '';
    $id('pat-product-dropdown').innerHTML = '';
    $id('pat-product-chips').innerHTML   = '';
    $id('pat-numero-hint').textContent   = '';
    $id('pat-obs') && ($id('pat-obs').value = '');
    $id('pat-modal-title').textContent   = 'Novo Pedido';
    _fetchClientes();
    modalOpen('pat-modal');
    focusModal('pat-modal');
    setTimeout(() => $id('pat-numero').focus(), 80);
}

async function openEditPat(id, pat) {
    // Preencher o modal com os dados da PAT existente
    _patProducts = (pat.produtos || []).map(p => ({ ...p }));

    $id('pat-edit-id').value            = id;
    $id('pat-modal-title').textContent  = `Editar PAT ${pat.numero || ''}`;
    $id('pat-numero').value             = pat.numero || '';
    $id('pat-numero').readOnly          = true; // nº PAT não pode ser alterado
    $id('pat-numero-hint').textContent  = '';
    $id('pat-obs') && ($id('pat-obs').value = pat.obs || '');

    // Cliente — tentar preencher clienteId se estiver em falta
    let clienteId = pat.clienteId || '';
    const clienteNum = pat.clienteNumero || '';
    const estab      = pat.estabelecimento || '';

    if (!clienteId && (clienteNum || estab)) {
        // Tentar encontrar o clienteId automaticamente
        await _fetchClientes();
        const match = _findClienteByEstab(estab, clienteNum, '');
        if (match) {
            clienteId = match[0];
            // Guardar na PAT para futuras utilizações
            apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clienteId })
            }).catch(() => {});
            if (_patCache.data?.[id]) _patCache.data[id].clienteId = clienteId;
        }
    }

    $id('pat-cliente-num').value         = clienteNum;
    $id('pat-cliente-id').value          = clienteId;
    $id('pat-client-dropdown').innerHTML = '';
    $id('pat-estabelecimento').value     = estab;
    const estabDdEdit = $id('pat-estab-dropdown');
    if (estabDdEdit) estabDdEdit.innerHTML = '';
    if (typeof _removeEstabOutsideListener === 'function') _removeEstabOutsideListener();

    // Renderizar chips de produtos
    $id('pat-product-chips').innerHTML = '';
    _renderPatChips();
    $id('pat-product-search').value      = '';
    $id('pat-product-dropdown').innerHTML = '';

    _fetchClientes();
    modalOpen('pat-modal');
    focusModal('pat-modal');
    setTimeout(() => $id('pat-estabelecimento').focus(), 80);
}

function closePatModal() {
    modalClose('pat-modal');
    $id('pat-product-dropdown').innerHTML = '';
    const estabDd  = $id('pat-estab-dropdown');
    const clientDd = $id('pat-client-dropdown');
    if (estabDd)  estabDd.innerHTML  = '';
    if (clientDd) clientDd.innerHTML = '';
    if (typeof _removeEstabOutsideListener  === 'function') _removeEstabOutsideListener();
    if (typeof _removeClientOutsideListener === 'function') _removeClientOutsideListener();
}

function patProductSearch(val) {
    _patDropdownIdx = -1;
    const dd = $id('pat-product-dropdown');
    const q = val.trim().toLowerCase();
    if (!q) { dd.innerHTML = ''; return; }

    const stock = cache.stock.data || {};
    const matches = Object.entries(stock)
        .filter(([id, item]) => {
            if (_patProducts.some(p => p.id === id)) return false;
            const codigo = (item.codigo || '').toLowerCase();
            const nome   = (item.nome   || '').toLowerCase();
            return codigo.startsWith(q) || nome.includes(q);
        })
        .slice(0, 8);

    if (matches.length === 0) {
        dd.innerHTML = '<div class="pat-dd-empty">Sem resultados</div>';
        return;
    }

    dd.innerHTML = '';
    matches.forEach(([id, item], i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        const stockQty = item.quantidade || 0;
        opt.innerHTML = `
            <span class="pat-dd-code">${escapeHtml((item.codigo||'SEMREF').toUpperCase())}</span>
            <span class="pat-dd-name">${escapeHtml(item.nome||'')}</span>
            <span class="pat-dd-stock">Stock: ${stockQty}</span>`;
        opt.onmousedown = (e) => { e.preventDefault(); patAddProduct(id, item); };
        dd.appendChild(opt);
    });
}

function patProductKeydown(e) {
    const dd = $id('pat-product-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _patDropdownIdx = Math.min(_patDropdownIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patDropdownIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _patDropdownIdx = Math.max(_patDropdownIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patDropdownIdx));
    } else if (e.key === 'Enter' && _patDropdownIdx >= 0) {
        e.preventDefault();
        opts[_patDropdownIdx]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

function patAddProduct(id, item) {
    if (_patProducts.some(p => p.id === id)) return;
    _patProducts.push({
        id,
        codigo: (item.codigo || 'SEMREF').toUpperCase(),
        nome: item.nome || '',
        quantidade: 1,
        stockDisponivel: item.quantidade || 0
    });
    _renderPatChips();
    $id('pat-product-search').value = '';
    $id('pat-product-dropdown').innerHTML = '';
    $id('pat-product-search').focus();
}

function patRemoveProduct(id) {
    _patProducts = _patProducts.filter(p => p.id !== id);
    _renderPatChips();
}

function patSetQty(id, val) {
    const prod = _patProducts.find(p => p.id === id);
    if (!prod) return;
    const n = Math.max(1, parseInt(val) || 1);
    prod.quantidade = n;
    // Actualiza visualmente o input sem re-renderizar tudo
    const inp = document.querySelector(`.pat-chip[data-id="${id}"] .pat-chip-qty`);
    if (inp && inp !== document.activeElement) inp.value = n;
}

function _renderPatChips() {
    const el = $id('pat-product-chips');
    el.innerHTML = '';
    _patProducts.forEach(p => {
        const chip = $el('div', { className: 'pat-chip' });
        chip.dataset.id = p.id;
        chip.innerHTML = `
            <div class="pat-chip-info">
                <span class="pat-chip-code">${escapeHtml(p.codigo)}</span>
                <span class="pat-chip-name">${escapeHtml(p.nome)}</span>
            </div>
            <div class="pat-chip-controls">
                <span class="pat-chip-stock-label">Stock: ${p.stockDisponivel}</span>
                <div class="pat-chip-qty-wrap">
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',-1)">−</button>
                    <input class="pat-chip-qty" type="number" min="1" value="${p.quantidade}"
                        onchange="patSetQty('${p.id}',this.value)"
                        onblur="patSetQty('${p.id}',this.value)">
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',1)">+</button>
                </div>
                <button class="pat-chip-remove" onclick="patRemoveProduct('${p.id}')" aria-label="Remover">×</button>
            </div>`;
        el.appendChild(chip);
    });
}

function patQtyStep(id, delta) {
    const prod = _patProducts.find(p => p.id === id);
    if (!prod) return;
    prod.quantidade = Math.max(1, (prod.quantidade || 1) + delta);
    const inp = document.querySelector(`.pat-chip[data-id="${id}"] .pat-chip-qty`);
    if (inp) inp.value = prod.quantidade;
}

async function savePat() {
    const editId     = $id('pat-edit-id').value.trim();
    const isEdit     = !!editId;
    const numero     = $id('pat-numero').value.trim();
    let clienteNum   = $id('pat-cliente-num').value.trim();
    let clienteId    = $id('pat-cliente-id').value.trim() || null;
    const estab      = $id('pat-estabelecimento').value.trim().toUpperCase();

    // Se o utilizador escreveu o nome exacto de um cliente existente sem clicar no dropdown,
    // associa-o automaticamente. Se não existir em /clientes, grava a PAT na mesma sem erro.
    if (!clienteId && estab && typeof _clientesCache !== 'undefined' && _clientesCache.data) {
        const estabKey = _normEstabKey(estab);
        const exacts = Object.entries(_clientesCache.data).filter(([, c]) =>
            c && c.nome && _normEstabKey(c.nome) === estabKey
        );
        let matched = null;
        if (exacts.length === 1) {
            matched = exacts[0];
        } else if (exacts.length > 1 && clienteNum) {
            matched = exacts.find(([, c]) => String(c.numero || '').trim() === clienteNum) || null;
        }
        if (matched) {
            clienteId = matched[0];
            if (!clienteNum && matched[1].numero) clienteNum = String(matched[1].numero).trim();
        }
    }
    const obs        = ($id('pat-obs')?.value || '').trim();
    const hint       = $id('pat-numero-hint');

    if (!/^\d{6}$/.test(numero)) {
        hint.textContent = 'O Nº PAT deve ter exactamente 6 dígitos.';
        hint.style.color = 'var(--danger)';
        $id('pat-numero').focus();
        return;
    }
    hint.textContent = '';

    // Verificar duplicado — só na criação
    // Verifica primeiro no cache local (rápido), depois confirma na Firebase
    // para proteger contra dois utilizadores a criar a mesma PAT em simultâneo.
    if (!isEdit) {
        const patsExistentes = Object.values(_patCache.data || {});
        const duplicadoLocal = patsExistentes.find(p => p.numero === numero && p.status !== 'levantado' && p.status !== 'historico');
        if (duplicadoLocal) {
            hint.textContent = `PAT ${numero} já está registada (${duplicadoLocal.estabelecimento || 'sem estabelecimento'}).`;
            hint.style.color = 'var(--danger)';
            $id('pat-numero').focus();
            return;
        }
        // Confirmação remota — protege contra race condition multi-utilizador
        if (navigator.onLine) {
            try {
                const checkUrl = await authUrl(`${BASE_URL}/pedidos.json?orderBy="numero"&equalTo="${numero}"`);
                const checkRes = await fetch(checkUrl);
                if (checkRes.ok) {
                    const remote = await checkRes.json();
                    if (remote && typeof remote === 'object') {
                        const remoteActive = Object.values(remote).find(p => p.status !== 'levantado' && p.status !== 'historico');
                        if (remoteActive) {
                            hint.textContent = `PAT ${numero} já está registada por outro utilizador.`;
                            hint.style.color = 'var(--danger)';
                            $id('pat-numero').focus();
                            // Actualiza cache local com o que o servidor tem
                            _patCache.lastFetch = 0;
                            return;
                        }
                    }
                }
            } catch(e) {
                console.warn('[savePat] verificação remota de duplicado falhou:', e?.message);
                // Não bloquear — continua com a verificação local
            }
        }
    }

    if (isEdit) {
        // ── Modo edição — PATCH só os campos editáveis ────────────────────
        const patchPayload = {
            clienteNumero:   clienteNum || null,
            clienteId:       clienteId  || null,
            estabelecimento: estab,
            obs:             obs || null,
            produtos: _patProducts.map(p => ({
                id: p.id, codigo: p.codigo, nome: p.nome, quantidade: p.quantidade || 1
            })),
        };
        try {
            await apiFetch(`${BASE_URL}/pedidos/${editId}.json`, {
                method: 'PATCH',
                body: JSON.stringify(patchPayload),
            });
            if (_patCache.data?.[editId]) {
                _patCache.data[editId] = { ..._patCache.data[editId], ...patchPayload };
            }
            closePatModal();
            renderPats();
            showToast(`PAT ${numero} actualizada`);
        } catch(_e) { showToast('Erro ao guardar edição', 'error'); }
    } else {
        // ── Modo criação — POST novo ───────────────────────────────────────
        const payload = {
            numero,
            clienteNumero: clienteNum || null,
            clienteId:     clienteId  || null,
            estabelecimento: estab,
            obs:           obs || null,
            produtos: _patProducts.map(p => ({
                id: p.id, codigo: p.codigo, nome: p.nome, quantidade: p.quantidade || 1
            })),
            status: 'pendente',
            criadoEm: Date.now(),
        };
        try {
            const res = await apiFetch(`${BASE_URL}/pedidos.json`, {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            if (!_patCache.data) _patCache.data = {};
            if (res) {
                const r = await res.json();
                if (r?.name) _patCache.data[r.name] = payload;
            } else {
                _patCache.data[`_tmp_pat_${Date.now()}`] = payload;
            }
            closePatModal();
            renderPats();
            showToast(res ? `PAT ${numero} registada!` : `PAT ${numero} guardada offline`);
        } catch(_e) { showToast('Erro ao guardar pedido', 'error'); }
    }
}

// ── Levantar PATs — pré-visualização, desconto de stock e resumo ─────────────
// Fluxo (igual para "Levantar" individual e para o modo de selecção múltipla):
//   1. Antes de confirmar: mostra o stock de cada artigo e avisa de faltas.
//   2. Marca as PATs como levantadas; as que falharem são revertidas e NÃO
//      descontam stock (evita descontar de PATs que continuam pendentes).
//   3. Desconta o stock dos produtos de TODAS as PATs levantadas (já não há "guia de transporte").
//   4. Se houve faltas, falhas ou artigos sem ligação ao stock, mostra um
//      resumo que o utilizador tem de ler — em vez de um "sucesso" genérico.
const _r3 = n => Math.round(n * 1000) / 1000;

// Agrega o que as PATs vão descontar, por artigo de stock (todas as PATs com produtos).
// Usa cache.stock.data (quem chama decide se o refresca antes).
function _patAggStock(ids) {
    const stock = cache.stock.data || {};
    const need = {};
    const orphan = [];
    for (const id of ids) {
        const pat = _patCache.data?.[id];
        if (!pat) continue;
        for (const p of (pat.produtos || [])) {
            const q = p.quantidade || 1;
            const sid = p.id;
            const s = sid ? stock[sid] : null;
            if (!sid || !s || String(sid).startsWith('_tmp_')) {
                orphan.push({
                    codigo: p.codigo || '', nome: p.nome || '', quantidade: q,
                    motivo: !sid ? 'sem ligação ao stock'
                          : String(sid).startsWith('_tmp_') ? 'artigo ainda não sincronizado'
                          : 'já não existe no stock',
                });
                continue;
            }
            if (!need[sid]) need[sid] = { id: sid, codigo: s.codigo || p.codigo || '', nome: s.nome || p.nome || '', unidade: s.unidade || 'un', need: 0 };
            need[sid].need = _r3(need[sid].need + q);
        }
    }
    return { need, orphan };
}

// Pré-visualização para o modal de confirmação (stock fresco do servidor).
async function _patLevantarPreview(ids) {
    if (!ids.some(id => (_patCache.data?.[id]?.produtos || []).length > 0)) return null;
    if (navigator.onLine) { try { await fetchCollection('stock', true); } catch (_) {} }
    const { need, orphan } = _patAggStock(ids);
    const stock = cache.stock.data || {};
    const lines = Object.values(need).map(l => {
        const have = Number(stock[l.id]?.quantidade) || 0;
        return { ...l, have, after: Math.max(0, _r3(have - l.need)), falta: Math.max(0, _r3(l.need - have)) };
    }).sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'pt'));
    return { lines, orphan };
}

function _lvRow(codigo, nome, valHtml, cls = '') {
    return `<div class="lv-row ${cls}"><div class="lv-main"><b>${escapeHtml(codigo)}</b><span>${escapeHtml(nome)}</span></div><div class="lv-val">${valHtml}</div></div>`;
}

// Preenche o slot do modal de confirmação (chamar DEPOIS de openConfirmModal).
function _patLevantarSlot(prev) {
    const slot = $id('confirm-modal-slot');
    if (!slot || !prev || (!prev.lines.length && !prev.orphan.length)) return;
    const faltas = prev.lines.filter(l => l.falta > 0).length;
    let html = '<div class="lv-box">';
    if (prev.lines.length) {
        html += '<div class="lv-title">Stock a descontar</div>';
        html += prev.lines.map(l => _lvRow(l.codigo, l.nome,
            `${escapeHtml(fmtQty(l.have, l.unidade))} → <strong>${escapeHtml(fmtQty(l.after, l.unidade))}</strong>`
            + (l.falta > 0 ? `<em class="lv-tag">faltam ${escapeHtml(fmtQty(l.falta, l.unidade))}</em>` : ''),
            l.falta > 0 ? 'lv-short' : '')).join('');
    }
    if (prev.orphan.length) {
        html += '<div class="lv-title lv-title-warn">Não vão ser descontados</div>';
        html += prev.orphan.map(o => _lvRow(o.codigo, o.nome, escapeHtml(o.motivo), 'lv-orphan')).join('');
    }
    if (faltas) {
        html += `<div class="lv-warn">Stock insuficiente em ${faltas} artigo${faltas > 1 ? 's' : ''}: o stock fica a 0 e a falta é indicada no fim.</div>`;
    }
    html += '</div>';
    slot.innerHTML = html;
}

// Levanta UMA PAT: vai direto para o Histórico (optimista no cache, revertido se falhar).
// Exige funcionário — nunca se levanta uma PAT sem saber quem a levantou.
async function _patMarcarLevantado(id, extra = {}) {
    const pat = _patCache.data?.[id];
    if (!pat) return false;
    if (!extra.funcionario) { console.warn('[PAT] levantar sem funcionário — bloqueado:', id); return false; }
    const prev = { status: pat.status, levantadoEm: pat.levantadoEm, saidaEm: pat.saidaEm, funcionario: pat.funcionario };
    const ts = Date.now();
    const payload = { status: 'historico', levantadoEm: ts, saidaEm: ts, ...extra };
    Object.assign(pat, payload);          // síncrono — protege contra duplo clique
    try {
        await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'PATCH', body: JSON.stringify(payload) });
        return true;
    } catch (e) {
        console.warn('[PAT] levantar falhou:', id, e?.message);
        Object.assign(pat, prev);
        return false;
    }
}

// Desconta o stock das PATs (todas as que têm produtos). Devolve o que correu mal.
async function _patDescontarStock(ids) {
    const { need, orphan } = _patAggStock(ids);
    const res = { short: [], failed: [], orphan, patFail: 0 };
    await Promise.allSettled(Object.values(need).map(async l => {
        const item = cache.stock.data?.[l.id];
        const base = Number(item?.quantidade) || 0;
        const pedido = _r3(base - l.need);                         // variação pedida: -need (o servidor limita a 0)
        if (item) item.quantidade = Math.max(0, pedido);           // optimista
        try {
            const r = await _commitStockDelta(l.id, base, pedido);
            if (cache.stock.data?.[l.id]) cache.stock.data[l.id].quantidade = r.saved;
            const movido = Math.max(0, _r3(-r.applied));           // quanto saiu MESMO do stock
            if (movido > 0) registarMovimento('saida_pat', l.id, l.codigo, l.nome, movido);
            const falta = _r3(l.need - movido);
            if (falta > 0) res.short.push({ codigo: l.codigo, nome: l.nome, falta, unidade: l.unidade });
        } catch (e) {
            console.warn('[Stock] desconto PAT falhou:', l.id, e?.message);
            if (cache.stock.data?.[l.id]) cache.stock.data[l.id].quantidade = base;   // rollback
            res.failed.push({ codigo: l.codigo, nome: l.nome, need: l.need, unidade: l.unidade });
        }
    }));
    return res;
}

// Sucesso limpo → toast. Qualquer problema → diálogo que tem de ser lido.
function _patLevantarResumo(res, okMsg) {
    if (!res.short.length && !res.failed.length && !res.orphan.length && !res.patFail) {
        showToast(okMsg);
        return;
    }
    const sec = (title, rows) => rows.length ? `<div class="lv-title lv-title-warn">${escapeHtml(title)}</div>${rows.join('')}` : '';
    let html = '<div class="lv-box">';
    if (res.patFail) {
        html += `<div class="lv-warn">${res.patFail} PAT${res.patFail > 1 ? 's' : ''} não ${res.patFail > 1 ? 'foram levantadas' : 'foi levantada'} (erro de ligação). Tenta de novo.</div>`;
    }
    html += sec('Desconto de stock falhou — ajusta manualmente',
        res.failed.map(f => _lvRow(f.codigo, f.nome, `devia sair ${escapeHtml(fmtQty(f.need, f.unidade))}`, 'lv-short')));
    html += sec('Stock insuficiente — ficou a 0',
        res.short.map(s => _lvRow(s.codigo, s.nome, `faltaram ${escapeHtml(fmtQty(s.falta, s.unidade))}`, 'lv-short')));
    html += sec('Não descontados',
        res.orphan.map(o => _lvRow(o.codigo, o.nome, escapeHtml(o.motivo), 'lv-orphan')));
    html += '</div>';
    // setTimeout: o handler do botão OK repõe o texto/estado do botão no "finally"
    // depois do onConfirm — abrir já aqui seria sobrescrito.
    setTimeout(() => {
        openConfirmModal({
            title: 'Verifica o stock', type: 'warn', okLabel: 'Entendido', hideCancel: true,
            desc: 'Concluído, mas há pontos que precisam da tua atenção:',
            onConfirm: () => {},
        });
        const slot = $id('confirm-modal-slot');
        if (slot) slot.innerHTML = html;
    }, 80);
}

async function marcarPatLevantado(id, { onDone, worker } = {}) {
    const pat = _patCache.data?.[id];
    if (!pat) return;
    // Protecção contra duplo-clique: verificar se já foi levantada (cache local)
    if (pat.status === 'levantado' || pat.status === 'historico') {
        showToast('PAT já foi levantada', 'error'); return;
    }
    // 1.º passo: escolher o funcionário (obrigatório). Só depois pede a confirmação.
    if (!worker) {
        openLevantarModal(w => marcarPatLevantado(id, { onDone, worker: w }), `PAT ${pat.numero || ''}`.trim());
        return;
    }
    const comProdutos = (pat.produtos || []).length > 0;

    const desc = comProdutos
        ? 'O stock dos produtos é descontado automaticamente.'
        : 'Não tem produtos, por isso o stock não é alterado.';

    const prev = await _patLevantarPreview([id]);

    openConfirmModal({
        title: `Levantar PAT ${pat.numero || ''}?`.replace(' ?', '?'),
        type: 'success', okLabel: 'Levantar',
        desc: `${worker} levanta esta PAT e ela passa para o Histórico. ${desc}`,
        onConfirm: async () => {
            try {
                if (['levantado', 'historico'].includes(_patCache.data?.[id]?.status)) {
                    showToast('PAT já foi levantada', 'error'); return;
                }
                // 1 — Levanta (com suporte offline). Se falhar, nada é descontado.
                const ok = await _patMarcarLevantado(id, { funcionario: worker });
                if (!ok) { showToast('Erro ao actualizar pedido', 'error'); renderPats(); return; }

                // 2 — Desconta o stock dos produtos (delta seguro em multi-utilizador)
                const res = await _patDescontarStock([id]);
                if (comProdutos) renderList();

                renderPats();
                _patLevantarResumo(res, comProdutos ? 'Levantado — stock descontado!' : 'Pedido marcado como levantado!');
                if (typeof onDone === 'function') await onDone();
            } catch(_e) { showToast('Erro ao actualizar pedido', 'error'); }
        }
    });
    _patLevantarSlot(prev);
}

async function apagarPat(id) {
    openConfirmModal({
        title: 'Apagar pedido?',
        type: 'danger',
        desc: 'O pedido será eliminado permanentemente. O stock não é alterado.',
        onConfirm: async () => {
            try {
                const pat = _patCache.data?.[id];
                // Guardar snapshot antes de apagar — garante que a PAT é contada no relatório
                if (pat) await _relSalvarPatAntesDeApagar(pat);
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' });
                if (_patCache.data) delete _patCache.data[id];
                renderPats();
                updatePatCount();
                showToast('Pedido apagado');
            } catch(_e) { showToast('Erro ao apagar pedido', 'error'); }
        }
    });
}

function openPatDetail(id, pat) {
    const dias      = _calcDias(pat.criadoEm);
    const dataStr   = pat.criadoEm ? new Date(pat.criadoEm).toLocaleDateString('pt-PT') : '—';
    const urgente   = dias >= 20;
    const body      = $id('pat-detail-body');
    body.innerHTML  = '';

    // ── Helper: criar linha de detalhe ──────────────────────────────────
    function _row(lbl, val) {
        const d = $el('div', { className: 'pat-detail-row' });
        const l = $el('span', { className: 'pat-detail-lbl' });
        l.textContent = lbl;
        const v = $el('span');
        v.textContent = val;
        d.appendChild(l); d.appendChild(v);
        return d;
    }

    // ── Header colorido ──────────────────────────────────────────────────
    const hdr = $el('div', { className: 'pat-detail-header' });
    hdr.style.cssText = [
        'text-align:left',
        'margin:-16px -16px 16px',
        'padding:16px',
        urgente
            ? 'background:#fef2f2;border-bottom:1px solid #fecaca'
            : 'background:var(--bg);border-bottom:1px solid var(--border)',
    ].join(';');

    // Linha 1: número PAT + badge estado
    const hdrTop = $el('div');
    hdrTop.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';

    const numEl = $el('span');
    numEl.style.cssText = `font-size:1.1rem;font-weight:600;color:${urgente ? '#7f1d1d' : 'var(--text-main)'}`;
    numEl.textContent = 'PAT ' + (pat.numero || '—');
    hdrTop.appendChild(numEl);

    const estadoBadge = $el('span');
    estadoBadge.style.cssText = urgente
        ? 'font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5'
        : 'font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:rgba(202,138,4,0.12);color:#92400e;border:1px solid rgba(202,138,4,0.25)';
    estadoBadge.textContent = (urgente ? '🔴 Urgente' : '🟡 Pendente') + ' · ' + (dias === 0 ? 'hoje' : `${dias}d`);
    hdrTop.appendChild(estadoBadge);

    hdr.appendChild(hdrTop);

    // Linha 2: nome do estabelecimento em destaque
    const estabEl = $el('p');
    estabEl.style.cssText = `margin:0 0 2px;font-size:15px;font-weight:500;color:${urgente ? '#7f1d1d' : 'var(--text-main)'}`;
    estabEl.textContent = pat.estabelecimento || 'Não especificado';
    hdr.appendChild(estabEl);

    // Linha 3: data
    const dateEl = $el('p');
    dateEl.style.cssText = `margin:0;font-size:12px;color:${urgente ? '#b91c1c' : 'var(--text-muted)'}`;
    dateEl.textContent = 'Criado em ' + dataStr;
    hdr.appendChild(dateEl);

    body.appendChild(hdr);

    // ── Linhas de informação ─────────────────────────────────────────────
    if (pat.funcionario) body.appendChild(_row('Levantado por', pat.funcionario));

    // ── Observações ──────────────────────────────────────────────────────
    if (pat.obs) {
        const obsLbl = $el('div', { className: 'pat-detail-lbl' });
        obsLbl.style.cssText = 'margin-top:14px;margin-bottom:6px';
        obsLbl.textContent = 'Observações';
        body.appendChild(obsLbl);
        const obsBox = $el('div');
        obsBox.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:0.875rem;color:var(--text-main);line-height:1.5;white-space:pre-wrap';
        obsBox.textContent = pat.obs;
        body.appendChild(obsBox);
    }

    // ── Produtos ─────────────────────────────────────────────────────────
    if (pat.produtos?.length) {
        const lbl = $el('div', { className: 'pat-detail-lbl' });
        lbl.style.cssText = 'margin-top:14px;margin-bottom:8px';
        lbl.textContent = 'Produtos reservados';
        body.appendChild(lbl);
        const prodsDiv = $el('div', { className: 'pat-detail-produtos' });
        pat.produtos.forEach(p => {
            const row = $el('div', { className: 'pat-detail-prod' });
            const code = $el('span', { className: 'pat-dd-code' });
            code.textContent = p.codigo || '?';
            const name = $el('span', { className: 'pat-dd-name' });
            name.textContent = p.nome || '';
            const qty = $el('span', { className: 'pat-detail-qty' });
            qty.textContent = '× ' + (p.quantidade || 1);
            row.appendChild(code); row.appendChild(name); row.appendChild(qty);
            prodsDiv.appendChild(row);
        });
        body.appendChild(prodsDiv);
    } else {
        const empty = $el('div', { className: 'pat-empty' });
        empty.style.marginTop = '12px';
        empty.textContent = 'Sem produtos associados.';
        body.appendChild(empty);
    }

    // ── Acções ───────────────────────────────────────────────────────────
    const actions = $el('div', { className: 'pat-detail-actions' });

    if (pat.status !== 'levantado' && pat.status !== 'historico') {
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.style.flex  = '1';
        btnLev.innerHTML   = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btnLev.appendChild(document.createTextNode('Dar como levantado'));
        btnLev.onclick     = () => { modalClose('pat-detail-modal'); marcarPatLevantado(id); };
        actions.appendChild(btnLev);
    }

    const btnDel = $el('button', { className: 'pat-btn-apagar' });
    btnDel.setAttribute('aria-label', 'Apagar PAT');
    btnDel.innerHTML = SVG_DEL;
    btnDel.onclick   = () => { modalClose('pat-detail-modal'); apagarPat(id); };
    actions.appendChild(btnDel);

    body.appendChild(actions);

    modalOpen('pat-detail-modal');
    focusModal('pat-detail-modal');
}
