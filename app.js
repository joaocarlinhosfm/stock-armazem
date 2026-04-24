// ─────────────────────────────────────────────────────────────────────────────
// app.js — Hiperfrio v6.62
// Lógica principal: stock, ferramentas, PATs, encomendas, mapa, inventário.
//
// DEPENDÊNCIAS (carregadas antes via index.html):
//   utils.js — BASE_URL, $id, $el, escapeHtml, showToast, fmtQty, UNITS, etc.
//   auth.js  — getAuthToken, authUrl, applyRole, handleLogin, bootApp, etc.
// ─────────────────────────────────────────────────────────────────────────────

// CACHE EM MEMÓRIA — TTL 60s
const CACHE_TTL = 300_000; // 5 min — stock de armazém não muda por segundo
const cache = {
    stock:        { data: null, lastFetch: 0 },
    ferramentas:  { data: null, lastFetch: 0 },
    funcionarios: { data: null, lastFetch: 0 },
};

const _fetchPending = {};

async function fetchCollection(name, force = false) {
    const entry   = cache[name];
    const isStale = (Date.now() - entry.lastFetch) > CACHE_TTL;
    if (!force && !isStale && entry.data !== null) return entry.data;
    if (_fetchPending[name]) return _fetchPending[name];
    _fetchPending[name] = (async () => {
        try {
            const url = await authUrl(`${BASE_URL}/${name}.json`);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data    = await res.json();
            entry.data      = data || {};
            entry.lastFetch = Date.now();
            return entry.data;
        } catch (e) {
            console.error(`Erro ao buscar ${name}:`, e);
            showToast('Erro ao carregar dados', 'error');
            return entry.data || {};
        } finally {
            delete _fetchPending[name];
        }
    })();
    return _fetchPending[name];
}

function invalidateCache(name) { cache[name].lastFetch = 0; }

// FILA OFFLINE — localStorage persistente
// Cópia em memória para evitar JSON.parse/stringify a cada mutação.
// Writes ao localStorage são debounced (400ms) + forçados no 'pagehide'/'beforeunload'.
const QUEUE_KEY = 'hiperfrio-offline-queue';
let isSyncing   = false; // FIX: evita execuções paralelas de syncQueue

const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function _pruneQueue(q) {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    return q.filter(op => !op.ts || op.ts > cutoff);
}

// Inicialização: lê uma vez da localStorage
let _queueMem = (() => {
    try { return _pruneQueue(JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')); }
    catch { return []; }
})();

let _queueSaveTimer = null;
function _queueFlush() {
    clearTimeout(_queueSaveTimer);
    _queueSaveTimer = null;
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(_queueMem)); }
    catch(e) { console.warn('[Queue] falha ao persistir:', e?.message); }
}
function _queueScheduleSave() {
    if (_queueSaveTimer) return;
    _queueSaveTimer = setTimeout(_queueFlush, 400);
}

// Garante persistência quando a aba fecha / fica em background
window.addEventListener('pagehide', _queueFlush);
window.addEventListener('beforeunload', _queueFlush);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _queueFlush();
});

// Mantém a assinatura antiga para o resto do código
function queueLoad() { return _queueMem; }
function queueSave(q) {
    // Substitui a referência em memória e agenda persistência
    _queueMem = q;
    _queueScheduleSave();
}

function queueAdd(op) {
    // Regista Background Sync ao adicionar à fila
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => sw.sync.register('hiperfrio-sync')).catch(() => {});
    }
    // FIX: só aceita mutações na fila, nunca GETs
    if (!op.method || op.method === 'GET') return;
    op.ts = Date.now(); // timestamp para TTL

    // Prune in-place (não recria array para operações baratas)
    const cutoff = Date.now() - QUEUE_TTL_MS;
    _queueMem = _queueMem.filter(o => !o.ts || o.ts > cutoff);

    // Colapsar PATCHes repetidos ao mesmo URL
    if (op.method === 'PATCH') {
        const idx = _queueMem.findIndex(o => o.method === 'PATCH' && o.url === op.url);
        if (idx !== -1) { _queueMem[idx] = op; } else { _queueMem.push(op); }
    } else {
        // FIX: ignorar operações em IDs temporários (_tmp_) para não enviar URLs inválidos
        if (op.url && op.url.includes('/_tmp_')) return;
        _queueMem.push(op);
    }
    _queueScheduleSave();
    updateOfflineBanner();
}

async function syncQueue() {
    if (isSyncing) return; // FIX: protecção contra execuções paralelas
    const q = queueLoad();
    if (q.length === 0) return;
    isSyncing = true;
    const failed = [];
    try {
        for (const op of q) {
            try {
                const opts = { method: op.method, headers: { 'Content-Type': 'application/json' } };
                if (op.body) opts.body = op.body;
                const signedUrl = await authUrl(op.url);
                const res = await fetch(signedUrl, opts);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch(_e) { console.warn('[Queue] falha ao sincronizar op:', op?.method, _e?.message); failed.push(op); }
        }
        queueSave(failed);
    } finally {
        isSyncing = false; // garante reset mesmo se ocorrer excepção inesperada
    }
    updateOfflineBanner();
    if (failed.length < q.length) {
        const synced = q.length - failed.length;
        showToast(`${synced} alteração(ões) sincronizada(s)`);
        // Invalida cache e refresca para limpar _tmp_ IDs
        invalidateCache('stock');
        invalidateCache('ferramentas');
        invalidateCache('funcionarios');
        _patCache.lastFetch = 0;
        renderList(window._searchInputEl?.value || '', true);
        renderPats();
        updatePatCount();
    }
}

// Wrapper fetch — se offline, coloca na fila
async function apiFetch(url, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (!navigator.onLine) {
        queueAdd({ method: opts.method || 'GET', url, body: opts.body || null });
        return null;
    }
    const signedUrl = await authUrl(url);
    const res = await fetch(signedUrl, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

function updateOfflineBanner() {
    const isOffline = !navigator.onLine;
    document.body.classList.toggle('is-offline', isOffline);
    const q       = queueLoad();
    const countEl = $id('offline-pending-count');
    if (countEl) {
        countEl.textContent   = q.length > 0 ? `${q.length} alteração(ões) pendente(s)` : '';
        countEl.style.display = q.length > 0 ? 'inline' : 'none';
    }
}

// NAVEGAÇÃO
// FIX: active state só actualizado após acesso confirmado
// ARQUITECTURA (#18): esta função gere routing + side-effects.
// Para refactor futuro: separar em _activateView(id) e callbacks por vista.
function nav(viewId) {
    if (viewId === 'view-admin' && !requireManagerAccess()) return;

    // Actualiza título do header
    const pageTitles = {
        'view-dashboard': 'Dashboard',
        'view-search':    'Stock',
        'view-pedidos':   'Pedidos PAT',
        'view-admin':     'Administração',
        'view-tools':     'Ferramentas',
        'view-register':  'Novo Artigo',
        'view-bulk':      'Entrada de Lote',
        'view-encomendas':'Encomendas',
        'view-guias':     'Guias Técnicos',
        'view-map':       'Mapa PAT',
    };
    const titleEl = $id('header-page-title');
    if (titleEl && pageTitles[viewId]) titleEl.textContent = pageTitles[viewId];

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $id(viewId)?.classList.add('active');

    // Desktop: admin precisa de padding 0 para o layout Windows Settings funcionar
    const mainContent = $id('main-content');
    if (mainContent) {
        mainContent.classList.remove('admin-view-active');
    }

    if (viewId === 'view-search') {
        // Limpa a pesquisa ao navegar para o stock (desktop e mobile)
        if (window._searchInputEl) {
            window._searchInputEl.value = '';
            $id('inp-search-clear')?.classList.add('hidden');
        }
        renderList('', true).then(() => {
            if (_zeroFilterActive) filterZeroStock();
            if (_pendingZeroFilter) { _pendingZeroFilter = false; filterZeroStock(); }
        });
        // Reset barra de pesquisa ao navegar para o stock
        document.querySelector('.search-container')?.classList.remove('search-scrolled-away');
        $id('search-peek-btn')?.classList.remove('visible');
    }
    if (viewId === 'view-register') { // PONTO 19: limpa form ao navegar
        const fa = $id('form-add');
        if (fa) { fa.reset(); setUnitSelector('inp','un'); $id('inp-notas').value = ''; }
    }
    if (viewId === 'view-bulk') {
        _bulkCount = 0; _updateBulkCounter();
        _refreshZoneDatalist(); // PONTO 16
        const bulkLoc = $id('bulk-loc');
        if (bulkLoc && !bulkLoc.value.trim()) bulkLoc.value = '';
    }
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-dashboard') { renderDashboard(true); }
    if (viewId === 'view-encomendas') { loadEncomendas(); }
    if (viewId === 'view-guias') {
        _guiasSearchQ = '';
        const gs = $id('guias-search');
        if (gs) gs.value = '';
        renderGuias();
    }

    if (viewId === 'view-admin') {
        // Mesmo comportamento em mobile e desktop — menu full-screen com cards
        _buildAdminMobileMenu();
    }
    if (viewId === 'view-pedidos') {
        // Limpa pesquisa ao entrar na vista para não confundir ao voltar
        _patSearchQuery = '';
        const searchEl = $id('pat-search');
        if (searchEl) searchEl.value = '';
        renderPats();
        // Desktop: carregar mapa no painel lateral automaticamente
        if (window.innerWidth >= 768) {
            setTimeout(() => _openPatMapPanel(), 200);
        }
    }
    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const sideMap = {
        'view-dashboard':'nav-dashboard',
        'view-pedidos':'nav-pedidos',
        'view-search':'nav-search','view-tools':'nav-tools','view-register':'nav-register',
        'view-bulk':'nav-bulk','view-admin':'nav-admin','view-encomendas':'nav-encomendas',
        'view-guias':'nav-guias'
    };
    $id(sideMap[viewId])?.classList.add('active');

    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bnavMap = {
        'view-dashboard':'bnav-dashboard',
        'view-search':'bnav-search',
        'view-pedidos':'bnav-pedidos',
        'view-encomendas':'bnav-encomendas'
    };
    $id(bnavMap[viewId])?.classList.add('active');

    if ($id('side-menu')?.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
    bnavAddClose(); // fecha o mini-menu ao navegar
    // Garante que o bottom nav pill está visível ao mudar de vista
    $id('bottom-nav')?.classList.remove('bnav-hidden');
    if (window.innerWidth < 768) {
        const fab = $id('fab-add');
        if (fab) fab.style.display = viewId === 'view-search' ? '' : 'none';
    }
}

// DASHBOARD — snapshot diário na Firebase
// Path: /dash-snapshots/{YYYY-MM-DD}
// Guardado 1x por dia, partilhado entre todos os dispositivos.
// Cleanup automático: mantém só os últimos 30 dias.

const DASH_SNAP_URL     = `${BASE_URL}/dash-snapshots`;
const _DASH_SNAP_WROTE_KEY = 'hiperfrio-dashsnap-wrote'; // localStorage: data do último write

// Cache em memória para evitar fetches repetidos na mesma sessão
let _dashSnapToday = null;
let _dashSnapYesterday = null;
let _dashSnapFetchedOn = null; // data em que foi feito o fetch

function _dashToday() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function _dashYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

// Guarda snapshot do dia na Firebase — só 1x por dia por dispositivo,
// mas qualquer dispositivo pode escrever se ainda não foi escrito hoje.
async function _saveDashSnapshot(total, semStock, alocadas, patPendentes, encActivas) {
    const today = _dashToday();
    const lastWrote = localStorage.getItem(_DASH_SNAP_WROTE_KEY);
    if (lastWrote === today) return; // já escrito hoje neste dispositivo
    try {
        const snap = { date: today, total, semStock, alocadas, patPendentes, encActivas, ts: Date.now() };
        await apiFetch(`${DASH_SNAP_URL}/${today}.json`, {
            method: 'PUT',
            body:   JSON.stringify(snap),
        });
        localStorage.setItem(_DASH_SNAP_WROTE_KEY, today);
        // Cleanup em background: apagar snapshots com mais de 30 dias
        _pruneDashSnapshots().catch(() => {});
    } catch(e) {
        console.warn('[dashSnap] falha ao guardar:', e?.message);
    }
}

// Carrega snapshots de hoje e ontem da Firebase (com cache em memória por sessão)
async function _loadDashSnaps() {
    const today = _dashToday();
    if (_dashSnapFetchedOn === today && _dashSnapToday !== undefined) {
        return { today: _dashSnapToday, yesterday: _dashSnapYesterday };
    }
    try {
        const [resT, resY] = await Promise.all([
            fetch(await authUrl(`${DASH_SNAP_URL}/${today}.json`)),
            fetch(await authUrl(`${DASH_SNAP_URL}/${_dashYesterday()}.json`)),
        ]);
        _dashSnapToday     = resT.ok ? await resT.json() : null;
        _dashSnapYesterday = resY.ok ? await resY.json() : null;
        _dashSnapFetchedOn = today;
    } catch(e) {
        _dashSnapToday = _dashSnapYesterday = null;
    }
    return { today: _dashSnapToday, yesterday: _dashSnapYesterday };
}

// Calcula a diferença entre valor actual e o snapshot de ontem.
// Retorna null se não houver dados de comparação.
function _getDashTrend(field, currentVal, snapYesterday) {
    if (!snapYesterday || snapYesterday[field] == null || currentVal == null) return null;
    const diff = currentVal - snapYesterday[field];
    return diff === 0 ? null : diff;
}

// Apaga snapshots com mais de 30 dias — corre 1x por semana no máximo
const _DASH_PRUNE_KEY = 'hiperfrio-dashsnap-pruned';
async function _pruneDashSnapshots() {
    const lastPrune = localStorage.getItem(_DASH_PRUNE_KEY) || '';
    const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    if (lastPrune >= weekAgo) return;
    try {
        const url  = await authUrl(`${DASH_SNAP_URL}.json`);
        const res  = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data) return;
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const old    = Object.keys(data).filter(k => k < cutoff);
        await Promise.allSettled(
            old.map(k => apiFetch(`${DASH_SNAP_URL}/${k}.json`, { method: 'DELETE' }))
        );
        localStorage.setItem(_DASH_PRUNE_KEY, _dashToday());
    } catch(e) {
        console.warn('[dashSnap] prune error:', e?.message);
    }
}

// ── renderDashboard helpers ──────────────────────────────────────────────────

function _renderDashGreeting(el, greeting, displayName, dateStr, timeStr) {
    const esc = escapeHtml;
    const greetDiv = $el('div', { className: 'dv3-greeting' });
    greetDiv.innerHTML = `
        <div class="dv3-greeting-top">
            <div>
                <div class="dv3-greeting-main">${esc(greeting)}${displayName ? ', ' + esc(displayName.split(' ')[0]) : ''}</div>
                <div class="dv3-greeting-sub">${esc(dateStr)} &middot; actualizado às ${esc(timeStr)}</div>
            </div>
            <button class="dv3-refresh-btn" id="dv3-refresh-btn" onclick="renderDashboard(true, true)" title="Actualizar" aria-label="Actualizar dashboard">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
            </button>
        </div>`;
    el.appendChild(greetDiv);
}

function _renderDashAlert(el, patUrgentes) {
    if (patUrgentes <= 0) return;
    const alert = $el('div', { className: 'dv3-alert' });
    alert.onclick   = () => nav('view-pedidos');
    alert.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>${patUrgentes} PAT${patUrgentes > 1 ? 's' : ''} com +20 dias sem levantar</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;margin-left:auto"><polyline points="9 18 15 12 9 6"/></svg>`;
    el.appendChild(alert);
}

function _renderDashKpis(el, { total, comStock, semStock, alocadas, totalFerr, alocadasHaMuito,
                                patPendentes, patUrgentes, patComGuia, patHoje,
                                encActivas, encPendentes, encParciais,
                                trendPats, trendEncomendas, trendSemStock }) {
    const esc = escapeHtml;
    const ALERTA_DIAS = 7;

    // KPI grande row: Stock + PATs
    const kpiRow = $el('div', { className: 'dv3-kpi-row' });

    const stockPct = total > 0 ? Math.round(comStock / total * 100) : 100;
    const kpiStock = $el('div', { className: 'dv3-kpi' });
    kpiStock.onclick   = () => nav('view-search');
    kpiStock.innerHTML = `
        <div class="dv3-kpi-label">Stock</div>
        <div class="dv3-kpi-val">${total}</div>
        <div class="dv3-kpi-chips">
            <span class="dv3-chip dv3-chip-green">${comStock} c/ stock</span>
            ${semStock > 0 ? `<span class="dv3-chip dv3-chip-red">${semStock} vazios</span>` : ''}
        </div>
        <div class="dv3-kpi-bar"><div class="dv3-kpi-bar-fill" style="width:${stockPct}%;background:#639922"></div></div>`;
    kpiRow.appendChild(kpiStock);

    const kpiPat = $el('div', { className: 'dv3-kpi' + (patUrgentes > 0 ? ' dv3-kpi-warn' : '') });
    kpiPat.onclick   = () => nav('view-pedidos');
    kpiPat.innerHTML = `
        <div class="dv3-kpi-label">PATs pendentes</div>
        <div class="dv3-kpi-val">${patPendentes}</div>
        <div class="dv3-kpi-chips">
            ${patUrgentes > 0 ? `<span class="dv3-chip dv3-chip-red">${patUrgentes} urgentes</span>` : ''}
            ${patComGuia  > 0 ? `<span class="dv3-chip dv3-chip-amber">${patComGuia} c/ guia</span>` : ''}
            ${patHoje     > 0 ? `<span class="dv3-chip dv3-chip-blue">${patHoje} hoje</span>` : ''}
            ${trendPats !== null ? `<span class="dv3-chip ${trendPats > 0 ? 'dv3-chip-red' : 'dv3-chip-green'}">${trendPats > 0 ? '▲' : '▼'} ${Math.abs(trendPats)} vs ontem</span>` : ''}
            ${patPendentes === 0 ? `<span class="dv3-chip dv3-chip-green">Em dia</span>` : ''}
        </div>
        <div class="dv3-kpi-bar"><div class="dv3-kpi-bar-fill" style="width:${patPendentes > 0 ? Math.min(100, patPendentes * 8) : 0}%;background:${patUrgentes > 0 ? '#E24B4A' : '#1a56db'}"></div></div>`;
    kpiRow.appendChild(kpiPat);
    el.appendChild(kpiRow);

    // KPI mini row: Ferramentas, Encomendas, Sem stock
    const miniRow = $el('div', { className: 'dv3-mini-row' });

    function _miniKpi(label, val, sub, color, warn, onClick) {
        const d = $el('div', { className: 'dv3-mini' + (warn ? ' dv3-mini-warn' : '') });
        if (onClick) d.onclick = onClick;
        d.innerHTML = `<div class="dv3-mini-label">${esc(label)}</div>
            <div class="dv3-mini-val" style="color:${color}">${esc(String(val))}</div>
            <div class="dv3-mini-sub">${sub}</div>`;
        return d;
    }

    miniRow.appendChild(_miniKpi(
        'Ferramentas', `${alocadas}/${totalFerr}`,
        alocadasHaMuito.length > 0
            ? `<span style="color:#A32D2D;font-weight:600">${alocadasHaMuito.length} em atraso</span>`
            : alocadas === 0 ? 'Todas em armazém' : `${totalFerr - alocadas} em armazém`,
        alocadasHaMuito.length > 0 ? '#BA7517' : 'var(--text-main)',
        alocadasHaMuito.length > 0, () => nav('view-tools')
    ));

    miniRow.appendChild(_miniKpi(
        'Encomendas', encActivas,
        (() => {
            if (trendEncomendas !== null)
                return `<span style="color:${trendEncomendas > 0 ? '#185FA5' : '#3B6D11'};font-weight:600">${trendEncomendas > 0 ? '▲' : '▼'} ${Math.abs(trendEncomendas)} vs ontem</span>`;
            if (encParciais > 0) return `<span style="color:#854F0B;font-weight:600">${encParciais} parcial${encParciais > 1 ? 'is' : ''}</span>`;
            if (encPendentes > 0) return `${encPendentes} pendente${encPendentes > 1 ? 's' : ''}`;
            return 'Sem activas';
        })(),
        encActivas > 0 ? '#185FA5' : 'var(--text-main)', false, () => nav('view-encomendas')
    ));

    const trendHtml = trendSemStock !== null
        ? `<span style="color:${trendSemStock > 0 ? '#A32D2D' : '#3B6D11'};font-weight:600">${trendSemStock > 0 ? '▲' : '▼'} ${Math.abs(trendSemStock)} vs ontem</span>`
        : semStock > 0 ? `${Math.round(semStock / total * 100)}% do inventário` : 'Tudo com stock';

    miniRow.appendChild(_miniKpi(
        'Sem stock', semStock, trendHtml,
        semStock > 0 ? '#E24B4A' : '#639922', semStock > 5,
        semStock > 0 ? () => { _pendingZeroFilter = true; nav('view-search'); } : null
    ));
    el.appendChild(miniRow);
}

function _renderDashSections(el, { patsPend, ferraEntries, encData, total, comStock, semStock, ALERTA_DIAS }) {
    const esc = escapeHtml;

    // PATs pendentes
    const patEntries = patsPend
        .sort((a, b) => _calcDias(b[1].criadoEm) - _calcDias(a[1].criadoEm))
        .slice(0, 5);

    if (patEntries.length > 0) {
        const sec = _dv3Section('PATs pendentes', 'Ver todas →', () => nav('view-pedidos'));
        const list = $el('div', { className: 'dv3-list' });
        patEntries.forEach(([id, pat]) => {
            const dias    = _calcDias(pat.criadoEm);
            const urgente = dias >= 20;
            const row     = $el('div', { className: 'dv3-list-row' });
            row.onclick   = () => openPatDetail(id, pat);
            const accent  = $el('div', { className: 'dv3-list-accent' });
            accent.style.background = urgente ? '#E24B4A' : '#1a56db';
            const info = $el('div', { className: 'dv3-list-info' });
            info.innerHTML = `
                <div class="dv3-list-primary">
                    <span class="dv3-mono">PAT ${esc(pat.numero || '—')}</span>
                    ${pat.separacao ? '<span class="dv3-chip dv3-chip-amber" style="font-size:9px;padding:1px 5px">Guia</span>' : ''}
                </div>
                <div class="dv3-list-secondary">${esc(pat.estabelecimento || 'Sem estabelecimento')}</div>`;
            const age = $el('span', { className: 'dv3-list-age' + (urgente ? ' dv3-list-age-urg' : '') });
            age.textContent = dias === 0 ? 'Hoje' : dias === 1 ? '1d' : `${dias}d`;
            row.appendChild(accent); row.appendChild(info); row.appendChild(age);
            list.appendChild(row);
        });
        sec.appendChild(list); el.appendChild(sec);
    }

    // Ferramentas em campo
    const alocadasList = ferraEntries
        .filter(t => t.status === 'alocada' && t.colaborador)
        .sort((a, b) => _calcDias(b.dataEntrega||0) - _calcDias(a.dataEntrega||0));

    if (alocadasList.length > 0) {
        const sec2 = _dv3Section('Ferramentas em campo', 'Painel →', () => nav('view-tools'));
        const list2 = $el('div', { className: 'dv3-list' });
        const porColab = {};
        alocadasList.forEach(t => { if (!porColab[t.colaborador]) porColab[t.colaborador] = []; porColab[t.colaborador].push(t); });
        Object.entries(porColab).forEach(([colab, tools]) => {
            const dias_max = Math.max(...tools.map(t => t.dataEntrega ? _calcDias(t.dataEntrega) : 0));
            const overdue  = dias_max >= ALERTA_DIAS;
            const initials = colab.trim().split(/\s+/).map(p => p[0]).slice(0,2).join('').toUpperCase();
            const row = $el('div', { className: 'dv3-list-row' });
            row.onclick   = () => nav('view-tools');
            row.innerHTML = `
                <div class="dv3-avatar">${esc(initials)}</div>
                <div class="dv3-list-info">
                    <div class="dv3-list-primary">${esc(colab)}</div>
                    <div class="dv3-list-secondary">${esc(tools.map(t => t.nome).join(' · '))}</div>
                </div>
                <span class="dv3-badge ${overdue ? 'dv3-badge-warn' : 'dv3-badge-ok'}">${dias_max}d fora</span>`;
            list2.appendChild(row);
        });
        sec2.appendChild(list2); el.appendChild(sec2);
    }

    // Encomendas activas
    const encActivas2 = Object.entries(encData || {})
        .filter(([, e]) => e.estado === 'pendente' || e.estado === 'parcial')
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
        .slice(0, 3);

    if (encActivas2.length > 0) {
        const sec3 = _dv3Section('Encomendas em curso', 'Ver todas →', () => nav('view-encomendas'));
        const list3 = $el('div', { className: 'dv3-list' });
        encActivas2.forEach(([, enc]) => {
            const linhas   = Object.values(enc.linhas || {});
            const tot      = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
            const recebido = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
            const pct      = tot > 0 ? Math.round(recebido / tot * 100) : 0;
            const isParcial = enc.estado === 'parcial';
            const row = $el('div', { className: 'dv3-list-row dv3-list-row-col' });
            row.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
                    <span class="dv3-list-primary dv3-mono" style="font-size:12px">Enc. ${esc(enc.num||'—')} · ${esc(enc.fornecedor||'—')}</span>
                    <span class="dv3-chip ${isParcial ? 'dv3-chip-amber' : 'dv3-chip-blue'}" style="font-size:9px">${isParcial ? 'Parcial' : 'Pendente'}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                    <div class="dv3-enc-bar"><div class="dv3-enc-bar-fill" style="width:${pct}%"></div></div>
                    <span class="dv3-mono" style="font-size:10px;color:var(--text-muted);flex-shrink:0">${pct}%</span>
                </div>`;
            list3.appendChild(row);
        });
        sec3.appendChild(list3); el.appendChild(sec3);
    }

    // Saúde do inventário
    if (total > 0) {
        const sec4 = _dv3Section('Saúde do inventário', null, null);
        const pctOk = Math.round(comStock / total * 100);
        sec4.insertAdjacentHTML('beforeend', `
            <div class="dv3-health-bar-wrap">
                <div class="dv3-health-bar">
                    <div style="width:${pctOk}%;background:#639922;border-radius:3px 0 0 3px;height:100%"></div>
                    <div style="width:${100 - pctOk}%;background:#E24B4A;border-radius:0 3px 3px 0;height:100%"></div>
                </div>
            </div>
            <div class="dv3-health-legend">
                <div class="dv3-health-item"><div class="dv3-health-dot" style="background:#639922"></div><span>${comStock} com stock (${pctOk}%)</span></div>
                <div class="dv3-health-item"><div class="dv3-health-dot" style="background:#E24B4A"></div><span>${semStock} esgotados</span></div>
            </div>`);
        el.appendChild(sec4);
    }
}

async function renderDashboard(force = false, fromBtn = false) {
    const el = $id('view-dashboard');
    if (!el) return;

    el.classList.add('dv3-loading');
    $id('dv3-refresh-btn')?.classList.add('spinning');

    const ts = Date.now();
    const [stockData, ferrData, , , snapData] = await Promise.all([
        fetchCollection('stock', force || ts > cache.stock.lastFetch + 60000),
        fetchCollection('ferramentas', force || ts > cache.ferramentas.lastFetch + 60000),
        _fetchPats(force || !_patCache.data),
        loadEncomendas(),
        _loadDashSnaps(),
    ]);

    const snapYesterday = snapData?.yesterday ?? null;
    const stockEntries  = Object.values(stockData || {});
    const ferraEntries  = Object.values(ferrData  || {});
    const total         = stockEntries.length;
    const semStock      = stockEntries.filter(i => (i.quantidade || 0) === 0).length;
    const comStock      = total - semStock;
    const alocadas      = ferraEntries.filter(t => t.status === 'alocada').length;
    const totalFerr     = ferraEntries.length;
    const patPendentes  = _getPatPendingCount();
    const ALERTA_DIAS   = 7;
    const alocadasHaMuito = ferraEntries.filter(t =>
        t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) > ALERTA_DIAS
    );
    const encEntries    = Object.values(_encData || {});
    const encPendentes  = encEntries.filter(e => e.estado === 'pendente').length;
    const encParciais   = encEntries.filter(e => e.estado === 'parcial').length;
    const encActivas    = encPendentes + encParciais;

    _saveDashSnapshot(total, semStock, alocadas, patPendentes, encActivas);

    const allPats    = Object.entries(_patCache.data || {});
    const patsPend   = allPats.filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');
    const patUrgentes = patsPend.filter(([, p]) => p.criadoEm && _calcDias(p.criadoEm) >= 20).length;
    const patComGuia  = patsPend.filter(([, p]) => !!p.separacao).length;
    const patHoje     = patsPend.filter(([, p]) => p.criadoEm && _calcDias(p.criadoEm) === 0).length;

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 19 ? 'Boa tarde' : 'Boa noite';
    const displayName = localStorage.getItem('hiperfrio-displayname') || localStorage.getItem('hiperfrio-username') || '';
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const weekdays = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const months   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const dateStr  = `${weekdays[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`;

    const trendSemStock   = _getDashTrend('semStock',    semStock,    snapYesterday);
    const trendPats       = _getDashTrend('patPendentes',patPendentes,snapYesterday);
    const trendEncomendas = _getDashTrend('encActivas',  encActivas,  snapYesterday);

    el.innerHTML = '';
    el.classList.remove('dv3-loading');
    el.classList.add('dash-v3');

    // Monta tudo num fragment detached — um único appendChild final = 1 reflow
    const scratch = document.createDocumentFragment();
    _renderDashGreeting(scratch, greeting, displayName, dateStr, timeStr);
    _renderDashAlert(scratch, patUrgentes);
    _renderDashKpis(scratch, { total, comStock, semStock, alocadas, totalFerr, alocadasHaMuito,
                          patPendentes, patUrgentes, patComGuia, patHoje,
                          encActivas, encPendentes, encParciais,
                          trendPats, trendEncomendas, trendSemStock });
    _renderGasCard(stockData, scratch);
    _renderDashSections(scratch, { patsPend, ferraEntries, encData: _encData, total, comStock, semStock, ALERTA_DIAS });
    el.appendChild(scratch);

    el.classList.remove('dv3-loading');
    $id('dv3-refresh-btn')?.classList.remove('spinning');
}

// ── Gas card helpers ─────────────────────────────────────────────────────────
// Lê MAX e ALERTA das notas do produto.
// Sintaxe nas notas: "MAX:50 ALERTA:10" (valores em kg)
// Exemplo: produto R404A com notas "MAX:50 ALERTA:8 Gás refrigerante"

// Detecta automaticamente todos os produtos com unidade 'kg'
function _getGasItems(stockData) {
    return Object.entries(stockData || {})
        .filter(([, item]) => item.unidade === 'kg')
        .map(([id, item]) => {
            const qty  = item.quantidade || 0;
            // gasMax: usa campo dedicado, senão máximo histórico local, senão qty*1.5
            const maxKey  = 'hiperfrio-gasmax-' + id;
            let   maxHist = parseFloat(localStorage.getItem(maxKey) || '0');
            if (qty > maxHist) { maxHist = qty; localStorage.setItem(maxKey, qty); }
            const maxVal  = (item.gasMax != null && item.gasMax > 0)
                ? item.gasMax
                : (maxHist > 0 ? maxHist : Math.max(qty, 1));
            // gasAlerta: usa campo dedicado, senão 20% do máximo
            const alertVal = (item.gasAlerta != null && item.gasAlerta > 0)
                ? item.gasAlerta
                : Math.round(maxVal * 0.20 * 10) / 10;
            return {
                id,
                name:    (item.codigo || item.nome || id).toUpperCase(),
                qty,
                max:     maxVal,
                alertAt: alertVal,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

function _drawGasCylSvg(g) {
    const W=44, H=96, capH=10, neckW=16, neckH=10;
    const bodyY = capH + neckH, bodyH = H - bodyY - 2, rx = 7;
    const p       = Math.max(0, Math.min(1, g.qty / g.max));
    const fillH   = Math.round((bodyH - 6) * p);
    const fillY   = bodyY + (bodyH - 6) - fillH + 3;
    const low     = g.qty <= g.alertAt;
    const fill    = low ? '#E24B4A' : '#185FA5';
    const pctText = Math.round(p * 100);
    const cid     = 'gc' + g.id.replace(/[^a-z0-9]/gi,'') + pctText;

    // Cores fixas para garantir visibilidade em tema claro e escuro
    const bodyFill   = '#DDE4F0';  // cinzento-azulado — visível sobre branco
    const bodyStroke = '#9BAAC4';  // borda com contraste suficiente
    const capFill    = '#B8C5DA';  // pescoço mais escuro
    const topFill    = '#9BAAC4';  // topo ainda mais escuro
    const textFill   = p > 0.18 ? '#ffffff' : '#4A5A72';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.id = 'gc-svg-' + g.id;
    svg.innerHTML = `
        <defs><clipPath id="${cid}"><rect x="3" y="${bodyY}" width="${W-6}" height="${bodyH}" rx="${rx}"/></clipPath></defs>
        <rect x="${(W-neckW)/2}" y="${capH}" width="${neckW}" height="${neckH}" rx="4" fill="${capFill}" stroke="${bodyStroke}" stroke-width="0.5"/>
        <rect x="${(W-neckW+4)/2}" y="2" width="${neckW-4}" height="${capH}" rx="3" fill="${topFill}"/>
        <rect x="3" y="${bodyY}" width="${W-6}" height="${bodyH}" rx="${rx}" fill="${bodyFill}" stroke="${bodyStroke}" stroke-width="1"/>
        ${p > 0 ? `<rect x="3" y="${fillY}" width="${W-6}" height="${fillH+6}" rx="${rx}" fill="${fill}" opacity="0.92" clip-path="url(#${cid})"/>` : ''}
        <text x="${W/2}" y="${bodyY + bodyH/2 + 1}" text-anchor="middle" dominant-baseline="middle"
            font-size="11" font-weight="500" font-family="'DM Mono','Courier New',monospace"
            fill="${textFill}">
            ${pctText}%
        </text>`;
    return svg;
}

function _renderGasCard(stockData, el) {
    const gases = _getGasItems(stockData);
    if (gases.length === 0) return; // sem produtos kg — não mostra o card

    const lowGases = gases.filter(g => g.qty <= g.alertAt);
    const totalKg  = gases.reduce((s, g) => s + g.qty, 0);
    const fmtKg    = v => (Math.round(v * 10) / 10).toFixed(1);

    const sec = _dv3Section('Gases refrigerantes', 'Ver stock →', () => {
        _pendingZeroFilter = false;
        nav('view-search');
    });
    sec.id = 'dv3-gas-section';

    // Badge de alerta no header
    if (lowGases.length > 0) {
        const badge = $el('span', { className: 'dv3-chip dv3-chip-red' });
        badge.style.cssText = 'font-size:9px;margin-left:6px;';
        badge.textContent = lowGases.length === 1
            ? lowGases[0].name + ' baixo'
            : `${lowGases.length} gases baixos`;
        sec.querySelector('.dv3-section-hdr').insertBefore(badge, sec.querySelector('.dv3-section-link'));
    }

    // Sub-info
    const subInfo = $el('div');
    subInfo.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:12px;';
    subInfo.textContent = `${gases.length} tipo${gases.length !== 1 ? 's' : ''} · ${fmtKg(totalKg)} kg total`;
    sec.appendChild(subInfo);

    // Cilindros
    const cylRow = $el('div');
    cylRow.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px;';

    gases.forEach(g => {
        const low = g.qty <= g.alertAt;
        const item = $el('div');
        item.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0;width:60px;cursor:pointer;';
        item.onclick = () => nav('view-search');

        item.appendChild(_drawGasCylSvg(g));

        const nm = $el('div');
        nm.style.cssText = 'font-size:11px;font-weight:500;color:var(--text-main);text-align:center;';
        nm.textContent = g.name;

        const qt = $el('div');
        qt.style.cssText = 'font-size:10px;font-family:"DM Mono","Courier New",monospace;color:var(--text-muted);text-align:center;';
        qt.textContent = fmtKg(g.qty) + ' kg';

        item.appendChild(nm);
        item.appendChild(qt);

        if (low) {
            const al = $el('div');
            al.style.cssText = 'font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;background:#FCEBEB;color:#A32D2D;';
            al.textContent = 'Baixo';
            item.appendChild(al);
        }
        cylRow.appendChild(item);
    });
    sec.appendChild(cylRow);

    // Barras horizontais
    const barsDiv = $el('div');
    barsDiv.style.cssText = 'border-top:0.5px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px;';

    gases.forEach(g => {
        const p   = Math.max(0, Math.min(1, g.qty / g.max));
        const low = g.qty <= g.alertAt;
        const bar = $el('div');
        bar.style.cssText = 'display:flex;align-items:center;gap:8px;';
        bar.innerHTML = `
            <span style="font-size:11px;color:var(--text-muted);width:52px;flex-shrink:0;">${g.name}</span>
            <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden;">
                <div style="height:100%;border-radius:3px;width:${Math.round(p*100)}%;background:${low?'#E24B4A':'#185FA5'};transition:width .3s;"></div>
            </div>
            <span style="font-size:11px;font-family:'DM Mono','Courier New',monospace;width:46px;text-align:right;flex-shrink:0;color:${low?'#A32D2D':'var(--text-muted)'};font-weight:${low?'600':'400'};">
                ${fmtKg(g.qty)} kg
            </span>`;
        barsDiv.appendChild(bar);
    });
    sec.appendChild(barsDiv);
    el.appendChild(sec);
}

// helper: cria secção com header
function _dv3Section(title, linkText, linkFn) {
    const sec = $el('div', { className: 'dv3-section' });
    const hdr = $el('div', { className: 'dv3-section-hdr' });
    const t = $el('span', { className: 'dv3-section-title' });
    t.textContent = title;
    hdr.appendChild(t);
    if (linkText && linkFn) {
        const l = $el('button', { className: 'dv3-section-link' });
        l.textContent = linkText;
        l.onclick     = linkFn;
        hdr.appendChild(l);
    }
    sec.appendChild(hdr);
    return sec;
}

// ADMIN — slider com swipe entre tabs
const ADMIN_TABS  = ['workers', 'tools', 'clientes', 'users', 'settings', 'relatorio'];
let   _adminIdx   = 0;   // índice activo

// ── Admin mobile — menu estilo Android ────────────────────────────────────────
const _adminMobileTitles = {
    workers:   'Funcionários',
    tools:     'Ferramentas',
    clientes:  'Clientes',
    users:     'Utilizadores',
    settings:  'Definições',
    relatorio: 'Relatórios',
};
let _adminMobileActive = null;

function _buildAdminMobileMenu() {
    const viewAdmin = $id('view-admin');
    if (!viewAdmin) return;
    $id('admin-mobile-menu')?.remove();
    $id('admin-mobile-detail')?.remove();

    const items = [
        { tab:'workers',  bg:'#eff6ff', color:'#2563eb', label:'Funcionários', sub:'Gerir técnicos e colaboradores',
          svg:'<path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>', vb:'0 0 20 20', fill:true },
        { tab:'tools',    bg:'#dcfce7', color:'#16a34a', label:'Ferramentas',  sub:'Registar e gerir ferramentas',
          svg:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', vb:'0 0 24 24', fill:false },
        { tab:'clientes', bg:'#fef3c7', color:'#d97706', label:'Clientes',     sub:'Importar e consultar clientes',
          svg:'<path d="M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C3.74 11.846 4.632 14 6.414 14H15a1 1 0 000-2H6.414l1-1H14a1 1 0 00.894-.553l3-6A1 1 0 0017 3H6.28l-.31-1.243A1 1 0 005 1H3zM16 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM6.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>', vb:'0 0 20 20', fill:true },
        { tab:'users',    bg:'#ede9fe', color:'#7c3aed', label:'Utilizadores', sub:'Gerir contas e permissões',
          svg:'<path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
        { tab:'settings',  bg:'#f1f5f9', color:'#64748b', label:'Definições',   sub:'OCR, tema, versão da app',
          svg:'<path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
        { tab:'relatorio', bg:'#ecfdf5', color:'#059669', label:'Relatórios',   sub:'Análise mensal de tendências',
          svg:'<path fill-rule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11 4a1 1 0 10-2 0v4a1 1 0 102 0V7zm-3 1a1 1 0 10-2 0v3a1 1 0 102 0V8zM8 9a1 1 0 00-2 0v2a1 1 0 102 0V9z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
    ];

    const menu = $el('div');
    menu.id = 'admin-mobile-menu';

    const groups = [
        { label:'Gestão',  tabs: items.slice(0,3) },
        { label:'Sistema',  tabs: items.slice(3,5) },
        { label:'Análise',  tabs: items.slice(5) },
    ];

    groups.forEach(g => {
        // Label de secção
        const lbl = $el('div', { className: 'admin-mobile-section-label' });
        lbl.textContent = g.label;
        menu.appendChild(lbl);

        // Grupo de cards
        const grp = $el('div', { className: 'admin-mobile-group' });

        g.tabs.forEach(item => {
            const row = $el('div', { className: 'admin-mobile-item' });
            row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--border);background:var(--card-bg);-webkit-tap-highlight-color:transparent';
            row.addEventListener('click', () => adminMobileOpen(item.tab));

            // Ícone
            const iconWrap = $el('div', { className: 'admin-mobile-item-icon' });
            iconWrap.style.cssText = `background:${item.bg};width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0`;
            const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgEl.setAttribute('width', '22');
            svgEl.setAttribute('height', '22');
            svgEl.setAttribute('viewBox', item.vb);
            if (item.fill) {
                svgEl.setAttribute('fill', item.color);
            } else {
                svgEl.setAttribute('fill', 'none');
                svgEl.setAttribute('stroke', item.color);
                svgEl.setAttribute('stroke-width', '2');
                svgEl.setAttribute('stroke-linecap', 'round');
            }
            svgEl.innerHTML = item.svg;
            iconWrap.appendChild(svgEl);

            // Texto
            const textWrap = $el('div');
            textWrap.style.cssText = 'flex:1;min-width:0';
            const labelEl = $el('div', { className: 'admin-mobile-item-label' });
            labelEl.textContent = item.label;
            const subEl = $el('div', { className: 'admin-mobile-item-sub' });
            subEl.textContent = item.sub;
            textWrap.appendChild(labelEl);
            textWrap.appendChild(subEl);

            // Chevron
            const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            chevron.setAttribute('width', '16');
            chevron.setAttribute('height', '16');
            chevron.setAttribute('viewBox', '0 0 24 24');
            chevron.setAttribute('fill', 'none');
            chevron.setAttribute('stroke', '#94a3b8');
            chevron.setAttribute('stroke-width', '2.5');
            chevron.setAttribute('stroke-linecap', 'round');
            chevron.style.flexShrink = '0';
            chevron.innerHTML = '<path d="M9 18l6-6-6-6"/>';

            row.appendChild(iconWrap);
            row.appendChild(textWrap);
            row.appendChild(chevron);
            grp.appendChild(row);
        });

        menu.appendChild(grp);
    });

    // Construir detalhe
    const detail = $el('div');
    detail.id = 'admin-mobile-detail';
    detail.style.display = 'none';

    // Linha do back btn
    const hdr = $el('div', { className: 'admin-mobile-detail-header' });
    hdr.style.cssText = 'display:flex;align-items:center;padding:10px 0 4px;';

    const backBtn = $el('button', { className: 'admin-mobile-back-btn' });
    backBtn.type = 'button';
    backBtn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:transparent;border:none;outline:none;color:var(--primary);font-family:Inter,sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;padding:6px 0;margin:0;-webkit-appearance:none;appearance:none;letter-spacing:0.01em;';
    backBtn.addEventListener('click', adminMobileBack);
    backBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg> Administração';

    // Título da secção como h2
    const detailTitle = $el('h2', { className: 'admin-mobile-detail-title' });
    detailTitle.id = 'admin-mobile-detail-title';
    detailTitle.style.cssText = 'font-size:1.35rem;font-weight:800;color:var(--text-main);letter-spacing:-0.4px;margin:4px 0 16px;padding:0;line-height:1.2;';

    hdr.appendChild(backBtn);

    const content = $el('div');
    content.id = 'admin-mobile-detail-content';

    detail.appendChild(hdr);
    detail.appendChild(detailTitle);
    detail.appendChild(content);

    // Inserir antes do slider-wrap
    const sliderWrap = $id('admin-slider-wrap');
    viewAdmin.insertBefore(detail, sliderWrap);
    viewAdmin.insertBefore(menu, sliderWrap);
}

function adminMobileOpen(tab) {
    _adminMobileActive = tab;
    const menu   = $id('admin-mobile-menu');
    const detail = $id('admin-mobile-detail');
    const title  = $id('admin-mobile-detail-title');
    const content = $id('admin-mobile-detail-content');
    if (!menu || !detail || !title || !content) return;

    title.textContent = _adminMobileTitles[tab] || tab;

    const panel = $id(`panel-${tab}`);
    if (panel) {
        // Forçar dimensões — o .admin-panel tem width/min-width:20% do slider desktop
        panel.style.cssText = 'width:100% !important; min-width:100% !important; flex-shrink:0; box-sizing:border-box; padding:0;';
        content.appendChild(panel);
    }

    if (tab === 'clientes')  renderClientesList();
    if (tab === 'users')     renderUsersList();
    if (tab === 'settings')  { _updateOcrKeyStatus(); _updateGimgStatus(); _loadOcrKeywordsInput(); _loadInvEmailInput(); }
    if (tab === 'tools')     renderAdminTools();
    if (tab === 'workers')   renderWorkers();

    menu.style.display   = 'none';
    detail.style.display = 'block';
    detail.style.padding = '0 16px 80px';
    detail.classList.remove('admin-mobile-detail-enter');
    void detail.offsetWidth;
    detail.classList.add('admin-mobile-detail-enter');

    const titleEl = $id('header-page-title');
    if (titleEl) titleEl.textContent = _adminMobileTitles[tab] || 'Administração';
    window.scrollTo(0, 0);
}

function adminMobileBack() {
    _adminMobileActive = null;
    const menu    = $id('admin-mobile-menu');
    const detail  = $id('admin-mobile-detail');
    const content = $id('admin-mobile-detail-content');
    if (!menu || !detail) return;

    const slider = $id('admin-slider');
    if (slider && content) {
        while (content.firstChild) {
            const child = content.firstChild;
            // Limpar estilos inline forçados — o slider desktop usa CSS próprio
            if (child.style) child.style.cssText = '';
            slider.appendChild(child);
        }
    }

    // Re-aplicar ws-active no painel correcto (para desktop)
    if (window.innerWidth >= 768) {
        ADMIN_TABS.forEach((t, i) => {
            const p = $id(`panel-${t}`);
            if (p) p.classList.toggle('ws-active', i === _adminIdx);
        });
    }

    detail.style.display = 'none';
    menu.style.display   = 'block';

    const titleEl = $id('header-page-title');
    if (titleEl) titleEl.textContent = 'Administração';
    window.scrollTo(0, 0);
}

function switchAdminTab(tab, animate = true) {
    const idx = ADMIN_TABS.indexOf(tab);
    if (idx < 0) return;
    // Cleanup de recursos pesados ao sair de um tab (M4 audit)
    const prevTab = ADMIN_TABS[_adminIdx];
    if (prevTab === 'relatorio' && tab !== 'relatorio' && typeof _relDestroyCharts === 'function') {
        _relDestroyCharts();
    }
    _adminIdx = idx;

    // Actualiza botões
    document.querySelectorAll('.admin-tab').forEach((t, i) =>
        t.classList.toggle('active', i === idx)
    );

    // Desktop ≥768px: mostra/esconde painéis via classe (sem transform)
    // transform num elemento pai quebra position:fixed dos modais
    if (window.innerWidth >= 768) {
        ADMIN_TABS.forEach((t, i) => {
            const p = $id(`panel-${t}`);
            if (p) p.classList.toggle('ws-active', i === idx);
        });
    }

    if (tab === 'clientes') renderClientesList();
    if (tab === 'users')    renderUsersList();
    if (tab === 'settings') { _updateOcrKeyStatus(); _updateGimgStatus(); _loadOcrKeywordsInput(); _loadInvEmailInput(); }
    if (tab === 'relatorio') {
        // Sempre que entramos no tab, pedimos reset ao mês actual.
        // A lógica de reset está dentro de renderRelatorio (reports.js).
        renderRelatorio(true);
    }
    if (tab === 'workers')  renderWorkers();
    if (tab === 'tools')    renderAdminTools();
    // Move slider apenas em mobile — no desktop usamos display:none/block
    // (transform num pai quebra position:fixed dos modais no desktop)
    const slider = $id('admin-slider');
    if (slider) {
        if (window.innerWidth < 768) {
            if (!animate) slider.classList.add('is-dragging');
            slider.style.transform = `translateX(-${(idx * 100 / 6).toFixed(4)}%)`;
            if (!animate) {
                void slider.offsetWidth;
                slider.classList.remove('is-dragging');
            }
        } else {
            // Garantir que não fica transform inline residual
            slider.style.transform = '';
            slider.style.transition = '';
        }
    }
}

// AbortController para garantir que os listeners são limpos antes de re-setup
let _adminSwipeAC = null;

function _setupAdminSwipe() {
    const wrap   = $id('admin-slider-wrap');
    const slider = $id('admin-slider');
    if (!wrap || !slider) return;

    // Remove listeners anteriores antes de adicionar novos
    if (_adminSwipeAC) { _adminSwipeAC.abort(); }
    _adminSwipeAC = new AbortController();
    const sig = _adminSwipeAC.signal;

    let startX = 0, startY = 0;
    let deltaX = 0;
    let intent = null;   // 'h' | 'v' | null
    let active = false;

    const INTENT_THRESHOLD = 8;    // px para decidir h vs v
    const SWIPE_THRESHOLD  = 50;   // px para confirmar mudança de tab
    const RESIST = 0.25;           // resistência nos extremos

    wrap.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaX = 0;
        intent = null;
        active = true;
    }, { passive: true, signal: sig });

    wrap.addEventListener('touchmove', e => {
        if (!active || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        // Decide intenção uma só vez
        if (intent === null && (Math.abs(dx) > INTENT_THRESHOLD || Math.abs(dy) > INTENT_THRESHOLD)) {
            intent = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        if (intent !== 'h') return;   // scroll vertical — não interferir

        e.preventDefault();
        deltaX = dx;

        // Resistência nos extremos
        let extra = deltaX;
        if ((_adminIdx === 0 && deltaX > 0) || (_adminIdx === ADMIN_TABS.length - 1 && deltaX < 0)) {
            extra = deltaX * RESIST;
        }

        slider.classList.add('is-dragging');
        const base = -(_adminIdx * 100 / 6);
        slider.style.transform = `translateX(calc(${base}% + ${extra}px))`;
    }, { passive: false, signal: sig });

    const onEnd = () => {
        if (!active) return;
        active = false;

        if (intent !== 'h') { intent = null; return; }

        slider.classList.remove('is-dragging');

        if (deltaX < -SWIPE_THRESHOLD && _adminIdx < ADMIN_TABS.length - 1) {
            switchAdminTab(ADMIN_TABS[_adminIdx + 1]);
        } else if (deltaX > SWIPE_THRESHOLD && _adminIdx > 0) {
            switchAdminTab(ADMIN_TABS[_adminIdx - 1]);
        } else {
            switchAdminTab(ADMIN_TABS[_adminIdx]);   // volta à posição
        }
        deltaX = 0;
        intent = null;
    };

    wrap.addEventListener('touchend',    onEnd, { passive: true, signal: sig });
    wrap.addEventListener('touchcancel', onEnd, { passive: true, signal: sig });
}

// TEMAS — claro / escuro
function _applyTheme(theme) {
    document.body.classList.remove('dark-mode');
    if (theme === 'dark')  document.body.classList.add('dark-mode');

    // Sync theme dropdown UI
    _syncThemeDropdown(theme);

    // Barra de status Android — meta theme-color dinâmica
    const themeColors = {
        light: '#2563eb',
        dark:  '#0f172a',
        
    };
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.name = 'theme-color';
        document.head.appendChild(metaTheme);
    }
    metaTheme.content = themeColors[theme] || themeColors.light;

    // Liga/desliga o comportamento de scroll da barra de pesquisa
    _setupSearchScrollBehaviour(false);
    // Scroll hide/show do pill — activo em todos os temas
    _setupBottomNavScrollBehaviour(true);
}

let _searchScrollCleanup = null;

function _setupSearchScrollBehaviour(enable) {
    // Remove listener anterior se existir
    if (_searchScrollCleanup) { _searchScrollCleanup(); _searchScrollCleanup = null; }

    const container  = document.querySelector('.search-container');
    if (!container) return;

    // Garante que o peek btn existe (criado uma vez, reutilizado)
    let peekBtn = $id('search-peek-btn');
    if (!peekBtn) {
        peekBtn = $el('button');
        peekBtn.id        = 'search-peek-btn';
        peekBtn.className = 'search-peek-btn';
        peekBtn.innerHTML = ' Pesquisar';
        peekBtn.setAttribute('aria-label', 'Mostrar barra de pesquisa');
        peekBtn.onclick   = () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        document.body.appendChild(peekBtn);
    }

    if (!enable) {
        container.classList.remove('search-scrolled-away');
        peekBtn.classList.remove('visible');
        return;
    }

    const HIDE_THRESHOLD  = 80;  // px de scroll para esconder
    const SHOW_THRESHOLD  = 20;  // px de scroll para mostrar de volta
    let   _lastScrollY    = 0;
    let   _hidden         = false;
    let   _rafId          = null;

    const onScroll = () => {
        if (_rafId) return; // throttle via rAF
        _rafId = requestAnimationFrame(() => {
            _rafId = null;
            const sy = window.scrollY;
            if (!_hidden && sy > HIDE_THRESHOLD) {
                _hidden = true;
                container.classList.add('search-scrolled-away');
                peekBtn.classList.add('visible');
            } else if (_hidden && sy <= SHOW_THRESHOLD) {
                _hidden = false;
                container.classList.remove('search-scrolled-away');
                peekBtn.classList.remove('visible');
            }
            _lastScrollY = sy;
        });
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    // Retorna função de cleanup para quando o tema mudar
    _searchScrollCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        container.classList.remove('search-scrolled-away');
        peekBtn.classList.remove('visible');
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    };
}

let _bnavScrollCleanup = null;

function _setupBottomNavScrollBehaviour(enable) {
    // Limpa listener anterior
    if (_bnavScrollCleanup) { _bnavScrollCleanup(); _bnavScrollCleanup = null; }

    const nav = $id('bottom-nav');
    if (!nav) return;

    // Detecção de direcção: esconde ao descer, mostra ao subir
    const SCROLL_SENSITIVITY = 6;   // px mínimos de delta para reagir
    const SHOW_AT_TOP        = 30;  // px — perto do topo mostra sempre
    let _lastY   = window.scrollY;
    let _hidden  = false;
    let _rafId   = null;

    const onScroll = () => {
        if (_rafId) return;
        _rafId = requestAnimationFrame(() => {
            _rafId = null;
            const sy    = window.scrollY;
            const delta = sy - _lastY;
            _lastY = sy;

            if (sy <= SHOW_AT_TOP) {
                if (_hidden) { _hidden = false; nav.classList.remove('bnav-hidden'); if (window.innerWidth < 768 && $id('view-search').classList.contains('active')) $id('fab-add').classList.remove('bnav-hidden'); }
                return;
            }
            if (!_hidden && delta > SCROLL_SENSITIVITY) {
                _hidden = true;
                nav.classList.add('bnav-hidden');
                $id('fab-add')?.classList.add('bnav-hidden');
            } else if (_hidden && delta < -SCROLL_SENSITIVITY) {
                _hidden = false;
                nav.classList.remove('bnav-hidden');
                if (window.innerWidth < 768 && $id('view-search').classList.contains('active')) $id('fab-add').classList.remove('bnav-hidden');
            }
        });
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    _bnavScrollCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        nav.classList.remove('bnav-hidden');
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    };
}

function setTheme(theme) {
    localStorage.setItem('hiperfrio-tema', theme);
    _applyTheme(theme);
    closeThemeDropdown();
}

// Sincroniza o dropdown com o tema activo
const _THEME_META = {
    light: { icon: '', label: 'Claro' },
    dark:  { icon: '', label: 'Escuro' },
    };
function _syncThemeDropdown(theme) {
    const meta = _THEME_META[theme] || _THEME_META.light;
    const iconEl  = $id('theme-dropdown-icon');
    const labelEl = $id('theme-dropdown-label');
    const descEl  = $id('theme-current-desc');
    if (iconEl)  iconEl.textContent  = meta.icon;
    if (labelEl) labelEl.textContent = meta.label;
    if (descEl)  descEl.textContent  = meta.label;
    // Tick nos itens do menu
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

function toggleThemeDropdown() {
    const menu = $id('theme-menu');
    const wrap = $id('theme-dropdown-wrap');
    if (!menu) return;
    const open = menu.classList.toggle('open');
    wrap?.classList.toggle('open', open);
    if (open) {
        // Fecha ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', closeThemeDropdown, { once: true });
        }, 0);
    }
}

function closeThemeDropdown() {
    $id('theme-menu')?.classList.remove('open');
    $id('theme-dropdown-wrap')?.classList.remove('open');
}

// INVENTÁRIO GUIADO — v2
// Pontos: filtro por zona, revisão, retoma, stats, Excel, email
// INV_RESUME_KEY removida — resume migrado para Firebase /inv-resume/{user}
const INV_EMAIL_KEY = 'hiperfrio-inv-email';

function _invGetEmail() {
    return localStorage.getItem(INV_EMAIL_KEY) || '';
}

function saveInvEmail() {
    const val = ($id('inv-email-input')?.value || '').trim();
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        showToast('Email inválido', 'error');
        return;
    }
    if (val) {
        localStorage.setItem(INV_EMAIL_KEY, val);
        showToast('Email guardado ✓');
    } else {
        localStorage.removeItem(INV_EMAIL_KEY);
        showToast('Email removido');
    }
}

function _loadInvEmailInput() {
    const el = $id('inv-email-input');
    if (el) el.value = _invGetEmail();
}

// Estado da sessão de inventário
let _invItems     = [];        // produtos a percorrer
let _invIdx       = 0;         // índice actual
let _invChanges   = {};        // { id: newQty } — confirmados
let _invSkipped   = new Set(); // ids saltados
let _invOptions   = { zones: null, skipZeros: false }; // null = todas as zonas
let _invLastData  = null;      // snapshot dos dados no início (para o Excel)

async function startInventory() {
    const data = await fetchCollection('stock', true);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para inventariar', 'error'); return;
    }

    // Carrega sessão guardada ANTES de abrir o modal — banner já está pronto ao aparecer
    const saved = await _invLoadResume();

    _openInvSetup(data);

    const banner = $id('inv-resume-banner');
    if (banner) {
        if (!saved) {
            banner.style.display = 'none';
        } else {
            const hoursAgo = Math.round((Date.now() - (saved.ts || 0)) / 3600000);
            const timeLabel = hoursAgo < 1 ? 'há menos de 1h' : `há ${hoursAgo}h`;
            $id('inv-resume-banner-text').textContent =
                `Inventário em curso · ${saved.idx + 1}/${saved.items.length} · guardado ${timeLabel}`;
            banner.style.display = 'flex';
            $id('inv-resume-btn-retomar').onclick = () => {
                closeInvSetup();
                _resumeInventory(saved);
            };
            $id('inv-resume-btn-novo').onclick = () => {
                banner.style.display = 'none';
                _invClearResume();
            };
        }
    }
}

function _openInvSetup(data) {
    // Extrai zonas únicas ordenadas
    const zones = [...new Set(
        Object.values(data)
            .filter(p => !String(p.codigo||'').startsWith('_tmp_'))
            .map(p => (p.localizacao||'').trim().toUpperCase())
            .filter(Boolean)
    )].sort((a,b) => a.localeCompare(b,'pt'));

    const container = $id('inv-setup-zones');
    container.innerHTML = '';

    if (zones.length === 0) {
        container.innerHTML = '<p class="modal-desc" style="margin:0">Todos os produtos serão inventariados (sem zonas definidas).</p>';
    } else {
        zones.forEach(zone => {
            const chip = $el('button');
            chip.type      = 'button';
            chip.className = 'inv-zone-chip active';
            chip.dataset.zone = zone;
            chip.textContent  = zone;
            chip.onclick = () => {
                chip.classList.toggle('active');
                _updateInvSetupBtn();
            };
            container.appendChild(chip);
        });
    }

    $id('inv-skip-zeros').checked = false;
    _updateInvSetupBtn();
    modalOpen('inv-setup-modal');
    focusModal('inv-setup-modal');
}

function invSetupToggleAll() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const allActive = [...chips].every(c => c.classList.contains('active'));
    chips.forEach(c => c.classList.toggle('active', !allActive));
    _updateInvSetupBtn();
}

function _updateInvSetupBtn() {
    const chips   = document.querySelectorAll('.inv-zone-chip');
    const active  = [...chips].filter(c => c.classList.contains('active'));
    const btn     = document.querySelector('#inv-setup-modal .btn-primary');
    const toggleBtn = document.querySelector('.inv-setup-toggle-all');
    if (!btn) return;
    if (chips.length === 0) {
        btn.textContent = 'Iniciar Inventário →';
    } else if (active.length === 0) {
        btn.textContent = 'Selecciona pelo menos uma zona';
        btn.disabled = true;
        if (toggleBtn) toggleBtn.textContent = 'Seleccionar todas';
        return;
    } else {
        const allActive = active.length === chips.length;
        btn.textContent = allActive
            ? `Iniciar — todos os produtos →`
            : `Iniciar — ${active.length} zona${active.length > 1 ? 's' : ''} →`;
        if (toggleBtn) toggleBtn.textContent = allActive ? 'Limpar selecção' : 'Seleccionar todas';
    }
    btn.disabled = false;
}

function closeInvSetup() {
    modalClose('inv-setup-modal');
}

async function invSetupStart() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const totalChips = chips.length;
    const activeZones = totalChips === 0
        ? null
        : [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.zone);

    if (activeZones && activeZones.length === 0) return;

    const skipZeros = $id('inv-skip-zeros').checked;
    const allZones  = totalChips === 0 || activeZones === null || activeZones.length === totalChips;
    closeInvSetup();
    await _startInvWithOptions(activeZones, skipZeros, allZones);
}

async function _startInvWithOptions(zones, skipZeros, allZones = true) {
    const data = cache.stock.data;
    if (!data) return;
    _invLastData = { ...data };

    const allChips  = document.querySelectorAll('.inv-zone-chip');

    _invOptions = { zones, skipZeros, allZones };

    _invItems = Object.entries(data)
        .filter(([k, p]) => {
            if (k.startsWith('_tmp_')) return false;
            if (skipZeros && (p.quantidade || 0) === 0) return false;
            if (zones !== null) {
                const z = (p.localizacao||'').trim().toUpperCase();
                return zones.includes(z);
            }
            return true;
        })
        .sort(([,a],[,b]) => {
            const la = (a.localizacao||'ZZZ').toUpperCase();
            const lb = (b.localizacao||'ZZZ').toUpperCase();
            return la !== lb ? la.localeCompare(lb,'pt') : (a.nome||'').localeCompare(b.nome||'','pt');
        });

    if (_invItems.length === 0) {
        showToast('Nenhum produto corresponde aos filtros seleccionados', 'error'); return;
    }

    _invIdx     = 0;
    _invChanges = {};
    _invSkipped = new Set();

    modalOpen('inv-modal');
    focusModal('inv-modal');
    _renderInvStep();
}

function _resumeInventory(saved) {
    closeConfirmModal();
    _invItems    = saved.items;
    _invIdx      = saved.idx;
    _invChanges  = saved.changes;
    _invSkipped  = new Set(saved.skipped || []);
    _invOptions  = saved.options || { zones: null, skipZeros: false };
    // Bug 5: garantir que _invLastData não é null ao exportar depois de retomar
    _invLastData = cache.stock.data ? { ...cache.stock.data } : null;
    if (!_invLastData) {
        fetchCollection('stock', false).then(d => { if (d) _invLastData = { ...d }; });
    }
    modalOpen('inv-modal');
    focusModal('inv-modal');
    _renderInvStep();
    showToast(`A retomar — produto ${_invIdx + 1} de ${_invItems.length}`);
}

function _renderInvStep() {
    const total      = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    $id('inv-progress-text').textContent = `${_invIdx + 1} / ${total}`;
    $id('inv-progress-bar').style.width  = `${Math.round((_invIdx / total) * 100)}%`;

    // Zone progress: "Zona 201-001A — 4 de 12"
    const zonaEl = $id('inv-zone-progress');
    if (zonaEl) {
        const zona = (item.localizacao||'').trim().toUpperCase() || 'SEM LOCAL';
        const zonaItems = _invItems.filter(([,p]) => (p.localizacao||'').trim().toUpperCase() === zona || (zona === 'SEM LOCAL' && !(p.localizacao||'').trim()));
        const zonaIdx   = zonaItems.findIndex(([i]) => i === id);
        // zona vem de Firebase (localização) — escapar para evitar injection.
        zonaEl.innerHTML = `<strong>${escapeHtml(zona)}</strong> — ${zonaIdx + 1} de ${zonaItems.length}`;
    }

    const zona = (item.localizacao||'').trim().toUpperCase();
    $id('inv-local').textContent = zona ? zona : 'SEM LOCAL';
    $id('inv-ref').textContent   = item.codigo  || '';
    $id('inv-nome').textContent  = item.nome    || '';
    $id('inv-unidade').textContent =
        item.unidade && item.unidade !== 'un' ? item.unidade : '';

    // Foto do produto
    const photoImg = $id('inv-photo-img');
    const photoPlaceholder = $id('inv-photo-placeholder');
    if (photoImg && photoPlaceholder) {
        if (item.imgUrl) {
            photoImg.src = item.imgUrl;
            photoImg.style.display = 'block';
            photoPlaceholder.style.display = 'none';
        } else {
            photoImg.style.display = 'none';
            photoPlaceholder.style.display = 'flex';
        }
    }

    // Limpar search ao navegar
    invSearchClear();

    // Badge de zona filtrada
    const badge = $id('inv-zone-badge');
    if (badge) {
        if (_invOptions.zones !== null && !_invOptions.allZones) {
            badge.textContent = `${_invOptions.zones.length} zona${_invOptions.zones.length > 1 ? 's' : ''}`;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    }

    // Quantidade: usa valor já confirmado se existir, senão o original
    const currentVal = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
    const qtyInput   = $id('inv-qtd');
    qtyInput.value   = currentVal;
    qtyInput.focus();
    qtyInput.select();

    // Enter = Confirmar (fix bug UX mobile — substitui listener anterior para evitar duplicados)
    const newInput = qtyInput.cloneNode(true);
    qtyInput.parentNode.replaceChild(newInput, qtyInput);
    newInput.value = currentVal;
    newInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); invConfirm(); }
    });
    newInput.focus();
    newInput.select();

    // Mostra a quantidade original do sistema como referência
    const origEl = $id('inv-orig-qty');
    if (origEl) {
        const orig = item.quantidade || 0;
        origEl.textContent = `Sistema: ${fmtQty(orig, item.unidade)}`;
        origEl.className   = 'inv-orig-qty' + (_invChanges[id] !== undefined && _invChanges[id] !== orig ? ' inv-orig-changed' : '');
    }

    $id('inv-prev-btn').disabled = _invIdx === 0;
    _invSaveResume();
}

function invQtyDelta(delta) {
    const el = $id('inv-qtd');
    if (!el) return;
    el.value = Math.max(0, (parseFloat(el.value) || 0) + delta);
    el.focus();
}

function invConfirm() {
    const [id] = _invItems[_invIdx] || [];
    if (!id) return;
    const val = parseFloat($id('inv-qtd').value);
    if (!isNaN(val) && val >= 0) {
        _invChanges[id] = val;
        _invSkipped.delete(id);
    }
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invSkip() {
    const [id] = _invItems[_invIdx] || [];
    if (id) _invSkipped.add(id);
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invPrev() {
    if (_invIdx > 0) { _invIdx--; _renderInvStep(); }
}

function closeInventory() {
    modalClose('inv-modal');
    invSearchClear();
    // Progresso guardado — não apaga para possível retoma
}

// ── Pesquisa inline no inventário ────────────────────────────────────────────
function invSearchInput(q) {
    const clearBtn = $id('inv-search-clear');
    const results  = $id('inv-search-results');
    if (!q.trim()) { invSearchClear(); return; }
    if (clearBtn) clearBtn.style.display = 'flex';
    results.style.display = 'flex';
    results.innerHTML = '';

    const term = q.trim().toLowerCase();
    // Produto actual para referência de zona
    const [curId, curItem] = _invItems[_invIdx] || [];
    const curZona = (curItem?.localizacao||'').trim().toUpperCase();

    // Encontrar matches (ref ou nome)
    const matches = _invItems
        .map(([id, item], idx) => ({ id, item, idx }))
        .filter(({ item }) =>
            (item.codigo||'').toLowerCase().includes(term) ||
            (item.nome||'').toLowerCase().includes(term)
        )
        .slice(0, 6);

    if (matches.length === 0) {
        results.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:8px 0;text-align:center">Sem resultados</div>';
        return;
    }

    matches.forEach(({ id, item, idx }) => {
        const zona      = (item.localizacao||'').trim().toUpperCase() || 'SEM LOCAL';
        const isCurrent = idx === _invIdx;
        const isConfirmed = _invChanges[id] !== undefined;

        const card = $el('div');
        card.className = 'inv-search-result' + (isCurrent ? ' inv-search-current' : '');

        // Header: ref + zona
        const hdr = $el('div', { className: 'inv-search-result-header' });
        const ref = $el('span', { className: 'inv-search-result-ref' });
        ref.textContent = item.codigo || '—';
        const zonaBadge = $el('span', { className: 'inv-search-result-zona' });
        zonaBadge.textContent = zona;
        hdr.appendChild(ref); hdr.appendChild(zonaBadge);

        // Nome
        const nome = $el('div', { className: 'inv-search-result-nome' });
        nome.textContent = item.nome || id;

        // Acções
        const acts = $el('div', { className: 'inv-search-result-actions' });

        if (!isCurrent) {
            const btnGoto = $el('button', { className: 'inv-search-btn-goto', textContent: 'Ir para →' });
            btnGoto.onclick = () => _invSearchJumpTo(idx);

            const btnOnly = $el('button', { className: 'inv-search-btn-only', textContent: 'Confirmar só este' });
            btnOnly.onclick = () => _invSearchConfirmOnly(id, item);

            acts.appendChild(btnGoto); acts.appendChild(btnOnly);
        } else {
            const lbl = $el('span');
            lbl.style.cssText = 'font-size:0.75rem;color:var(--primary);font-weight:700;padding:4px 0';
            lbl.textContent = '← Produto actual';
            acts.appendChild(lbl);
        }

        // Contexto: outros produtos da mesma zona (até 3)
        const zonaNeighbours = _invItems
            .map(([i, p], ni) => ({ i, p, ni }))
            .filter(({ i, p }) => i !== id && (p.localizacao||'').trim().toUpperCase() === zona)
            .slice(0, 3);

        if (zonaNeighbours.length > 0) {
            const ctx = $el('div', { className: 'inv-search-result-ctx' });
            zonaNeighbours.forEach(({ i, p, ni }) => {
                const row = $el('div');
                row.className = 'inv-search-ctx-row' + (ni === _invIdx ? ' ctx-current' : '');
                const confirmed = _invChanges[i] !== undefined;
                row.innerHTML = `<span>${escapeHtml(p.codigo || '—')} · ${escapeHtml((p.nome||'').slice(0,22))}</span>`
                    + `<span style="color:${confirmed?'var(--success)':'var(--text-muted)'}">${confirmed ? '✓' : '–'}</span>`;
                ctx.appendChild(row);
            });
            card.appendChild(hdr); card.appendChild(nome); card.appendChild(acts); card.appendChild(ctx);
        } else {
            card.appendChild(hdr); card.appendChild(nome); card.appendChild(acts);
        }

        results.appendChild(card);
    });
}

function invSearchClear() {
    const inp      = $id('inv-search-input');
    const clearBtn = $id('inv-search-clear');
    const results  = $id('inv-search-results');
    if (inp)      inp.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (results)  { results.style.display = 'none'; results.innerHTML = ''; }
}

function _invSearchJumpTo(idx) {
    _invIdx = idx;
    invSearchClear();
    _renderInvStep();
}

function _invSearchConfirmOnly(id, item) {
    const inp = $id('inv-search-input');
    // Abre modal rápido de confirmação para este produto
    openConfirmModal({
        title: `Confirmar ${item.codigo || id}`,
        desc: `Quantidade actual de "${item.nome || id}"? (Sistema: ${item.quantidade || 0})`,
        type: 'confirm', okLabel: 'Confirmar',
        onConfirm: () => {
            const val = parseFloat($id('inv-qtd')?.value);
            if (!isNaN(val) && val >= 0) {
                _invChanges[id] = val;
                _invSkipped.delete(id);
                _invSaveResume();
                showToast(`${item.codigo || id} confirmado`);
                invSearchClear();
            }
        },
    });
    // Injecta input no slot dedicado do modal
    const slot = $id('confirm-modal-slot');
    if (slot) {
        const qInput = $el('input');
        qInput.type = 'number'; qInput.min = '0'; qInput.step = 'any';
        qInput.value = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
        qInput.className = 'inv-qty-input';
        qInput.id = 'inv-qtd';
        qInput.style.cssText = 'width:100%;text-align:center';
        qInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $id('confirm-modal-ok').click(); }});
        slot.appendChild(qInput);
        setTimeout(() => { qInput.focus(); qInput.select(); }, 50);
    }
}

// ── Guardar progresso parcial ─────────────────────────────────────────────────
function _openInvSavePartial() {
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;
    const remaining = _invItems.length - confirmed - skipped;

    const statsEl = $id('inv-partial-stats');
    if (statsEl) {
        statsEl.innerHTML = `
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--success)">${confirmed}</span>
                <span class="inv-partial-stat-lbl">Confirmados</span>
            </div>
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--danger)">${skipped}</span>
                <span class="inv-partial-stat-lbl">Saltados</span>
            </div>
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--text-muted)">${remaining}</span>
                <span class="inv-partial-stat-lbl">Por fazer</span>
            </div>`;
    }
    modalOpen('inv-partial-modal');
    focusModal('inv-partial-modal');
}

// Guarda progresso no Firebase (já está guardado incrementalmente) e sai para o menu
async function invSaveAndExit() {
    // Força um último save para garantir que está actualizado
    await _invSaveResume();
    // Fecha todos os modais do inventário
    modalClose('inv-partial-modal');
    modalClose('inv-modal');
    invSearchClear();
    showToast('Progresso guardado — podes retomar em qualquer dispositivo', 'success');
}

async function exportInventoryPartialEmail() {
    // Guarda no Firebase antes de exportar
    await _invSaveResume();
    modalClose('inv-partial-modal');
    // Fecha o inventário
    modalClose('inv-modal');
    invSearchClear();
    await exportInventoryEmail(true); // true = parcial
}

function _finishInventory() {
    modalClose('inv-modal');
    _invClearResume(); // limpa a sessão guardada

    const data = cache.stock.data || {};
    const changed = Object.entries(_invChanges).filter(([id, newQty]) => {
        const oldQty = data[id]?.quantidade;
        return oldQty !== undefined && newQty !== oldQty;
    });

    // Abre modal de revisão
    _openInvReview(changed, data);
}

function _openInvReview(changed, data) {
    const total     = _invItems.length;
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;

    const descEl = $id('inv-review-desc');
    descEl.textContent = changed.length === 0
        ? `${confirmed} produto${confirmed !== 1?'s':''} confirmado${confirmed !== 1?'s':''} — sem diferenças de quantidade.`
        : `${changed.length} diferença${changed.length !== 1?'s':''} encontrada${changed.length !== 1?'s':''}. Revê e confirma antes de guardar.`;

    const listEl = $id('inv-review-list');
    listEl.innerHTML = '';

    if (changed.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Tudo conforme ✓</div>';
    } else {
        changed.forEach(([id, newQty]) => {
            const item   = data[id] || {};
            const oldQty = item.quantidade || 0;
            const diff   = newQty - oldQty;
            const row = $el('label', { className: 'inv-review-row' });

            const cb  = $el('input');
            cb.type   = 'checkbox';
            cb.checked = true;
            cb.dataset.id = id;
            cb.className  = 'inv-review-cb';

            const info = $el('div', { className: 'inv-review-info' });

            const nome = $el('span', { className: 'inv-review-nome' });
            nome.textContent = item.nome || id;

            const qty = $el('span', { className: 'inv-review-qty' });
            const sign = diff > 0 ? '+' : '';
            const oldSpan = $el('span', { className: 'inv-rev-old' });
            oldSpan.textContent = fmtQty(oldQty, item.unidade);
            const arr  = document.createTextNode(' → ');
            const newSpan = $el('span', { className: 'inv-rev-new' });
            newSpan.textContent = fmtQty(newQty, item.unidade);
            const sp = document.createTextNode(' ');
            const diffSpan = $el('span');
            diffSpan.className   = 'inv-rev-diff ' + (diff > 0 ? 'inv-rev-plus' : 'inv-rev-minus');
            diffSpan.textContent = '(' + sign + fmtQty(diff, item.unidade) + ')';
            qty.appendChild(oldSpan); qty.appendChild(arr);
            qty.appendChild(newSpan); qty.appendChild(sp); qty.appendChild(diffSpan);

            info.appendChild(nome);
            info.appendChild(qty);
            row.appendChild(cb);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    }

    modalOpen('inv-review-modal');
    focusModal('inv-review-modal');
}

function invReviewBack() {
    modalClose('inv-review-modal');
    // Reabre o inventário no último produto
    modalOpen('inv-modal');
    _invSaveResume();
}

async function invReviewConfirm() {
    modalClose('inv-review-modal');

    const data    = cache.stock.data || {};
    const checked = [...document.querySelectorAll('.inv-review-cb:checked')].map(cb => cb.dataset.id);

    // Estatísticas para o ecrã de resultado
    let totalAdded   = 0;
    let totalRemoved = 0;
    let savedCount   = 0;

    // Calcula estatísticas e actualiza cache local primeiro
    const patches = [];
    for (const id of checked) {
        const newQty = _invChanges[id];
        const oldQty = data[id]?.quantidade || 0;
        if (newQty === undefined) continue;
        const diff = newQty - oldQty;
        if (diff > 0) totalAdded   += diff;
        if (diff < 0) totalRemoved += Math.abs(diff);
        savedCount++;
        if (data[id]) data[id].quantidade = newQty;
        patches.push({ id, newQty });
    }
    // Envia todos os PATCHes em paralelo — muito mais rápido que em série
    const results = await Promise.allSettled(
        patches.map(({ id, newQty }) =>
            apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: newQty })
            })
        )
    );
    if (results.some(r => r.status === 'rejected')) {
        console.warn('invSave: alguns PATCHes falharam');
        invalidateCache('stock');
    }

    renderList(window._searchInputEl?.value || '', true);
    renderDashboard();

    // Guardar snapshot final para exportação
    _invLastData = { ...cache.stock.data };

    // Mostrar resultado com stats
    _openInvResult({
        total:      _invItems.length,
        confirmed:  Object.keys(_invChanges).length,
        skipped:    _invSkipped.size,
        saved:      savedCount,
        added:      totalAdded,
        removed:    totalRemoved,
    });
}

function _openInvResult(stats) {
    const statsEl = $id('inv-result-stats');
    statsEl.innerHTML = `
        <div class="inv-stat-grid">
            <div class="inv-stat-card inv-stat-ok">
                <span class="inv-stat-num">${stats.confirmed}</span>
                <span class="inv-stat-label">Confirmados</span>
            </div>
            <div class="inv-stat-card inv-stat-skip">
                <span class="inv-stat-num">${stats.skipped}</span>
                <span class="inv-stat-label">Saltados</span>
            </div>
            <div class="inv-stat-card inv-stat-plus">
                <span class="inv-stat-num">+${stats.added}</span>
                <span class="inv-stat-label">Unid. adicionadas</span>
            </div>
            <div class="inv-stat-card inv-stat-minus">
                <span class="inv-stat-num">−${stats.removed}</span>
                <span class="inv-stat-label">Unid. removidas</span>
            </div>
        </div>
        ${stats.saved > 0
            ? `<p class="inv-result-saved">${stats.saved} alteração${stats.saved !== 1?'s':''} guardada${stats.saved !== 1?'s':''} no sistema.</p>`
            : '<p class="inv-result-saved">Nenhuma diferença encontrada — stock conforme!</p>'}
    `;
    modalOpen('inv-result-modal');
    focusModal('inv-result-modal');
}

async function exportInventoryExcel() {
    await loadXlsx();
    const wb       = _buildInventoryWorkbook();
    const filename = `inventario-hiperfrio-${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel exportado com sucesso!');
}

async function exportInventoryEmail(parcial = false) {
    await loadXlsx();
    const now     = new Date();
    const dateStr = now.toLocaleDateString('pt-PT');
    const data    = _invLastData || cache.stock.data || {};
    const diffRows = _invItems
        .filter(([id]) => {
            const nq = _invChanges[id];
            return nq !== undefined && nq !== (data[id]?.quantidade || 0);
        })
        .map(([id, item]) => {
            const nq = _invChanges[id];
            const oq = item.quantidade || 0;
            return `• ${item.nome||id} (${item.localizacao||'sem zona'}): ${fmtQty(oq, item.unidade)} → ${fmtQty(nq, item.unidade)}`;
        });

    const parcialLabel = parcial ? ' [PARCIAL]' : '';
    const subject = encodeURIComponent(`Inventário Hiperfrio${parcialLabel} — ${dateStr}`);
    const body = encodeURIComponent(
        `Inventário Hiperfrio${parcialLabel} — ${dateStr}\n\n`
        + `Produtos verificados: ${Object.keys(_invChanges).length}/${_invItems.length}\n`
        + (parcial ? `Por verificar: ${_invItems.length - Object.keys(_invChanges).length - _invSkipped.size}\n` : '')
        + `Diferenças encontradas: ${diffRows.length}\n\n`
        + (diffRows.length > 0 ? 'ALTERAÇÕES:\n' + diffRows.join('\n') + '\n\n' : 'Sem diferenças de stock.\n\n')
        + '(Ficheiro Excel em anexo)'
    );

    const destEmail = _invGetEmail();

    // Tenta Web Share API com ficheiro (Android)
    if (navigator.canShare) {
        try {
            const wb   = _buildInventoryWorkbook();
            const blob = new Blob(
                [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            );
            const filename = `inventario-hiperfrio${parcial ? '-parcial' : ''}-${now.toISOString().slice(0,10)}.xlsx`;
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: `Inventário Hiperfrio${parcialLabel} — ${dateStr}`,
                    text:  `Relatório de inventário de ${dateStr}`,
                    files: [file],
                });
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('share:', e);
        }
    }

    // Fallback: download do Excel + mailto com destinatário pré-preenchido
    exportInventoryExcel();
    setTimeout(() => {
        const mailto = destEmail
            ? `mailto:${encodeURIComponent(destEmail)}?subject=${subject}&body=${body}`
            : `mailto:?subject=${subject}&body=${body}`;
        window.open(mailto, '_blank');
    }, 800);
}

// Helper partilhado por exportInventoryEmail e exportInventoryExcel
function _buildInventoryWorkbook() {
    const data = _invLastData || cache.stock.data || {};
    const now  = new Date();
    const rows = _invItems.map(([id, item]) => {
        const newQty  = _invChanges[id];
        const origQty = item.quantidade || 0;
        const status  = _invSkipped.has(id) ? 'Saltado'
            : newQty === undefined ? 'Não verificado'
            : newQty === origQty   ? 'Conforme'
            : newQty > origQty     ? 'Corrigido ↑' : 'Corrigido ↓';
        return {
            'Referência': item.codigo||'', 'Nome': item.nome||'',
            'Zona': item.localizacao||'SEM LOCAL',
            'Qtd Sistema': origQty,
            'Qtd Inventário': newQty !== undefined ? newQty : origQty,
            'Diferença': newQty !== undefined ? newQty - origQty : 0,
            'Unidade': item.unidade === 'un' || !item.unidade ? '' : item.unidade,
            'Estado': status, 'Notas': item.notas||'',
        };
    });
    const wb  = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(rows);
    ws1['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, 'Inventário Completo');
    const diffRows = rows.filter(r => r['Diferença'] !== 0);
    if (diffRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(diffRows);
        ws2['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws2, 'Diferenças');
    }
    const ws3 = XLSX.utils.aoa_to_sheet([
        ['Hiperfrio Stock — Relatório de Inventário',''],
        ['Data', now.toLocaleDateString('pt-PT')],
        ['Hora', now.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})],
        ['Produtos verificados', Object.keys(_invChanges).length],
        ['Produtos saltados', _invSkipped.size],
        ['Total de produtos', _invItems.length],
        ['Diferenças encontradas', diffRows.length],
    ]);
    ws3['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Resumo');
    return wb;
}

// ── Inventário Resume — Firebase /inv-resume/shared (72h TTL) ──────────────
// Caminho único partilhado — não depende do dispositivo nem do username em localStorage
const INV_RESUME_FIREBASE_TTL = 72 * 60 * 60 * 1000; // 72 horas em ms

function _invResumeUserKey() {
    const username = (localStorage.getItem(USER_KEY) || '').trim().toLowerCase();
    return username && /^[a-z0-9._-]+$/.test(username) ? username : 'anon-device';
}

function _invResumeUrl() {
    return `${BASE_URL}/inv-resume/${encodeURIComponent(_invResumeUserKey())}.json`;
}

async function _invSaveResume() {
    try {
        const payload = JSON.stringify({
            idx:     _invIdx,
            items:   _invItems,
            changes: _invChanges,
            skipped: [..._invSkipped],
            options: _invOptions,
            ts:      Date.now(),
        });
        const url = await authUrl(_invResumeUrl());
        // await o fetch — garante que os dados chegaram ao Firebase antes de continuar
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload });
    } catch (e) { console.warn('invSaveResume:', e); }
}

async function _invLoadResume() {
    try {
        const url = await authUrl(_invResumeUrl());
        const res = await fetch(url);
        if (!res.ok) {
            console.warn('invLoadResume: resposta', res.status, res.statusText);
            return null;
        }
        const saved = await res.json();
        if (!saved || !saved.items || saved.items.length === 0) {
            return null;
        }
        if (Date.now() - (saved.ts || 0) > INV_RESUME_FIREBASE_TTL) {
            _invClearResume();
            return null;
        }
        return saved;
    } catch (e) {
        console.warn('invLoadResume erro:', e);
        return null;
    }
}

async function _invClearResume() {
    try {
        const url = await authUrl(_invResumeUrl());
        fetch(url, { method: 'DELETE' }).catch(() => {});
    } catch (_e) {}
}

// BOTTOM NAV — botão + com mini-menu
let _bnavAddOpen = false;

function bnavAddToggle() {
    _bnavAddOpen ? bnavAddClose() : bnavAddOpen();
}

function bnavAddOpen() {
    _bnavAddOpen = true;
    const menu    = $id('bnav-add-menu');
    const overlay = $id('bnav-add-overlay');
    const btn     = $id('fab-add');
    menu?.classList.add('open');
    overlay?.classList.add('open');
    btn?.classList.add('fab-open');
    document.addEventListener('keydown', _bnavAddEsc, { once: true });
}

function bnavAddClose() {
    _bnavAddOpen = false;
    const menu    = $id('bnav-add-menu');
    const overlay = $id('bnav-add-overlay');
    const btn     = $id('fab-add');
    menu?.classList.remove('open');
    overlay?.classList.remove('open');
    btn?.classList.remove('fab-open');
}

function _bnavAddEsc(e) {
    if (e.key === 'Escape') bnavAddClose();
}

function bnavAddChoose(viewId) {
    bnavAddClose();
    nav(viewId);
}

document.addEventListener('DOMContentLoaded', () => {
    // PAT: só aceita dígitos
    $id('pat-numero')?.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
        const hint = $id('pat-numero-hint');
        if (hint) {
            if (this.value.length > 0 && this.value.length < 6) {
                hint.textContent = `${this.value.length}/6 dígitos`;
                hint.style.color = 'var(--text-muted)';
            } else {
                hint.textContent = '';
            }
        }
    });

    // Tema
    const savedTheme = localStorage.getItem('hiperfrio-tema') || 'light';
    _applyTheme(savedTheme);
    // _applyTheme já chama _setupSearchScrollBehaviour e _setupBottomNavScrollBehaviour
    _setupAdminSwipe();

    // Verifica perfil guardado — se existir, arranca diretamente
    const savedRole = localStorage.getItem(ROLE_KEY);
    if (savedRole === 'worker' || savedRole === 'manager') {
        applyRole(savedRole);
        bootApp();
    }

    // Pesquisa com debounce — cache o elemento para evitar lookups repetidos
    const searchInput = $id('inp-search');
    const searchClear = $id('inp-search-clear');
    window._searchInputEl = searchInput; // referência global para renderList
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            const val = e.target.value;
            if (searchClear) searchClear.classList.toggle('hidden', !val);
            if (val) { _zeroFilterActive = false; const b = $id('zero-filter-badge'); if (b) b.remove(); }
            debounceTimer = setTimeout(() => renderList(val), 300);
        };
    }

    // Delegação de eventos nas ferramentas — um único listener no container
    const toolsListEl = $id('tools-list');
    if (toolsListEl) {
        toolsListEl.addEventListener('contextmenu', e => {
            const div = e.target.closest('[data-tool-id]');
            if (!div) return;
            e.preventDefault();
            openHistoryModal(div.dataset.toolId, div.dataset.toolNome);
        });
        let _lpTimer = null;
        toolsListEl.addEventListener('touchstart', e => {
            const div = e.target.closest('[data-tool-id]');
            if (!div) return;
            _lpTimer = setTimeout(() => openHistoryModal(div.dataset.toolId, div.dataset.toolNome), 600);
        }, { passive: true });
        toolsListEl.addEventListener('touchend',  () => clearTimeout(_lpTimer), { passive: true });
        toolsListEl.addEventListener('touchmove', () => clearTimeout(_lpTimer), { passive: true });
    }

    // Pesquisa de ferramentas (usa _debounce centralizado)
    $id('inp-tools-search')?.addEventListener('input', _debounce(e => {
        _toolsFilter = e.target.value.trim() || 'all';
        renderTools();
    }, 250));

    // Escape fecha o modal ativo
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modals = [
            { id: 'worker-modal',       close: () => modalClose('worker-modal') },
            { id: 'edit-modal',         close: () => modalClose('edit-modal') },
            { id: 'confirm-modal',      close: closeConfirmModal },
            { id: 'switch-role-modal',  close: () => modalClose('switch-role-modal') },
            { id: 'history-modal',      close: () => modalClose('history-modal') },
            { id: 'dup-modal',          close: () => modalClose('dup-modal') },
            { id: 'inv-setup-modal',    close: closeInvSetup },
            { id: 'inv-modal',          close: closeInventory },
            { id: 'inv-review-modal',   close: invReviewBack },
            { id: 'inv-result-modal',   close: () => modalClose('inv-result-modal') },
            { id: 'timeline-modal',     close: () => modalClose('timeline-modal') },
            { id: 'edit-tool-modal',    close: () => modalClose('edit-tool-modal') },
            { id: 'modal-edit-cliente', close: () => modalClose('modal-edit-cliente') },
            { id: 'gimg-settings-modal',close: closeGimgSettings },
            { id: 'product-detail-modal',close: () => modalClose('product-detail-modal') },
        ];
        for (const { id, close } of modals) {
            if ($id(id)?.classList.contains('active')) { close(); break; }
        }
        const anyUnitOpen = UNIT_PREFIXES.some(p =>
            $id(`${p}-unit-menu`)?.classList.contains('open')
        );
        if (anyUnitOpen) {
            _closeAllUnitMenus();
            document.removeEventListener('click', _onOutsideUnitClick);
        }
    });

    // Online/Offline
    window.addEventListener('offline', () => {
        updateOfflineBanner();
        showToast('Sem ligação — alterações guardadas localmente', 'error');
    });
    window.addEventListener('online', async () => {
        updateOfflineBanner();
        await syncQueue();
    });

    // Re-render stock ao redimensionar (desktop ↔ mobile)
    let _resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            if ($id('view-search')?.classList.contains('active')) {
                renderList(window._searchInputEl?.value || '', true);
            }
        }, 250);
    });

    // Renovação de token ao voltar ao foco — protege sessões longas no Android
    // quando a PWA fica em background e o setTimeout de 45min não disparou
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState !== 'visible') return;
        if (!window._firebaseUser) return;
        const now = Date.now();
        // Renovar se o token expirou ou está a menos de 10min de expirar
        if (_authTokenExp - now < 10 * 60 * 1000) {
            try {
                _authToken = await window._firebaseUser.getIdToken(true);
                _authTokenExp = now + 3_500_000;
                _scheduleTokenRenewal(); // re-agenda o timer
            } catch(e) { console.warn('[Auth] falha ao renovar no visibilitychange:', e.message); }
        }
        // Sincronizar fila offline se houver ligação
        if (navigator.onLine) syncQueue().catch(() => {});
    });

    // Background Sync
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => {
            window._registerBackgroundSync = () => {
                sw.sync.register('hiperfrio-sync').catch(() => {});
            };
        }).catch(() => {});
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', async e => {
            if (e.data?.type === 'SYNC_QUEUE') { await syncQueue(); }
            if (e.data?.type === 'SW_UPDATED') {
                // Nova versão do SW activou — recarrega a página para garantir
                // que CSS/JS em cache de memória são substituídos.
                // Evita loop: só recarrega uma vez por sessão.
                if (!sessionStorage.getItem('sw-reload-done')) {
                    sessionStorage.setItem('sw-reload-done', '1');
                    console.log('[SW] Nova versão activa, a recarregar...');
                    // Pequeno delay para toast aparecer se estiver visível
                    setTimeout(() => window.location.reload(), 200);
                }
            }
        });
    }

    // Confirm modal OK — desabilita durante operações async
    $id('confirm-modal-ok').onclick = async () => {
        const cb = confirmCallback;
        if (!cb) return;
        const btn = $id('confirm-modal-ok');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'A processar...';
        closeConfirmModal();
        try { await cb(); }
        finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    // Delete confirm — chamado pelo openDeleteModal via _deleteProductCallback
    window._deleteProductCallback = async (id, item) => {
        delete cache.stock.data[id];
        renderList(window._searchInputEl?.value || '', true);
        renderDashboard();
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'DELETE' });
            // Só agora, com delete confirmado, registar a remoção.
            // Se DELETE caiu para queue offline (apiFetch → null sem lançar),
            // o movimento também vai para queue — ambos sincronizam juntos.
            if (item) registarMovimento('remocao', id, item.codigo, item.nome, item.quantidade || 0);
        } catch (e) {
            console.warn('deleteProduct erro:', e?.message || e);
            cache.stock.data[id] = item;
            renderList(window._searchInputEl?.value || '', true);
            renderDashboard();
            showToast('Erro ao apagar produto','error');
        }
    };

    // Form: Novo Produto
    $id('form-add')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = $id('inp-codigo').value.trim().toUpperCase();
        const unidade = $id('inp-unidade').value || 'un';
        const payload = {
            nome:        $id('inp-nome').value.trim().toUpperCase(),
            localizacao: $id('inp-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat($id('inp-qtd').value) || 0,
            unidade,
            notas:       $id('inp-notas')?.value.trim() || '',
            codigo,
        };
        if (unidade === 'kg') {
            const gMax   = parseFloat($id('inp-gas-max')?.value);
            const gAlert = parseFloat($id('inp-gas-alerta')?.value);
            if (!isNaN(gMax)   && gMax   > 0) payload.gasMax    = gMax;
            if (!isNaN(gAlert) && gAlert > 0) payload.gasAlerta = gAlert;
        }
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(`${BASE_URL}/stock.json`, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
                renderDashboard();
                setUnitSelector('inp', 'un');
                showToast('Produto Registado!'); nav('view-search'); e.target.reset();
            } catch(_e) { invalidateCache('stock'); showToast('Erro ao registar produto','error'); }
            finally { btn.disabled = false; }
        };
        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Lote
    $id('form-bulk')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = $id('bulk-codigo').value.trim().toUpperCase();
        const zona   = $id('bulk-loc').value.trim().replace(/\s+/g,'').toUpperCase();
        const unidade = $id('bulk-unidade').value || 'un';
        const payload = {
            localizacao: zona,
            codigo,
            nome:       $id('bulk-nome').value.trim().toUpperCase(),
            quantidade: parseFloat($id('bulk-qtd').value) || 0,
            unidade,
            notas:      $id('bulk-notas')?.value.trim() || '',
        };
        if (unidade === 'kg') {
            const gMax   = parseFloat($id('bulk-gas-max')?.value);
            const gAlert = parseFloat($id('bulk-gas-alerta')?.value);
            if (!isNaN(gMax)   && gMax   > 0) payload.gasMax    = gMax;
            if (!isNaN(gAlert) && gAlert > 0) payload.gasAlerta = gAlert;
        }
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(`${BASE_URL}/stock.json`, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
                _bulkCount++;
                _updateBulkCounter();
                _saveZoneToHistory(zona);
                showToast(`${payload.codigo} adicionado ao lote!`);
                $id('bulk-codigo').value = '';
                $id('bulk-nome').value   = '';
                $id('bulk-qtd').value    = '1';
                $id('bulk-notas').value  = '';
                $id('bulk-codigo').focus();
            } catch(_e) { invalidateCache('stock'); showToast('Erro ao adicionar ao lote','error'); }
            finally { btn.disabled = false; }
        };
        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Editar Produto
    $id('form-edit')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id      = $id('edit-id').value;
        const btn     = e.target.querySelector('button[type=submit]');
        const unidade = $id('edit-unidade').value || 'un';
        btn.disabled  = true;
        const updated = {
            codigo:      $id('edit-codigo').value.trim().toUpperCase(),
            nome:        $id('edit-nome').value.trim().toUpperCase(),
            localizacao: $id('edit-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat($id('edit-qtd').value) || 0,
            unidade,
            notas:       $id('edit-notas')?.value.trim() || '',
        };
        if (unidade === 'kg') {
            const gMax   = parseFloat($id('edit-gas-max')?.value);
            const gAlert = parseFloat($id('edit-gas-alerta')?.value);
            updated.gasMax    = (!isNaN(gMax)   && gMax   > 0) ? gMax    : null;
            updated.gasAlerta = (!isNaN(gAlert) && gAlert > 0) ? gAlert  : null;
        } else {
            // Limpar campos de gás se unidade mudou de kg para outra
            updated.gasMax    = null;
            updated.gasAlerta = null;
        }
        // Imagem do produto — URL ou null
        const imgUrlVal = $id('edit-img-url')?.value.trim();
        updated.imgUrl = imgUrlVal || null;

        const _oldQtyEdit = cache.stock.data?.[id]?.quantidade ?? 0;
        const _oldStockCache = { ...cache.stock.data[id] }; // snapshot para rollback
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        btn.textContent = 'A guardar...';
        modalClose('edit-modal');
        renderList(window._searchInputEl?.value || '', true);
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'PATCH', body:JSON.stringify(updated) });
            // Só após PATCH confirmado: regista saída se a quantidade desceu.
            // Se foi queued (offline), apiFetch retorna null sem lançar — também
            // registamos porque o movimento vai para a mesma queue.
            if (updated.quantidade < _oldQtyEdit) {
                registarMovimento('saida_manual', id, updated.codigo, updated.nome, _oldQtyEdit - updated.quantidade);
            }
            showToast('Produto atualizado!');
        } catch (e) {
            console.warn('editProduct:', e?.message||e);
            // Rollback do cache — PATCH falhou mesmo online
            cache.stock.data[id] = _oldStockCache;
            invalidateCache('stock');
            renderList(window._searchInputEl?.value || '', true);
            showToast('Erro ao guardar alterações','error');
        }
        finally { btn.disabled = false; btn.textContent = 'Guardar Alterações'; }
    });

    // Form: Funcionário
    $id('form-worker')?.addEventListener('submit', async e => {
        e.preventDefault();
        if (!requireManagerAccess()) return;
        const nome = $id('worker-name').value.trim().toUpperCase();
        if (!nome) return;
        try {
            const res = await apiFetch(`${BASE_URL}/funcionarios.json`, { method:'POST', body:JSON.stringify({nome}) });
            if (!cache.funcionarios.data) cache.funcionarios.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.funcionarios.data[r.name] = {nome}; }
            else { cache.funcionarios.data[`_tmp_${Date.now()}`] = {nome}; }
            $id('worker-name').value = '';
            renderWorkers(); showToast('Funcionário adicionado');
        } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao adicionar funcionário','error'); }
    });

    // Form: Registar Ferramenta
    $id('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        if (!requireManagerAccess()) return;
        const nome  = $id('reg-tool-name').value.trim().toUpperCase();
        const payload = { nome, status:'disponivel' };
        try {
            const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.ferramentas.data[r.name] = payload; }
            else { cache.ferramentas.data[`_tmp_${Date.now()}`] = payload; }
            $id('reg-tool-name').value = '';
            renderAdminTools(); showToast('Ferramenta registada');
        } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao registar ferramenta','error'); }
    });

    // Form: Editar Ferramenta
    $id('form-edit-tool')?.addEventListener('submit', async e => {
        e.preventDefault();
        await saveEditTool();
    });

    // Desktop layout — o CSS gere sidebar e main-content via media query
    // Aqui apenas gerimos o fab-add que o CSS não controla
    function applyDesktopLayout() {
        const isDesktop = window.innerWidth >= 768;
        const fab = $id('fab-add');
        if (fab) fab.style.display = isDesktop ? 'none' : '';
    }
    applyDesktopLayout();
    window.addEventListener('resize', applyDesktopLayout);
});

// REGISTO PWA
// ATENÇÃO: estas duas constantes TÊM de subir em cada bump de versão.
// SW_EXPECTED_VERSION deve bater certo com SW_VERSION em sw.js, senão o
// client deteta sempre "SW desactualizado" e fica em loop de update.
// SW_SCRIPT_URL tem de mudar de query string ou o browser não re-baixa o SW.
const SW_EXPECTED_VERSION = 'hiperfrio-v6.62';
const SW_SCRIPT_URL = 'sw.js?v=6.62';

if ('serviceWorker' in navigator) {
    // Forçar limpeza de SW desactualizados
    /* preserva o SW actual */
    // Limpar todas as caches
    /* preserva cache do SW activo */
    window.addEventListener('load', () => {
        // 1 — Regista o SW novo
        navigator.serviceWorker.register(SW_SCRIPT_URL)
            .then(reg => {
                reg.update().catch(() => {});
                // 2 — Verifica se o SW activo é a versão correcta
                // Se for uma versão antiga (cache-first), força update imediato
                if (reg.active) {
                    const msgChannel = new MessageChannel();
                    msgChannel.port1.onmessage = e => {
                        if (e.data && e.data.version !== SW_EXPECTED_VERSION) {
                            console.warn('SW desactualizado — a forçar update...');
                            reg.update().then(() => {
                                // Após update, recarrega para aplicar
                                navigator.serviceWorker.addEventListener('controllerchange', () => {
                                    window.location.reload();
                                }, { once: true });
                            });
                        }
                    };
                    reg.active.postMessage({ type: 'GET_VERSION' }, [msgChannel.port2]);
                }
            })
            .catch(e => console.warn('PWA SW erro:', e));

        // 3 — Se o SW mudar enquanto a app está aberta, recarrega automaticamente
        let swRefreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!swRefreshing) {
                swRefreshing = true;
                window.location.reload();
            }
        });
    });
}

// ENCOMENDAS A FORNECEDOR  (REST API — mesmo padrão do resto da app)
// Firebase: /encomendas/{id}
//   num, fornecedor, data, obs, estado, ts
//   linhas: { "0": {ref, nome, qtd, recebido}, ... }

const ENC_URL = `${BASE_URL}/encomendas`;

let _encFilter  = 'all';
let _encData    = {};
let _encDataTs  = 0;
const ENC_TTL   = 60000;
let _encEditId  = null;
let _encEntradaId   = null;
let _encEntradaLIdx = null;

// ── Carregar dados ────────────────────────────────────────────────────────
async function loadEncomendas(force = false) {
    if (!force && _encDataTs && (Date.now() - _encDataTs < ENC_TTL)) {
        renderEncList();
        return;
    }
    try {
        const res  = await apiFetch(`${ENC_URL}.json`);
        _encData   = res ? await res.json() : {};
        if (!_encData) _encData = {};
        _encDataTs = Date.now();
        renderEncList();
    } catch(e) {
        console.error('[encomendas] load error', e);
    }
}

// Carrega quando navega para a view

// ── Render lista ──────────────────────────────────────────────────────────
let _encProdutosActive = false;

function encToggleProdutosView(btn) {
    _encProdutosActive = !_encProdutosActive;
    btn.classList.toggle('active', _encProdutosActive);
    $id('enc-list').style.display          = _encProdutosActive ? 'none' : '';
    $id('enc-produtos-view').style.display = _encProdutosActive ? '' : 'none';
    // Desactivar filtros de estado quando em modo produtos
    document.querySelectorAll('.enc-filter-btn:not(.enc-filter-produtos)').forEach(b => {
        b.style.opacity        = _encProdutosActive ? '0.4' : '';
        b.style.pointerEvents  = _encProdutosActive ? 'none' : '';
    });
    if (_encProdutosActive) renderEncProdutos();
}

function renderEncProdutos() {
    const wrap = $id('enc-produtos-view');
    if (!wrap) return;

    // Recolher encomendas activas ordenadas por data
    const encs = Object.entries(_encData || {})
        .filter(([, e]) => e.estado !== 'recebida')
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

    if (encs.length === 0) {
        wrap.innerHTML = `<div class="enc-empty"><div class="enc-empty-title">Sem produtos em encomendas activas</div></div>`;
        return;
    }

    // KPIs globais
    let totalRefs = 0, totalFalta = 0, totalCompleto = 0;
    encs.forEach(([, enc]) => {
        Object.values(enc.linhas || {}).forEach(l => {
            const qtd = parseFloat(l.qtd) || 0;
            const rec = Math.min(parseFloat(l.recebido) || 0, qtd);
            totalRefs++;
            if (rec >= qtd) totalCompleto++; else totalFalta++;
        });
    });

    let html = `
        <div class="enc-prod-summary">
            <div class="enc-prod-stat">
                <span class="enc-prod-stat-val">${totalRefs}</span>
                <span class="enc-prod-stat-lbl">Referências</span>
            </div>
            <div class="enc-prod-stat enc-prod-stat-danger">
                <span class="enc-prod-stat-val">${totalFalta}</span>
                <span class="enc-prod-stat-lbl">Por receber</span>
            </div>
            <div class="enc-prod-stat enc-prod-stat-ok">
                <span class="enc-prod-stat-val">${totalCompleto}</span>
                <span class="enc-prod-stat-lbl">Completas</span>
            </div>
        </div>`;

    encs.forEach(([, enc]) => {
        const linhas   = Object.values(enc.linhas || {});
        if (linhas.length === 0) return;
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : '—';
        const estadoLabel = { pendente: 'Pendente', parcial: 'Parcial', recebida: 'Recebida' }[enc.estado] || 'Pendente';
        const totalQtd = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const totalRec = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct      = totalQtd > 0 ? Math.round(totalRec / totalQtd * 100) : 0;

        html += `
        <div class="enc-prod-group">
            <div class="enc-prod-group-hdr">
                <div class="enc-prod-group-title">
                    <span class="enc-prod-group-num">Encomenda ${escapeHtml(enc.num || '—')}</span>
                    <span class="enc-prod-group-sep">·</span>
                    <span class="enc-prod-group-date">${escapeHtml(dataFmt)}</span>
                    ${enc.fornecedor ? `<span class="enc-prod-group-sep">·</span><span class="enc-prod-group-forn">${escapeHtml(enc.fornecedor)}</span>` : ''}
                </div>
                <div class="enc-prod-group-meta">
                    <span class="enc-badge enc-badge-${enc.estado || 'pendente'}">${estadoLabel}</span>
                    <span class="enc-prod-group-pct">${totalRec}/${totalQtd} un · ${pct}%</span>
                </div>
            </div>
            <table class="enc-prod-table">
                <thead>
                    <tr>
                        <th>Referência</th>
                        <th>Designação</th>
                        <th class="enc-prod-th-num">Enc.</th>
                        <th class="enc-prod-th-num">Rec.</th>
                        <th class="enc-prod-th-num">Falta</th>
                        <th class="enc-prod-th-num">Estado</th>
                    </tr>
                </thead>
                <tbody>`;

        // Ordenar: por receber primeiro
        const sorted = [...linhas].sort((a, b) => {
            const fa = (parseFloat(a.qtd)||0) - Math.min(parseFloat(a.recebido)||0, parseFloat(a.qtd)||0);
            const fb = (parseFloat(b.qtd)||0) - Math.min(parseFloat(b.recebido)||0, parseFloat(b.qtd)||0);
            return fb - fa;
        });

        sorted.forEach(l => {
            const qtd     = parseFloat(l.qtd) || 0;
            const rec     = Math.min(parseFloat(l.recebido) || 0, qtd);
            const falta   = qtd - rec;
            const pctL    = qtd > 0 ? Math.round(rec / qtd * 100) : 0;
            const completo = falta <= 0;
            const rowClass = completo ? 'enc-prod-row-ok' : rec > 0 ? 'enc-prod-row-partial' : 'enc-prod-row-pending';
            const badge   = completo
                ? `<span class="enc-prod-badge enc-prod-badge-ok">Recebido</span>`
                : rec > 0
                    ? `<span class="enc-prod-badge enc-prod-badge-partial">${pctL}%</span>`
                    : `<span class="enc-prod-badge enc-prod-badge-pending">Pendente</span>`;
            const ref  = (l.ref  || '').trim().toUpperCase();
            const nome = (l.nome || l.desc || '').trim();

            html += `
                <tr class="enc-prod-row ${rowClass}">
                    <td class="enc-prod-ref">${escapeHtml(ref || '—')}</td>
                    <td class="enc-prod-nome">${escapeHtml(nome || '—')}</td>
                    <td class="enc-prod-td-num">${qtd}</td>
                    <td class="enc-prod-td-num">${rec}</td>
                    <td class="enc-prod-td-num ${completo ? '' : 'enc-prod-falta'}">${completo ? '—' : falta}</td>
                    <td class="enc-prod-td-num">${badge}</td>
                </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    wrap.innerHTML = html;
}

function renderEncList() {
    const wrap = $id('enc-list');
    if (!wrap) return;

    let entries = Object.entries(_encData)
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

    if (_encFilter !== 'all')
        entries = entries.filter(([, e]) => e.estado === _encFilter);

    wrap.innerHTML = '';

    if (entries.length === 0) {
        const label = _encFilter === 'all' ? 'Nenhuma encomenda registada' : 'Nenhuma encomenda ' + _encFilter;
        const sub   = _encFilter === 'all' ? 'Cria a primeira encomenda com o bot\u00e3o acima.' : 'N\u00e3o existem encomendas com este estado.';
        wrap.innerHTML = `
            <div class="enc-empty">
                <div class="enc-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                        <line x1="12" y1="22.08" x2="12" y2="12"/>
                    </svg>
                </div>
                <div class="enc-empty-title">${escapeHtml(label)}</div>
                <div class="enc-empty-text">${escapeHtml(sub)}</div>
            </div>`;
        return;
    }

    entries.forEach(([id, enc]) => {
        const linhas   = Object.values(enc.linhas || {});
        const total    = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const recebido = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct      = total > 0 ? Math.round(recebido / total * 100) : 0;
        const estadoLabel = { pendente: 'Pendente', parcial: 'Parcial', recebida: 'Recebida' }[enc.estado] || 'Pendente';
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : '—';

        // Card
        const card = $el('div', { className: 'enc-card' });
        card.onclick   = () => openEncDetail(id);

        // Top row
        const top = $el('div', { className: 'enc-card-top' });

        const left = $el('div');
        const num = $el('div', { className: 'enc-card-num' });
        num.textContent = 'Encomenda Nº ' + (enc.num || '—');
        const forn = $el('div', { className: 'enc-card-forn' });
        forn.textContent = enc.fornecedor || '—';
        left.appendChild(num);
        left.appendChild(forn);

        const right = $el('div');
        right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px';
        const badge = $el('span');
        badge.className   = 'enc-badge enc-badge-' + (enc.estado || 'pendente');
        badge.textContent = estadoLabel;
        const date = $el('span', { className: 'enc-card-date' });
        date.textContent = dataFmt;
        right.appendChild(badge);
        right.appendChild(date);

        top.appendChild(left);
        top.appendChild(right);

        // Progress
        const progWrap = $el('div', { className: 'enc-progress-wrap' });
        const bar = $el('div', { className: 'enc-progress-bar' });
        const fill = $el('div', { className: 'enc-progress-fill' });
        fill.style.width  = pct + '%';
        bar.appendChild(fill);
        const lbl = $el('div', { className: 'enc-progress-label' });
        lbl.textContent = `${recebido} / ${total} unidades recebidas (${pct}%)`;
        progWrap.appendChild(bar);
        progWrap.appendChild(lbl);

        card.appendChild(top);
        card.appendChild(progWrap);
        wrap.appendChild(card);
    });
}

function encFilterSet(btn, filter) {
    _encFilter = filter;
    document.querySelectorAll('.enc-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderEncList();
}

// ── Calculadora de Stock por Peso ─────────────────────────────────────────

function openWeightCalc() {
    weightCalcReset();
    modalOpen('weight-calc-modal');
    focusModal('weight-calc-modal');
    setTimeout(() => $id('wc-sample-units').focus(), 120);
}

function weightCalcReset() {
    ['wc-sample-units','wc-sample-weight','wc-total-weight'].forEach(id => {
        const el = $id(id);
        if (el) el.value = '';
    });
    $id('wc-unit-weight').textContent = '';
    $id('wc-result').style.display = 'none';
}

function weightCalcUpdate() {
    const sampleUnits  = parseFloat($id('wc-sample-units').value);
    const sampleWeight = parseFloat($id('wc-sample-weight').value);
    const totalWeight  = parseFloat($id('wc-total-weight').value);

    const unitWeightEl = $id('wc-unit-weight');
    const resultEl     = $id('wc-result');
    const resultValEl  = $id('wc-result-value');
    const resultSubEl  = $id('wc-result-sub');

    // Mostrar peso por unidade
    if (sampleUnits > 0 && sampleWeight > 0) {
        const unitGrams = sampleWeight / sampleUnits;
        unitWeightEl.textContent = `≈ ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)} g por unidade`;
    } else {
        unitWeightEl.textContent = '';
    }

    // Calcular resultado
    if (sampleUnits > 0 && sampleWeight > 0 && totalWeight > 0) {
        const unitGrams = sampleWeight / sampleUnits;
        const units     = totalWeight / unitGrams;
        const rounded   = Math.round(units);
        const exact     = units % 1 === 0;

        resultValEl.textContent = rounded.toLocaleString('pt-PT');
        resultSubEl.textContent = exact
            ? `${totalWeight}g ÷ ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)}g = ${rounded} unidades exactas`
            : `${totalWeight}g ÷ ${unitGrams.toFixed(2)}g = ${units.toFixed(2)} → arredondado para ${rounded}`;
        resultEl.style.display = 'flex';
    } else {
        resultEl.style.display = 'none';
    }
}

// ── Importar PDF de encomenda via Claude ───────────────────────────────────

async function encImportPdf(inp) {
    const file = inp.files[0];
    if (!file) return;
    inp.value = '';

    const apiKey = _getAnthropicKey();
    if (!apiKey) {
        showToast('Configura o Worker em Definições → Leitura por fotografia', 'error');
        return;
    }

    const label = $id('enc-pdf-label');
    const originalHTML = label ? label.innerHTML : '';
    if (label) {
        label.innerHTML = '◷';
        label.style.pointerEvents = 'none';
        label.style.opacity = '0.6';
    }
    showToast('A analisar PDF…', 'info');

    try {
        const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result.split(',')[1]);
            r.onerror = () => rej(new Error('Erro a ler o ficheiro'));
            r.readAsDataURL(file);
        });

        const prompt = `Analisa este documento PDF de encomenda a fornecedor.

Extrai os seguintes campos e responde APENAS com JSON válido, sem markdown:

{
  "numero": "número da encomenda (alfanumérico) ou null",
  "fornecedor": "nome do fornecedor em MAIÚSCULAS ou null",
  "linhas": [
    { "ref": "referência do produto ou string vazia", "nome": "designação do produto em MAIÚSCULAS", "qtd": número }
  ]
}

REGRAS:
- numero: procura campos "N.º Encomenda", "Ordem de Compra", "OC", "PO", "Ref."
- fornecedor: quem fornece os produtos — procura "Fornecedor", "Supplier", "Para", "A/C"
- linhas: extrai TODAS as linhas de produtos com referência, designação e quantidade encomendada
- qtd deve ser número inteiro — usa coluna "Qtd", "Quantidade", "Qty" ou similar
- Se qtd não existir num produto, usa 1
- Responde APENAS com o JSON`;

        const isProxy  = _isProxyUrl(apiKey);
        const endpoint = isProxy ? apiKey : 'https://api.anthropic.com/v1/messages';
        const headers  = { 'Content-Type': 'application/json' };
        if (!isProxy) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-allow-browser'] = 'true';
        }

        const resp = await _fetchWithTimeout(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1500,
                messages: [{ role: 'user', content: [
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                    { type: 'text', text: prompt }
                ]}]
            })
        });

        if (!resp.ok) {
            const e = await resp.json().catch(() => ({}));
            if (resp.status === 401) throw new Error('Chave API inválida — actualiza em Definições');
            throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }

        const data   = await resp.json();
        const raw    = data.content?.map(b => b.text || '').join('') || '';
        const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());

        openNovaEncomenda();
        if (result.numero)     $id('enc-num').value        = result.numero;
        if (result.fornecedor) $id('enc-fornecedor').value = result.fornecedor;

        if (Array.isArray(result.linhas) && result.linhas.length > 0) {
            $id('enc-linhas-wrap').innerHTML = '';
            for (const l of result.linhas) {
                encAddLinha(l.ref || '', l.nome || '', l.qtd ?? 1);
            }
        }

        const n = result.linhas?.length || 0;
        showToast(`PDF importado — ${n} produto${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}. Revê antes de guardar`, 'ok');

    } catch(e) {
        showToast('Erro ao importar PDF: ' + (e?.message || e), 'error');
        console.error('[encImportPdf]', e);
    } finally {
        if (label) {
            label.innerHTML = originalHTML;
            label.style.pointerEvents = '';
            label.style.opacity = '';
        }
    }
}

// ─── Web Share Target: processar PDF partilhado de outra app ────────────────
// Fluxo: Android partilha PDF → SW intercepta POST → redirige para ?share=ready
// → bootApp chama esta função → pede o ficheiro ao SW → pergunta ao utilizador
// se é Guia ou Encomenda → chama a pipeline correspondente.
async function _handleSharedPdf() {
    // Limpa o parâmetro da URL para não re-disparar em refresh
    if (window.history?.replaceState) {
        window.history.replaceState({}, '', location.pathname);
    }

    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        // Primeiro boot após instalação ainda não tem controller. Raro mas
        // acontece — avisa o utilizador em vez de silenciosamente ignorar.
        console.warn('[share] sem service worker activo');
        showToast('Partilha não disponível — tenta novamente daqui a uns segundos', 'error');
        return;
    }

    // Pedir o ficheiro ao SW via MessageChannel
    const file = await new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (ev) => resolve(ev.data?.file || null);
        navigator.serviceWorker.controller.postMessage(
            { type: 'GET_SHARED_FILE' },
            [ch.port2]
        );
        // Fallback timeout
        setTimeout(() => resolve(null), 3000);
    });

    if (!file) {
        showToast('Ficheiro partilhado expirou ou não foi recebido', 'error');
        return;
    }

    // Pergunta ao utilizador que tipo de documento é
    const tipo = await _askShareType();
    if (!tipo) return; // cancelou

    // Monta um input fake que tem .files[0] e .value — as pipelines existentes
    // esperam um <input type=file> mas nós só precisamos destes 2 atributos.
    const dt = new DataTransfer();
    dt.items.add(file);
    const fakeInp = { files: dt.files, value: '' };

    if (tipo === 'guia')      await guiaImportPdf(fakeInp);
    else if (tipo === 'enc')  await encImportPdf(fakeInp);
}

// Modal simples que pergunta "Guia ou Encomenda?" e devolve 'guia' / 'enc' / null
function _askShareType() {
    return new Promise((resolve) => {
        const overlay = $el('div', { className: 'modal-overlay active share-type-modal' });
        overlay.innerHTML = `
            <div class="modal-content" style="max-width:380px">
                <div class="modal-header">
                    <span class="modal-icon">📄</span>
                    <h3 class="modal-title">PDF partilhado — que tipo?</h3>
                </div>
                <div style="padding:8px 4px 20px;display:flex;flex-direction:column;gap:10px">
                    <button class="btn-primary" data-choice="guia" style="padding:14px;font-size:0.95rem">
                        📋 Guia Técnica
                    </button>
                    <button class="btn-primary" data-choice="enc" style="padding:14px;font-size:0.95rem;background:#059669">
                        📦 Encomenda
                    </button>
                    <button class="btn-cancel" data-choice="cancel" style="padding:12px;font-size:0.88rem">Cancelar</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-choice]');
            if (!b) return;
            const choice = b.dataset.choice;
            overlay.remove();
            resolve(choice === 'cancel' ? null : choice);
        });
    });
}

// ── Modal criar ───────────────────────────────────────────────────────────
function openNovaEncomenda() {
    _encEditId = null;
    $id('enc-modal-title').textContent = 'Nova Encomenda';
    $id('enc-num').value        = '';
    $id('enc-data').value       = new Date().toISOString().split('T')[0];
    $id('enc-fornecedor').value = '';
    $id('enc-obs').value        = '';
    $id('enc-linhas-wrap').innerHTML = '';
    encAddLinha();
    modalOpen('enc-modal');
    focusModal('enc-modal');
}

function closeEncModal() {
    modalClose('enc-modal');
}

function encAddLinha(ref = '', nome = '', qtd = '') {
    const wrap = $id('enc-linhas-wrap');
    const div = $el('div', { className: 'enc-linha' });
    div.innerHTML = `
        <input class="blue-input enc-linha-ref"  type="text"   placeholder="Ref."       value="${escapeHtml(String(ref))}"  autocomplete="off" spellcheck="false">
        <input class="blue-input enc-linha-nome" type="text"   placeholder="Designação" value="${escapeHtml(String(nome))}" autocomplete="off" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input enc-linha-qtd"  type="number" placeholder="Qtd."       value="${qtd}" min="0" step="0.01">
        <button class="enc-linha-del" onclick="this.closest('.enc-linha').remove()">✕</button>`;
    wrap.appendChild(div);
}

async function saveEncomenda() {
    const num  = $id('enc-num').value.trim();
    const data = $id('enc-data').value;
    const forn = $id('enc-fornecedor').value.trim();
    const obs  = $id('enc-obs').value.trim();

    if (!num)  { showToast('Indica o número da encomenda', 'error'); return; }
    if (!forn) { showToast('Indica o fornecedor', 'error'); return; }

    const linhasEls = document.querySelectorAll('#enc-linhas-wrap .enc-linha');
    const linhas = {};
    let i = 0;
    for (const el of linhasEls) {
        const ref  = el.querySelector('.enc-linha-ref').value.trim().toUpperCase();
        const nome = el.querySelector('.enc-linha-nome').value.trim();
        const qtd  = parseFloat(el.querySelector('.enc-linha-qtd').value) || 0;
        if (!nome && !ref) continue;
        linhas[i] = { ref, nome, qtd, recebido: 0 };
        i++;
    }
    if (i === 0) { showToast('Adiciona pelo menos um produto', 'error'); return; }

    const payload = { num, fornecedor: forn, data, obs, estado: 'pendente', ts: Date.now(), linhas };

    try {
        const res = await apiFetch(`${ENC_URL}.json`, { method: 'POST', body: JSON.stringify(payload) });
        if (res) { const r = await res.json(); if (r?.name) _encData[r.name] = payload; }
        showToast('Encomenda criada ✓', 'ok');
        closeEncModal();
        renderEncList();
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro ao guardar: ' + e.message, 'error');
    }
}

// ── Detalhe ───────────────────────────────────────────────────────────────
function openEncDetail(id) {
    const enc = _encData[id];
    if (!enc) return;
    _encEditId = id;

    const dataFmt = enc.data ? enc.data.split('-').reverse().join('/') : '—';
    $id('enc-detail-title').textContent = `Encomenda Nº ${enc.num || '—'}`;
    $id('enc-detail-sub').textContent   =
        `${enc.fornecedor || '—'} · ${dataFmt}${enc.obs ? ' · ' + enc.obs : ''}`;

    const linhas = enc.linhas || {};
    $id('enc-detail-linhas').innerHTML = Object.entries(linhas).map(([idx, l]) => {
        const qtd      = parseFloat(l.qtd) || 0;
        const recebido = Math.min(parseFloat(l.recebido) || 0, qtd);
        const pct      = qtd > 0 ? Math.round(recebido / qtd * 100) : 0;
        const cor      = pct >= 100 ? '#16a34a' : pct > 0 ? '#f59e0b' : 'var(--primary)';
        const done     = recebido >= qtd && qtd > 0;
        return `<div class="enc-detail-linha">
            <div class="enc-detail-linha-top">
                <div style="flex:1;min-width:0">
                    ${l.ref ? `<span class="enc-detail-ref">${escapeHtml(l.ref)}</span> ` : ''}
                    <span class="enc-detail-nome">${escapeHtml(l.nome || '—')}</span>
                </div>
                <div class="enc-detail-qty">${recebido}/${qtd}</div>
            </div>
            <div class="enc-detail-prog-wrap">
                <div class="enc-detail-prog-bar">
                    <div class="enc-detail-prog-fill" style="width:${pct}%;background:${cor}"></div>
                </div>
                <div class="enc-detail-prog-label">${pct}% recebido</div>
            </div>
            <button class="enc-entrada-btn ${done ? 'enc-entrada-btn-done' : ''}"
                ${done ? 'disabled' : `onclick="openEntradaModal('${id}',${idx})"`}>
                ${done ? '✓ Totalmente recebido' : '↓ Dar entrada'}
            </button>
        </div>`;
    }).join('');

    modalOpen('enc-detail-modal');
    focusModal('enc-detail-modal');
}

async function deleteEncomenda() {
    if (!_encEditId) return;
    const enc = _encData[_encEditId];
    openConfirmModal({
        title: 'Apagar encomenda?',
        desc: `Encomenda Nº ${enc?.num} será apagada permanentemente.`,
        type: 'danger',
        onConfirm: async () => {
            try {
                await apiFetch(`${ENC_URL}/${_encEditId}.json`, { method: 'DELETE' });
                // Remover do cache local imediatamente
                delete _encData[_encEditId];
                showToast('Encomenda apagada', 'ok');
                modalClose('enc-detail-modal');
                renderEncList();
                loadEncomendas(true);
            } catch(e) {
                showToast('Erro: ' + e.message, 'error');
            }
        }
    });
}

// ── Dar entrada ───────────────────────────────────────────────────────────
function openEntradaModal(encId, lIdx) {
    _encEntradaId   = encId;
    _encEntradaLIdx = lIdx;
    const l = _encData[encId]?.linhas?.[lIdx];
    if (!l) return;
    const falta = (parseFloat(l.qtd) || 0) - (parseFloat(l.recebido) || 0);
    $id('enc-entrada-desc').textContent =
        `${l.ref ? '[' + l.ref + '] ' : ''}${l.nome} — faltam ${falta} unidades`;
    const inp = $id('enc-entrada-qty');
    inp.value = falta;
    inp.max   = falta;
    $id('enc-entrada-info').textContent =
        `Já recebido: ${parseFloat(l.recebido) || 0} · Encomendado: ${parseFloat(l.qtd) || 0}`;
    modalOpen('enc-entrada-modal');
    focusModal('enc-entrada-modal');
    setTimeout(() => inp.focus(), 100);
}

async function confirmarEntrada() {
    const qty = parseFloat($id('enc-entrada-qty').value);
    if (isNaN(qty) || qty <= 0) { showToast('Quantidade inválida', 'error'); return; }

    const enc = _encData[_encEntradaId];
    const l   = enc?.linhas?.[_encEntradaLIdx];
    if (!l) return;

    // Lê o valor ACTUAL do servidor antes de somar — protege contra dois utilizadores
    // a dar entrada na mesma linha ao mesmo tempo (o segundo sobrescreveria o primeiro).
    let recebidoActual = parseFloat(l.recebido) || 0;
    if (navigator.onLine) {
        try {
            const remoteUrl = await authUrl(`${ENC_URL}/${_encEntradaId}/linhas/${_encEntradaLIdx}/recebido.json`);
            const remoteRes = await fetch(remoteUrl);
            if (remoteRes.ok) {
                const remoteVal = await remoteRes.json();
                if (typeof remoteVal === 'number' && !isNaN(remoteVal)) {
                    recebidoActual = remoteVal;
                    // Actualiza cache local com valor real
                    if (_encData[_encEntradaId]?.linhas?.[_encEntradaLIdx]) {
                        _encData[_encEntradaId].linhas[_encEntradaLIdx].recebido = recebidoActual;
                    }
                }
            }
        } catch(e) {
            console.warn('[confirmarEntrada] falha ao ler valor actual:', e?.message);
        }
    }

    const novoRecebido = Math.min(recebidoActual + qty, parseFloat(l.qtd) || 0);
    const novasLinhas  = { ...(enc.linhas || {}) };
    novasLinhas[_encEntradaLIdx] = { ...l, recebido: novoRecebido };
    const novoEstado   = _calcEstado(novasLinhas);

    try {
        await apiFetch(`${ENC_URL}/${_encEntradaId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({
                [`linhas/${_encEntradaLIdx}/recebido`]: novoRecebido,
                estado: novoEstado
            })
        });
        // Actualizar cache local imediatamente
        if (_encData[_encEntradaId]?.linhas?.[_encEntradaLIdx]) {
            _encData[_encEntradaId].linhas[_encEntradaLIdx].recebido = novoRecebido;
            _encData[_encEntradaId].estado = novoEstado;
        }
        showToast(`Entrada de ${qty} confirmada ✓`, 'ok');
        modalClose('enc-entrada-modal');
        renderEncList();
        openEncDetail(_encEntradaId);
        // Sincroniza com Firebase em background
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

function _calcEstado(linhas) {
    const arr = Object.values(linhas);
    if (arr.every(l => (parseFloat(l.recebido) || 0) >= (parseFloat(l.qtd) || 0))) return 'recebida';
    if (arr.some(l => (parseFloat(l.recebido) || 0) > 0)) return 'parcial';
    return 'pendente';
}
