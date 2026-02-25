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
    console.log('✅ Firebase Auth: token obtido com sucesso');
    return _authToken;
}

// Renovação proactiva do token a cada 45 min — protege sessões longas (ponto 1)
let _tokenRenewalTimer = null;
function _scheduleTokenRenewal() {
    clearTimeout(_tokenRenewalTimer);
    _tokenRenewalTimer = setTimeout(async () => {
        if (window._firebaseUser) {
            try {
                _authToken = await window._firebaseUser.getIdToken(true);
                _authTokenExp = Date.now() + 3_500_000;
                console.log('🔄 Token renovado proactivamente');
            } catch(e) { console.warn('Falha na renovação do token:', e.message); }
        }
        _scheduleTokenRenewal(); // agenda próxima renovação
    }, 45 * 60 * 1000); // 45 minutos
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
    _scheduleTokenRenewal(); // inicia ciclo de renovação proactiva (ponto 1)
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
    try {
        const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return _pruneQueue(raw); // PONTO 10: remove entradas expiradas
    }
    catch { return []; }
}
function queueSave(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

// PONTO 10: remove operações com mais de 7 dias da fila
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function _pruneQueue(q) {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    return q.filter(op => !op.ts || op.ts > cutoff);
}

function queueAdd(op) {
    // Regista Background Sync ao adicionar à fila
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => sw.sync.register('hiperfrio-sync')).catch(() => {});
    }
    // FIX: só aceita mutações na fila, nunca GETs
    if (!op.method || op.method === 'GET') return;
    op.ts = Date.now(); // timestamp para TTL
    const q = _pruneQueue(queueLoad());
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

    if (viewId === 'view-search') renderList().then(() => { if (_zeroFilterActive) filterZeroStock(); });
    if (viewId === 'view-register') { // PONTO 19: limpa form ao navegar
        const fa = document.getElementById('form-add');
        if (fa) { fa.reset(); setUnitSelector('inp','un'); document.getElementById('inp-notas').value = ''; }
    }
    if (viewId === 'view-bulk') {
        _bulkCount = 0; _updateBulkCounter();
        _refreshZoneDatalist(); // PONTO 16
        // PONTO 4: limpa zona se vazia para evitar confusão com lote anterior persistido pelo browser
        const bulkLoc = document.getElementById('bulk-loc');
        if (bulkLoc && !bulkLoc.value.trim()) bulkLoc.value = '';
    }
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-map')    whRender();
    if (viewId === 'view-map')    renderMapView();
    if (viewId === 'view-admin')  { renderWorkers(); renderAdminTools(); }

    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const sideMap = {
        'view-search':'nav-search','view-tools':'nav-tools','view-register':'nav-register',
        'view-bulk':'nav-bulk','view-admin':'nav-admin','view-map':'nav-map'
    };
    document.getElementById(sideMap[viewId])?.classList.add('active');

    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bnavMap = {
        'view-search':'bnav-search','view-tools':'bnav-tools','view-register':'bnav-register',
        'view-bulk':'bnav-bulk','view-admin':'bnav-admin','view-map':'bnav-map'
    };
    document.getElementById(bnavMap[viewId])?.classList.add('active');

    if (document.getElementById('side-menu')?.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
}


// =============================================
// DASHBOARD — resumo no topo do stock
// =============================================
// PONTO 17: snapshot diário para tendência no dashboard
const DASH_SNAPSHOT_KEY = 'hiperfrio-dash-snap';
function _saveDashSnapshot(total, semStock, alocadas) {
    const today = new Date().toISOString().slice(0,10);
    const snap  = JSON.parse(localStorage.getItem(DASH_SNAPSHOT_KEY) || '{}');
    if (snap.date !== today) {
        snap.prev = snap.curr || null;
        snap.curr = { date: today, total, semStock, alocadas };
        snap.date = today;
        localStorage.setItem(DASH_SNAPSHOT_KEY, JSON.stringify(snap));
    }
}
function _getDashTrend(field, currentVal) {
    try {
        const snap = JSON.parse(localStorage.getItem(DASH_SNAPSHOT_KEY) || '{}');
        if (!snap.prev) return null;
        const diff = currentVal - snap.prev[field];
        if (diff === 0) return null;
        return diff;
    } catch { return null; }
}

async function renderDashboard() {
    const el = document.getElementById('dashboard');
    if (!el) return;

    // Mostra skeleton enquanto carrega
    el.innerHTML = '';
    el.className = 'dashboard';

    // Invalida cache dos dois ao mesmo tempo para garantir consistência temporal
    const ts = Date.now();
    const [stockData, ferrData] = await Promise.all([
        fetchCollection('stock', ts > cache.stock.lastFetch + 60000),
        fetchCollection('ferramentas', ts > cache.ferramentas.lastFetch + 60000)
    ]);

    const stockEntries  = Object.values(stockData || {});
    const ferraEntries  = Object.values(ferrData  || {});
    const total         = stockEntries.length;
    const semStock      = stockEntries.filter(i => (i.quantidade || 0) === 0).length;
    const alocadas      = ferraEntries.filter(t => t.status === 'alocada').length;
    const totalFerr     = ferraEntries.length;
    // PONTO 17 + 27: alertas de ferramentas alocadas há mais de 7 dias
    const ALERTA_DIAS = 7;
    const alocadasHaMuito = ferraEntries.filter(t => {
        if (t.status !== 'alocada' || !t.dataEntrega) return false;
        return (Date.now() - new Date(t.dataEntrega).getTime()) > ALERTA_DIAS * 86400000;
    });
    _saveDashSnapshot(total, semStock, alocadas);

    const cards = [
        {
            label: 'Produtos', value: total, icon: '📦', cls: '',
            trend: _getDashTrend('total', total),
            action: () => { nav('view-search'); }
        },
        {
            label: 'Sem stock', value: semStock, icon: '⚠️',
            cls: semStock > 0 ? 'dash-card-warn' : '',
            trend: _getDashTrend('semStock', semStock),
            action: semStock > 0 ? () => {
                _pendingZeroFilter = true;
                nav('view-search');
            } : null
        },
        {
            label: 'Ferramentas', value: `${alocadas}/${totalFerr}`, icon: '🪛',
            cls: alocadas === totalFerr && totalFerr > 0 ? 'dash-card-warn' : '',
            trend: _getDashTrend('alocadas', alocadas),
            action: () => nav('view-tools')
        },
        ...(alocadasHaMuito.length > 0 ? [{
            label: `Há +${ALERTA_DIAS}d`, value: alocadasHaMuito.length, icon: '🔴', cls: 'dash-card-alert',
            trend: null,
            action: () => { nav('view-tools'); showToast(`${alocadasHaMuito.length} ferramenta(s) alocada(s) há mais de ${ALERTA_DIAS} dias!`, 'error'); }
        }] : []),
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
        // PONTO 17: indicador de tendência
        if (c.trend !== null && c.trend !== undefined) {
            const tr = document.createElement('span');
            tr.className   = 'dash-trend ' + (c.trend > 0 ? 'dash-trend-up' : 'dash-trend-down');
            tr.textContent = (c.trend > 0 ? '↑' : '↓') + Math.abs(c.trend);
            val.appendChild(tr);
        }
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
let _pendingZeroFilter  = false;
let _bulkCount = 0; // contador de produtos adicionados no lote actual
let _toolsFilter = ''; // filtro de pesquisa de ferramentas // activa filtro zero-stock após próximo renderList
let _zeroFilterActive  = false; // zero-stock filter está activo (persiste entre navegações)

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

// Fecha sort menu em scroll ou resize (posição desactualizada)
window.addEventListener('scroll', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
}, { passive: true });
window.addEventListener('resize', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
});

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
    _zeroFilterActive = true;
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;
    const wrappers = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    wrappers.forEach(wrapper => {
        const id   = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        const isZero = item && (item.quantidade || 0) === 0;
        wrapper.style.display = isZero ? '' : 'none';
    });
    let badge = document.getElementById('zero-filter-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id        = 'zero-filter-badge';
        badge.className = 'zero-filter-badge';
        badge.innerHTML = '⚠️ A mostrar apenas produtos sem stock &nbsp;<button onclick="clearZeroFilter()">✕ Limpar</button>';
        listEl.parentNode.insertBefore(badge, listEl);
    }
}

// PONTO 16: histórico de zonas
const ZONE_HISTORY_KEY = 'hiperfrio-zone-history';
function _saveZoneToHistory(zona) {
    if (!zona) return;
    const hist = JSON.parse(localStorage.getItem(ZONE_HISTORY_KEY) || '[]');
    const updated = [zona, ...hist.filter(z => z !== zona)].slice(0, 8);
    localStorage.setItem(ZONE_HISTORY_KEY, JSON.stringify(updated));
    _refreshZoneDatalist();
}
function _refreshZoneDatalist() {
    const dl = document.getElementById('zone-datalist');
    if (!dl) return;
    const hist = JSON.parse(localStorage.getItem(ZONE_HISTORY_KEY) || '[]');
    dl.innerHTML = hist.map(z => `<option value="${z}">`).join('');
}

// PONTO 20: fechar lote com resumo
function closeBatch() {
    if (_bulkCount === 0) { nav('view-search'); return; }
    const zona = document.getElementById('bulk-loc')?.value?.trim() || '?';
    openConfirmModal({
        icon: '📦',
        title: 'Fechar lote?',
        desc: `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''} na zona "${zona}". Fechar e ir para o stock?`,
        onConfirm: () => {
            // Limpa o formulário completo
            document.getElementById('form-bulk')?.reset();
            setUnitSelector('bulk', 'un');
            document.getElementById('bulk-notas').value = '';
            _bulkCount = 0; _updateBulkCounter();
            nav('view-search');
        }
    });
}

function _updateBulkCounter() {
    const el = document.getElementById('bulk-counter');
    if (!el) return;
    el.textContent = _bulkCount === 0 ? '' : `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''}`;
    el.style.display = _bulkCount > 0 ? 'block' : 'none';
}

function clearSearch() {
    const inp = document.getElementById('inp-search');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); }
}

function clearZeroFilter() {
    _zeroFilterActive = false;
    const badge = document.getElementById('zero-filter-badge');
    if (badge) badge.remove();
    renderList('', false);
}

// PONTO 8: lógica de filtragem centralizada — usada por renderList em ambos os caminhos
function _itemMatchesFilter(item, filterLower, filterUpper) {
    if (!filterLower) return true;
    return (item.nome || '').toLowerCase().includes(filterLower)
        || String(item.codigo || '').toUpperCase().includes(filterUpper)
        || (item.localizacao || '').toLowerCase().includes(filterLower)
        || (item.notas || '').toLowerCase().includes(filterLower);
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
            const matches = _itemMatchesFilter(item, filterLower, filter.toUpperCase());
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
    const PAGE_SIZE = 80; // PONTO 9: paginação
    let _shownCount = 0;

    // Ordenação configurável
    getSortedEntries(entries).forEach(([id, item]) => {
        const matches = _itemMatchesFilter(item, filterLower, filter.toUpperCase());

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
        // Duplo-toque/duplo-clique abre edição inline de quantidade
        let _tapTimer = null;
        qtySpan.addEventListener('click', () => {
            if (_tapTimer) {
                clearTimeout(_tapTimer);
                _tapTimer = null;
                openInlineQtyEdit(id, item);
            } else {
                _tapTimer = setTimeout(() => { _tapTimer = null; }, 350);
            }
        });

        const btnP = document.createElement('button');
        btnP.className   = 'btn-qty';
        btnP.textContent = '+';
        btnP.onclick     = () => changeQtd(id, 1);

        qtyBox.appendChild(btnM); qtyBox.appendChild(qtySpan); qtyBox.appendChild(btnP);
        row.appendChild(pill); row.appendChild(qtyBox);
        // PONTO 13: indicador de notas
        if (item.notas) {
            const notasRow = document.createElement('div');
            notasRow.className   = 'card-notas';
            notasRow.title       = item.notas;
            notasRow.textContent = `📝 ${item.notas}`;
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
            el.appendChild(notasRow);
        } else {
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
        }
        el.appendChild(hr); el.appendChild(row);

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        if (!matches) { listEl.appendChild(wrapper); return; }
        // PONTO 9: só renderiza os primeiros PAGE_SIZE visíveis
        if (_shownCount < PAGE_SIZE) {
            listEl.appendChild(wrapper);
        } else {
            wrapper.style.display = 'none';
            wrapper.dataset.deferred = '1';
            listEl.appendChild(wrapper);
        }
        _shownCount++;
    });

    // Botão "Mostrar mais" se há cards diferidos
    const deferred = listEl.querySelectorAll('.swipe-wrapper[data-deferred="1"]').length;
    const existingBtn = document.getElementById('load-more-btn');
    if (existingBtn) existingBtn.remove();
    if (deferred > 0) {
        const btn = document.createElement('button');
        btn.id = 'load-more-btn';
        btn.className = 'btn-load-more';
        btn.textContent = `Mostrar mais ${deferred} produto${deferred > 1 ? 's' : ''}`;
        btn.onclick = () => {
            listEl.querySelectorAll('.swipe-wrapper[data-deferred="1"]').forEach(w => {
                w.style.display = '';
                delete w.dataset.deferred;
            });
            btn.remove();
        };
        listEl.appendChild(btn);
    }

    if (filter && found === 0) {
        const em = document.createElement('div');
        em.className   = 'empty-msg';
        em.textContent = 'Nenhum resultado encontrado.';
        listEl.appendChild(em);
    }

    // Aplica filtro zero-stock se estava pendente (vindo do dashboard)
    if (_pendingZeroFilter) {
        _pendingZeroFilter = false;
        filterZeroStock();
    }
}

// Edição inline de quantidade — abre mini-form no lugar do span
function openInlineQtyEdit(id, item) {
    const qtyEl = document.getElementById(`qty-${id}`);
    if (!qtyEl || qtyEl.querySelector('input')) return; // já em edição
    const currentQty = cache.stock.data?.[id]?.quantidade ?? item.quantidade ?? 0; // PONTO 5: lê do cache actualizado
    const wrap = document.createElement('div');
    wrap.className = 'qty-inline-edit';
    const inp = document.createElement('input');
    inp.type  = 'number';
    inp.min   = '0';
    inp.step  = 'any';
    inp.value = currentQty;
    inp.className = 'qty-inline-input';
    inp.setAttribute('inputmode', 'decimal');
    const confirmFn = async () => {
        const newVal = parseFloat(inp.value);
        if (isNaN(newVal) || newVal < 0) { cancelFn(); return; }
        wrap.replaceWith(qtyEl);
        qtyEl.textContent = fmtQty(newVal, item.unidade);
        qtyEl.classList.toggle('is-zero', newVal === 0);
        document.getElementById(`btn-minus-${id}`)?.toggleAttribute('disabled', newVal === 0);
        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newVal;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: newVal }) });
            renderDashboard();
        } catch { showToast('Erro ao guardar','error'); }
    };
    const cancelFn = () => { wrap.replaceWith(qtyEl); };
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmFn(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelFn(); }
    });
    inp.addEventListener('blur', () => setTimeout(cancelFn, 150));
    const ok = document.createElement('button');
    ok.className = 'qty-inline-ok';
    ok.textContent = '✓';
    ok.addEventListener('mousedown', e => { e.preventDefault(); confirmFn(); });
    wrap.appendChild(inp);
    wrap.appendChild(ok);
    qtyEl.replaceWith(wrap);
    inp.focus();
    inp.select();
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

    // Mostra indicador de "a guardar" após 300ms sem actividade
    if (qtyEl) qtyEl.classList.add('qty-saving');
    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: finalQty })
            });
            if (qtyEl) qtyEl.classList.remove('qty-saving');
        } catch {
            if (qtyEl) qtyEl.classList.remove('qty-saving');
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
    const filterLower = _toolsFilter.toLowerCase();
    let toolsFound = 0;
    ;[...Object.entries(data)].reverse().forEach(([id, t]) => {
        if (filterLower && !t.nome?.toLowerCase().includes(filterLower)) return;
        toolsFound++;
        const isAv = t.status === 'disponivel';
        const div  = document.createElement('div');
        // PONTO 27: badge de alerta se alocada há mais de ALERTA_DIAS dias
        const TOOL_ALERT_DAYS = 7;
        const isOverdue = !isAv && t.dataEntrega &&
            (Date.now() - new Date(t.dataEntrega).getTime()) > TOOL_ALERT_DAYS * 86400000;
        div.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}${isOverdue ? ' tool-overdue' : ''}`;
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
        const toolIconSpan = document.createElement('span');
        toolIconSpan.className   = 'tool-card-icon';
        toolIconSpan.textContent = t.icone || '🪛';
        nome.appendChild(toolIconSpan);
        nome.appendChild(document.createTextNode(t.nome));
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
            if (isOverdue) {
                const ovd = document.createElement('div');
                ovd.className   = 'tool-overdue-badge';
                const days = Math.floor((Date.now() - new Date(t.dataEntrega).getTime()) / 86400000);
                ovd.textContent = `⏰ Alocada há ${days} dias`;
                sub.appendChild(ovd);
            }
        }
        info.appendChild(nome); info.appendChild(sub);
        const arrow = document.createElement('span');
        arrow.className  = 'tool-arrow';
        arrow.textContent = isAv ? '➔' : '↩';
        div.appendChild(info); div.appendChild(arrow);
        list.appendChild(div);
    });
    if (filterLower && toolsFound === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta encontrada.</div>';
    }
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
        lbl.textContent = `${t.icone || '🪛'} ${t.nome}`;
        const btn = document.createElement('button');
        btn.className = 'admin-list-delete';
        btn.textContent = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon:'🗑️', title:'Apagar ferramenta?',
            desc:`"${escapeHtml(t.nome)}" será removida permanentemente.`,
            onConfirm: () => deleteTool(id)
        });
        const editBtn = document.createElement('button');
        editBtn.className   = 'admin-list-edit';
        editBtn.textContent = '✏️';
        editBtn.title       = 'Editar';
        editBtn.onclick     = () => openEditToolModal(id, t);
        const histBtn = document.createElement('button');
        histBtn.className   = 'admin-list-hist';
        histBtn.textContent = '📋';
        histBtn.title       = 'Ver histórico';
        histBtn.onclick     = () => openHistoryModal(id, t.nome);
        row.appendChild(lbl); row.appendChild(editBtn); row.appendChild(histBtn); row.appendChild(btn);
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
        if (!navigator.onLine) {
            listEl.innerHTML = '<div class="empty-msg">Sem ligação — histórico indisponível offline.</div>';
            return;
        }
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    // PONTO 2: guarda colaborador ANTES de modificar cache — evita perda offline
    const colaborador = cache.ferramentas.data[id]?.colaborador || '';
    const dataEntregaOrig = cache.ferramentas.data[id]?.dataEntrega || '';
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'disponivel', colaborador:'', dataEntrega:''
    };
    renderTools(); renderDashboard(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'disponivel',colaborador:'',dataEntrega:''})
        });
        // Regista histórico com colaborador preservado mesmo offline
        await addToolHistoryEvent(id, 'devolvida', colaborador);
    } catch {
        // Reverte estado local
        cache.ferramentas.data[id] = {
            ...cache.ferramentas.data[id], status:'alocada', colaborador, dataEntrega: dataEntregaOrig
        };
        invalidateCache('ferramentas'); showToast('Erro ao guardar.','error');
    }
}

// PONTO 11: editar ferramenta (nome + ícone)
let _editToolId = null;

function openEditToolModal(id, tool) {
    _editToolId = id;
    document.getElementById('edit-tool-id').value   = id;
    document.getElementById('edit-tool-name').value = tool.nome || '';
    setUnitSelector && null; // não aplica
    // Set icon
    document.getElementById('edit-tool-icon-hidden').value = tool.icone || '🪛';
    document.getElementById('edit-tool-icon-btn').textContent = tool.icone || '🪛';
    document.getElementById('edit-tool-modal').classList.add('active');
    focusModal('edit-tool-modal');
}

function closeEditToolModal() {
    document.getElementById('edit-tool-modal').classList.remove('active');
    _editToolId = null;
}

async function saveEditTool() {
    const id    = document.getElementById('edit-tool-id').value;
    const nome  = document.getElementById('edit-tool-name').value.trim();
    const icone = document.getElementById('edit-tool-icon-hidden').value || '🪛';
    if (!nome) { showToast('Nome obrigatório', 'error'); return; }
    if (cache.ferramentas.data?.[id]) {
        cache.ferramentas.data[id] = { ...cache.ferramentas.data[id], nome, icone };
    }
    closeEditToolModal();
    renderAdminTools();
    renderTools();
    renderDashboard();
    showToast('Ferramenta actualizada!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body: JSON.stringify({ nome, icone })
        });
    } catch { invalidateCache('ferramentas'); showToast('Erro ao guardar','error'); }
}

async function deleteTool(id) {
    // PONTO 3: se ferramenta está alocada, força devolução antes de apagar
    const tool = cache.ferramentas.data?.[id];
    const _doDelete = async () => {
        delete cache.ferramentas.data[id]; renderAdminTools(); renderTools(); renderDashboard();
        try {
            await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method:'DELETE' });
            showToast('Ferramenta apagada');
        } catch { invalidateCache('ferramentas'); showToast('Erro ao apagar.','error'); }
    };
    if (tool?.status === 'alocada') {
        openConfirmModal({
            icon: '⚠️',
            title: 'Ferramenta alocada!',
            desc: `"${escapeHtml(tool.nome)}" está com ${escapeHtml(tool.colaborador || '?')}. Apagar irá forçar a devolução sem registo. Confirmas?`,
            onConfirm: _doDelete
        });
    } else {
        await _doDelete();
    }
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

    // Mostra o nome e ícone da ferramenta no modal
    const toolData = cache.ferramentas.data?.[id];
    const toolName = toolData?.nome || '';
    const toolIcon = toolData?.icone || '🪛';
    const toolDesc = document.getElementById('worker-modal-tool-name');
    if (toolDesc) toolDesc.textContent = toolName ? `${toolIcon} ${toolName}` : '';
    // Actualiza também o ícone grande no topo do modal
    const modalIcon = document.getElementById('worker-modal-icon');
    if (modalIcon) modalIcon.textContent = toolIcon;

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
    document.getElementById('edit-notas').value  = item.notas || '';
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

// PONTO 12: lockout armazenado na Firebase — bypass-proof mesmo se localStorage for limpo
const PIN_LOCKOUT_FB_URL = `${BASE_URL}/config/pinLockout.json`;

function isPinLocked() {
    // Verificação local rápida (fallback)
    const lockUntil = parseInt(localStorage.getItem(PIN_LOCKOUT_KEY) || '0');
    if (Date.now() < lockUntil) return lockUntil;
    return false;
}

async function isPinLockedRemote() {
    try {
        const url = await authUrl(PIN_LOCKOUT_FB_URL);
        const res = await fetch(url);
        if (!res.ok) return false;
        const data = await res.json();
        if (!data) return false;
        if (Date.now() < (data.until || 0)) return data.until;
        return false;
    } catch { return false; } // offline — usa local
}

function recordPinFailure() {
    const attempts = parseInt(localStorage.getItem(PIN_ATTEMPTS_KEY) || '0') + 1;
    if (attempts >= PIN_MAX_ATTEMPTS) {
        const until = Date.now() + PIN_LOCKOUT_MS;
        localStorage.setItem(PIN_LOCKOUT_KEY,  String(until));
        localStorage.setItem(PIN_ATTEMPTS_KEY, '0');
        // Persiste também na Firebase (async — best-effort)
        authUrl(PIN_LOCKOUT_FB_URL).then(url =>
            fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ until, attempts: 0 }) })
        ).catch(() => {});
        return until;
    }
    localStorage.setItem(PIN_ATTEMPTS_KEY, String(attempts));
    // Actualiza contagem na Firebase
    authUrl(PIN_LOCKOUT_FB_URL).then(url =>
        fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ attempts }) })
    ).catch(() => {});
    return false;
}

function resetPinAttempts() {
    localStorage.removeItem(PIN_ATTEMPTS_KEY);
    localStorage.removeItem(PIN_LOCKOUT_KEY);
    // Limpa também na Firebase
    authUrl(PIN_LOCKOUT_FB_URL).then(url =>
        fetch(url, { method:'DELETE' })
    ).catch(() => {});
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
    // PONTO 12: verifica lockout remoto antes de validar
    const remoteLock = await isPinLockedRemote();
    if (remoteLock) {
        const remaining = Math.ceil((remoteLock - Date.now()) / 60000);
        showPinError('pin-dots', 'pin-error', `Bloqueado por ${remaining} min`);
        return;
    }
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
    document.getElementById('pin-remove-btn')?.classList.toggle('hidden', !(hasPin && !isFirst));
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
// PONTO 25: exportar histórico de ferramentas para CSV
async function exportToolHistoryCSV() {
    const btn = document.querySelector('[onclick="exportToolHistoryCSV()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    try {
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData || Object.keys(ferrData).length === 0) {
            showToast('Sem ferramentas para exportar', 'error');
            return;
        }
        const headers = ['Ferramenta','Ícone','Ação','Colaborador','Data'];
        const rows = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (!t.historico) continue;
            for (const ev of Object.values(t.historico)) {
                rows.push([
                    `"${(t.nome||'').replace(/"/g,'""')}"`,
                    `"${t.icone || '🪛'}"`,
                    `"${ev.acao || ''}"`,
                    `"${(ev.colaborador||'').replace(/"/g,'""')}"`,
                    `"${ev.data ? new Date(ev.data).toLocaleString('pt-PT') : ''}"`
                ]);
            }
        }
        if (rows.length === 0) {
            showToast('Sem histórico para exportar', 'error');
            return;
        }
        rows.sort((a, b) => a[4] < b[4] ? 1 : -1); // mais recente primeiro
        const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
        const blob = new Blob(['﻿'+csv], { type:'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), {
            href: url,
            download: `hiperfrio-historico-ferramentas-${new Date().toISOString().slice(0,10)}.csv`
        }).click();
        URL.revokeObjectURL(url);
        showToast(`${rows.length} registos exportados!`);
    } catch(e) {
        showToast('Erro ao exportar histórico', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar Histórico'; }
    }
}

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
const UNIT_PREFIXES = ['inp', 'bulk', 'edit'];

// Fecha todos os menus de unidade abertos
function _closeAllUnitMenus() {
    UNIT_PREFIXES.forEach(p => {
        document.getElementById(`${p}-unit-menu`)?.classList.remove('open');
        document.getElementById(`${p}-unit-btn`)?.classList.remove('active');
    });
}

// Listener nomeado para poder ser removido com segurança (ponto 7)
function _onOutsideUnitClick(e) {
    const isInsideAny = UNIT_PREFIXES.some(p =>
        document.getElementById(`${p}-unit-wrap`)?.contains(e.target)
    );
    if (!isInsideAny) {
        _closeAllUnitMenus();
        document.removeEventListener('click', _onOutsideUnitClick);
    }
}

function toggleUnitMenu(prefix) {
    const menu   = document.getElementById(`${prefix}-unit-menu`);
    const btn    = document.getElementById(`${prefix}-unit-btn`);
    const isOpen = menu.classList.contains('open');

    // Fecha todos primeiro (inclui outros menus de unidade)
    _closeAllUnitMenus();
    document.removeEventListener('click', _onOutsideUnitClick);

    if (!isOpen) {
        menu.classList.add('open');
        btn.classList.add('active');
        setTimeout(() => document.addEventListener('click', _onOutsideUnitClick), 0);
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


// =============================================
// ÍCONES DE FERRAMENTAS — picker por categoria
// =============================================
const TOOL_ICONS = {
    'Manuais':      ['🔧','🪛','🔩','🪚','🔨','🪝','⚙️','🗜️','📐','📏','🔑','🗝️','🪤','🪜','🪓','⚒️','🛠️','🔗','📌','🧲','🔮','🔪','🗡️','🪤'],
    'Elétrico':     ['🔌','🔋','💡','🔦','📡','🖥️','🖨️','⚡','🔆','🎛️','📟','🔘','🖱️','⌨️','🔲','📺','📻','📱','📲','🔔','🔕','🔈','🔉','🔊','🎚️','🎙️'],
    'Corte':        ['🔪','🪚','✂️','🗡️','🪓','⚔️','🪃','🧵','🧶','📎','🖇️','🖊️','🖋️','✒️','🗂️'],
    'Canalização':  ['🚿','🛁','🪠','🪣','💧','🌊','⛲','🏊','🧴','🧼','🫧','🪤','🔩','🔧','🪜','🏗️','🚧'],
    'AVAC / Frio':  ['❄️','🌡️','💨','🌬️','🏠','🌡️','♨️','🔥','💧','🌊','⛅','🌤️','🌪️','🌈'],
    'Elev. e Carga':['🏗️','⛓️','🪝','🧲','🔗','📦','🚛','🚜','🏋️','⚓','🪜','🛗','🛞','🔩','🔧'],
    'Medição':      ['⏱️','⏲️','🌡️','🧪','🧫','🔬','🔭','📊','📈','📉','🧮','⚖️','📏','📐','🔭','🔮','🗓️','📅','🕐','⏰'],
    'Pintura':      ['🎨','🖌️','🖼️','🪣','🧻','🎭','🎪','🖍️','✏️','🪥','🧽','🪣','💧'],
    'Solda':        ['🔥','⚡','💥','🛡️','🥽','🦺','🧤','🔩','⚙️','🔧','🪛','🏭','♨️','🌡️'],
    'Transporte':   ['🚗','🚛','🚜','🏎️','🚐','🛻','🚲','🛵','🛺','⛽','🪝','🔗','🚁','🛩️','⛵','🚢','🏍️','🚑','🚒'],
    'Segurança':    ['🦺','🧤','🥽','⛑️','🪖','🧯','🚨','⚠️','🚧','🔒','🛡️','🔐','🚫','🛑','🔴','🚒','👁️','🦯'],
    'Limpeza':      ['🧹','🧺','🧻','🪣','🧼','🧽','🫧','🪠','🚿','💧','🧴','🗑️','♻️','🪥','🌊','💦','🫙'],
    'Jardim / Ext.':['🌱','🌿','🌾','🪴','🌲','🌳','🍃','💐','🌻','🌺','🌸','🪻','🌵','🎋','🎍','🪸','🍄','🪨','🪵','⛏️','🌊','🏕️'],
    'Betão / Obra': ['🧱','🪣','🏗️','⛏️','🪚','🔨','🪜','🚧','🏠','🏢','🏭','🪟','🚪','🪞','🛗','🪑','🛁'],
    'Informática':  ['💻','🖥️','🖨️','⌨️','🖱️','📱','📲','🖲️','💾','💿','📀','📡','📟','📠','🔋','🔌','🖊️'],
    'Documentação': ['📋','📁','📂','📄','📃','📑','🗒️','🗓️','📊','📈','📉','📌','📍','🔖','🏷️','📎','🖇️','✂️','📬','📭'],
    'Outros':       ['📦','🗃️','🗄️','⭐','🏆','🎯','🎲','🧩','🎁','🎀','🧸','🪆','🔮','🪬','🧿','💎','🏅','🥇','🥈','🥉'],
};

let _iconPickerTarget = 'reg'; // 'reg' ou 'edit-tool'
let _iconPickerCat    = Object.keys(TOOL_ICONS)[0];

function openIconPicker(target = 'reg') {
    _iconPickerTarget = target;
    _renderIconPicker();
    document.getElementById('icon-picker-modal').classList.add('active');
    focusModal('icon-picker-modal');
}

function closeIconPicker() {
    document.getElementById('icon-picker-modal').classList.remove('active');
}

function _renderIconPicker() {
    // Categorias
    const catEl = document.getElementById('icon-picker-cats');
    catEl.innerHTML = '';
    Object.keys(TOOL_ICONS).forEach(cat => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-cat-btn' + (cat === _iconPickerCat ? ' active' : '');
        btn.textContent = cat;
        btn.onclick = () => { _iconPickerCat = cat; _renderIconPicker(); };
        catEl.appendChild(btn);
    });

    // Ícones da categoria activa
    const gridEl = document.getElementById('icon-picker-grid');
    gridEl.innerHTML = '';
    const currentIcon = (document.getElementById(`${_iconPickerTarget}-tool-icon`) || document.getElementById(`${_iconPickerTarget}-icon-hidden`))?.value || '🪛';
    TOOL_ICONS[_iconPickerCat].forEach(icon => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-grid-btn' + (icon === currentIcon ? ' active' : '');
        btn.textContent = icon;
        btn.onclick = () => _selectIcon(icon);
        gridEl.appendChild(btn);
    });
}

function _selectIcon(icon) {
    // Suporta dois padrões de ID: '{target}-tool-icon' e '{target}-icon-hidden'
    const hiddenEl = document.getElementById(`${_iconPickerTarget}-tool-icon`)
                  || document.getElementById(`${_iconPickerTarget}-icon-hidden`);
    if (hiddenEl) hiddenEl.value = icon;
    const btnEl = document.getElementById(`${_iconPickerTarget}-tool-icon-btn`);
    if (btnEl) btnEl.textContent = icon;
    closeIconPicker();
}


// =============================================
// PONTO 26: MODO INVENTÁRIO GUIADO
// =============================================
let _invItems     = [];   // lista ordenada por local
let _invIdx       = 0;    // índice actual
let _invChanges   = {};   // { id: novaQtd }

async function startInventory() {
    const data = await fetchCollection('stock', true);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para inventariar', 'error'); return;
    }
    // Ordena por localização depois nome
    _invItems = Object.entries(data)
        .filter(([k]) => !k.startsWith('_tmp_'))
        .sort(([,a],[,b]) => {
            const la = (a.localizacao||'ZZZ').toUpperCase();
            const lb = (b.localizacao||'ZZZ').toUpperCase();
            return la !== lb ? la.localeCompare(lb,'pt') : (a.nome||'').localeCompare(b.nome||'','pt');
        });
    _invIdx     = 0;
    _invChanges = {};
    document.getElementById('inv-modal').classList.add('active');
    focusModal('inv-modal');
    _renderInvStep();
}

function _renderInvStep() {
    const total  = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    document.getElementById('inv-progress-text').textContent =
        `${_invIdx + 1} / ${total}`;
    document.getElementById('inv-progress-bar').style.width =
        `${Math.round((_invIdx / total) * 100)}%`;
    document.getElementById('inv-local').textContent =
        item.localizacao ? `📍 ${item.localizacao.toUpperCase()}` : '📍 SEM LOCAL';
    document.getElementById('inv-ref').textContent = item.codigo || '';
    document.getElementById('inv-nome').textContent = item.nome || '';
    document.getElementById('inv-unidade').textContent = item.unidade && item.unidade !== 'un' ? item.unidade : '';
    const qtyInput = document.getElementById('inv-qtd');
    qtyInput.value = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
    qtyInput.focus();
    qtyInput.select();

    // Botão prev
    document.getElementById('inv-prev-btn').disabled = _invIdx === 0;
}

function invConfirm() {
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) return;
    const val = parseFloat(document.getElementById('inv-qtd').value);
    if (!isNaN(val) && val >= 0) _invChanges[id] = val;
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invSkip() {
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invPrev() {
    if (_invIdx > 0) { _invIdx--; _renderInvStep(); }
}

function closeInventory() {
    document.getElementById('inv-modal').classList.remove('active');
}

async function _finishInventory() {
    document.getElementById('inv-modal').classList.remove('active');
    const changed = Object.entries(_invChanges).filter(([id, newQty]) => {
        const oldQty = cache.stock.data?.[id]?.quantidade;
        return oldQty !== undefined && newQty !== oldQty;
    });
    if (changed.length === 0) {
        showToast('Inventário concluído — sem diferenças!'); return;
    }
    // Aplica alterações
    for (const [id, newQty] of changed) {
        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newQty;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method:'PATCH', body: JSON.stringify({ quantidade: newQty })
            });
        } catch { invalidateCache('stock'); }
    }
    renderList(document.getElementById('inp-search')?.value || '', true);
    renderDashboard();
    showToast(`Inventário: ${changed.length} diferença${changed.length > 1 ? 's' : ''} corrigida${changed.length > 1 ? 's' : ''}!`);
}

// =============================================
// PONTO 23: TIMELINE DE FERRAMENTAS
// =============================================
async function openToolTimeline() {
    const el = document.getElementById('timeline-list');
    el.innerHTML = '<div class="empty-msg">A carregar...</div>';
    document.getElementById('timeline-modal').classList.add('active');
    focusModal('timeline-modal');

    try {
        if (!navigator.onLine) {
            el.innerHTML = '<div class="empty-msg">Sem ligação — timeline indisponível offline.</div>';
            return;
        }
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData) { el.innerHTML = '<div class="empty-msg">Sem dados.</div>'; return; }

        // Recolhe todos os eventos de histórico
        const events = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (t.historico) {
                for (const ev of Object.values(t.historico)) {
                    events.push({ ...ev, toolNome: t.nome, toolIcone: t.icone || '🪛', toolId: id });
                }
            }
            // Adiciona estado actual se alocada
            if (t.status === 'alocada' && t.dataEntrega) {
                const days = Math.floor((Date.now() - new Date(t.dataEntrega).getTime()) / 86400000);
                events.push({
                    data: t.dataEntrega,
                    acao: 'alocada_agora',
                    colaborador: t.colaborador,
                    toolNome: t.nome,
                    toolIcone: t.icone || '🪛',
                    toolId: id,
                    _dias: days
                });
            }
        }
        // Ordena do mais recente
        events.sort((a,b) => new Date(b.data) - new Date(a.data));

        el.innerHTML = '';
        if (events.length === 0) {
            el.innerHTML = '<div class="empty-msg">Sem eventos registados.</div>'; return;
        }

        let lastDate = '';
        events.slice(0, 100).forEach(ev => { // max 100 eventos
            const d     = new Date(ev.data);
            const dateStr = d.toLocaleDateString('pt-PT', { day:'numeric', month:'short', year:'numeric' });
            if (dateStr !== lastDate) {
                const sep = document.createElement('div');
                sep.className   = 'tl-date-sep';
                sep.textContent = dateStr;
                el.appendChild(sep);
                lastDate = dateStr;
            }
            const row  = document.createElement('div');
            const isOut = ev.acao === 'atribuida' || ev.acao === 'alocada_agora';
            row.className = `tl-event ${isOut ? 'tl-out' : 'tl-in'}`;

            const icoEl = document.createElement('span');
            icoEl.className   = 'tl-tool-icon';
            icoEl.textContent = ev.toolIcone;

            const info = document.createElement('div');
            info.className = 'tl-info';

            const name = document.createElement('span');
            name.className   = 'tl-tool-name';
            name.textContent = ev.toolNome || '?';

            const action = document.createElement('span');
            action.className = 'tl-action';
            if (ev.acao === 'alocada_agora') {
                action.textContent = `🔴 Com ${ev.colaborador || '?'} há ${ev._dias}d`;
                action.className += ' tl-action-overdue';
            } else if (ev.acao === 'atribuida') {
                action.textContent = `➔ Entregue a ${ev.colaborador || '?'}`;
            } else {
                action.textContent = `↩ Devolvida${ev.colaborador ? ' por ' + ev.colaborador : ''}`;
            }

            const time = document.createElement('span');
            time.className   = 'tl-time';
            time.textContent = d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });

            info.appendChild(name);
            info.appendChild(action);
            row.appendChild(icoEl);
            row.appendChild(info);
            row.appendChild(time);
            el.appendChild(row);
        });
    } catch(e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar timeline.</div>';
    }
}

function closeToolTimeline() {
    document.getElementById('timeline-modal').classList.remove('active');
}


// =============================================
// ARMAZÉM — Navegação hierárquica
// Corredor → Secção → Prateleira → Gaveta
// Passo 1: estrutura + navegação
// =============================================

const WH_URL = `${BASE_URL}/armazem`;
const WH_COLORS = [
    '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
    '#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6',
    '#6366f1','#d97706',
];
const WH_LEVELS = ['corredor','seccao','prateleira','gaveta'];
const WH_LEVEL_LABELS = {
    corredor:   { sing:'Corredor',   plu:'Corredores',   icon:'🏢' },
    seccao:     { sing:'Secção',     plu:'Secções',       icon:'📦' },
    prateleira: { sing:'Prateleira', plu:'Prateleiras',   icon:'🗂️'  },
    gaveta:     { sing:'Gaveta',     plu:'Gavetas',       icon:'📥' },
};

// Cache local — evita fetches desnecessários
let _whData = {
    corredores:  null,  // { id: { nome, cor, ordem } }
    seccoes:     null,  // { id: { nome, corredor_id, ordem } }
    prateleiras: null,  // { id: { nome, seccao_id, ordem } }
    gavetas:     null,  // { id: { nome, prateleira_id, ordem, produtos:{stock_id:true} } }
};
let _whLoaded     = false;
// Stack de navegação: [{ level, id, nome, cor }]
// level 0 = raiz (mostra corredores)
let _whNavStack   = [];
let _whEditColor  = WH_COLORS[0];
let _whCurrentTab = 'struct';
let _whProdSearchTimer = null;

// ── Carregar / Guardar ──────────────────────────────────────────────────────

async function _whLoad(force = false) {
    if (_whLoaded && !force) return;
    try {
        const url  = await authUrl(`${WH_URL}.json`);
        const res  = await fetch(url);
        const data = res.ok ? (await res.json()) || {} : {};
        _whData.corredores  = data.corredores  || {};
        _whData.seccoes     = data.seccoes     || {};
        _whData.prateleiras = data.prateleiras || {};
        _whData.gavetas     = data.gavetas     || {};
        _whLoaded = true;
    } catch {
        _whData = { corredores:{}, seccoes:{}, prateleiras:{}, gavetas:{} };
        _whLoaded = true;
    }
}

async function _whSavePatch(path, value) {
    try {
        const url = await authUrl(`${WH_URL}/${path}.json`);
        await fetch(url, {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(value)
        });
    } catch { showToast('Erro ao guardar no armazém','error'); }
}

async function _whDeletePath(path) {
    try {
        const url = await authUrl(`${WH_URL}/${path}.json`);
        await fetch(url, { method:'DELETE' });
    } catch { showToast('Erro ao apagar','error'); }
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function whSwitchTab(tab) {
    _whCurrentTab = tab;
    document.getElementById('wh-tab-struct')?.classList.toggle('active', tab === 'struct');
    document.getElementById('wh-tab-planta')?.classList.toggle('active', tab === 'planta');
    document.getElementById('wh-panel-struct')?.classList.toggle('hidden', tab !== 'struct');
    document.getElementById('wh-panel-planta')?.classList.toggle('hidden', tab !== 'planta');
    if (tab === 'struct') whRender();
    if (tab === 'planta') renderMapView();
}

// ── Navegação ───────────────────────────────────────────────────────────────

function whCurrentLevel() {
    // 0=raiz(corredores), 1=seccoes, 2=prateleiras, 3=gavetas(conteúdo)
    return _whNavStack.length;
}

function whNavTo(depth) {
    _whNavStack = _whNavStack.slice(0, depth);
    whRender();
}

function whNavInto(level, id, nome, cor) {
    _whNavStack.push({ level, id, nome, cor: cor || '#3b82f6' });
    whRender();
}

// ── Render principal ────────────────────────────────────────────────────────

async function whRender() {
    const grid   = document.getElementById('wh-grid');
    const drawer = document.getElementById('wh-drawer-panel');
    const addBtn = document.getElementById('wh-add-btn');
    if (!grid) return;

    await _whLoad();

    const depth = whCurrentLevel();

    // Breadcrumb
    _whRenderBreadcrumb();

    // Título do botão +
    const nextLevelKey = WH_LEVELS[depth];  // o que vamos criar
    if (addBtn && nextLevelKey) {
        addBtn.textContent = `＋ ${WH_LEVEL_LABELS[nextLevelKey].sing}`;
        addBtn.classList.toggle('hidden', depth > 3 || currentRole !== 'manager');
    }

    drawer?.classList.add('hidden');
    grid.classList.remove('hidden');

    if (depth === 3) {
        // Nível gaveta — mostra conteúdo da gaveta (produtos)
        const gavId = _whNavStack[2].id;
        grid.classList.add('hidden');
        drawer?.classList.remove('hidden');
        _whRenderDrawer(gavId);
        return;
    }

    // Nível 0–2: mostra cards do nível filho
    const items = _whGetChildItems(depth);
    grid.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className   = 'wh-empty';
        const lbl = nextLevelKey ? WH_LEVEL_LABELS[nextLevelKey] : null;
        empty.innerHTML = lbl
            ? `<span class="wh-empty-icon">${lbl.icon}</span><span>Sem ${lbl.plu.toLowerCase()} — clica ＋ para adicionar</span>`
            : '<span>Vazio</span>';
        grid.appendChild(empty);
        return;
    }

    items.forEach(([id, item]) => {
        const card = _whBuildCard(depth, id, item);
        grid.appendChild(card);
    });
}

function _whGetChildItems(depth) {
    // Returns sorted array of [id, item] for the current depth level
    let col, parentKey;
    if      (depth === 0) { col = _whData.corredores;  parentKey = null; }
    else if (depth === 1) { col = _whData.seccoes;     parentKey = 'corredor_id'; }
    else if (depth === 2) { col = _whData.prateleiras; parentKey = 'seccao_id'; }
    else                  { col = _whData.gavetas;     parentKey = 'prateleira_id'; }

    const parentId = depth > 0 ? _whNavStack[depth - 1].id : null;

    return Object.entries(col || {})
        .filter(([, item]) => parentKey ? item[parentKey] === parentId : true)
        .sort(([, a], [, b]) => (a.ordem || 0) - (b.ordem || 0) || (a.nome || '').localeCompare(b.nome || '', 'pt'));
}

function _whBuildCard(depth, id, item) {
    const levelKey = WH_LEVELS[depth];  // o nível actual
    const info     = WH_LEVEL_LABELS[levelKey];
    const cor      = item.cor || _whNavStack[0]?.cor || '#3b82f6';

    // Conta filhos
    const childCount = _whCountChildren(depth, id);

    const card = document.createElement('div');
    card.className = 'wh-card';
    card.style.setProperty('--wh-card-color', cor);

    // Ícone
    const iconEl = document.createElement('div');
    iconEl.className   = 'wh-card-icon';
    iconEl.textContent = info.icon;

    // Nome
    const nameEl = document.createElement('div');
    nameEl.className   = 'wh-card-name';
    nameEl.textContent = item.nome || id;

    // Contagem de filhos
    const subEl = document.createElement('div');
    subEl.className   = 'wh-card-sub';
    if (depth < 3) {
        const nextInfo = WH_LEVEL_LABELS[WH_LEVELS[depth + 1]];
        subEl.textContent = childCount > 0
            ? `${childCount} ${childCount === 1 ? nextInfo.sing.toLowerCase() : nextInfo.plu.toLowerCase()}`
            : `sem ${nextInfo.plu.toLowerCase()}`;
    }

    // Clique → navegar para dentro
    card.onclick = () => whNavInto(levelKey, id, item.nome, cor);

    // Botão editar (gestor)
    if (currentRole === 'manager') {
        const editBtn = document.createElement('button');
        editBtn.className = 'wh-card-edit';
        editBtn.textContent = '⋯';
        editBtn.title = 'Editar';
        editBtn.onclick = (e) => { e.stopPropagation(); whOpenEditModal(depth, id, item); };
        card.appendChild(editBtn);
    }

    card.appendChild(iconEl);
    card.appendChild(nameEl);
    card.appendChild(subEl);
    return card;
}

function _whCountChildren(depth, id) {
    let col, parentKey;
    if      (depth === 0) { col = _whData.seccoes;     parentKey = 'corredor_id'; }
    else if (depth === 1) { col = _whData.prateleiras; parentKey = 'seccao_id'; }
    else if (depth === 2) { col = _whData.gavetas;     parentKey = 'prateleira_id'; }
    else return 0;
    return Object.values(col || {}).filter(i => i[parentKey] === id).length;
}

// ── Gaveta — lista de produtos ──────────────────────────────────────────────

function _whRenderDrawer(gavId) {
    const drawer  = document.getElementById('wh-drawer-panel');
    const gaveta  = _whData.gavetas?.[gavId];
    if (!drawer || !gaveta) return;

    const stock    = cache.stock.data || {};
    const prodIds  = Object.keys(gaveta.produtos || {});

    drawer.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'wh-drawer-header';

    const titleEl = document.createElement('div');
    titleEl.className   = 'wh-drawer-title';
    titleEl.innerHTML   = `<span class="wh-drawer-icon">📥</span> ${gaveta.nome || gavId}`;

    header.appendChild(titleEl);

    if (currentRole === 'manager') {
        const editBtn = document.createElement('button');
        editBtn.className   = 'wh-card-edit wh-drawer-edit';
        editBtn.textContent = '✏️ Editar gaveta';
        editBtn.onclick     = () => whOpenEditModal(3, gavId, gaveta);
        header.appendChild(editBtn);
    }

    drawer.appendChild(header);

    // Caminho completo
    const path = document.createElement('div');
    path.className   = 'wh-drawer-path';
    path.textContent = _whNavStack.map(n => n.nome).join(' › ');
    drawer.appendChild(path);

    // Produtos
    if (prodIds.length === 0) {
        const em = document.createElement('div');
        em.className   = 'wh-drawer-empty';
        em.innerHTML   = currentRole === 'manager'
            ? '📭 Gaveta vazia — clica ✏️ Editar para adicionar produtos'
            : '📭 Gaveta vazia';
        drawer.appendChild(em);
        return;
    }

    const list = document.createElement('div');
    list.className = 'wh-drawer-list';

    prodIds.forEach(pid => {
        const item = stock[pid];
        if (!item) return; // produto apagado
        const qty  = item.quantidade || 0;

        const row = document.createElement('div');
        row.className = 'wh-drawer-row';

        const left = document.createElement('div');
        left.className = 'wh-drawer-left';

        const ref = document.createElement('div');
        ref.className   = 'wh-drawer-ref';
        ref.textContent = (item.codigo || '').toUpperCase() || '—';

        const name = document.createElement('div');
        name.className   = 'wh-drawer-name';
        name.textContent = item.nome || '(sem nome)';

        left.appendChild(ref);
        left.appendChild(name);

        const qtyEl = document.createElement('div');
        qtyEl.className   = `wh-drawer-qty${qty === 0 ? ' is-zero' : ''}`;
        qtyEl.textContent = fmtQty(qty, item.unidade);

        row.appendChild(left);
        row.appendChild(qtyEl);
        list.appendChild(row);
    });

    drawer.appendChild(list);
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────

function _whRenderBreadcrumb() {
    const bc = document.getElementById('wh-breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';

    const root = document.createElement('span');
    root.className   = 'wh-bc-root';
    root.textContent = '🏭';
    root.onclick     = () => whNavTo(0);
    bc.appendChild(root);

    _whNavStack.forEach((node, i) => {
        const sep = document.createElement('span');
        sep.className   = 'wh-bc-sep';
        sep.textContent = '›';
        bc.appendChild(sep);

        const crumb = document.createElement('span');
        crumb.className   = 'wh-bc-item' + (i === _whNavStack.length - 1 ? ' wh-bc-current' : '');
        crumb.textContent = node.nome;
        if (i < _whNavStack.length - 1) crumb.onclick = () => whNavTo(i + 1);
        bc.appendChild(crumb);
    });
}

// ── Modal Adicionar / Editar ─────────────────────────────────────────────────

function whOpenAddModal() {
    const depth    = whCurrentLevel();
    const levelKey = WH_LEVELS[depth];
    if (!levelKey) return;
    const info = WH_LEVEL_LABELS[levelKey];

    document.getElementById('wh-edit-title').textContent  = `Novo ${info.sing}`;
    document.getElementById('wh-edit-level').value        = depth;
    document.getElementById('wh-edit-id').value           = '';
    document.getElementById('wh-edit-name').value         = '';
    document.getElementById('wh-edit-parent-id').value    = depth > 0 ? _whNavStack[depth-1].id : '';

    // Cor só para corredores
    const colorGroup = document.getElementById('wh-color-group');
    colorGroup?.classList.toggle('hidden', depth !== 0);
    _whEditColor = WH_COLORS[Object.keys(_whData.corredores || {}).length % WH_COLORS.length];
    document.getElementById('wh-edit-color').value = _whEditColor;
    _whBuildColorPicker();

    // Produtos só para gavetas
    const prodGroup = document.getElementById('wh-products-group');
    prodGroup?.classList.toggle('hidden', depth !== 3);
    if (depth === 3) _whInitProductAssign(null);

    // Botão apagar — só em edição
    document.getElementById('wh-edit-delete-btn')?.classList.add('hidden');

    document.getElementById('wh-edit-modal').classList.add('active');
    focusModal('wh-edit-modal');
    setTimeout(() => document.getElementById('wh-edit-name')?.focus(), 80);
}

function whOpenEditModal(depth, id, item) {
    const levelKey = WH_LEVELS[depth];
    const info     = WH_LEVEL_LABELS[levelKey];

    document.getElementById('wh-edit-title').textContent = `Editar ${info.sing}`;
    document.getElementById('wh-edit-level').value       = depth;
    document.getElementById('wh-edit-id').value          = id;
    document.getElementById('wh-edit-name').value        = item.nome || '';
    document.getElementById('wh-edit-parent-id').value   = item.corredor_id || item.seccao_id || item.prateleira_id || '';

    const colorGroup = document.getElementById('wh-color-group');
    colorGroup?.classList.toggle('hidden', depth !== 0);
    if (depth === 0) {
        _whEditColor = item.cor || WH_COLORS[0];
        document.getElementById('wh-edit-color').value = _whEditColor;
        _whBuildColorPicker();
    }

    const prodGroup = document.getElementById('wh-products-group');
    prodGroup?.classList.toggle('hidden', depth !== 3);
    if (depth === 3) _whInitProductAssign(item.produtos || {});

    document.getElementById('wh-edit-delete-btn')?.classList.remove('hidden');

    document.getElementById('wh-edit-modal').classList.add('active');
    focusModal('wh-edit-modal');
    setTimeout(() => document.getElementById('wh-edit-name')?.focus(), 80);
}

function whCloseEditModal() {
    document.getElementById('wh-edit-modal')?.classList.remove('active');
}

// ── Color picker ─────────────────────────────────────────────────────────────

function _whBuildColorPicker() {
    const el = document.getElementById('wh-color-picker');
    if (!el) return;
    el.innerHTML = '';
    WH_COLORS.forEach(c => {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'wh-color-swatch' + (c === _whEditColor ? ' active' : '');
        btn.style.background = c;
        btn.onclick = () => {
            _whEditColor = c;
            document.getElementById('wh-edit-color').value = c;
            el.querySelectorAll('.wh-color-swatch').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        el.appendChild(btn);
    });
}

// ── Atribuição de produtos à gaveta ──────────────────────────────────────────

let _whAssignedProd = {}; // { stock_id: true } — produtos atribuídos ao modal actual

function _whInitProductAssign(existing) {
    _whAssignedProd = existing ? { ...existing } : {};
    _whRenderAssigned();
    document.getElementById('wh-prod-search').value = '';
    document.getElementById('wh-prod-results').innerHTML = '';

    const searchEl = document.getElementById('wh-prod-search');
    if (searchEl) {
        searchEl.oninput = (e) => {
            clearTimeout(_whProdSearchTimer);
            _whProdSearchTimer = setTimeout(() => _whSearchProducts(e.target.value.trim()), 200);
        };
    }
}

function _whRenderAssigned() {
    const el    = document.getElementById('wh-product-assign');
    const stock = cache.stock.data || {};
    if (!el) return;
    el.innerHTML = '';

    const ids = Object.keys(_whAssignedProd);
    if (ids.length === 0) {
        el.innerHTML = '<div class="wh-assign-empty">Nenhum produto adicionado</div>';
        return;
    }
    ids.forEach(pid => {
        const item = stock[pid];
        const row  = document.createElement('div');
        row.className = 'wh-assign-row';

        const nameEl = document.createElement('span');
        nameEl.className   = 'wh-assign-name';
        nameEl.textContent = item
            ? `${(item.codigo || '').toUpperCase()} — ${item.nome || ''}`
            : `(produto removido: ${pid})`;

        const removeBtn = document.createElement('button');
        removeBtn.type      = 'button';
        removeBtn.className = 'wh-assign-remove';
        removeBtn.textContent = '✕';
        removeBtn.onclick   = () => { delete _whAssignedProd[pid]; _whRenderAssigned(); };

        row.appendChild(nameEl);
        row.appendChild(removeBtn);
        el.appendChild(row);
    });
}

function _whSearchProducts(q) {
    const el    = document.getElementById('wh-prod-results');
    const stock = cache.stock.data || {};
    if (!el) return;
    if (!q) { el.innerHTML = ''; return; }

    const ql = q.toLowerCase();
    const results = Object.entries(stock)
        .filter(([id, item]) =>
            !_whAssignedProd[id] &&
            ((item.nome || '').toLowerCase().includes(ql) ||
             (item.codigo || '').toLowerCase().includes(ql))
        )
        .slice(0, 8);

    el.innerHTML = '';
    if (results.length === 0) {
        el.innerHTML = '<div class="wh-prod-no-results">Sem resultados</div>';
        return;
    }
    results.forEach(([id, item]) => {
        const row = document.createElement('div');
        row.className = 'wh-prod-result-row';
        row.innerHTML = `<span class="wh-prod-ref">${(item.codigo||'').toUpperCase()}</span>
                         <span class="wh-prod-rname">${item.nome||''}</span>`;
        row.onclick = () => {
            _whAssignedProd[id] = true;
            _whRenderAssigned();
            document.getElementById('wh-prod-search').value = '';
            el.innerHTML = '';
        };
        el.appendChild(row);
    });
}

// ── Guardar / Apagar ─────────────────────────────────────────────────────────

async function whSaveNode(e) {
    e.preventDefault();
    const depth    = parseInt(document.getElementById('wh-edit-level').value);
    const editId   = document.getElementById('wh-edit-id').value;
    const parentId = document.getElementById('wh-edit-parent-id').value;
    const nome     = document.getElementById('wh-edit-name').value.trim();
    const cor      = document.getElementById('wh-edit-color').value || WH_COLORS[0];
    if (!nome) { showToast('Nome obrigatório', 'error'); return; }

    const levelKey = WH_LEVELS[depth];
    const colKey   = ['corredores','seccoes','prateleiras','gavetas'][depth];
    const parentField = ['','corredor_id','seccao_id','prateleira_id'][depth];

    const id = editId || `${levelKey.slice(0,3)}_${Date.now()}`;
    const existing = editId ? (_whData[colKey][editId] || {}) : {};
    const ordem    = existing.ordem ?? Object.keys(_whData[colKey] || {}).length;

    const node = {
        nome,
        ordem,
        ...(parentField ? { [parentField]: parentId } : {}),
        ...(depth === 0 ? { cor } : {}),
        ...(depth === 3 ? { produtos: _whAssignedProd } : {}),
    };

    // Update local cache
    if (!_whData[colKey]) _whData[colKey] = {};
    _whData[colKey][id] = node;

    whCloseEditModal();
    whRender();
    showToast(`${WH_LEVEL_LABELS[levelKey].sing} guardada!`);

    // Persist to Firebase
    await _whSavePatch(`${colKey}/${id}`, node);
}

function whDeleteNode() {
    const depth  = parseInt(document.getElementById('wh-edit-level').value);
    const editId = document.getElementById('wh-edit-id').value;
    const nome   = document.getElementById('wh-edit-name').value;
    if (!editId) return;

    // Count descendentes
    const count = _whCountDescendants(depth, editId);
    const desc  = count > 0
        ? `Esta acção vai apagar também ${count} item${count>1?'s':''} dentro de "${nome}".`
        : `"${nome}" será apagado permanentemente.`;

    document.getElementById('wh-delete-desc').textContent = desc;
    document.getElementById('wh-delete-confirm-btn').onclick = () => _whConfirmDelete(depth, editId);
    whCloseEditModal();
    document.getElementById('wh-delete-modal').classList.add('active');
    focusModal('wh-delete-modal');
}

function _whCountDescendants(depth, id) {
    let count = 0;
    if (depth === 0) {
        const seccoes = Object.entries(_whData.seccoes||{}).filter(([,s])=>s.corredor_id===id);
        count += seccoes.length;
        seccoes.forEach(([sid])=>{
            const prats = Object.entries(_whData.prateleiras||{}).filter(([,p])=>p.seccao_id===sid);
            count += prats.length;
            prats.forEach(([pid])=> {
                count += Object.values(_whData.gavetas||{}).filter(g=>g.prateleira_id===pid).length;
            });
        });
    } else if (depth === 1) {
        const prats = Object.entries(_whData.prateleiras||{}).filter(([,p])=>p.seccao_id===id);
        count += prats.length;
        prats.forEach(([pid])=> {
            count += Object.values(_whData.gavetas||{}).filter(g=>g.prateleira_id===pid).length;
        });
    } else if (depth === 2) {
        count += Object.values(_whData.gavetas||{}).filter(g=>g.prateleira_id===id).length;
    }
    return count;
}

async function _whConfirmDelete(depth, id) {
    whCloseDeleteModal();
    const colKey      = ['corredores','seccoes','prateleiras','gavetas'][depth];
    const levelKey    = WH_LEVELS[depth];

    // Apagar em cascata localmente
    if (depth <= 0) { // corredor — apaga secções, prateleiras, gavetas dentro
        const sIds = Object.keys(_whData.seccoes||{}).filter(s => _whData.seccoes[s].corredor_id === id);
        sIds.forEach(sid => {
            const pIds = Object.keys(_whData.prateleiras||{}).filter(p => _whData.prateleiras[p].seccao_id === sid);
            pIds.forEach(pid => {
                Object.keys(_whData.gavetas||{}).filter(g => _whData.gavetas[g].prateleira_id === pid)
                    .forEach(gid => { delete _whData.gavetas[gid]; _whDeletePath(`gavetas/${gid}`); });
                delete _whData.prateleiras[pid]; _whDeletePath(`prateleiras/${pid}`);
            });
            delete _whData.seccoes[sid]; _whDeletePath(`seccoes/${sid}`);
        });
    } else if (depth === 1) {
        const pIds = Object.keys(_whData.prateleiras||{}).filter(p => _whData.prateleiras[p].seccao_id === id);
        pIds.forEach(pid => {
            Object.keys(_whData.gavetas||{}).filter(g => _whData.gavetas[g].prateleira_id === pid)
                .forEach(gid => { delete _whData.gavetas[gid]; _whDeletePath(`gavetas/${gid}`); });
            delete _whData.prateleiras[pid]; _whDeletePath(`prateleiras/${pid}`);
        });
    } else if (depth === 2) {
        Object.keys(_whData.gavetas||{}).filter(g => _whData.gavetas[g].prateleira_id === id)
            .forEach(gid => { delete _whData.gavetas[gid]; _whDeletePath(`gavetas/${gid}`); });
    }

    delete _whData[colKey][id];
    await _whDeletePath(`${colKey}/${id}`);

    // Se estava navegado para dentro, volta um nível
    if (_whNavStack.some(n => n.id === id)) {
        whNavTo(_whNavStack.findIndex(n => n.id === id));
    } else {
        whRender();
    }
    showToast(`${WH_LEVEL_LABELS[levelKey].sing} apagada`);
}

function whCloseDeleteModal() {
    document.getElementById('wh-delete-modal')?.classList.remove('active');
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
            if (searchClear) searchClear.classList.toggle('hidden', !val);
            // Remove zero-stock filter badge if user types
            if (val) { _zeroFilterActive = false; const b = document.getElementById('zero-filter-badge'); if (b) b.remove(); }
            debounceTimer = setTimeout(() => renderList(val), 300);
        };
    }

    // Pesquisa de ferramentas
    document.getElementById('inp-tools-search')?.addEventListener('input', e => {
        _toolsFilter = e.target.value.trim();
        renderTools();
    });

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
            { id: 'icon-picker-modal',  close: closeIconPicker },
            { id: 'dup-modal',          close: closeDupModal },
            { id: 'inv-modal',          close: closeInventory },
            { id: 'wh-edit-modal',      close: whCloseEditModal },
            { id: 'wh-delete-modal',    close: whCloseDeleteModal },
            { id: 'zone-modal',         close: closeZoneModal },
            { id: 'timeline-modal',     close: closeToolTimeline },
            { id: 'edit-tool-modal',    close: closeEditToolModal },
        ];
        for (const { id, close } of modals) {
            if (document.getElementById(id)?.classList.contains('active')) { close(); break; }
        }
        // Fecha menus de unidade se estiverem abertos
        const anyUnitOpen = UNIT_PREFIXES.some(p =>
            document.getElementById(`${p}-unit-menu`)?.classList.contains('open')
        );
        if (anyUnitOpen) {
            _closeAllUnitMenus();
            document.removeEventListener('click', _onOutsideUnitClick);
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

    // Regista Background Sync para sincronizar quando o SW acordar (app fechada)
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => {
            // Sempre que há itens na fila, regista sync tag
            const origQueueAdd = queueAdd;
            // Patch queueAdd to also register sync
            window._registerBackgroundSync = () => {
                sw.sync.register('hiperfrio-sync').catch(() => {});
            };
        }).catch(() => {});
    }

    // Recebe mensagem do Service Worker para sincronizar (Background Sync — ponto 25)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', async e => {
            if (e.data?.type === 'SYNC_QUEUE') {
                await syncQueue();
            }
        });
    }

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
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase().replace(/\s+/g, ''),
            quantidade:  parseFloat(document.getElementById('inp-qtd').value) || 0,
            unidade:     document.getElementById('inp-unidade').value || 'un',
            notas:       document.getElementById('inp-notas').value.trim(),
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
        // PONTO 6: normaliza zona — remove espaços internos e padroniza formato
        const rawZona = document.getElementById('bulk-loc').value.trim().toUpperCase().replace(/\s+/g, '');
        const payload = {
            localizacao: rawZona,
            codigo,
            nome:        document.getElementById('bulk-nome').value.trim(),
            quantidade:  parseFloat(document.getElementById('bulk-qtd').value) || 0,
            unidade:     document.getElementById('bulk-unidade').value || 'un',
            notas:       document.getElementById('bulk-notas').value.trim(),
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
                // PONTO 16: guarda zona no histórico de zonas usadas
                _saveZoneToHistory(rawZona);
                _bulkCount++;
                _updateBulkCounter();
                showToast(`${payload.codigo} adicionado ao lote!`);
                document.getElementById('bulk-codigo').value = '';
                document.getElementById('bulk-nome').value   = '';
                document.getElementById('bulk-qtd').value    = '1';
                document.getElementById('bulk-notas').value  = '';
                // Unidade mantém-se propositadamente — catalogação em série do mesmo tipo
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
            localizacao: document.getElementById('edit-loc').value.trim().toUpperCase().replace(/\s+/g, ''),
            quantidade:  parseFloat(document.getElementById('edit-qtd').value) || 0,
            unidade:     document.getElementById('edit-unidade').value || 'un',
            notas:       document.getElementById('edit-notas').value.trim(),
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
    // Form: Armazém — guardar nó
    document.getElementById('form-wh-edit')?.addEventListener('submit', whSaveNode);

    // Form: Editar ferramenta
    document.getElementById('form-edit-tool')?.addEventListener('submit', async e => {
        e.preventDefault();
        await saveEditTool();
    });

    document.getElementById('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome    = document.getElementById('reg-tool-name').value.trim();
        const icone   = document.getElementById('reg-tool-icon').value || '🪛';
        const payload = { nome, icone, status:'disponivel' };
        try {
            const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.ferramentas.data[r.name] = payload; }
            else { cache.ferramentas.data[`_tmp_${Date.now()}`] = payload; }
            document.getElementById('reg-tool-name').value = '';
            // Reset icon to default after save
            document.getElementById('reg-tool-icon').value = '🪛';
            document.getElementById('reg-tool-icon-btn').textContent = '🪛';
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

// =============================================
// MAPA DO ARMAZÉM
// =============================================
const MAP_IMAGE_KEY  = 'hiperfrio-map-image';   // localStorage (base64)
const MAP_ZONES_URL  = `${BASE_URL}/config/mapZones.json`;
const ZONE_COLORS    = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
                         '#06b6d4','#84cc16','#f97316','#ec4899','#14b8a6'];

let _mapZones       = {};      // { id: { label, prefix, x, y, w, h, color, parent } }
let _mapZonesLoaded = false;
let _mapEditMode    = false;
let _mapTool        = 'zone';  // 'zone' | 'pointer'
let _mapDrawing     = false;
let _mapDrawStart   = null;    // { x%, y% }
let _mapNavStack    = [];      // breadcrumb stack of zone IDs
let _mapPendingZone = null;    // zone being drawn before modal
let _mapSelectedColor = ZONE_COLORS[0];

// ── Dados ──────────────────────────────────────────────────────────────────

async function _mapLoadZones() {
    if (_mapZonesLoaded) return;
    try {
        const url  = await authUrl(MAP_ZONES_URL);
        const res  = await fetch(url);
        _mapZones  = res.ok ? (await res.json()) || {} : {};
    } catch { _mapZones = {}; }
    _mapZonesLoaded = true;
}

async function _mapSaveZones() {
    try {
        const url = await authUrl(MAP_ZONES_URL);
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_mapZones)
        });
    } catch { showToast('Erro ao guardar zonas', 'error'); }
}

// ── Imagem ─────────────────────────────────────────────────────────────────

function mapUploadImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => {
            // Redimensiona para máx 1400px preservando ratio
            const MAX = 1400;
            let w = img.width, h = img.height;
            if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL('image/jpeg', 0.82);
            try {
                localStorage.setItem(MAP_IMAGE_KEY, compressed);
                showToast('Planta carregada!');
                renderMapView();
            } catch {
                showToast('Imagem demasiado grande. Tenta uma menor.', 'error');
            }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    input.value = ''; // reset so same file can be re-selected
}

function mapClearImage() {
    openConfirmModal({
        icon: '🗑️', title: 'Limpar planta?',
        desc: 'A imagem será removida. As zonas definidas mantêm-se.',
        onConfirm: () => {
            localStorage.removeItem(MAP_IMAGE_KEY);
            renderMapView();
        }
    });
}

// ── Render principal ────────────────────────────────────────────────────────

async function renderMapView() {
    await _mapLoadZones();

    const placeholder  = document.getElementById('map-placeholder');
    const svgWrap      = document.getElementById('map-svg-wrap');
    const mapImg       = document.getElementById('map-img');
    const editToolbar  = document.getElementById('map-editor-toolbar');
    const editToggle   = document.getElementById('map-edit-toggle');
    if (!placeholder || !svgWrap) return;

    // Toolbar visível apenas para gestores
    if (editToolbar) editToolbar.classList.toggle('hidden', !_mapEditMode);
    if (editToggle)  editToggle.textContent = _mapEditMode ? '✅ Concluir' : '✏️ Editar';

    const imgSrc = localStorage.getItem(MAP_IMAGE_KEY);

    if (!imgSrc) {
        placeholder.classList.remove('hidden');
        svgWrap.style.display = 'none';
        const sub = document.getElementById('map-placeholder-sub');
        if (sub) sub.textContent = currentRole === 'manager'
            ? 'Clica em "✏️ Editar" e depois "📁 Carregar Planta"'
            : 'Peça ao gestor para carregar a planta em modo edição';
        return;
    }

    placeholder.classList.add('hidden');
    svgWrap.style.display = 'block';
    mapImg.src = imgSrc;

    // Aguarda imagem carregar para ter dimensões correctas
    await new Promise(resolve => {
        if (mapImg.complete) resolve();
        else { mapImg.onload = resolve; mapImg.onerror = resolve; }
    });

    _mapRenderSVG();
    _mapSetupInteraction();
    _mapUpdatePanel();
}

// ── SVG render ──────────────────────────────────────────────────────────────

function _mapRenderSVG() {
    const svg = document.getElementById('map-svg');
    if (!svg) return;
    svg.innerHTML = `<defs><filter id="zone-shadow">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.2"/>
    </filter></defs>`;

    // Determina quais zonas mostrar: filha do nível actual ou raiz
    const parentId    = _mapNavStack.length ? _mapNavStack[_mapNavStack.length - 1] : null;
    const visibleZones = Object.entries(_mapZones)
        .filter(([, z]) => (z.parent || null) === parentId);

    visibleZones.forEach(([id, zone]) => {
        const color  = zone.color || ZONE_COLORS[0];
        const hasKids = Object.values(_mapZones).some(z => z.parent === id);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'map-zone-group');
        g.style.cursor = 'pointer';

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x',      `${zone.x * 100}%`);
        rect.setAttribute('y',      `${zone.y * 100}%`);
        rect.setAttribute('width',  `${zone.w * 100}%`);
        rect.setAttribute('height', `${zone.h * 100}%`);
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill',   color + '2a');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '2');

        // Label background pill
        const labelH = 22, labelPad = 8;
        const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        fo.setAttribute('x',      `${zone.x * 100}%`);
        fo.setAttribute('y',      `${zone.y * 100}%`);
        fo.setAttribute('width',  `${zone.w * 100}%`);
        fo.setAttribute('height', `${labelH + 4}px`);
        fo.setAttribute('class', 'zone-fo');
        const div = document.createElement('div');
        div.className   = 'zone-label-pill';
        div.style.background = color;
        div.textContent = (hasKids ? '📁 ' : '📍 ') + (zone.label || zone.prefix || id);
        fo.appendChild(div);

        g.appendChild(rect);
        g.appendChild(fo);

        // Clique em modo visualização
        g.addEventListener('click', e => {
            e.stopPropagation();
            if (_mapEditMode && _mapTool === 'pointer') {
                _mapOpenZoneEditor(id, zone);
                return;
            }
            if (!_mapEditMode) {
                if (hasKids) {
                    _mapNavStack.push(id);
                    _mapUpdateBreadcrumb();
                    _mapRenderSVG();
                    mapClosePanel();
                } else {
                    _mapShowZoneProducts(id, zone);
                }
            }
        });

        svg.appendChild(g);
    });
}

// ── Navegação hierárquica ───────────────────────────────────────────────────

function _mapUpdateBreadcrumb() {
    const bc = document.getElementById('map-breadcrumb');
    if (!bc) return;
    bc.innerHTML = '<span class="map-bc-item map-bc-root" onclick="mapNavRoot()">🏭 Armazém</span>';
    _mapNavStack.forEach((id, i) => {
        const z = _mapZones[id];
        const sep = document.createElement('span');
        sep.className   = 'map-bc-sep';
        sep.textContent = '›';
        const item = document.createElement('span');
        item.className   = 'map-bc-item';
        item.textContent = z?.label || id;
        const idx = i;
        item.onclick = () => {
            _mapNavStack = _mapNavStack.slice(0, idx + 1);
            _mapUpdateBreadcrumb();
            _mapRenderSVG();
            mapClosePanel();
        };
        bc.appendChild(sep);
        bc.appendChild(item);
    });
}

function mapNavRoot() {
    _mapNavStack = [];
    _mapUpdateBreadcrumb();
    _mapRenderSVG();
    mapClosePanel();
}

// ── Painel de produtos ─────────────────────────────────────────────────────

function _mapShowZoneProducts(zoneId, zone) {
    const panel = document.getElementById('map-product-panel');
    const list  = document.getElementById('map-panel-list');
    const title = document.getElementById('map-panel-title');
    if (!panel || !list) return;

    title.textContent = `${zone.label || zone.prefix} — produtos`;

    const stock   = cache.stock.data || {};
    const prefix  = (zone.prefix || '').toUpperCase();
    const matches = Object.entries(stock).filter(([, item]) => {
        const loc = (item.localizacao || '').toUpperCase();
        return prefix && (loc === prefix || loc.startsWith(prefix + '-') || loc.startsWith(prefix));
    });

    list.innerHTML = '';
    if (matches.length === 0) {
        list.innerHTML = '<div class="empty-msg" style="padding:14px">Nenhum produto nesta zona.<br>Verifica se o código de localização coincide.</div>';
    } else {
        matches.forEach(([id, item]) => {
            const row  = document.createElement('div');
            row.className = 'map-product-row';
            const qty = item.quantidade || 0;

            const left = document.createElement('div');
            left.className = 'map-prod-left';

            const ref = document.createElement('div');
            ref.className   = 'map-prod-ref';
            ref.textContent = (item.codigo || '').toUpperCase();

            const name = document.createElement('div');
            name.className   = 'map-prod-name';
            name.textContent = item.nome || '';

            const loc = document.createElement('div');
            loc.className   = 'map-prod-loc';
            loc.textContent = `📍 ${(item.localizacao || '').toUpperCase()}`;

            left.appendChild(ref);
            left.appendChild(name);
            left.appendChild(loc);

            const qtyEl = document.createElement('div');
            qtyEl.className = `map-prod-qty${qty === 0 ? ' is-zero' : ''}`;
            qtyEl.textContent = fmtQty(qty, item.unidade);

            row.appendChild(left);
            row.appendChild(qtyEl);
            list.appendChild(row);
        });
    }

    panel.classList.remove('hidden');
}

function mapClosePanel() {
    document.getElementById('map-product-panel')?.classList.add('hidden');
}

function _mapUpdatePanel() {
    // Se já havia um painel aberto, fecha ao re-renderizar
    mapClosePanel();
}

// ── Modo edição — desenhar zonas ────────────────────────────────────────────

function mapToggleEdit() {
    _mapEditMode = !_mapEditMode;
    _mapTool     = 'zone';
    renderMapView();
}

function mapSetTool(tool) {
    _mapTool = tool;
    document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`map-tool-${tool}`)?.classList.add('active');
}

function _mapGetRelativeCoords(e, el) {
    const rect = el.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
        x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height))
    };
}

function _mapSetupInteraction() {
    const wrap    = document.getElementById('map-svg-wrap');
    const preview = document.getElementById('map-draw-preview');
    if (!wrap) return;

    // Remove old listeners by cloning
    const newWrap = wrap.cloneNode(true);
    wrap.parentNode.replaceChild(newWrap, wrap);

    // Re-attach SVG and img refs after clone
    const svgEl  = document.getElementById('map-svg');
    const prevEl = document.getElementById('map-draw-preview');

    const onStart = e => {
        if (!_mapEditMode || _mapTool !== 'zone') return;
        e.preventDefault();
        _mapDrawing = true;
        const coords = _mapGetRelativeCoords(e, newWrap);
        _mapDrawStart = coords;
        if (prevEl) { prevEl.classList.remove('hidden'); _mapUpdatePreview(coords, coords, prevEl, newWrap); }
    };
    const onMove = e => {
        if (!_mapDrawing || !_mapDrawStart) return;
        e.preventDefault();
        const coords = _mapGetRelativeCoords(e, newWrap);
        if (prevEl) _mapUpdatePreview(_mapDrawStart, coords, prevEl, newWrap);
    };
    const onEnd = e => {
        if (!_mapDrawing || !_mapDrawStart) return;
        _mapDrawing = false;
        const coords = e.changedTouches
            ? { x: Math.max(0,Math.min(1,(e.changedTouches[0].clientX - newWrap.getBoundingClientRect().left)/newWrap.getBoundingClientRect().width)),
                y: Math.max(0,Math.min(1,(e.changedTouches[0].clientY - newWrap.getBoundingClientRect().top) /newWrap.getBoundingClientRect().height)) }
            : _mapGetRelativeCoords(e, newWrap);
        if (prevEl) prevEl.classList.add('hidden');
        const x = Math.min(_mapDrawStart.x, coords.x);
        const y = Math.min(_mapDrawStart.y, coords.y);
        const w = Math.abs(coords.x - _mapDrawStart.x);
        const wh = Math.abs(coords.y - _mapDrawStart.y);
        _mapDrawStart = null;
        if (w < 0.03 || wh < 0.03) return; // demasiado pequeno
        _mapPendingZone = { x, y, w, h: wh, color: _mapSelectedColor,
                            parent: _mapNavStack.length ? _mapNavStack[_mapNavStack.length-1] : null };
        _mapOpenZoneEditor(null, _mapPendingZone);
    };

    newWrap.addEventListener('mousedown',  onStart);
    newWrap.addEventListener('mousemove',  onMove);
    newWrap.addEventListener('mouseup',    onEnd);
    newWrap.addEventListener('touchstart', onStart, { passive: false });
    newWrap.addEventListener('touchmove',  onMove,  { passive: false });
    newWrap.addEventListener('touchend',   onEnd);
}

function _mapUpdatePreview(start, end, prevEl, wrap) {
    const rect  = wrap.getBoundingClientRect();
    const x = Math.min(start.x, end.x) * rect.width;
    const y = Math.min(start.y, end.y) * rect.height;
    const w = Math.abs(end.x - start.x) * rect.width;
    const h = Math.abs(end.y - start.y) * rect.height;
    prevEl.style.left   = x + 'px';
    prevEl.style.top    = y + 'px';
    prevEl.style.width  = w + 'px';
    prevEl.style.height = h + 'px';
    prevEl.style.borderColor = _mapSelectedColor;
    prevEl.style.background  = _mapSelectedColor + '22';
}

// ── Modal de zona ───────────────────────────────────────────────────────────

function _mapOpenZoneEditor(id, zone) {
    document.getElementById('zone-editing-id').value = id || '';
    document.getElementById('zone-label-input').value  = zone?.label  || '';
    document.getElementById('zone-prefix-input').value = zone?.prefix || '';
    document.getElementById('zone-modal-title').textContent = id ? 'Editar Zona' : 'Nova Zona';
    const delBtn = document.getElementById('zone-delete-btn');
    if (delBtn) delBtn.style.display = id ? 'block' : 'none';

    // Cor actual ou default
    _mapSelectedColor = zone?.color || ZONE_COLORS[0];
    _mapBuildColorPicker();

    document.getElementById('zone-modal').classList.add('active');
    focusModal('zone-modal');
    setTimeout(() => document.getElementById('zone-label-input')?.focus(), 100);
}

function _mapBuildColorPicker() {
    const el = document.getElementById('zone-color-picker');
    if (!el) return;
    el.innerHTML = '';
    ZONE_COLORS.forEach(color => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'zone-color-swatch' + (color === _mapSelectedColor ? ' active' : '');
        btn.style.background = color;
        btn.title = color;
        btn.onclick = () => {
            _mapSelectedColor = color;
            document.querySelectorAll('.zone-color-swatch').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
        el.appendChild(btn);
    });
}

function closeZoneModal() {
    document.getElementById('zone-modal').classList.remove('active');
    _mapPendingZone = null;
}

async function mapSaveZone() {
    const label  = document.getElementById('zone-label-input').value.trim();
    const prefix = document.getElementById('zone-prefix-input').value.trim().toUpperCase();
    const editId = document.getElementById('zone-editing-id').value;

    if (!label) { showToast('Nome da zona obrigatório', 'error'); return; }

    if (editId && _mapZones[editId]) {
        // Editar existente
        _mapZones[editId] = { ..._mapZones[editId], label, prefix, color: _mapSelectedColor };
    } else {
        // Nova zona
        const id = 'zone_' + Date.now();
        _mapZones[id] = { ..._mapPendingZone, label, prefix, color: _mapSelectedColor };
    }

    closeZoneModal();
    await _mapSaveZones();
    _mapRenderSVG();
    showToast('Zona guardada!');
}

async function mapDeleteZone() {
    const editId = document.getElementById('zone-editing-id').value;
    if (!editId) return;
    // Apaga também filhas
    const toDelete = [editId, ...Object.keys(_mapZones).filter(id => _mapZones[id].parent === editId)];
    toDelete.forEach(id => delete _mapZones[id]);
    closeZoneModal();
    await _mapSaveZones();
    _mapRenderSVG();
    showToast('Zona removida');
}
