// NOTA DE SEGURANÇA (#24): a apiKey do Firebase é pública por design.
// A protecção real é feita pelas Firebase Security Rules (exigem Anonymous Auth).
// Confirmar que as rules não permitem leitura/escrita sem token válido.
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

// Trocar de perfil — sem reload para ser mais rápido
function switchRole() {
    closeSwitchRoleModal();
    localStorage.removeItem(ROLE_KEY);
    currentRole = null;
    // Remove badge
    document.getElementById('role-badge')?.remove();
    // Repõe body classes
    document.body.classList.remove('worker-mode');
    // Invalida cache em memória
    Object.keys(cache).forEach(k => { cache[k].data = null; cache[k].lastFetch = 0; });
    // Para renovação de token
    clearTimeout(_tokenRenewalTimer);
    // Mostra ecrã de seleção
    document.getElementById('role-screen')?.classList.remove('hidden');
    // Esconde todas as vistas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // Reset nav activo
    document.querySelectorAll('.menu-items li, .bottom-nav-item').forEach(b => b.classList.remove('active'));
    // Volta ao stock ao próximo login
    document.getElementById('view-search')?.classList.add('active');
    document.getElementById('nav-search')?.classList.add('active');
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
    } catch (e) {
        console.warn('getPinHash offline, usando cache local:', e?.message || e);
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
        renderList(window._searchInputEl?.value || '', true);
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
// ARQUITECTURA (#18): esta função gere routing + side-effects.
// Para refactor futuro: separar em _activateView(id) e callbacks por vista.
function nav(viewId) {
    if (viewId === 'view-admin' && !checkAdminAccess()) return;

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');

    if (viewId === 'view-search') {
        renderList().then(() => { if (_zeroFilterActive) filterZeroStock(); });
        // Reset barra de pesquisa ao navegar para o stock
        document.querySelector('.search-container')?.classList.remove('search-scrolled-away');
        document.getElementById('search-peek-btn')?.classList.remove('visible');
    }
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
    // Re-setup swipe ao entrar na admin (slider pode ter sido re-renderizado)
    if (viewId === 'view-admin') { _setupAdminSwipe(); switchAdminTab(ADMIN_TABS[_adminIdx], false); }
    // Garante que o bottom nav pill está visível ao mudar de vista
    document.getElementById('bottom-nav')?.classList.remove('bnav-hidden');
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
    renderList(window._searchInputEl?.value || '', true);
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
        const _badgeTxt = document.createElement('span');
        _badgeTxt.textContent = '⚠️ A mostrar apenas produtos sem stock';
        const _badgeBtn = document.createElement('button');
        _badgeBtn.textContent = '✕ Limpar';
        _badgeBtn.onclick = clearZeroFilter;
        badge.appendChild(_badgeTxt);
        badge.appendChild(_badgeBtn);
        listEl.parentNode.insertBefore(badge, listEl);
        // Scroll para o topo e foca o badge
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => badge.classList.add('badge-pulse'), 100);
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
        // Remove "Mostrar mais" antes de filtrar — contagem pode mudar
        document.getElementById('load-more-btn')?.remove();
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
        } catch (e) {
            console.warn('changeQtd erro:', e?.message || e);
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

let _toolLongPressTimer = null; // módulo-level para evitar memory leak ao re-render

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
        // Long-press para mobile (usa variável de módulo para evitar leak ao re-render)
        div.addEventListener('touchstart', () => {
            _toolLongPressTimer = setTimeout(() => openHistoryModal(id, t.nome), 600);
        }, { passive: true });
        div.addEventListener('touchend',   () => clearTimeout(_toolLongPressTimer), { passive: true });
        div.addEventListener('touchmove',  () => clearTimeout(_toolLongPressTimer), { passive: true });
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
            // Mostra sempre há quantos dias está alocada
            const _days = t.dataEntrega
                ? Math.floor((Date.now() - new Date(t.dataEntrega).getTime()) / 86400000)
                : null;
            const _timeStr = _days !== null
                ? (_days === 0 ? 'hoje' : _days === 1 ? 'há 1 dia' : `há ${_days} dias`)
                : '';
            dl.textContent = `📅 ${formatDate(t.dataEntrega)}${_timeStr ? ' · ' + _timeStr : ''}`;
            sub.appendChild(w); sub.appendChild(dl);
            if (isOverdue) {
                const ovd = document.createElement('div');
                ovd.className   = 'tool-overdue-badge';
                ovd.textContent = `⏰ Alocada há ${_days} dias — verificar!`;
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
        // Verifica se excede o limite usando o cache de ferramentas (evita fetch extra)
        const histCache = cache.ferramentas.data?.[toolId]?.historico;
        const histCount = histCache ? Object.keys(histCache).length : 0;
        if (histCount >= HISTORY_MAX) {
            // Faz fetch apenas quando necessário para obter os IDs ordenados
            try {
                const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
                const res  = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (data && Object.keys(data).length > HISTORY_MAX) {
                        const sorted = Object.entries(data).sort((a, b) => new Date(a[1].data) - new Date(b[1].data));
                        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico/${sorted[0][0]}.json`, { method: 'DELETE' });
                    }
                }
            } catch (e) { console.warn('Limpeza histórico:', e?.message || e); }
        }
    } catch (e) { console.warn('addToolHistoryEvent:', e?.message || e); /* best-effort */ }
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
    } catch (e) {
        console.warn('returnTool erro:', e?.message || e);
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
// SEGURANÇA (#25): PIN de 4 dígitos (10 000 combinações + lockout de 5 tentativas).
// Para maior segurança considera alterar para 6 dígitos: mudar >= 4 para >= 6
// e === 4 para === 6 aqui e em pinSetupKey.
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
function removePin() {
    openConfirmModal({
        icon: '⚠️',
        title: 'Remover PIN?',
        desc: 'Sem PIN, qualquer pessoa poderá aceder como Gestor. Tens a certeza?',
        onConfirm: async () => {
            await deletePinHash();
            localStorage.removeItem('hiperfrio-pin');
            closePinSetupModal(); updatePinStatusUI(); showToast('PIN removido');
        }
    });
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
    const btn = document.getElementById('export-csv-btn');
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
    const btn = document.getElementById('export-hist-btn');
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

// =============================================
// ADMIN — slider com swipe entre tabs
// =============================================
const ADMIN_TABS  = ['workers', 'tools', 'settings'];
let   _adminIdx   = 0;   // índice activo

function switchAdminTab(tab, animate = true) {
    const idx = ADMIN_TABS.indexOf(tab);
    if (idx < 0) return;
    _adminIdx = idx;

    // Actualiza botões
    document.querySelectorAll('.admin-tab').forEach((t, i) =>
        t.classList.toggle('active', i === idx)
    );

    // Move slider (sem .active nos painéis — visibilidade é por transform)
    const slider = document.getElementById('admin-slider');
    if (slider) {
        if (!animate) slider.classList.add('is-dragging');
        // Cada painel ocupa 1/3 do slider (width:300%)
        // translateX(-idx * 33.333%) move para o painel certo
        slider.style.transform = `translateX(-${idx * 33.3333}%)`;
        if (!animate) {
            // força reflow para garantir sem transição no reset
            void slider.offsetWidth;
            slider.classList.remove('is-dragging');
        }
    }
}

// ── Swipe detector no slider wrap ────────────────────────────────────────────
function _setupAdminSwipe() {
    const wrap   = document.getElementById('admin-slider-wrap');
    const slider = document.getElementById('admin-slider');
    if (!wrap || !slider) return;

    let startX = 0, startY = 0;
    let deltaX = 0;
    let intent = null;   // 'h' | 'v' | null — decidido após 10px de movimento
    let active = false;

    const INTENT_THRESHOLD = 10;   // px para decidir h vs v
    const SWIPE_THRESHOLD  = 50;   // px para confirmar mudança de tab
    const RESIST = 0.25;           // resistência nos extremos

    wrap.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaX = 0;
        intent = null;
        active = true;
    }, { passive: true });

    wrap.addEventListener('touchmove', e => {
        if (!active || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        // Decide intenção na primeira vez que passa o threshold
        if (intent === null && (Math.abs(dx) > INTENT_THRESHOLD || Math.abs(dy) > INTENT_THRESHOLD)) {
            intent = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        if (intent !== 'h') return;   // scroll vertical — não interferir

        e.preventDefault();   // bloqueia scroll vertical durante swipe h
        deltaX = dx;

        // Resistência nos extremos (primeiro/último painel)
        let extra = deltaX;
        if ((_adminIdx === 0 && deltaX > 0) || (_adminIdx === ADMIN_TABS.length - 1 && deltaX < 0)) {
            extra = deltaX * RESIST;
        }

        // Segue o dedo sem transição
        slider.classList.add('is-dragging');
        const base = -_adminIdx * 33.3333;
        // extra em percentagem relativa ao wrapper (slider tem width:300%)
        const extraPct = (extra / wrap.offsetWidth) * 100 / 3;
        slider.style.transform = `translateX(calc(${base}% + ${extra}px))`;
    }, { passive: false });

    const onEnd = () => {
        if (!active || intent !== 'h') { active = false; intent = null; return; }
        active = false;
        slider.classList.remove('is-dragging');

        if (deltaX < -SWIPE_THRESHOLD && _adminIdx < ADMIN_TABS.length - 1) {
            switchAdminTab(ADMIN_TABS[_adminIdx + 1]);
        } else if (deltaX > SWIPE_THRESHOLD && _adminIdx > 0) {
            switchAdminTab(ADMIN_TABS[_adminIdx - 1]);
        } else {
            // Volta à posição sem swipe suficiente
            switchAdminTab(ADMIN_TABS[_adminIdx]);
        }
        deltaX = 0;
        intent = null;
    };

    wrap.addEventListener('touchend',    onEnd, { passive: true });
    wrap.addEventListener('touchcancel', onEnd, { passive: true });
}

// =============================================
// TEMA
// =============================================
// =============================================
// TEMAS — claro / escuro / liquid glass
// =============================================
function _applyTheme(theme) {
    document.body.classList.remove('dark-mode', 'glass-mode');
    if (theme === 'dark')  document.body.classList.add('dark-mode');
    if (theme === 'glass') document.body.classList.add('glass-mode');

    // Sync toggle dark/light
    const t = document.getElementById('theme-toggle-admin');
    if (t) t.checked = (theme === 'dark');

    // Sync glass button indicator
    const gBtn = document.getElementById('glass-theme-btn');
    if (gBtn) gBtn.dataset.active = (theme === 'glass') ? '1' : '0';

    // Barra de status Android — meta theme-color dinâmica
    const themeColors = {
        light: '#2563eb',
        dark:  '#0f172a',
        glass: '#0d0a20',   // mesma cor do fundo aurora do glass
    };
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.name = 'theme-color';
        document.head.appendChild(metaTheme);
    }
    metaTheme.content = themeColors[theme] || themeColors.light;

    // Liga/desliga o comportamento de scroll da barra de pesquisa
    _setupSearchScrollBehaviour(theme === 'glass');
    // Scroll hide/show do pill — activo em todos os temas
    _setupBottomNavScrollBehaviour(true);
}

// ── Barra de pesquisa flutuante — desaparece ao fazer scroll (só glass) ──────
let _searchScrollCleanup = null;

function _setupSearchScrollBehaviour(enable) {
    // Remove listener anterior se existir
    if (_searchScrollCleanup) { _searchScrollCleanup(); _searchScrollCleanup = null; }

    const container  = document.querySelector('.search-container');
    if (!container) return;

    // Garante que o peek btn existe (criado uma vez, reutilizado)
    let peekBtn = document.getElementById('search-peek-btn');
    if (!peekBtn) {
        peekBtn = document.createElement('button');
        peekBtn.id        = 'search-peek-btn';
        peekBtn.className = 'search-peek-btn';
        peekBtn.innerHTML = '🔍 Pesquisar';
        peekBtn.setAttribute('aria-label', 'Mostrar barra de pesquisa');
        peekBtn.onclick   = () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        document.body.appendChild(peekBtn);
    }

    if (!enable) {
        // Temas não-glass: repõe estado normal
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

// ── Bottom nav pill flutuante — esconde ao descer, aparece ao subir ─────────
let _bnavScrollCleanup = null;

function _setupBottomNavScrollBehaviour(enable) {
    // Limpa listener anterior
    if (_bnavScrollCleanup) { _bnavScrollCleanup(); _bnavScrollCleanup = null; }

    const nav = document.getElementById('bottom-nav');
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
                // Sempre visível perto do topo
                if (_hidden) { _hidden = false; nav.classList.remove('bnav-hidden'); }
                return;
            }
            if (!_hidden && delta > SCROLL_SENSITIVITY) {
                // Desceu — esconde
                _hidden = true;
                nav.classList.add('bnav-hidden');
            } else if (_hidden && delta < -SCROLL_SENSITIVITY) {
                // Subiu — mostra
                _hidden = false;
                nav.classList.remove('bnav-hidden');
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

function toggleTheme() {
    // Cicla entre claro ↔ escuro (o toggle original)
    const current = localStorage.getItem('hiperfrio-tema') || 'light';
    const next    = (current === 'dark' || current === 'glass') ? 'light' : 'dark';
    localStorage.setItem('hiperfrio-tema', next);
    _applyTheme(next);
}

function toggleGlassTheme() {
    const current = localStorage.getItem('hiperfrio-tema') || 'light';
    const next    = current === 'glass' ? 'light' : 'glass';
    localStorage.setItem('hiperfrio-tema', next);
    _applyTheme(next);
    // Sincroniza o toggle dark/light (glass desactiva-o)
    const t = document.getElementById('theme-toggle-admin');
    if (t) t.checked = false;
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
// Fonte única de verdade para unidades — adicionar aqui para afectar toda a app
const UNITS = [
    { value: 'un', label: 'Unidade',     short: 'Unidade' },
    { value: 'L',  label: 'Litros (L)',  short: 'Litros'  },
    { value: 'm',  label: 'Metros (m)',  short: 'm'       },
    { value: 'm2', label: 'Metros² (m²)',short: 'm²'      },
];
// Mapas derivados (mantidos para compatibilidade interna)
const UNIT_LABELS   = Object.fromEntries(UNITS.map(u => [u.value, u.label]));
const UNIT_SHORT    = Object.fromEntries(UNITS.map(u => [u.value, u.short]));
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
// INVENTÁRIO GUIADO — v2
// Pontos: filtro por zona, revisão, retoma, stats, Excel, email
// =============================================

const INV_RESUME_KEY = 'hiperfrio-inv-resume';

// Estado da sessão de inventário
let _invItems     = [];        // produtos a percorrer
let _invIdx       = 0;         // índice actual
let _invChanges   = {};        // { id: newQty } — confirmados
let _invSkipped   = new Set(); // ids saltados
let _invOptions   = { zones: null, skipZeros: false }; // null = todas as zonas
let _invLastData  = null;      // snapshot dos dados no início (para o Excel)

// ── PASSO 0: Abrir configuração ────────────────────────────────────────────
async function startInventory() {
    const data = await fetchCollection('stock', true);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para inventariar', 'error'); return;
    }

    // Verifica se existe sessão guardada para retomar
    const saved = _invLoadResume();
    if (saved) {
        openConfirmModal({
            icon: '💾',
            title: 'Retomar inventário?',
            desc: `Tens um inventário em curso (${saved.idx + 1}/${saved.items.length} produtos). Continuar onde ficaste?`,
            onConfirm: () => _resumeInventory(saved),
        });
        // Adiciona botão "Começar novo" ao modal confirm
        setTimeout(() => {
            const okBtn = document.getElementById('confirm-modal-ok');
            if (!okBtn) return;
            let newBtn = document.getElementById('inv-resume-new-btn');
            if (!newBtn) {
                newBtn = document.createElement('button');
                newBtn.id        = 'inv-resume-new-btn';
                newBtn.className = 'btn-cancel';
                newBtn.style.cssText = 'width:100%;margin-top:6px;color:var(--text-muted)';
                newBtn.textContent = 'Começar novo inventário';
                newBtn.onclick = () => {
                    closeConfirmModal();
                    _invClearResume();
                    _openInvSetup(data);
                };
                okBtn.parentNode.insertBefore(newBtn, okBtn.nextSibling);
            }
        }, 60);
        return;
    }

    _openInvSetup(data);
}

function _openInvSetup(data) {
    // Extrai zonas únicas ordenadas
    const zones = [...new Set(
        Object.values(data)
            .filter(p => !String(p.codigo||'').startsWith('_tmp_'))
            .map(p => (p.localizacao||'').trim().toUpperCase())
            .filter(Boolean)
    )].sort((a,b) => a.localeCompare(b,'pt'));

    const container = document.getElementById('inv-setup-zones');
    container.innerHTML = '';

    if (zones.length === 0) {
        container.innerHTML = '<p class="modal-desc" style="margin:0">Todos os produtos serão inventariados (sem zonas definidas).</p>';
    } else {
        zones.forEach(zone => {
            const chip = document.createElement('button');
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

    document.getElementById('inv-skip-zeros').checked = false;
    _updateInvSetupBtn();
    document.getElementById('inv-setup-modal').classList.add('active');
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
    document.getElementById('inv-setup-modal').classList.remove('active');
}

async function invSetupStart() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const activeZones = chips.length === 0
        ? null
        : [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.zone);

    if (activeZones && activeZones.length === 0) return;

    const skipZeros = document.getElementById('inv-skip-zeros').checked;
    closeInvSetup();
    await _startInvWithOptions(activeZones, skipZeros);
}

// ── PASSO 1: Correr o inventário ──────────────────────────────────────────
async function _startInvWithOptions(zones, skipZeros) {
    const data = cache.stock.data;
    if (!data) return;
    _invLastData = data;

    const allChips  = document.querySelectorAll('.inv-zone-chip');
    const allZones  = allChips.length === 0 || zones === null
        || zones.length === document.querySelectorAll('.inv-zone-chip').length;

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

    document.getElementById('inv-modal').classList.add('active');
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
    _invLastData = cache.stock.data;
    document.getElementById('inv-modal').classList.add('active');
    focusModal('inv-modal');
    _renderInvStep();
    showToast(`A retomar — produto ${_invIdx + 1} de ${_invItems.length}`);
}

// ── Render do passo actual ────────────────────────────────────────────────
function _renderInvStep() {
    const total      = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    document.getElementById('inv-progress-text').textContent = `${_invIdx + 1} / ${total}`;
    document.getElementById('inv-progress-bar').style.width  = `${Math.round((_invIdx / total) * 100)}%`;

    const zona = (item.localizacao||'').trim().toUpperCase();
    document.getElementById('inv-local').textContent = zona ? `📍 ${zona}` : '📍 SEM LOCAL';
    document.getElementById('inv-ref').textContent   = item.codigo  || '';
    document.getElementById('inv-nome').textContent  = item.nome    || '';
    document.getElementById('inv-unidade').textContent =
        item.unidade && item.unidade !== 'un' ? item.unidade : '';

    // Badge de zona filtrada
    const badge = document.getElementById('inv-zone-badge');
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
    const qtyInput   = document.getElementById('inv-qtd');
    qtyInput.value   = currentVal;
    qtyInput.focus();
    qtyInput.select();

    // Mostra a quantidade original do sistema como referência
    const origEl = document.getElementById('inv-orig-qty');
    if (origEl) {
        const orig = item.quantidade || 0;
        origEl.textContent = `Sistema: ${fmtQty(orig, item.unidade)}`;
        origEl.className   = 'inv-orig-qty' + (_invChanges[id] !== undefined && _invChanges[id] !== orig ? ' inv-orig-changed' : '');
    }

    document.getElementById('inv-prev-btn').disabled = _invIdx === 0;
    _invSaveResume();
}

function invQtyDelta(delta) {
    const el = document.getElementById('inv-qtd');
    if (!el) return;
    el.value = Math.max(0, (parseFloat(el.value) || 0) + delta);
    el.focus();
}

function invConfirm() {
    const [id] = _invItems[_invIdx] || [];
    if (!id) return;
    const val = parseFloat(document.getElementById('inv-qtd').value);
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
    document.getElementById('inv-modal').classList.remove('active');
    // Progresso guardado — não apaga para possível retoma
}

// ── PASSO 2: Revisão antes de guardar ────────────────────────────────────
function _finishInventory() {
    document.getElementById('inv-modal').classList.remove('active');
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

    const descEl = document.getElementById('inv-review-desc');
    descEl.textContent = changed.length === 0
        ? `${confirmed} produto${confirmed !== 1?'s':''} confirmado${confirmed !== 1?'s':''} — sem diferenças de quantidade.`
        : `${changed.length} diferença${changed.length !== 1?'s':''} encontrada${changed.length !== 1?'s':''}. Revê e confirma antes de guardar.`;

    const listEl = document.getElementById('inv-review-list');
    listEl.innerHTML = '';

    if (changed.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Tudo conforme ✓</div>';
    } else {
        changed.forEach(([id, newQty]) => {
            const item   = data[id] || {};
            const oldQty = item.quantidade || 0;
            const diff   = newQty - oldQty;
            const row    = document.createElement('label');
            row.className = 'inv-review-row';

            const cb  = document.createElement('input');
            cb.type   = 'checkbox';
            cb.checked = true;
            cb.dataset.id = id;
            cb.className  = 'inv-review-cb';

            const info = document.createElement('div');
            info.className = 'inv-review-info';

            const nome = document.createElement('span');
            nome.className   = 'inv-review-nome';
            nome.textContent = item.nome || id;

            const qty = document.createElement('span');
            qty.className = 'inv-review-qty';
            const sign = diff > 0 ? '+' : '';
            qty.innerHTML = `<span class="inv-rev-old">${fmtQty(oldQty, item.unidade)}</span>`
                + ` → <span class="inv-rev-new">${fmtQty(newQty, item.unidade)}</span>`
                + ` <span class="inv-rev-diff ${diff > 0 ? 'inv-rev-plus' : 'inv-rev-minus'}">(${sign}${fmtQty(diff, item.unidade)})</span>`;

            info.appendChild(nome);
            info.appendChild(qty);
            row.appendChild(cb);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    }

    document.getElementById('inv-review-modal').classList.add('active');
    focusModal('inv-review-modal');
}

function invReviewBack() {
    document.getElementById('inv-review-modal').classList.remove('active');
    // Reabre o inventário no último produto
    document.getElementById('inv-modal').classList.add('active');
    _invSaveResume();
}

async function invReviewConfirm() {
    document.getElementById('inv-review-modal').classList.remove('active');

    const data    = cache.stock.data || {};
    const checked = [...document.querySelectorAll('.inv-review-cb:checked')].map(cb => cb.dataset.id);

    // Estatísticas para o ecrã de resultado
    let totalAdded   = 0;
    let totalRemoved = 0;
    let savedCount   = 0;

    for (const id of checked) {
        const newQty = _invChanges[id];
        const oldQty = data[id]?.quantidade || 0;
        if (newQty === undefined) continue;
        const diff = newQty - oldQty;
        if (diff > 0) totalAdded   += diff;
        if (diff < 0) totalRemoved += Math.abs(diff);
        savedCount++;
        if (data[id]) data[id].quantidade = newQty;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: newQty })
            });
        } catch (e) { console.warn('invSave:', e?.message||e); invalidateCache('stock'); }
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

// ── PASSO 3: Resultado e exportação ──────────────────────────────────────
function _openInvResult(stats) {
    const statsEl = document.getElementById('inv-result-stats');
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
    document.getElementById('inv-result-modal').classList.add('active');
    focusModal('inv-result-modal');
}

function closeInvResult() {
    document.getElementById('inv-result-modal').classList.remove('active');
}

// ── Exportação Excel ──────────────────────────────────────────────────────
function exportInventoryExcel() {
    const data = _invLastData || cache.stock.data || {};
    const now  = new Date();
    const dateStr = now.toLocaleDateString('pt-PT');
    const timeStr = now.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

    // Sheet 1: Inventário completo
    const rows = _invItems.map(([id, item]) => {
        const newQty  = _invChanges[id];
        const origQty = item.quantidade || 0;
        const status  = _invSkipped.has(id) ? 'Saltado'
            : newQty === undefined             ? 'Não verificado'
            : newQty === origQty               ? 'Conforme'
            : newQty > origQty                 ? 'Corrigido ↑'
            :                                    'Corrigido ↓';
        return {
            'Referência':    item.codigo   || '',
            'Nome':          item.nome     || '',
            'Zona':          item.localizacao || 'SEM LOCAL',
            'Qtd Sistema':   origQty,
            'Qtd Inventário':newQty !== undefined ? newQty : origQty,
            'Diferença':     newQty !== undefined ? newQty - origQty : 0,
            'Unidade':       item.unidade === 'un' || !item.unidade ? '' : item.unidade,
            'Estado':        status,
            'Notas':         item.notas || '',
        };
    });

    // Sheet 2: Apenas diferenças
    const diffRows = rows.filter(r => r['Diferença'] !== 0);

    const wb = XLSX.utils.book_new();

    // Sheet 1
    const ws1 = XLSX.utils.json_to_sheet(rows);
    ws1['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, 'Inventário Completo');

    // Sheet 2
    if (diffRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(diffRows);
        ws2['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws2, 'Diferenças');
    }

    // Sheet 3: Resumo
    const summaryData = [
        ['Hiperfrio Stock — Relatório de Inventário', ''],
        ['Data', dateStr],
        ['Hora', timeStr],
        ['Produtos verificados', Object.keys(_invChanges).length],
        ['Produtos saltados', _invSkipped.size],
        ['Total de produtos', _invItems.length],
        ['Diferenças encontradas', diffRows.length],
        ['Unidades adicionadas', rows.reduce((s,r) => s + Math.max(0, r['Diferença']), 0)],
        ['Unidades removidas',   rows.reduce((s,r) => s + Math.abs(Math.min(0, r['Diferença'])), 0)],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(summaryData);
    ws3['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Resumo');

    const filename = `inventario-hiperfrio-${now.toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel exportado com sucesso!');
}

// ── Envio por email ───────────────────────────────────────────────────────
async function exportInventoryEmail() {
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

    const body = encodeURIComponent(
        'Inventário Hiperfrio — ' + dateStr + '\n\n'
        + 'Produtos verificados: ' + Object.keys(_invChanges).length + '/' + _invItems.length + '\n'
        + 'Diferenças encontradas: ' + diffRows.length + '\n\n'
        + (diffRows.length > 0 ? 'ALTERAÇÕES:\n' + diffRows.join('\n') + '\n\n' : 'Sem diferenças de stock.\n\n')
        + '(Ficheiro Excel em anexo — exportar com o botão "Exportar para Excel")'
    );

        const subject = encodeURIComponent(`Inventário Hiperfrio — ${dateStr}`);

    // Tenta Web Share API (Android partilha nativa com ficheiro)
    if (navigator.canShare) {
        try {
            // Gera o ficheiro para partilhar
            const wb   = _buildInventoryWorkbook();
            const blob = new Blob(
                [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            );
            const file = new File([blob], `inventario-hiperfrio-${now.toISOString().slice(0,10)}.xlsx`,
                { type: blob.type });

            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title:   `Inventário Hiperfrio — ${dateStr}`,
                    text:    `Relatório de inventário de ${dateStr}`,
                    files:   [file],
                });
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('share:', e);
        }
    }

    // Fallback: download do Excel + abre cliente de email
    exportInventoryExcel();
    setTimeout(() => {
        window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
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

// ── Persistência (retoma de sessão interrompida) ──────────────────────────
function _invSaveResume() {
    try {
        localStorage.setItem(INV_RESUME_KEY, JSON.stringify({
            idx:     _invIdx,
            items:   _invItems,
            changes: _invChanges,
            skipped: [..._invSkipped],
            options: _invOptions,
            ts:      Date.now(),
        }));
    } catch (e) { console.warn('invSaveResume:', e); }
}

function _invLoadResume() {
    try {
        const raw = localStorage.getItem(INV_RESUME_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        // Ignora sessões com mais de 24 horas
        if (!saved || Date.now() - (saved.ts||0) > 86400000) { _invClearResume(); return null; }
        if (!saved.items || saved.items.length === 0) { _invClearResume(); return null; }
        return saved;
    } catch { return null; }
}

function _invClearResume() {
    localStorage.removeItem(INV_RESUME_KEY);
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


document.addEventListener('DOMContentLoaded', () => {

    // Tema
    // Aplica tema guardado (claro / escuro / glass)
    const savedTheme = localStorage.getItem('hiperfrio-tema') || 'light';
    _applyTheme(savedTheme);
    // Setup scroll behaviours com o tema carregado (DOM já existe)
    _setupSearchScrollBehaviour(savedTheme === 'glass');
    _setupAdminSwipe();
    _setupBottomNavScrollBehaviour(true); // pill activo em todos os temas

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

    // Pesquisa com debounce — cache o elemento para evitar lookups repetidos
    const searchInput = document.getElementById('inp-search');
    const searchClear = document.getElementById('inp-search-clear');
    window._searchInputEl = searchInput; // referência global para renderList
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            const val = e.target.value;
            if (searchClear) searchClear.classList.toggle('hidden', !val);
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
            { id: 'worker-modal',       close: closeModal },
            { id: 'pin-modal',          close: closePinModal },
            { id: 'pin-setup-modal',    close: closePinSetupModal },
            { id: 'delete-modal',       close: closeDeleteModal },
            { id: 'edit-modal',         close: closeEditModal },
            { id: 'confirm-modal',      close: closeConfirmModal },
            { id: 'switch-role-modal',  close: closeSwitchRoleModal },
            { id: 'history-modal',      close: closeHistoryModal },
            { id: 'icon-picker-modal',  close: closeIconPicker },
            { id: 'dup-modal',          close: closeDupModal },
            { id: 'inv-setup-modal',    close: closeInvSetup },
            { id: 'inv-modal',          close: closeInventory },
            { id: 'inv-review-modal',   close: invReviewBack },
            { id: 'inv-result-modal',   close: closeInvResult },
            { id: 'timeline-modal',     close: closeToolTimeline },
            { id: 'edit-tool-modal',    close: closeEditToolModal },
        ];
        for (const { id, close } of modals) {
            if (document.getElementById(id)?.classList.contains('active')) { close(); break; }
        }
        const anyUnitOpen = UNIT_PREFIXES.some(p =>
            document.getElementById(`${p}-unit-menu`)?.classList.contains('open')
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
        renderList(window._searchInputEl?.value || '', true);
        renderDashboard();
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'DELETE' });
        } catch (e) {
            console.warn('deleteProduct erro:', e?.message || e);
            cache.stock.data[id] = item;
            renderList(window._searchInputEl?.value || '', true);
            renderDashboard();
            showToast('Erro ao apagar produto','error');
        }
    };

    // Form: Novo Produto
    document.getElementById('form-add')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = document.getElementById('inp-codigo').value.trim().toUpperCase();
        const payload = {
            nome:        document.getElementById('inp-nome').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat(document.getElementById('inp-qtd').value) || 0,
            unidade:     document.getElementById('inp-unidade').value || 'un',
            notas:       document.getElementById('inp-notas')?.value.trim() || '',
            codigo,
        };
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(DB_URL, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
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
        const zona   = document.getElementById('bulk-loc').value.trim().replace(/\s+/g,'').toUpperCase();
        const payload = {
            localizacao: zona,
            codigo,
            nome:       document.getElementById('bulk-nome').value.trim(),
            quantidade: parseFloat(document.getElementById('bulk-qtd').value) || 0,
            unidade:    document.getElementById('bulk-unidade').value || 'un',
            notas:      document.getElementById('bulk-notas')?.value.trim() || '',
        };
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(DB_URL, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
                _bulkCount++;
                _updateBulkCounter();
                _saveZoneToHistory(zona);
                showToast(`${payload.codigo} adicionado ao lote!`);
                document.getElementById('bulk-codigo').value = '';
                document.getElementById('bulk-nome').value   = '';
                document.getElementById('bulk-qtd').value    = '1';
                document.getElementById('bulk-notas').value  = '';
                document.getElementById('bulk-codigo').focus();
            } catch { invalidateCache('stock'); showToast('Erro ao adicionar ao lote','error'); }
            finally { btn.disabled = false; }
        };
        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Editar Produto
    document.getElementById('form-edit')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id  = document.getElementById('edit-id').value;
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        const updated = {
            codigo:      document.getElementById('edit-codigo').value.trim().toUpperCase(),
            nome:        document.getElementById('edit-nome').value.trim(),
            localizacao: document.getElementById('edit-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat(document.getElementById('edit-qtd').value) || 0,
            unidade:     document.getElementById('edit-unidade').value || 'un',
            notas:       document.getElementById('edit-notas')?.value.trim() || '',
        };
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        btn.textContent = 'A guardar...';
        closeEditModal();
        renderList(window._searchInputEl?.value || '', true);
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'PATCH', body:JSON.stringify(updated) });
            showToast('Produto atualizado!');
        } catch (e) { console.warn('editProduct:', e?.message||e); invalidateCache('stock'); showToast('Erro ao guardar alterações','error'); }
        finally { btn.disabled = false; btn.textContent = 'Guardar Alterações'; }
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

    // Form: Registar Ferramenta
    document.getElementById('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome  = document.getElementById('reg-tool-name').value.trim();
        const icone = document.getElementById('reg-tool-icon').value || '🪛';
        const payload = { nome, icone, status:'disponivel' };
        try {
            const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.ferramentas.data[r.name] = payload; }
            else { cache.ferramentas.data[`_tmp_${Date.now()}`] = payload; }
            document.getElementById('reg-tool-name').value = '';
            document.getElementById('reg-tool-icon').value = '🪛';
            document.getElementById('reg-tool-icon-btn').textContent = '🪛';
            renderAdminTools(); showToast('Ferramenta registada');
        } catch { invalidateCache('ferramentas'); showToast('Erro ao registar ferramenta','error'); }
    });

    // Form: Editar Ferramenta
    document.getElementById('form-edit-tool')?.addEventListener('submit', async e => {
        e.preventDefault();
        await saveEditTool();
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
