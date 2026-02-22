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
// PERFIL — Funcionário vs Gestor
// =============================================
const ROLE_KEY    = 'hiperfrio-role';   // 'worker' | 'manager'
let   currentRole = null;               // definido no arranque

// Aplica o perfil à UI — chamado uma vez no boot
function applyRole(role) {
    currentRole = role;
    document.body.classList.toggle('worker-mode', role === 'worker');

    // Badge no header
    let badge = document.getElementById('role-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.id = 'role-badge';
        document.querySelector('header')?.appendChild(badge);
    }
    if (role === 'worker') {
        badge.textContent = '👤 FUNCIONÁRIO';
        badge.className   = 'role-badge-worker';
    } else {
        badge.textContent = '🔑 GESTOR';
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
function enterAsManager() {
    const hasPin = !!localStorage.getItem('hiperfrio-pin-hash');
    if (!hasPin) {
        // Sem PIN configurado — entra diretamente e sugere definir
        localStorage.setItem(ROLE_KEY, 'manager');
        applyRole('manager');
        bootApp();
        setTimeout(() => showToast('Recomendamos definir um PIN de Gestor nas Definições'), 1500);
    } else {
        // Tem PIN — pede verificação antes de entrar
        openPinModal('role'); // modo 'role' = ao confirmar, guarda role e faz boot
    }
}

// Trocar de perfil (botão nas Definições)
function switchRole() {
    localStorage.removeItem(ROLE_KEY);
    // Recarrega a página — forma mais limpa de repor o estado
    window.location.reload();
}

// Inicializa a app após o perfil estar definido
function bootApp() {
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
            const res = await fetch(`${BASE_URL}/${name}.json`);
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
            const res = await fetch(op.url, opts);
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
    // FIX: Content-Type em todos os pedidos com body
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (!navigator.onLine) {
        queueAdd({ method: opts.method || 'GET', url, body: opts.body || null });
        return null;
    }
    const res = await fetch(url, { ...opts, headers });
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
// STOCK — RENDER
// FIX: usa [...entries].reverse() para não mutar o cache
// FIX: qty-display.is-zero para stock a 0
// FIX: filtragem por show/hide nos cards existentes sem recriar DOM
// =============================================
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
                || String(item.codigo).toUpperCase().includes(filter.toUpperCase());
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

    // Swipe hint — só na primeira vez
    if (!filter && !localStorage.getItem('swipe-hint-seen')) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        const l = document.createElement('span'); l.textContent = '✏️ Swipe direita para editar';
        const r = document.createElement('span'); r.textContent = '🗑️ Swipe esquerda para apagar';
        hint.appendChild(l); hint.appendChild(r);
        listEl.appendChild(hint);
        localStorage.setItem('swipe-hint-seen', '1');
    }

    const filterLower = filter.toLowerCase();
    let found = 0;

    // FIX: cópia do array antes de reverter para não mutar o cache
    ;[...entries].reverse().forEach(([id, item]) => {
        const matches = !filter
            || item.nome.toLowerCase().includes(filterLower)
            || String(item.codigo).toUpperCase().includes(filter.toUpperCase());

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
        nomEl.style.cssText = 'font-size:0.9rem;font-weight:600;color:var(--text-muted);margin-bottom:12px;line-height:1.2;';
        nomEl.textContent   = item.nome || '';

        const hr = document.createElement('hr');
        hr.style.cssText = 'border:0;border-top:1px solid var(--border);margin-bottom:10px;opacity:0.5;';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        const pill = document.createElement('div');
        pill.className = 'loc-pill';
        const pinIcon = document.createElement('span');
        pinIcon.style.fontSize = '0.85rem';
        pinIcon.textContent    = '📍';
        pill.appendChild(pinIcon);
        pill.appendChild(document.createTextNode(' ' + (item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL')));

        const qtyBox = document.createElement('div');
        qtyBox.className = 'qty-pill-box';

        const btnM = document.createElement('button');
        btnM.className   = 'btn-qty';
        btnM.textContent = '−';
        btnM.onclick     = () => changeQtd(id, -1);

        const qty = item.quantidade || 0;
        const qtySpan = document.createElement('span');
        qtySpan.className   = 'qty-display' + (qty === 0 ? ' is-zero' : '');
        qtySpan.id          = `qty-${id}`;
        qtySpan.textContent = qty;

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
    await renderList(document.getElementById('inp-search')?.value || '', true);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(50);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return;

    // Actualiza cache + DOM imediatamente
    stockData[id].quantidade = newQty;
    const qtyEl = document.getElementById(`qty-${id}`);
    if (qtyEl) {
        qtyEl.textContent = newQty;
        // FIX: actualiza classe is-zero
        qtyEl.classList.toggle('is-zero', newQty === 0);
    }

    try {
        await apiFetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH', body: JSON.stringify({ quantidade: newQty })
        });
    } catch (e) {
        stockData[id].quantidade = oldQty;
        if (qtyEl) { qtyEl.textContent = oldQty; qtyEl.classList.toggle('is-zero', oldQty === 0); }
        showToast('Erro ao guardar quantidade', 'error');
    }
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
        const info = document.createElement('div');
        const nome = document.createElement('div');
        nome.style.cssText  = 'font-weight:800;font-size:0.95rem;';
        nome.textContent    = t.nome;
        const sub = document.createElement('div');
        sub.style.cssText   = 'font-size:0.75rem;margin-top:4px;font-weight:600;';
        if (isAv) {
            sub.textContent = '📦 EM ARMAZÉM';
        } else {
            const w = document.createElement('span');
            w.textContent = `👤 ${(t.colaborador||'').toUpperCase()}`;
            const dl = document.createElement('div');
            dl.style.cssText  = 'font-size:0.7rem;opacity:0.85;margin-top:2px;';
            dl.textContent    = `📅 ${formatDate(t.dataEntrega)}`;
            sub.appendChild(w); sub.appendChild(dl);
        }
        info.appendChild(nome); info.appendChild(sub);
        const arrow = document.createElement('span');
        arrow.style.fontSize = '1.1rem';
        arrow.textContent    = isAv ? '➔' : '↩';
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
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-weight:600;font-size:0.9rem;';
        lbl.textContent   = `🪛 ${t.nome}`;
        const btn = document.createElement('button');
        btn.style.cssText = 'color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;';
        btn.textContent   = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon:'🗑️', title:'Apagar ferramenta?',
            desc:`"${escapeHtml(t.nome)}" será removida permanentemente.`,
            onConfirm: () => deleteTool(id)
        });
        row.appendChild(lbl); row.appendChild(btn);
        list.appendChild(row);
    });
}

async function assignTool(worker) {
    const dataEntrega = new Date().toISOString();
    cache.ferramentas.data[toolToAllocate] = {
        ...cache.ferramentas.data[toolToAllocate], status:'alocada', colaborador:worker, dataEntrega
    };
    closeModal(); renderTools(); showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, {
            method:'PATCH', body:JSON.stringify({status:'alocada',colaborador:worker,dataEntrega})
        });
    } catch { invalidateCache('ferramentas'); showToast('Erro ao guardar.','error'); }
}

async function returnTool(id) {
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'disponivel', colaborador:'', dataEntrega:''
    };
    renderTools(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'disponivel',colaborador:'',dataEntrega:''})
        });
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
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'font-weight:600;font-size:0.9rem;';
        lbl.textContent   = `👤 ${w.nome}`;
        const btn = document.createElement('button');
        btn.style.cssText = 'color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;';
        btn.textContent   = '🗑️';
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
    const sel = document.getElementById('worker-select-list');
    sel.innerHTML = '';
    workers.forEach(w => {
        const opt = document.createElement('div');
        opt.className   = 'worker-option';
        opt.textContent = `👤 ${w.nome}`;
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
    document.getElementById('edit-tipo').value   = item.tipo || '';
    document.getElementById('edit-loc').value    = item.localizacao || '';
    document.getElementById('edit-qtd').value    = item.quantidade ?? 0;
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
    card.addEventListener('touchstart', e => _onSwipeStart(card, wrapper, id, item, e.touches[0].clientX, e.touches[0].clientY), { passive:true });
    card.addEventListener('touchmove',  e => _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY), { passive:true });
    card.addEventListener('touchend',   _onSwipeEnd);
    card.addEventListener('mousedown',  e => { _onSwipeStart(card, wrapper, id, item, e.clientX); e.preventDefault(); });
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
let pinSessionVerified = false;
let pinBuffer          = '';
let pendingAdminNav    = false;

function checkAdminAccess() {
    // Managers already verified at login — full access
    if (currentRole === 'manager') return true;
    // Legacy: non-role-based PIN check (fallback)
    const hash = localStorage.getItem('hiperfrio-pin-hash');
    if (!hash || pinSessionVerified) return true;
    pendingAdminNav = true;
    openPinModal('admin');
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
    pendingAdminNav = false; pinBuffer = '';
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
    const savedHash = localStorage.getItem('hiperfrio-pin-hash');
    const entered   = await hashPin(pinBuffer);
    if (entered === savedHash) {
        document.getElementById('pin-modal').classList.remove('active');
        if (pinMode === 'role') {
            // Entrar como Gestor a partir do ecrã de seleção
            localStorage.setItem(ROLE_KEY, 'manager');
            applyRole('manager');
            bootApp();
        } else {
            // PIN de acesso ao painel Admin (fluxo anterior)
            pinSessionVerified = true;
            if (pendingAdminNav) { pendingAdminNav = false; nav('view-admin'); }
        }
    } else {
        showPinError('pin-dots','pin-error','PIN incorreto');
        pinBuffer = '';
    }
}

let pinSetupBuffer = '', pinSetupFirstEntry = '', pinSetupStep = 'first';

function openPinSetupModal() {
    const hasPin = !!localStorage.getItem('hiperfrio-pin-hash');
    pinSetupBuffer = ''; pinSetupFirstEntry = ''; pinSetupStep = 'first';
    updatePinDots('pin-setup-dots', 0);
    document.getElementById('pin-setup-error').textContent = '';
    document.getElementById('pin-setup-title').textContent = hasPin ? 'Alterar PIN' : 'Definir PIN';
    document.getElementById('pin-setup-desc').textContent  = 'Escolhe um PIN de 4 dígitos';
    document.getElementById('pin-setup-icon').textContent  = '🔐';
    document.getElementById('pin-remove-btn').style.display = hasPin ? 'block' : 'none';
    document.getElementById('pin-setup-modal').classList.add('active');
    focusModal('pin-setup-modal');
}
function closePinSetupModal() { document.getElementById('pin-setup-modal').classList.remove('active'); }

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
            localStorage.setItem('hiperfrio-pin-hash', await hashPin(pinSetupBuffer));
            localStorage.removeItem('hiperfrio-pin'); // remove legado
            pinSessionVerified = true;
            closePinSetupModal(); updatePinStatusUI(); showToast('PIN definido!');
        } else {
            showPinError('pin-setup-dots','pin-setup-error','PINs não coincidem. Tenta novamente.');
            pinSetupBuffer = ''; pinSetupFirstEntry = ''; pinSetupStep = 'first';
            setTimeout(() => { document.getElementById('pin-setup-desc').textContent = 'Escolhe um PIN de 4 dígitos'; }, 1000);
        }
    }
}
function pinSetupDel() { pinSetupBuffer = pinSetupBuffer.slice(0,-1); updatePinDots('pin-setup-dots', pinSetupBuffer.length); }
function removePin() {
    localStorage.removeItem('hiperfrio-pin-hash');
    localStorage.removeItem('hiperfrio-pin');
    pinSessionVerified = false;
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
    const hasPin = !!localStorage.getItem('hiperfrio-pin-hash');
    const desc   = document.getElementById('pin-status-desc');
    const btn    = document.getElementById('pin-action-btn');
    if (desc) desc.textContent = hasPin ? 'PIN ativo — acesso protegido' : 'Protege o acesso à área de administração';
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
    const headers = ['Referência','Nome','Tipo','Localização','Quantidade'];
    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_tmp_')));
    const rows = Object.values(cleanData).map(item => [
        `"${(item.codigo||'').toUpperCase()}"`,
        `"${(item.nome||'').replace(/"/g,'""')}"`,
        `"${(item.tipo||'Geral').replace(/"/g,'""')}"`,
        `"${(item.localizacao||'').toUpperCase()}"`,
        item.quantidade ?? 0
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
document.addEventListener('DOMContentLoaded', () => {

    // Tema
    if (localStorage.getItem('hiperfrio-tema') === 'dark') {
        document.body.classList.add('dark-mode');
        const t = document.getElementById('theme-toggle-admin');
        if (t) t.checked = true;
    }

    // Migração PIN legado (texto simples → hash)
    const legacyPin = localStorage.getItem('hiperfrio-pin');
    if (legacyPin && !localStorage.getItem('hiperfrio-pin-hash')) {
        hashPin(legacyPin).then(h => {
            localStorage.setItem('hiperfrio-pin-hash', h);
            localStorage.removeItem('hiperfrio-pin');
        });
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
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => renderList(e.target.value), 300);
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
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'DELETE' });
        } catch {
            cache.stock.data[id] = item;
            renderList(document.getElementById('inp-search')?.value || '', true);
            showToast('Erro ao apagar produto','error');
        }
    };

    // Form: Novo Produto
    document.getElementById('form-add')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        const payload = {
            nome:        document.getElementById('inp-nome').value.trim(),
            tipo:        document.getElementById('inp-tipo').value.trim() || 'Geral',
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade:  parseInt(document.getElementById('inp-qtd').value) || 0,
            codigo:      document.getElementById('inp-codigo').value.trim().toUpperCase()
        };
        try {
            const res = await apiFetch(DB_URL, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.stock.data) cache.stock.data = {};
            if (res) {
                const r = await res.json();
                if (r?.name) cache.stock.data[r.name] = payload;
            } else {
                cache.stock.data[`_tmp_${Date.now()}`] = payload;
            }
            showToast('Produto Registado!'); nav('view-search'); e.target.reset();
        } catch { invalidateCache('stock'); showToast('Erro ao registar produto','error'); }
        finally { btn.disabled = false; }
    });

    // Form: Lote
    document.getElementById('form-bulk')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        const payload = {
            localizacao: document.getElementById('bulk-loc').value.trim().toUpperCase(),
            codigo:      document.getElementById('bulk-codigo').value.trim().toUpperCase(),
            nome:        document.getElementById('bulk-nome').value.trim(),
            quantidade:  parseInt(document.getElementById('bulk-qtd').value) || 0,
            tipo:        'Geral'
        };
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
            document.getElementById('bulk-qtd').value    = '';
            document.getElementById('bulk-codigo').focus();
        } catch { invalidateCache('stock'); showToast('Erro ao adicionar ao lote','error'); }
        finally { btn.disabled = false; }
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
            tipo:        document.getElementById('edit-tipo').value.trim() || 'Geral',
            localizacao: document.getElementById('edit-loc').value.trim().toUpperCase(),
            quantidade:  parseInt(document.getElementById('edit-qtd').value) || 0,
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
