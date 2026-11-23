// ─────────────────────────────────────────────────────────────────────────────
// app.js — Gestão Armazém v6.83
// Núcleo da aplicação: cache em memória, fila offline/sync, navegação (nav),
// administração, temas, calculadora de peso, Web Share Target, arranque
// (DOMContentLoaded) e registo do Service Worker.
//
// DEPENDÊNCIAS (carregadas antes via index.html):
//   utils.js, auth.js, reports.js, stock.js, stockimport.js, backup.js,
//   tools.js, settings.js, clientes.js, pat-map.js, pats.js, guias.js,
//   encomendas.js, inventory.js, dashboard.js
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

// Junta dois PATCH ao mesmo endereço (antes o 2.º SUBSTITUÍA o 1.º e perdia campos).
//  • campos diferentes            → ficam todos
//  • mesmo campo                  → vale o mais recente
//  • dois incrementos do servidor → somam-se (ex.: stock −2 e depois +1 = −1)
function _mergePatchBodies(oldBody, newBody) {
    let o, n;
    try { o = JSON.parse(oldBody || '{}'); n = JSON.parse(newBody || '{}'); } catch (_) { return newBody; }
    const inc = v => (v && typeof v === 'object' && v['.sv'] && Number.isFinite(v['.sv'].increment)) ? v['.sv'].increment : null;
    const r3  = x => Math.round(x * 1000) / 1000;
    for (const k of Object.keys(n)) {
        const ni = inc(n[k]), oi = inc(o[k]);
        if (ni !== null && oi !== null)                    o[k] = { '.sv': { increment: r3(oi + ni) } };
        else if (ni !== null && typeof o[k] === 'number')  o[k] = r3(o[k] + ni);      // valor absoluto + variação
        else                                               o[k] = n[k];
    }
    return JSON.stringify(o);
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

    // Juntar PATCHes repetidos ao mesmo URL (sem perder campos nem variações)
    if (op.method === 'PATCH') {
        const idx = _queueMem.findIndex(o => o.method === 'PATCH' && o.url === op.url);
        if (idx !== -1) { _queueMem[idx] = { ...op, body: _mergePatchBodies(_queueMem[idx].body, op.body) }; }
        else { _queueMem.push(op); }
    } else {
        // FIX: ignorar operações em IDs temporários (_tmp_) para não enviar URLs inválidos
        if (op.url && op.url.includes('/_tmp_')) return;
        _queueMem.push(op);
    }
    _queueScheduleSave();
    updateOfflineBanner();
}

// Variações de stock feitas offline podem, ao somar, deixar o artigo abaixo de 0
// (ex.: outra pessoa já tinha levantado o material). Repõe a 0, de forma atómica.
async function _syncFixNegativeStock(op, res) {
    if (op.method !== 'PATCH' || !op.body || !op.body.includes('"increment"')) return;
    if (!/\/stock\/[^/]+\.json$/.test(op.url)) return;
    try {
        let q = null;
        try { const j = await res.clone().json(); if (j && typeof j.quantidade === 'number') q = j.quantidade; } catch (_) {}
        if (q === null) {
            const r2 = await fetch(await authUrl(op.url.replace(/\.json$/, '/quantidade.json')));
            if (r2.ok) { const v = await r2.json(); if (typeof v === 'number') q = v; }
        }
        if (q !== null && q < 0) {
            await fetch(await authUrl(op.url), {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantidade: { '.sv': { increment: Math.round(-q * 1000) / 1000 } } }),
            });
        }
    } catch (e) { console.warn('[Queue] correcção de stock negativo falhou:', e?.message); }
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
                await _syncFixNegativeStock(op, res);
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
    if (viewId === 'view-encomendas') { _encSetFilter(_encNextFilter || 'pendente'); _encNextFilter = null; loadEncomendas(); }
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
        'view-encomendas':'bnav-encomendas',
        'view-tools':'bnav-tools'
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


// ADMIN — slider com swipe entre tabs
const ADMIN_TABS  = ['workers', 'tools', 'clientes', 'stockimport', 'users', 'settings', 'relatorio'];
let   _adminIdx   = 0;   // índice activo

// ── Admin mobile — menu estilo Android ────────────────────────────────────────
const _adminMobileTitles = {
    workers:   'Funcionários',
    tools:     'Ferramentas',
    clientes:  'Clientes',
    stockimport: 'Importar Stock',
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
        { tab:'stockimport', bg:'#e0f2fe', color:'#0284c7', label:'Importar Stock', sub:'Atualizar quantidades a partir de Excel',
          svg:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/>', vb:'0 0 24 24', fill:false },
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
        { label:'Gestão',  tabs: items.slice(0,4) },
        { label:'Sistema',  tabs: items.slice(4,6) },
        { label:'Análise',  tabs: items.slice(6) },
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
    if (tab === 'stockimport') renderStockImport();
    if (tab === 'users')     renderUsersList();
    if (tab === 'settings')  { _updateOcrKeyStatus(); _updateGimgStatus(); _loadOcrKeywordsInput(); _loadInvEmailInput(); bkUpdateStatus(); }
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
    if (tab === 'stockimport') renderStockImport();
    if (tab === 'users')    renderUsersList();
    if (tab === 'settings') { _updateOcrKeyStatus(); _updateGimgStatus(); _loadOcrKeywordsInput(); _loadInvEmailInput(); bkUpdateStatus(); }
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
            slider.style.transform = `translateX(-${(idx * 100 / ADMIN_TABS.length).toFixed(4)}%)`;
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
        const base = -(_adminIdx * 100 / ADMIN_TABS.length);
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
            if (val) { _zeroFilterActive = false; _desktopFilter = 'all'; const b = $id('zero-filter-badge'); if (b) b.remove(); }
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
const SW_EXPECTED_VERSION = 'hiperfrio-v6.83';
const SW_SCRIPT_URL = 'sw.js?v=6.83';

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
