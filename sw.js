const DB_URL   = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// =============================================
// XSS — escapar sempre dados do utilizador
// =============================================
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================
// FIREBASE AUTH — token anónimo para REST API
// =============================================
let _authToken     = null;
let _authTokenExp  = 0;     // timestamp de expiração (tokens duram 1h)
let _authReady     = false; // true depois do primeiro login

// Obtém token válido — aguarda Promise do SDK Firebase ou renova se expirado
async function getAuthToken() {
    const now = Date.now();
    // Token em cache ainda válido (margem de 5 min)
    if (_authToken && now < _authTokenExp - 300_000) return _authToken;

    // Aguarda a Promise criada pelo SDK (com timeout de 10s)
    const tokenPromise = window._firebaseTokenPromise
        ? window._firebaseTokenPromise
        : Promise.reject(new Error('Firebase SDK não carregou'));

    _authToken = await Promise.race([
        tokenPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Auth timeout — verifica Anonymous Auth na consola Firebase')), 10_000))
    ]);

    // Se o user está disponível, renova o token (force=true garante token fresco)
    if (window._firebaseUser) {
        try {
            const forceRefreshToken = (_authToken !== null); // força renovação se já tivemos token antes
            _authToken = await window._firebaseUser.getIdToken(forceRefreshToken);
        } catch { /* usa o token da Promise */ }
    }

    _authTokenExp = now + 3_500_000; // ~58 min
    _authReady    = true;
    console.log('✅ Firebase Auth: token obtido com sucesso');
    return _authToken;
}

// Adiciona ?auth=TOKEN a um URL da Firebase REST API
async function authUrl(url) {
    try {
        const token = await getAuthToken();
        const sep   = url.includes('?') ? '&' : '?';
        return `${url}${sep}auth=${token}`;
    } catch (e) {
        console.warn('Auth token indisponível:', e.message);
        return url; // offline — a fila offline trata do reenvio quando voltar online
    }
}

// =============================================
// PERFIL — Funcionário vs Gestor
// =============================================
const ROLE_KEY    = 'hiperfrio-role';   // 'worker' | 'manager'
let   currentRole = null;               // definido no arranque

// Aplica o perfil à UI — chamado uma vez no boot
function applyRole(role) {
    currentRole = role;
    document.body.classList.toggle('worker-mode', role === 'worker');

    // Badge no header — clicável para trocar de perfil
    let badge = document.getElementById('role-badge');
    if (!badge) {
        badge = document.createElement('button');
        badge.id      = 'role-badge';
        badge.onclick = () => openSwitchRoleModal();
        document.querySelector('header')?.appendChild(badge);
    }
    if (role === 'worker') {
        badge.textContent = '👤 Funcionário ▾';
        badge.className   = 'role-badge-worker';
    } else {
        badge.textContent = '🔑 Gestor ▾';
        badge.className   = 'role-badge-manager';
    }

    // Esconde o ecrã de seleção
    document.getElementById('role-screen')?.classList.add('hidden');
}

// Botão "Funcionário" no ecrã de seleção
function enterAsWorker() {
    localStorage.setItem(ROLE_KEY, 'worker');
    applyRole('worker');
    bootApp();
}

// Botão "Gestor" no ecrã de seleção
async function enterAsManager() {
    const btn = document.querySelector('.role-btn-manager');
    if (btn) { btn.disabled = true; btn.querySelector('.role-btn-label').textContent = 'A verificar...'; }
    try {
        const hasPin = await hasPinConfigured();
        if (!hasPin) {
            openPinSetupModal('first-time');
        } else {
            openPinModal('role');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.querySelector('.role-btn-label').textContent = 'Gestor'; }
    }
}

// Trocar de perfil (botão nas Definições)
function switchRole() {
    closeSwitchRoleModal();
    localStorage.removeItem(ROLE_KEY);
    window.location.reload();
}

function openSwitchRoleModal() {
    document.getElementById('switch-role-modal')?.classList.add('active');
    focusModal('switch-role-modal');
}
function closeSwitchRoleModal() {
    document.getElementById('switch-role-modal')?.classList.remove('active');
}

// Inicializa a app após o perfil estar definido
async function bootApp() {
    try { await getAuthToken(); } catch { /* offline — continua com cache */ }
    renderDashboard();
    renderList();
    fetchCollection('ferramentas');
    fetchCollection('funcionarios');
    updatePinStatusUI();
    updateOfflineBanner();
}

// =============================================
// PIN — hash SHA-256
// =============================================
async function hashPin(pin) {
    const data    = new TextEncoder().encode(pin + 'hiperfrio-salt');
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// PIN guardado na Firebase — partilhado entre dispositivos
const PIN_URL = `${BASE_URL}/config/pinHash.json`;
let   _cachedPinHash = undefined; // undefined = ainda não carregado; null = carregado, sem PIN

async function getPinHash() {
    if (_cachedPinHash !== undefined) return _cachedPinHash; // cache hit (mesmo que null = sem PIN)
    // Tenta Firebase primeiro; fallback para localStorage (offline)
    try {
        const res  = await fetch(await authUrl(PIN_URL));
        const data = await res.json();
        _cachedPinHash = data || null;
        if (_cachedPinHash) localStorage.setItem('hiperfrio-pin-hash-cache', _cachedPinHash);
        else                 localStorage.removeItem('hiperfrio-pin-hash-cache');
    } catch {
        // Offline — usa cache local
        _cachedPinHash = localStorage.getItem('hiperfrio-pin-hash-cache') || null;
    }
    return _cachedPinHash;
}

async function setPinHash(hash) {
    _cachedPinHash = hash;
    // Guarda sempre localmente como fallback offline
    if (hash) localStorage.setItem('hiperfrio-pin-hash-cache', hash);
    else       localStorage.removeItem('hiperfrio-pin-hash-cache');
    // Envia para Firebase
    await fetch(await authUrl(PIN_URL), {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(hash)
    });
}

async function deletePinHash() {
    _cachedPinHash = null;
    localStorage.removeItem('hiperfrio-pin-hash-cache');
    await fetch(await authUrl(PIN_URL), { method: 'DELETE' });
}

async function hasPinConfigured() {
    const hash = await getPinHash();
    return !!hash;
}

// =============================================
// CACHE EM MEMÓRIA — TTL 60s
// =============================================
const CACHE_TTL = 60_000;
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

// =============================================
// FILA OFFLINE — localStorage persistente
// =============================================
const QUEUE_KEY = 'hiperfrio-offline-queue';
let isSyncing   = false; // FIX: evita execuções paralelas de syncQueue

function queueLoad() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
}
function queueSave(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

function queueAdd(op) {
    // FIX: só aceita mutações na fila, nunca GETs
    if (!op.method || op.method === 'GET') return;
    const q = queueLoad();
    // Colapsar PATCHes repetidos ao mesmo URL
    if (op.method === 'PATCH') {
        const idx = q.findIndex(o => o.method === 'PATCH' && o.url === op.url);
        if (idx !== -1) { q[idx] = op; } else { q.push(op); }
    } else {
        // FIX: ignorar operações em IDs temporários (_tmp_) para não enviar URLs inválidos
        if (op.url && op.url.includes('/_tmp_')) return;
        q.push(op);
    }
    queueSave(q);
    updateOfflineBanner();
}

async function syncQueue() {
    if (isSyncing) return; // FIX: protecção contra execuções paralelas
    const q = queueLoad();
    if (q.length === 0) return;
    isSyncing = true;
    const failed = [];
    for (const op of q) {
        try {
            const opts = { method: op.method, headers: { 'Content-Type': 'application/json' } };
            if (op.body) opts.body = op.body;
            const signedUrl = await authUrl(op.url);
            const res = await fetch(signedUrl, opts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch { failed.push(op); }
    }
    queueSave(failed);
    isSyncing = false;
    updateOfflineBanner();
    if (failed.length < q.length) {
        const synced = q.length - failed.length;
        showToast(`${synced} alteração(ões) sincronizada(s)!`);
        // Invalida cache e refresca para limpar _tmp_ IDs
        invalidateCache('stock');
        invalidateCache('ferramentas');
        invalidateCache('funcionarios');
        renderList(document.getElementById('inp-search')?.value || '', true);
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
    const countEl = document.getElementById('offline-pending-count');
    if (countEl) {
        countEl.textContent   = q.length > 0 ? `${q.length} alteração(ões) pendente(s)` : '';
        countEl.style.display = q.length > 0 ? 'inline' : 'none';
    }
}

// =============================================
// UI HELPERS
// =============================================
function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t    = document.createElement('div');
    t.className = 'toast';
    if (type === 'error') t.style.borderLeftColor = 'var(--danger)';
    const icon = document.createElement('span');
    icon.textContent = type === 'success' ? '✅' : '❌';
    const text = document.createElement('span');
    text.textContent = msg;
    t.appendChild(icon);
    t.appendChild(text);
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function setRefreshSpinning(s) { document.getElementById('btn-refresh')?.classList.toggle('spinning', s); }

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay')?.classList.toggle('active');
}

// =============================================
// NAVEGAÇÃO
// FIX: active state só actualizado após acesso confirmado
// =============================================
function nav(viewId) {
    if (viewId === 'view-admin' && !checkAdminAccess()) return;

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');

    if (viewId === 'view-search') renderList();
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-admin')  { renderWorkers(); renderAdminTools(); }

    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const sideMap = {
        'view-search':'nav-search','view-tools':'nav-tools','view-register':'nav-register',
        'view-bulk':'nav-bulk','view-admin':'nav-admin'
    };
    document.getElementById(sideMap[viewId])?.classList.add('active');

    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bnavMap = {
        'view-search':'bnav-search','view-tools':'bnav-tools','view-register':'bnav-register',
        'view-bulk':'bnav-bulk','view-admin':'bnav-admin'
    };
    document.getElementById(bnavMap[viewId])?.classList.add('active');

    if (document.getElementById('side-menu')?.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
}


// =============================================
// DASHBOARD — resumo no topo do stock
// =============================================
async function renderDashboard() {
    const el = document.getElementById('dashboard');
    if (!el) return;

    // Mostra skeleton enquanto carrega
    el.innerHTML = '';
    el.className = 'dashboard';

    const [stockData, ferrData] = await Promise.all([
        fetchCollection('stock'),
        fetchCollection('ferramentas')
    ]);

    const stockEntries  = Object.values(stockData || {});
    const ferraEntries  = Object.values(ferrData  || {});
    const total         = stockEntries.length;
    const semStock      = stockEntries.filter(i => (i.quantidade || 0) === 0).length;
    const alocadas      = ferraEntries.filter(t => t.status === 'alocada').length;
    const totalFerr     = ferraEntries.length;

    const cards = [
        {
            label: 'Produtos', value: total, icon: '📦', cls: '',
            action: () => { nav('view-search'); }
        },
        {
            label: 'Sem stock', value: semStock, icon: '⚠️',
            cls: semStock > 0 ? 'dash-card-warn' : '',
            action: semStock > 0 ? () => {
                nav('view-search');
                const inp = document.getElementById('inp-search');
                // Filtra mostrando apenas os que têm stock 0 via função interna
                setTimeout(() => filterZeroStock(), 100);
            } : null
        },
        {
            label: 'Ferramentas', value: `${alocadas}/${totalFerr}`, icon: '🪛',
            cls: alocadas === totalFerr && totalFerr > 0 ? 'dash-card-warn' : '',
            action: () => nav('view-tools')
        },
    ];

    cards.forEach(c => {
        const card  = document.createElement('div');
        card.className = `dash-card ${c.cls}`;
        if (c.action) {
            card.style.cursor = 'pointer';
            card.onclick = c.action;
        }
        const icon  = document.createElement('span');
        icon.className   = 'dash-icon';
        icon.textContent = c.icon;
        const val   = document.createElement('span');
        val.className   = 'dash-value';
        val.textContent = c.value;
        const lbl   = document.createElement('span');
        lbl.className   = 'dash-label';
        lbl.textContent = c.label;
        card.appendChild(icon);
        card.appendChild(val);
        card.appendChild(lbl);
        el.appendChild(card);
    });
}


// =============================================
// ORDENAÇÃO DO STOCK
// =============================================
let _stockSort = 'recente'; // 'recente' | 'nome' | 'qtd-asc' | 'qtd-desc' | 'local'

// Menu de ordenação — criado no body para evitar clipping por stacking contexts
function _getSortMenu() {
    let menu = document.getElementById('sort-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id        = 'sort-menu';
        menu.className = 'sort-menu';
        const options  = [
            { val: 'recente',  label: 'Mais recente' },
            { val: 'nome',     label: 'Nome A→Z'     },
            { val: 'qtd-asc',  label: 'Quantidade ↑' },
            { val: 'qtd-desc', label: 'Quantidade ↓' },
            { val: 'local',    label: 'Localização'  },
        ];
        options.forEach(o => {
            const btn = document.createElement('button');
            btn.className   = 'sort-option' + (o.val === _stockSort ? ' active' : '');
            btn.id          = `sort-${o.val}`;
            btn.textContent = o.label;
            btn.onclick     = () => setStockSort(o.val);
            menu.appendChild(btn);
        });
        document.body.appendChild(menu);
    }
    return menu;
}

function toggleSortMenu() {
    const btn  = document.getElementById('sort-dropdown-btn');
    const menu = _getSortMenu();
    const isOpen = menu.classList.contains('open');

    if (isOpen) {
        _closeSortMenu();
        return;
    }

    // Posiciona o menu sob o botão usando coordenadas absolutas
    const rect = btn.getBoundingClientRect();
    menu.style.top   = `${rect.bottom + window.scrollY + 6}px`;
    menu.style.right = `${window.innerWidth - rect.right - window.scrollX}px`;
    menu.style.left  = 'auto';
    menu.classList.add('open');
    btn.classList.add('active');

    // Fecha ao clicar fora (próximo tick para não capturar o click actual)
    setTimeout(() => {
        document.addEventListener('click', _onOutsideSortClick);
    }, 0);
}

function _onOutsideSortClick(e) {
    const wrap = document.getElementById('sort-dropdown-wrap');
    const menu = document.getElementById('sort-menu');
    if (!wrap?.contains(e.target) && !menu?.contains(e.target)) {
        _closeSortMenu();
    }
}

function _closeSortMenu() {
    document.getElementById('sort-menu')?.classList.remove('open');
    document.getElementById('sort-dropdown-btn')?.classList.remove('active');
    document.removeEventListener('click', _onOutsideSortClick);
}

function setStockSort(val) {
    _stockSort = val;
    // Actualiza estado visual das opções
    document.querySelectorAll('.sort-option').forEach(btn => {
        btn.classList.toggle('active', btn.id === `sort-${val}`);
    });
    // Fecha o menu
    _closeSortMenu();
    renderList(document.getElementById('inp-search')?.value || '', true);
}

function getSortedEntries(entries) {
    const copy = [...entries];
    switch (_stockSort) {
        case 'nome':     return copy.sort((a,b) => (a[1].nome||'').localeCompare(b[1].nome||'', 'pt'));
        case 'qtd-asc':  return copy.sort((a,b) => (a[1].quantidade||0) - (b[1].quantidade||0));
        case 'qtd-desc': return copy.sort((a,b) => (b[1].quantidade||0) - (a[1].quantidade||0));
        case 'local':    return copy.sort((a,b) => (a[1].localizacao||'').localeCompare(b[1].localizacao||'', 'pt'));
        default:         return copy.reverse(); // mais recente primeiro
    }
}

// =============================================
// STOCK — RENDER
// FIX: usa [...entries].reverse() para não mutar o cache
// FIX: qty-display.is-zero para stock a 0
// FIX: filtragem por show/hide nos cards existentes sem recriar DOM
// =============================================

// Filtra stock para mostrar apenas produtos com quantidade 0
function filterZeroStock() {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;
    const wrappers = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    wrappers.forEach(wrapper => {
        const id   = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        const isZero = item && (item.quantidade || 0) === 0;
        wrapper.style.display = isZero ? '' : 'none';
    });
    // Mostra indicador de filtro ativo
    let badge = document.getElementById('zero-filter-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id        = 'zero-filter-badge';
        badge.className = 'zero-filter-badge';
        badge.innerHTML = '⚠️ A mostrar apenas produtos sem stock &nbsp;<button onclick="clearZeroFilter()">✕ Limpar</button>';
        listEl.parentNode.insertBefore(badge, listEl);
    }
}

function clearSearch() {
    const inp = document.getElementById('inp-search');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); }
}

function clearZeroFilter() {
    const badge = document.getElementById('zero-filter-badge');
    if (badge) badge.remove();
    renderList('', false);
}

async function renderList(filter = '', force = false) {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    if (!cache.stock.data) listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';

    const data    = await fetchCollection('stock', force);
    const entries = Object.entries(data);

    // Se DOM já tem cards (re-render por filtro), apenas faz show/hide
    const existingCards = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    if (existingCards.length > 0 && !force) {
        const filterLower = filter.toLowerCase();
        let visible = 0;
        existingCards.forEach(wrapper => {
            const id   = wrapper.dataset.id;
            const item = data[id];
            if (!item) { wrapper.style.display = 'none'; return; }
            const matches = !filter
                || item.nome.toLowerCase().includes(filterLower)
                || String(item.codigo).toUpperCase().includes(filter.toUpperCase())
                || (item.localizacao || '').toLowerCase().includes(filterLower);
            wrapper.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });
        let noResult = listEl.querySelector('.empty-msg');
        if (filter && visible === 0) {
            if (!noResult) {
                noResult = document.createElement('div');
                noResult.className = 'empty-msg';
                listEl.appendChild(noResult);
            }
            noResult.textContent = 'Nenhum resultado encontrado.';
        } else if (noResult) {
            noResult.remove();
        }
        return;
    }

    // Full render
    listEl.innerHTML = '';

    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
        return;
    }

    // Hint contextual — swipe para gestores, leitura para funcionários
    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!filter && !localStorage.getItem(hintKey)) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        if (currentRole === 'worker') {
            const msg = document.createElement('span');
            msg.textContent = '👁️ Modo consulta — apenas visualização';
            hint.appendChild(msg);
        } else {
            const l = document.createElement('span'); l.textContent = '✏️ Swipe direita para editar';
            const r = document.createElement('span'); r.textContent = '🗑️ Swipe esquerda para apagar';
            hint.appendChild(l); hint.appendChild(r);
        }
        listEl.appendChild(hint);
        localStorage.setItem(hintKey, '1');
    }

    const filterLower = filter.toLowerCase();
    let found = 0;

    // Ordenação configurável
    getSortedEntries(entries).forEach(([id, item]) => {
        const matches = !filter
            || item.nome.toLowerCase().includes(filterLower)
            || String(item.codigo).toUpperCase().includes(filter.toUpperCase())
            || (item.localizacao || '').toLowerCase().includes(filterLower);

        const wrapper = document.createElement('div');
        wrapper.className    = 'swipe-wrapper';
        wrapper.dataset.id   = id;
        wrapper.style.display = matches ? '' : 'none';
        if (matches) found++;

        // Swipe backgrounds
        const bgL = document.createElement('div'); bgL.className = 'swipe-bg swipe-bg-left';
        const iL  = document.createElement('span'); iL.className = 'swipe-bg-icon'; iL.textContent = '🗑️';
        bgL.appendChild(iL);
        const bgR = document.createElement('div'); bgR.className = 'swipe-bg swipe-bg-right';
        const iR  = document.createElement('span'); iR.className = 'swipe-bg-icon'; iR.textContent = '✏️';
        bgR.appendChild(iR);
        wrapper.appendChild(bgL); wrapper.appendChild(bgR);

        // Card content — tudo via textContent (sem XSS)
        const el = document.createElement('div');
        el.className = 'item-card';

        const refLabel = document.createElement('div');
        refLabel.className   = 'ref-label';
        refLabel.textContent = 'REFERÊNCIA';

        const refVal = document.createElement('div');
        refVal.className   = 'ref-value';
        refVal.textContent = String(item.codigo || '').toUpperCase();

        const nomEl = document.createElement('div');
        nomEl.className   = 'card-nome';
        nomEl.textContent = item.nome || '';

        const hr = document.createElement('hr');
        hr.className = 'card-divider';

        const row = document.createElement('div');
        row.className = 'card-bottom-row';

        const pill = document.createElement('div');
        pill.className = 'loc-pill';
        const pinIcon = document.createElement('span');
        pinIcon.style.fontSize = '0.85rem';
        pinIcon.textContent    = '📍';
        pill.appendChild(pinIcon);
        pill.appendChild(document.createTextNode(' ' + (item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL')));

        const qtyBox = document.createElement('div');
        qtyBox.className = 'qty-pill-box';

        const qty = item.quantidade || 0;

        const btnM = document.createElement('button');
        btnM.className   = 'btn-qty';
        btnM.textContent = '−';
        btnM.disabled    = qty === 0;
        btnM.id          = `btn-minus-${id}`;
        btnM.onclick     = () => changeQtd(id, -1);

        const qtySpan = document.createElement('span');
        qtySpan.className   = 'qty-display' + (qty === 0 ? ' is-zero' : '');
        qtySpan.id          = `qty-${id}`;
        qtySpan.textContent = fmtQty(qty, item.unidade);

        const btnP = document.createElement('button');
        btnP.className   = 'btn-qty';
        btnP.textContent = '+';
        btnP.onclick     = () => changeQtd(id, 1);

        qtyBox.appendChild(btnM); qtyBox.appendChild(qtySpan); qtyBox.appendChild(btnP);
        row.appendChild(pill); row.appendChild(qtyBox);
        el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
        el.appendChild(hr); el.appendChild(row);

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        listEl.appendChild(wrapper);
    });

    if (filter && found === 0) {
        const em = document.createElement('div');
        em.className   = 'empty-msg';
        em.textContent = 'Nenhum resultado encontrado.';
        listEl.appendChild(em);
    }
}

async function forceRefresh() {
    setRefreshSpinning(true);
    await Promise.all([
        renderList(document.getElementById('inp-search')?.value || '', true),
        renderDashboard()
    ]);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

// Debounce de escrita para changeQtd — agrupa toques rápidos numa só chamada à Firebase
const _qtyTimers = {};

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(30);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return;

    // Actualiza cache + DOM imediatamente (optimistic)
    stockData[id].quantidade = newQty;
    const qtyEl   = document.getElementById(`qty-${id}`);
    const minusEl = document.getElementById(`btn-minus-${id}`);
    const itemUnidade = stockData[id]?.unidade;
    if (qtyEl) {
        qtyEl.textContent = fmtQty(newQty, itemUnidade);
        qtyEl.classList.toggle('is-zero', newQty === 0);
    }
    if (minusEl) minusEl.disabled = newQty === 0;

    // Debounce: agrupa múltiplos toques rápidos — só envia após 600ms de pausa
    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: finalQty })
            });
        } catch {
            // Reverte para o valor antes desta sequência de toques
            stockData[id].quantidade = oldQty;
            if (qtyEl)   { qtyEl.textContent = fmtQty(oldQty, stockData[id]?.unidade); qtyEl.classList.toggle('is-zero', oldQty === 0); }
            if (minusEl)   minusEl.disabled = oldQty === 0;
            showToast('Erro ao guardar quantidade', 'error');
        }
        delete _qtyTimers[id];
    }, 600);
}

// =============================================
// FERRAMENTAS
// =============================================
function formatDate(iso) {
    if (!iso) return 'Data desconhecida';
    const d = new Date(iso), pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderTools() {
    const list = document.getElementById('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');
    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>'; return;
    }
    // FIX: cópia antes de reverter
    ;[...Object.entries(data)].reverse().forEach(([id, t]) => {
        const isAv = t.status === 'disponivel';
        const div  = document.createElement('div');
        div.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}`;
        div.onclick = () => isAv ? openModal(id) : openConfirmModal({
            icon:'↩', title:'Confirmar devolução?',
            desc:`"${escapeHtml(t.nome)}" será marcada como disponível.`,
            onConfirm: () => returnTool(id)
        });
        // Histórico: right-click no desktop, long-press no mobile
        div.addEventListener('contextmenu', e => { e.preventDefault(); openHistoryModal(id, t.nome); });
        // Long-press para mobile
        let _longPressTimer = null;
        div.addEventListener('touchstart', () => {
            _longPressTimer = setTimeout(() => openHistoryModal(id, t.nome), 600);
        }, { passive: true });
        div.addEventListener('touchend',   () => clearTimeout(_longPressTimer), { passive: true });
        div.addEventListener('touchmove',  () => clearTimeout(_longPressTimer), { passive: true });
        const info = document.createElement('div');
        const nome = document.createElement('div');
        nome.className   = 'tool-nome';
        nome.textContent = t.nome;
        const sub = document.createElement('div');
        sub.className    = 'tool-sub';
        if (isAv) {
            sub.textContent = '📦 EM ARMAZÉM';
        } else {
            const w = document.createElement('span');
            w.textContent = `👤 ${(t.colaborador||'').toUpperCase()}`;
            const dl = document.createElement('div');
            dl.className   = 'tool-date';
            dl.textContent = `📅 ${formatDate(t.dataEntrega)}`;
            sub.appendChild(w); sub.appendChild(dl);
        }
        info.appendChild(nome); info.appendChild(sub);
        const arrow = document.createElement('span');
        arrow.className  = 'tool-arrow';
        arrow.textContent = isAv ? '➔' : '↩';
        div.appendChild(info); div.appendChild(arrow);
        list.appendChild(div);
    });
}

async function renderAdminTools() {
    const data = await fetchCollection('ferramentas');
    const list = document.getElementById('admin-tools-list');
    if (!list) return;
    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>'; return;
    }
    Object.entries(data).forEach(([id, t]) => {
        const row = document.createElement('div');
        row.className = 'admin-list-row';
        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label';
        lbl.textContent = `🪛 ${t.nome}`;
        const btn = document.createElement('button');
        btn.className = 'admin-list-delete';
        btn.textContent = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon:'🗑️', title:'Apagar ferramenta?',
            desc:`"${escapeHtml(t.nome)}" será removida permanentemente.`,
            onConfirm: () => deleteTool(id)
        });
        const histBtn = document.createElement('button');
        histBtn.className   = 'admin-list-hist';
        histBtn.textContent = '📋';
        histBtn.title       = 'Ver histórico';
        histBtn.onclick     = () => openHistoryModal(id, t.nome);
        row.appendChild(lbl); row.appendChild(histBtn); row.appendChild(btn);
        list.appendChild(row);
    });
}


// =============================================
// HISTÓRICO DAS FERRAMENTAS
// =============================================
const HISTORY_MAX = 50; // máximo de registos por ferramenta

async function addToolHistoryEvent(toolId, acao, colaborador) {
    const event = { acao, colaborador: colaborador || '', data: new Date().toISOString() };
    try {
        // Adiciona novo evento
        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico.json`, {
            method: 'POST', body: JSON.stringify(event)
        });
        // Verifica se excede o limite — se sim, apaga o mais antigo
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        const data = await res.json();
        if (data && Object.keys(data).length > HISTORY_MAX) {
            // Ordena por data e apaga o mais antigo
            const sorted = Object.entries(data).sort((a, b) => new Date(a[1].data) - new Date(b[1].data));
            const oldestKey = sorted[0][0];
            await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico/${oldestKey}.json`, { method: 'DELETE' });
        }
    } catch { /* histórico é best-effort */ }
}

async function openHistoryModal(toolId, toolName) {
    document.getElementById('history-modal-tool-name').textContent = `🪛 ${toolName}`;
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';
    document.getElementById('history-modal').classList.add('active');
    focusModal('history-modal');

    try {
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        const data = await res.json();
        listEl.innerHTML = '';

        if (!data) {
            listEl.innerHTML = '<div class="empty-msg">Sem registos de histórico.</div>';
            return;
        }

        // Converte objeto Firebase em array e ordena do mais recente para o mais antigo
        const events = Object.values(data).sort((a, b) => new Date(b.data) - new Date(a.data));

        events.forEach(ev => {
            const row  = document.createElement('div');
            row.className = `history-row ${ev.acao === 'atribuida' ? 'history-out' : 'history-in'}`;
            const icon = ev.acao === 'atribuida' ? '➔' : '↩';
            const label = ev.acao === 'atribuida'
                ? `Entregue a ${ev.colaborador || '?'}`
                : `Devolvida${ev.colaborador ? ` por ${ev.colaborador}` : ''}`;
            const date  = formatDate(ev.data);
            const iconEl = document.createElement('span');
            iconEl.className   = 'history-icon';
            iconEl.textContent = icon;
            const info  = document.createElement('div');
            info.className = 'history-info';
            const lbl   = document.createElement('span');
            lbl.className   = 'history-label';
            lbl.textContent = label;
            const dt    = document.createElement('span');
            dt.className   = 'history-date';
            dt.textContent = date;
            info.appendChild(lbl);
            info.appendChild(dt);
            row.appendChild(iconEl);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = '<div class="empty-msg">Erro ao carregar histórico.</div>';
    }
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('active');
}

async function assignTool(worker) {
    const dataEntrega = new Date().toISOString();
    const id = toolToAllocate;
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'alocada', colaborador:worker, dataEntrega
    };
    closeModal(); renderTools(); renderDashboard(); showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'alocada',colaborador:worker,dataEntrega})
        });
        await addToolHistoryEvent(id, 'atribuida', worker);
    } catch { invalidateCache('ferramentas'); showToast('Erro ao guardar.','error'); }
}

async function returnTool(id) {
    const colaborador = cache.ferramentas.data[id]?.colaborador || '';
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'disponivel', colaborador:'', dataEntrega:''
    };
    renderTools(); renderDashboard(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'disponivel',colaborador:'',dataEntrega:''})
        });
        await addToolHistoryEvent(id, 'devolvida', colaborador);
    } catch { invalidateCache('ferramentas'); showToast('Erro ao guardar.','error'); }
}

async function deleteTool(id) {
    delete cache.ferramentas.data[id]; renderAdminTools();
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method:'DELETE' });
    } catch { invalidateCache('ferramentas'); showToast('Erro ao apagar.','error'); }
}

// =============================================
// FUNCIONÁRIOS
// =============================================
async function renderWorkers() {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id,v]) => ({id, nome:v.nome})) : [];
    const list    = document.getElementById('workers-list');
    if (!list) return;
    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionário adicionado.</div>'; return;
    }
    workers.forEach(w => {
        const row = document.createElement('div');
        row.className = 'admin-list-row';
        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label';
        lbl.textContent = `👤 ${w.nome}`;
        const btn = document.createElement('button');
        btn.className = 'admin-list-delete';
        btn.textContent = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon:'👤', title:'Apagar funcionário?',
            desc:`"${escapeHtml(w.nome)}" será removido permanentemente.`,
            onConfirm: () => deleteWorker(w.id)
        });
        row.appendChild(lbl); row.appendChild(btn);
        list.appendChild(row);
    });
}

async function deleteWorker(id) {
    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();
    try {
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method:'DELETE' });
    } catch { invalidateCache('funcionarios'); showToast('Erro ao apagar.','error'); }
}

// =============================================
// MODAL — entregar ferramenta
// =============================================
let toolToAllocate = null;

async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid,v]) => ({id:wid,nome:v.nome})) : [];
    if (workers.length === 0) return showToast('Adicione funcionários na Administração','error');
    toolToAllocate = id;

    // Mostra o nome da ferramenta no modal
    const toolName = cache.ferramentas.data?.[id]?.nome || '';
    const toolDesc = document.getElementById('worker-modal-tool-name');
    if (toolDesc) toolDesc.textContent = toolName ? `🪛 ${toolName}` : '';

    const sel = document.getElementById('worker-select-list');
    sel.innerHTML = '';
    // Ordenar por nome
    workers.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
    workers.forEach(w => {
        const opt = document.createElement('div');
        opt.className   = 'worker-option';
        opt.textContent = w.nome;
        opt.onclick     = () => assignTool(w.nome);
        sel.appendChild(opt);
    });
    document.getElementById('worker-modal').classList.add('active');
    focusModal('worker-modal');
}
function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

// Focus first focusable element inside a modal when it opens
function focusModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const focusable = modal.querySelector('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

// =============================================
// MODAL — confirmação genérica
// =============================================
let confirmCallback = null;

function openConfirmModal({ icon='⚠️', title, desc, onConfirm }) {
    confirmCallback = onConfirm;
    document.getElementById('confirm-modal-icon').textContent  = icon;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent  = desc;
    document.getElementById('confirm-modal').classList.add('active');
    focusModal('confirm-modal');
}
function closeConfirmModal() {
    confirmCallback = null;
    document.getElementById('confirm-modal').classList.remove('active');
}

// =============================================
// MODAL — apagar produto (swipe left)
// =============================================
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    document.getElementById('delete-modal-desc').textContent =
        `"${String(item.codigo||'').toUpperCase()} — ${item.nome}" será removido permanentemente.`;
    document.getElementById('delete-modal').classList.add('active');
    focusModal('delete-modal');
}
function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-modal').classList.remove('active');
}

// =============================================
// MODAL — editar produto (swipe right)
// =============================================
function openEditModal(id, item) {
    document.getElementById('edit-id').value     = id;
    document.getElementById('edit-codigo').value = item.codigo || '';
    document.getElementById('edit-nome').value   = item.nome || '';
    document.getElementById('edit-loc').value    = item.localizacao || '';
    document.getElementById('edit-qtd').value    = item.quantidade ?? 0;
    setUnitSelector('edit', item.unidade || 'un');
    document.getElementById('edit-modal').classList.add('active');
    focusModal('edit-modal');
}
function closeEditModal() { document.getElementById('edit-modal').classList.remove('active'); }

// =============================================
// SWIPE GESTURES
// FIX: único par de listeners globais — sem acumulação por card
// =============================================
const SWIPE_THRESHOLD = 80;
let _swipeCard    = null;
let _swipeWrapper = null;
let _swipeStartX  = 0;
let _swipeCurrentX = 0;
let _swipeDragging = false;
let _swipeMeta    = null; // { id, item }

document.addEventListener('mousemove', e => {
    if (!_swipeDragging) return;
    _onSwipeMove(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => {
    if (!_swipeDragging) return;
    _onSwipeEnd();
});

function attachSwipe(card, wrapper, id, item) {
    // Funcionários não têm swipe — apenas leitura
    if (currentRole === 'worker') return;
    card.addEventListener('touchstart', e => {
        e.stopPropagation();
        _onSwipeStart(card, wrapper, id, item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchmove',  e => _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend',   e => { e.stopPropagation(); _onSwipeEnd(); }, { passive: true });
    card.addEventListener('mousedown',  e => {
        // Não interferir com cliques nos botões +/−
        if (e.target.closest('.btn-qty')) return;
        _onSwipeStart(card, wrapper, id, item, e.clientX, e.clientY);
        e.preventDefault();
    });
}

let _swipeStartY  = 0;
let _swipeIntent  = null; // 'horizontal' | 'vertical' | null

function _onSwipeStart(card, wrapper, id, item, x, y = 0) {
    _swipeCard     = card;
    _swipeWrapper  = wrapper;
    _swipeMeta     = { id, item };
    _swipeStartX   = x;
    _swipeStartY   = y;
    _swipeCurrentX = 0;
    _swipeDragging  = true;
    _swipeIntent   = null;
    // Don't add is-swiping yet — wait to know direction
}

function _onSwipeMove(x, y = 0) {
    if (!_swipeDragging || !_swipeCard) return;
    const dx = x - _swipeStartX;
    const dy = y - _swipeStartY;

    // Determine intent on first meaningful movement
    if (_swipeIntent === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        _swipeIntent = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (_swipeIntent === 'horizontal') _swipeCard.classList.add('is-swiping');
    }

    // Only track horizontal swipes
    if (_swipeIntent !== 'horizontal') return;

    _swipeCurrentX = dx;
    const clamped  = Math.max(-140, Math.min(140, dx));
    _swipeCard.style.transform = `translateX(${clamped}px)`;
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (clamped < -20)     _swipeWrapper.classList.add('swiping-left');
    else if (clamped > 20) _swipeWrapper.classList.add('swiping-right');
}

function _onSwipeEnd() {
    if (!_swipeDragging || !_swipeCard) return;
    _swipeDragging = false;
    _swipeCard.classList.remove('is-swiping');
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (_swipeIntent === 'horizontal') {
        snapBack(_swipeCard);
        if      (_swipeCurrentX < -SWIPE_THRESHOLD) openDeleteModal(_swipeMeta.id, _swipeMeta.item);
        else if (_swipeCurrentX >  SWIPE_THRESHOLD) openEditModal(_swipeMeta.id, _swipeMeta.item);
    }
    _swipeCard = _swipeWrapper = _swipeMeta = null;
    _swipeIntent = null;
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once:true });
}

// =============================================
// PIN — SHA-256
// =============================================
let pinBuffer = '';
// Variáveis de tentativas removidas (sistema antigo)

// Bloqueio de PIN por tentativas excessivas
const PIN_MAX_ATTEMPTS  = 5;
const PIN_LOCKOUT_MS    = 5 * 60 * 1000; // 5 minutos
const PIN_ATTEMPTS_KEY  = 'hiperfrio-pin-attempts';
const PIN_LOCKOUT_KEY   = 'hiperfrio-pin-lockout';

function isPinLocked() {
    const lockUntil = parseInt(localStorage.getItem(PIN_LOCKOUT_KEY) || '0');
    if (Date.now() < lockUntil) return lockUntil;
    return false;
}

function recordPinFailure() {
    const attempts = parseInt(localStorage.getItem(PIN_ATTEMPTS_KEY) || '0') + 1;
    if (attempts >= PIN_MAX_ATTEMPTS) {
        const until = Date.now() + PIN_LOCKOUT_MS;
        localStorage.setItem(PIN_LOCKOUT_KEY,   String(until));
        localStorage.setItem(PIN_ATTEMPTS_KEY,  '0');
        return until;
    }
    localStorage.setItem(PIN_ATTEMPTS_KEY, String(attempts));
    return false;
}

function resetPinAttempts() {
    localStorage.removeItem(PIN_ATTEMPTS_KEY);
    localStorage.removeItem(PIN_LOCKOUT_KEY);
}

function checkAdminAccess() {
    // Só gestores têm acesso — qualquer outro perfil é bloqueado
    if (currentRole === 'manager') return true;
    showToast('Acesso reservado a gestores', 'error');
    return false;
}

let pinMode = 'admin'; // 'admin' | 'role'

function openPinModal(mode = 'admin') {
    pinMode   = mode;
    pinBuffer = '';
    updatePinDots('pin-dots', 0);
    const desc = document.getElementById('pin-modal-desc');
    if (desc) desc.textContent = mode === 'role'
        ? 'Introduz o PIN para entrar como Gestor'
        : 'Introduz o PIN de Gestor';
    document.getElementById('pin-error').textContent = '';
    document.getElementById('pin-modal').classList.add('active');
    focusModal('pin-modal');
}
function closePinModal() {
    pinBuffer = '';
    document.getElementById('pin-modal').classList.remove('active');
}
function pinKey(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots('pin-dots', pinBuffer.length);
    if (pinBuffer.length === 4) setTimeout(validatePin, 150);
}
function pinDel() { pinBuffer = pinBuffer.slice(0,-1); updatePinDots('pin-dots', pinBuffer.length); }

async function validatePin() {
    // Verifica bloqueio antes de qualquer comparação
    const locked = isPinLocked();
    if (locked) {
        const mins = Math.ceil((locked - Date.now()) / 60000);
        showPinError('pin-dots','pin-error',`Bloqueado. Tenta em ${mins} min.`);
        pinBuffer = '';
        return;
    }

    const savedHash = await getPinHash();
    const entered   = await hashPin(pinBuffer);
    if (entered === savedHash) {
        resetPinAttempts();
        document.getElementById('pin-modal').classList.remove('active');
        if (pinMode === 'role') {
            localStorage.setItem(ROLE_KEY, 'manager');
            applyRole('manager');
            bootApp();
        }
    } else {
        const lockedUntil = recordPinFailure();
        const remaining   = parseInt(localStorage.getItem(PIN_ATTEMPTS_KEY) || '0');
        const attemptsLeft = PIN_MAX_ATTEMPTS - remaining;
        if (lockedUntil) {
            showPinError('pin-dots','pin-error','Demasiadas tentativas. Bloqueado 5 min.');
        } else {
            showPinError('pin-dots','pin-error',`PIN incorreto (${attemptsLeft} tentativa${attemptsLeft !== 1 ? 's' : ''} restante${attemptsLeft !== 1 ? 's' : ''})`);
        }
        pinBuffer = '';
    }
}

let pinSetupBuffer = '', pinSetupFirstEntry = '', pinSetupStep = 'first';

let pinSetupMode = 'change'; // 'change' | 'first-time'

function openPinSetupModal(mode = 'change') {
    pinSetupMode   = mode;
    const hasPin   = !!_cachedPinHash;
    const isFirst  = mode === 'first-time';
    pinSetupBuffer = ''; pinSetupFirstEntry = ''; pinSetupStep = 'first';
    updatePinDots('pin-setup-dots', 0);
    document.getElementById('pin-setup-error').textContent = '';
    document.getElementById('pin-setup-title').textContent = isFirst ? 'Criar PIN de Gestor' : (hasPin ? 'Alterar PIN' : 'Definir PIN');
    document.getElementById('pin-setup-desc').textContent  = isFirst
        ? 'Define um PIN de 4 dígitos para proteger o acesso de Gestor'
        : 'Escolhe um PIN de 4 dígitos';
    document.getElementById('pin-setup-icon').textContent  = isFirst ? '🔑' : '🔐';
    document.getElementById('pin-remove-btn').style.display = (hasPin && !isFirst) ? 'block' : 'none';
    document.getElementById('pin-setup-modal').classList.add('active');
    focusModal('pin-setup-modal');
}
function closePinSetupModal() {
    document.getElementById('pin-setup-modal').classList.remove('active');
    // Se cancelou na primeira configuração, volta ao ecrã de seleção de perfil
    if (pinSetupMode === 'first-time') {
        pinSetupMode = 'change';
        document.getElementById('role-screen')?.classList.remove('hidden');
    }
}

function pinSetupKey(digit) {
    if (pinSetupBuffer.length >= 4) return;
    pinSetupBuffer += digit;
    updatePinDots('pin-setup-dots', pinSetupBuffer.length);
    if (pinSetupBuffer.length === 4) setTimeout(handlePinSetupStep, 150);
}
async function handlePinSetupStep() {
    if (pinSetupStep === 'first') {
        pinSetupFirstEntry = pinSetupBuffer;
        pinSetupBuffer = ''; pinSetupStep = 'confirm';
        updatePinDots('pin-setup-dots', 0);
        document.getElementById('pin-setup-desc').textContent = 'Repete o PIN para confirmar';
    } else {
        if (pinSetupBuffer === pinSetupFirstEntry) {
            const hash         = await hashPin(pinSetupBuffer);
            const wasFirstTime = pinSetupMode === 'first-time'; // guarda antes de closePinSetupModal resetar
            await setPinHash(hash);
            localStorage.removeItem('hiperfrio-pin'); // remove legado
            closePinSetupModal(); updatePinStatusUI(); showToast('PIN definido!');
            // Se foi a primeira configuração, entra logo como Gestor
            if (wasFirstTime) {
                localStorage.setItem(ROLE_KEY, 'manager');
                applyRole('manager');
                bootApp();
            }
        } else {
            showPinError('pin-setup-dots','pin-setup-error','PINs não coincidem. Tenta novamente.');
            pinSetupBuffer = ''; pinSetupFirstEntry = ''; pinSetupStep = 'first';
            setTimeout(() => { document.getElementById('pin-setup-desc').textContent = 'Escolhe um PIN de 4 dígitos'; }, 1000);
        }
    }
}
function pinSetupDel() { pinSetupBuffer = pinSetupBuffer.slice(0,-1); updatePinDots('pin-setup-dots', pinSetupBuffer.length); }
async function removePin() {
    await deletePinHash();
    localStorage.removeItem('hiperfrio-pin');
    closePinSetupModal(); updatePinStatusUI(); showToast('PIN removido');
}
function updatePinDots(cId, count) {
    document.querySelectorAll(`#${cId} span`).forEach((d,i) => {
        d.classList.toggle('filled', i < count); d.classList.remove('error');
    });
}
function showPinError(dotsId, errorId, msg) {
    document.querySelectorAll(`#${dotsId} span`).forEach(d => { d.classList.remove('filled'); d.classList.add('error'); });
    document.getElementById(errorId).textContent = msg;
    setTimeout(() => {
        document.querySelectorAll(`#${dotsId} span`).forEach(d => d.classList.remove('error'));
        document.getElementById(errorId).textContent = '';
    }, 1000);
}
function updatePinStatusUI() {
    const hasPin = !!_cachedPinHash;
    const desc   = document.getElementById('pin-status-desc');
    const btn    = document.getElementById('pin-action-btn');
    if (desc) desc.textContent = hasPin ? 'PIN ativo — partilhado entre dispositivos' : 'Protege o acesso como Gestor';
    if (btn)  btn.textContent  = hasPin ? 'Alterar' : 'Definir';
}

// =============================================
// EXPORTAR CSV
// =============================================
async function exportCSV() {
    const btn = document.querySelector('[onclick="exportCSV()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    const data = await fetchCollection('stock', false);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para exportar','error');
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
        return;
    }
    const headers = ['Referência','Nome','Localização','Quantidade','Unidade'];
    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_tmp_')));
    const rows = Object.values(cleanData).map(item => [
        `"${(item.codigo||'').toUpperCase()}"`,
        `"${(item.nome||'').replace(/"/g,'""')}"`,
        `"${(item.localizacao||'').toUpperCase()}"`,
        item.quantidade ?? 0,
        item.unidade || 'un'
    ]);
    const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
        href: url,
        download: `hiperfrio-stock-${new Date().toISOString().slice(0,10)}.csv`
    }).click();
    URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
    showToast(`${Object.keys(cleanData).length} produtos exportados!`);
}

// =============================================
// ADMIN TABS
// =============================================
function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-'+tab)?.classList.add('active');
    document.getElementById('panel-'+tab)?.classList.add('active');
}

// =============================================
// TEMA
// =============================================
function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
    const t = document.getElementById('theme-toggle-admin');
    if (t) t.checked = isDark;
}

// =============================================
// INICIALIZAÇÃO
// =============================================

// =============================================
// DETECÇÃO DE CÓDIGO DUPLICADO
// =============================================
function checkDuplicateCodigo(codigo, onConfirm) {
    if (!codigo || codigo.toUpperCase() === 'SEMREF') {
        onConfirm(); return; // SEMREF é sempre permitido em duplicado
    }
    const stock = cache.stock.data || {};
    const dupes = Object.values(stock).filter(
        item => (item.codigo || '').toUpperCase() === codigo.toUpperCase()
    );
    if (dupes.length === 0) {
        onConfirm(); return;
    }
    // Existe duplicado — mostra modal de confirmação
    const names = dupes.map(d => d.nome || '(sem nome)').join(', ');
    document.getElementById('dup-modal-desc').textContent =
        `O código "${codigo.toUpperCase()}" já existe em: ${names}. Queres registar mesmo assim?`;
    document.getElementById('dup-confirm-btn').onclick = () => { closeDupModal(); onConfirm(); };
    document.getElementById('dup-modal').classList.add('active');
    focusModal('dup-modal');
}
function closeDupModal() {
    document.getElementById('dup-modal').classList.remove('active');
}


// =============================================
// UNIDADE DE MEDIDA — dropdown inline no input
// =============================================
const UNIT_LABELS = { un: 'Unidade', L: 'Litros', m: 'Metros (m)', m2: 'Metros² (m²)' };
const UNIT_SHORT  = { un: 'Unidade', L: 'Litros', m: 'm', m2: 'm²' };

function toggleUnitMenu(prefix) {
    const menu = document.getElementById(`${prefix}-unit-menu`);
    const btn  = document.getElementById(`${prefix}-unit-btn`);
    const isOpen = menu.classList.toggle('open');
    btn.classList.toggle('active', isOpen);
    if (isOpen) {
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(e) {
                if (!document.getElementById(`${prefix}-unit-wrap`)?.contains(e.target)) {
                    menu.classList.remove('open');
                    btn.classList.remove('active');
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 0);
    }
}

function selectUnit(prefix, unit) {
    document.getElementById(`${prefix}-unidade`).value = unit;
    // Update button label
    const label = document.getElementById(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[unit] || unit;
    // Update active state in menu
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === unit);
    });
    // Close menu
    document.getElementById(`${prefix}-unit-menu`)?.classList.remove('open');
    document.getElementById(`${prefix}-unit-btn`)?.classList.remove('active');
}

function setUnitSelector(prefix, unit) {
    const val = unit || 'un';
    document.getElementById(`${prefix}-unidade`).value = val;
    const label = document.getElementById(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[val] || val;
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === val);
    });
}

// Formata quantidade — só mostra unidade se não for "un"
function fmtQty(quantidade, unidade) {
    const qty = quantidade ?? 0;
    if (!unidade || unidade === 'un') return String(qty);
    return `${qty} ${UNIT_SHORT[unidade] || unidade}`;
}

document.addEventListener('DOMContentLoaded', () => {

    // Tema
    if (localStorage.getItem('hiperfrio-tema') === 'dark') {
        document.body.classList.add('dark-mode');
        const t = document.getElementById('theme-toggle-admin');
        if (t) t.checked = true;
    }

    // Migração legacy PIN — só corre uma vez
    if (!localStorage.getItem('hiperfrio-migrated')) {
        const legacyPin = localStorage.getItem('hiperfrio-pin');
        if (legacyPin) {
            hashPin(legacyPin).then(h => setPinHash(h).then(() => {
                localStorage.removeItem('hiperfrio-pin');
                localStorage.setItem('hiperfrio-migrated', '1');
            }));
        } else {
            const legacyHash = localStorage.getItem('hiperfrio-pin-hash');
            if (legacyHash) {
                setPinHash(legacyHash).then(() => {
                    localStorage.removeItem('hiperfrio-pin-hash');
                });
            }
            localStorage.setItem('hiperfrio-migrated', '1');
        }
    }

    // Verifica perfil guardado — se existir, arranca diretamente
    const savedRole = localStorage.getItem(ROLE_KEY);
    if (savedRole === 'worker' || savedRole === 'manager') {
        applyRole(savedRole);
        bootApp();
    }
    // Se não há perfil guardado, o ecrã de seleção fica visível (default no HTML)

    // Pesquisa com debounce
    const searchInput = document.getElementById('inp-search');
    const searchClear = document.getElementById('inp-search-clear');
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            const val = e.target.value;
            if (searchClear) searchClear.style.display = val ? 'flex' : 'none';
            // Remove zero-stock filter badge if user types
            if (val) { const b = document.getElementById('zero-filter-badge'); if (b) b.remove(); }
            debounceTimer = setTimeout(() => renderList(val), 300);
        };
    }

    // Escape fecha o modal ativo
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modals = [
            { id: 'worker-modal',    close: closeModal },
            { id: 'pin-modal',       close: closePinModal },
            { id: 'pin-setup-modal', close: closePinSetupModal },
            { id: 'delete-modal',    close: closeDeleteModal },
            { id: 'edit-modal',      close: closeEditModal },
            { id: 'confirm-modal',   close: closeConfirmModal },
            { id: 'switch-role-modal', close: closeSwitchRoleModal },
            { id: 'history-modal',      close: closeHistoryModal },
            { id: 'dup-modal',          close: closeDupModal },
        ];
        for (const { id, close } of modals) {
            if (document.getElementById(id)?.classList.contains('active')) { close(); break; }
        }
    });

    // Online/Offline
    // (updateOfflineBanner é chamado por bootApp — aqui só registamos os eventos)
    window.addEventListener('offline', () => {
        updateOfflineBanner();
        showToast('Sem ligação — alterações guardadas localmente', 'error');
    });
    window.addEventListener('online', async () => {
        updateOfflineBanner();
        await syncQueue();
    });

    // Confirm modal OK
    document.getElementById('confirm-modal-ok').onclick = () => {
        const cb = confirmCallback; closeConfirmModal(); if (cb) cb();
    };

    // Delete confirm
    document.getElementById('delete-confirm-btn').onclick = async () => {
        if (!pendingDeleteId) return;
        const id   = pendingDeleteId;
        const item = cache.stock.data[id];
        closeDeleteModal();
        delete cache.stock.data[id];
        renderList(document.getElementById('inp-search')?.value || '', true);
        renderDashboard();
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'DELETE' });
        } catch {
            cache.stock.data[id] = item;
            renderList(document.getElementById('inp-search')?.value || '', true);
            renderDashboard();
            showToast('Erro ao apagar produto','error');
        }
    };

    // Form: Novo Produto
    document.getElementById('form-add')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn     = e.target.querySelector('button[type=submit]');
        const codigo  = document.getElementById('inp-codigo').value.trim().toUpperCase();
        const payload = {
            nome:        document.getElementById('inp-nome').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade:  parseFloat(document.getElementById('inp-qtd').value) || 0,
            unidade:     document.getElementById('inp-unidade').value || 'un',
            codigo
        };

        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(DB_URL, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) {
                    const r = await res.json();
                    if (r?.name) cache.stock.data[r.name] = payload;
                } else {
                    cache.stock.data[`_tmp_${Date.now()}`] = payload;
                }
                renderDashboard();
                setUnitSelector('inp', 'un');
                showToast('Produto Registado!'); nav('view-search'); e.target.reset();
            } catch { invalidateCache('stock'); showToast('Erro ao registar produto','error'); }
            finally { btn.disabled = false; }
        };

        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Lote
    document.getElementById('form-bulk')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = document.getElementById('bulk-codigo').value.trim().toUpperCase();
        const payload = {
            localizacao: document.getElementById('bulk-loc').value.trim().toUpperCase(),
            codigo,
            nome:        document.getElementById('bulk-nome').value.trim(),
            quantidade:  parseFloat(document.getElementById('bulk-qtd').value) || 0,
            unidade:     document.getElementById('bulk-unidade').value || 'un',
        };

        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(DB_URL, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) {
                    const r = await res.json();
                    if (r?.name) cache.stock.data[r.name] = payload;
                } else {
                    cache.stock.data[`_tmp_${Date.now()}`] = payload;
                }
                showToast(`${payload.codigo} adicionado ao lote!`);
                document.getElementById('bulk-codigo').value = '';
                document.getElementById('bulk-nome').value   = '';
                document.getElementById('bulk-qtd').value    = '1';
                setUnitSelector('bulk', 'un');
                document.getElementById('bulk-codigo').focus();
            } catch { invalidateCache('stock'); showToast('Erro ao adicionar ao lote','error'); }
            finally { btn.disabled = false; }
        };

        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Editar
    document.getElementById('form-edit')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id  = document.getElementById('edit-id').value;
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        const updated = {
            codigo:      document.getElementById('edit-codigo').value.trim().toUpperCase(),
            nome:        document.getElementById('edit-nome').value.trim(),
            localizacao: document.getElementById('edit-loc').value.trim().toUpperCase(),
            quantidade:  parseFloat(document.getElementById('edit-qtd').value) || 0,
            unidade:     document.getElementById('edit-unidade').value || 'un',
        };
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        closeEditModal();
        // FIX: força full re-render após edição (dados mudaram)
        renderList(document.getElementById('inp-search')?.value || '', true);
        showToast('Produto atualizado!');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'PATCH', body:JSON.stringify(updated) });
        } catch { invalidateCache('stock'); showToast('Erro ao guardar alterações','error'); }
        finally { btn.disabled = false; }
    });

    // Form: Funcionário
    document.getElementById('form-worker')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome = document.getElementById('worker-name').value.trim();
        if (!nome) return;
        try {
            const res = await apiFetch(`${BASE_URL}/funcionarios.json`, { method:'POST', body:JSON.stringify({nome}) });
            if (!cache.funcionarios.data) cache.funcionarios.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.funcionarios.data[r.name] = {nome}; }
            else { cache.funcionarios.data[`_tmp_${Date.now()}`] = {nome}; }
            document.getElementById('worker-name').value = '';
            renderWorkers(); showToast('Funcionário adicionado');
        } catch { invalidateCache('funcionarios'); showToast('Erro ao adicionar funcionário','error'); }
    });

    // Form: Ferramenta
    document.getElementById('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome    = document.getElementById('reg-tool-name').value.trim();
        const payload = { nome, status:'disponivel' };
        try {
            const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.ferramentas.data[r.name] = payload; }
            else { cache.ferramentas.data[`_tmp_${Date.now()}`] = payload; }
            document.getElementById('reg-tool-name').value = '';
            renderAdminTools(); showToast('Ferramenta registada');
        } catch { invalidateCache('ferramentas'); showToast('Erro ao registar ferramenta','error'); }
    });
});

// =============================================
// REGISTO PWA
// =============================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(() => console.log('PWA SW registado'))
            .catch(e => console.warn('PWA SW erro:', e));
    });
}
