const DB_URL   = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// =============================================
// SEGURANÇA — XSS: escapar sempre dados do user
// =============================================
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// =============================================
// SEGURANÇA — PIN: hash SHA-256 via Web Crypto
// =============================================
async function hashPin(pin) {
    const encoder = new TextEncoder();
    const data    = encoder.encode(pin + 'hiperfrio-salt');
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// =============================================
// CACHE EM MEMÓRIA
// =============================================
const CACHE_TTL = 60_000;

const cache = {
    stock:        { data: null, lastFetch: 0 },
    ferramentas:  { data: null, lastFetch: 0 },
    funcionarios: { data: null, lastFetch: 0 },
};

async function fetchCollection(name, force = false) {
    const entry   = cache[name];
    const isStale = (Date.now() - entry.lastFetch) > CACHE_TTL;
    if (!force && !isStale && entry.data !== null) return entry.data;

    try {
        const res = await fetch(`${BASE_URL}/${name}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        entry.data      = data || {};
        entry.lastFetch = Date.now();
        return entry.data;
    } catch (e) {
        console.error(`Erro ao buscar ${name}:`, e);
        showToast('Erro ao carregar dados', 'error');
        return entry.data || {};
    }
}

function invalidateCache(name) {
    cache[name].lastFetch = 0;
}

let toolToAllocate = null;

// =============================================
// UI HELPERS
// =============================================
function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    if (type === 'error') t.style.borderLeftColor = 'var(--danger)';
    // msg is always a hardcoded string from our code — safe to use textContent
    const icon = document.createElement('span');
    icon.textContent = type === 'success' ? '✅' : '❌';
    const text = document.createElement('span');
    text.textContent = msg;
    t.appendChild(icon);
    t.appendChild(text);
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function setRefreshSpinning(spinning) {
    document.getElementById('btn-refresh')?.classList.toggle('spinning', spinning);
}

// =============================================
// FILA OFFLINE — persiste em localStorage
// Cada entrada: { id, method, url, body }
// =============================================
const QUEUE_KEY = 'hiperfrio-offline-queue';

function queueLoad() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
}

function queueSave(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

// Adiciona uma operação à fila e atualiza o banner
function queueAdd(op) {
    const q = queueLoad();
    // Colapsar PATCHes repetidos ao mesmo URL (ex: +/- rápido na mesma quantidade)
    if (op.method === 'PATCH') {
        const idx = q.findIndex(o => o.method === 'PATCH' && o.url === op.url);
        if (idx !== -1) { q[idx] = op; } else { q.push(op); }
    } else {
        q.push(op);
    }
    queueSave(q);
    updateOfflineBanner();
}

// Tenta enviar toda a fila para a Firebase
async function syncQueue() {
    let q = queueLoad();
    if (q.length === 0) return;

    const failed = [];
    for (const op of q) {
        try {
            const opts = { method: op.method };
            if (op.body) opts.body = op.body;
            const res = await fetch(op.url, opts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            failed.push(op); // volta para a fila se falhar
        }
    }
    queueSave(failed);
    updateOfflineBanner();
    if (failed.length === 0 && q.length > 0) {
        showToast(`${q.length} alteração(ões) sincronizada(s)!`);
        // Força refresh do cache após sync
        invalidateCache('stock');
        invalidateCache('ferramentas');
        invalidateCache('funcionarios');
        renderList(document.getElementById('inp-search')?.value || '', true);
    }
}

// Wrapper de fetch: se offline, vai para a fila em vez de falhar
async function apiFetch(url, opts = {}) {
    if (!navigator.onLine) {
        queueAdd({ method: opts.method || 'GET', url, body: opts.body || null });
        return null; // indica que foi para a fila
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

function updateOfflineBanner() {
    const isOffline = !navigator.onLine;
    document.body.classList.toggle('is-offline', isOffline);
    const q = queueLoad();
    const countEl = document.getElementById('offline-pending-count');
    if (countEl) {
        countEl.textContent = q.length > 0 ? `${q.length} alteração(ões) pendente(s)` : '';
        countEl.style.display = q.length > 0 ? 'inline' : 'none';
    }
}

// =============================================
// MENU
// =============================================
function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay')?.classList.toggle('active');
}

// =============================================
// NAVEGAÇÃO
// FIX: active state só é atualizado DEPOIS de o acesso ser confirmado
// =============================================
function nav(viewId) {
    // PIN check antes de qualquer alteração de UI
    if (viewId === 'view-admin' && !checkAdminAccess()) return;

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');

    if (viewId === 'view-search') renderList();
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-admin')  { renderWorkers(); renderAdminTools(); }

    // Sidebar active
    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const sidebarMap = {
        'view-search': 'nav-search', 'view-tools': 'nav-tools',
        'view-register': 'nav-register', 'view-bulk': 'nav-bulk', 'view-admin': 'nav-admin'
    };
    document.getElementById(sidebarMap[viewId])?.classList.add('active');

    // Bottom nav active
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bnavMap = {
        'view-search': 'bnav-search', 'view-tools': 'bnav-tools',
        'view-register': 'bnav-register', 'view-bulk': 'bnav-bulk', 'view-admin': 'bnav-admin'
    };
    document.getElementById(bnavMap[viewId])?.classList.add('active');

    const menu = document.getElementById('side-menu');
    if (menu?.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
}

// =============================================
// STOCK — RENDER
// =============================================
async function renderList(filter = '', force = false) {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    if (!cache.stock.data) {
        listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';
    }

    const data = await fetchCollection('stock', force);
    listEl.innerHTML = '';

    const entries = Object.entries(data);
    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
        return;
    }

    // Swipe hint — só na primeira vez
    if (!filter && !localStorage.getItem('swipe-hint-seen')) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        const l = document.createElement('span');
        l.textContent = '✏️ Swipe direita para editar';
        const r = document.createElement('span');
        r.textContent = '🗑️ Swipe esquerda para apagar';
        hint.appendChild(l);
        hint.appendChild(r);
        listEl.appendChild(hint);
        localStorage.setItem('swipe-hint-seen', '1');
    }

    const filterLower = filter.toLowerCase();
    let found = 0;

    entries.reverse().forEach(([id, item]) => {
        if (filter &&
            !item.nome.toLowerCase().includes(filterLower) &&
            !String(item.codigo).toUpperCase().includes(filter.toUpperCase())) return;

        found++;
        const wrapper = document.createElement('div');
        wrapper.className = 'swipe-wrapper';

        // Backgrounds — usando textContent onde possível, sem innerHTML com dados do user
        const bgLeft  = document.createElement('div');
        bgLeft.className = 'swipe-bg swipe-bg-left';
        const iconLeft = document.createElement('span');
        iconLeft.className = 'swipe-bg-icon';
        iconLeft.textContent = '🗑️';
        bgLeft.appendChild(iconLeft);

        const bgRight = document.createElement('div');
        bgRight.className = 'swipe-bg swipe-bg-right';
        const iconRight = document.createElement('span');
        iconRight.className = 'swipe-bg-icon';
        iconRight.textContent = '✏️';
        bgRight.appendChild(iconRight);

        wrapper.appendChild(bgLeft);
        wrapper.appendChild(bgRight);

        // Card — todos os dados do user escapados via textContent ou escapeHtml
        const el = document.createElement('div');
        el.className = 'item-card';

        const refLabel = document.createElement('div');
        refLabel.className = 'ref-label';
        refLabel.textContent = 'REFERÊNCIA';

        const refValue = document.createElement('div');
        refValue.className = 'ref-value';
        refValue.textContent = String(item.codigo || '').toUpperCase();

        const nomEl = document.createElement('div');
        nomEl.style.cssText = 'font-size:0.9rem;font-weight:600;color:var(--text-muted);margin-bottom:12px;line-height:1.2;';
        nomEl.textContent = item.nome || '';

        const hr = document.createElement('hr');
        hr.style.cssText = 'border:0;border-top:1px solid var(--border);margin-bottom:10px;opacity:0.5;';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        const pill = document.createElement('div');
        pill.className = 'loc-pill';
        const pinIcon = document.createElement('span');
        pinIcon.style.fontSize = '0.85rem';
        pinIcon.textContent = '📍';
        const locText = document.createTextNode(' ' + (item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL'));
        pill.appendChild(pinIcon);
        pill.appendChild(locText);

        const qtyBox = document.createElement('div');
        qtyBox.className = 'qty-pill-box';

        const btnMinus = document.createElement('button');
        btnMinus.className = 'btn-qty';
        btnMinus.textContent = '−';
        btnMinus.onclick = () => changeQtd(id, -1);

        const qtySpan = document.createElement('span');
        qtySpan.className = 'qty-display';
        qtySpan.id = `qty-${id}`;
        qtySpan.textContent = item.quantidade || 0;

        const btnPlus = document.createElement('button');
        btnPlus.className = 'btn-qty';
        btnPlus.textContent = '+';
        btnPlus.onclick = () => changeQtd(id, 1);

        qtyBox.appendChild(btnMinus);
        qtyBox.appendChild(qtySpan);
        qtyBox.appendChild(btnPlus);

        row.appendChild(pill);
        row.appendChild(qtyBox);

        el.appendChild(refLabel);
        el.appendChild(refValue);
        el.appendChild(nomEl);
        el.appendChild(hr);
        el.appendChild(row);

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        listEl.appendChild(wrapper);
    });

    if (filter && found === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum resultado encontrado.</div>';
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

    stockData[id].quantidade = newQty;
    const qtyEl = document.getElementById(`qty-${id}`);
    if (qtyEl) qtyEl.textContent = newQty;

    try {
        const res = await apiFetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: newQty })
        });
        // null significa que foi para a fila offline — cache já está atualizado
    } catch (e) {
        stockData[id].quantidade = oldQty;
        if (qtyEl) qtyEl.textContent = oldQty;
        showToast('Erro ao guardar quantidade', 'error');
    }
}

// =============================================
// FERRAMENTAS — RENDER & MUTAÇÕES
// =============================================
function formatDate(iso) {
    if (!iso) return 'Data desconhecida';
    const d   = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderTools() {
    const list = document.getElementById('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');
    list.innerHTML = '';

    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>';
        return;
    }

    Object.entries(data).reverse().forEach(([id, t]) => {
        const isAv = t.status === 'disponivel';
        const div  = document.createElement('div');
        div.style.cssText = `padding:14px;border-radius:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;background:${isAv ? '#dcfce7' : '#fee2e2'};color:${isAv ? '#166534' : '#991b1b'};border:1px solid ${isAv ? '#22c55e' : '#ef4444'}`;
        div.onclick = () => isAv ? openModal(id) : openConfirmModal({
            icon: '↩',
            title: 'Confirmar devolução?',
            desc: `"${escapeHtml(t.nome)}" será marcada como disponível.`,
            onConfirm: () => returnTool(id)
        });

        const info = document.createElement('div');
        const nome = document.createElement('div');
        nome.style.cssText = 'font-weight:800;font-size:0.95rem;';
        nome.textContent = t.nome;

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:0.75rem;margin-top:4px;font-weight:600;';
        if (isAv) {
            sub.textContent = '📦 EM ARMAZÉM';
        } else {
            const workerLine = document.createElement('span');
            workerLine.textContent = `👤 ${(t.colaborador || '').toUpperCase()}`;
            const dateLine = document.createElement('div');
            dateLine.style.cssText = 'font-size:0.7rem;opacity:0.85;margin-top:2px;';
            dateLine.textContent = `📅 ${formatDate(t.dataEntrega)}`;
            sub.appendChild(workerLine);
            sub.appendChild(dateLine);
        }

        info.appendChild(nome);
        info.appendChild(sub);

        const arrow = document.createElement('span');
        arrow.style.fontSize = '1.1rem';
        arrow.textContent = isAv ? '➔' : '↩';

        div.appendChild(info);
        div.appendChild(arrow);
        list.appendChild(div);
    });
}

async function renderAdminTools() {
    const data = await fetchCollection('ferramentas');
    const list = document.getElementById('admin-tools-list');
    if (!list) return;

    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>';
        return;
    }

    Object.entries(data).forEach(([id, t]) => {
        const row  = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);';
        const label = document.createElement('span');
        label.style.cssText = 'font-weight:600;font-size:0.9rem;';
        label.textContent = `🪛 ${t.nome}`;
        const btn = document.createElement('button');
        btn.style.cssText = 'color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;';
        btn.textContent = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon: '🗑️',
            title: 'Apagar ferramenta?',
            desc: `"${escapeHtml(t.nome)}" será removida permanentemente.`,
            onConfirm: () => deleteTool(id)
        });
        row.appendChild(label);
        row.appendChild(btn);
        list.appendChild(row);
    });
}

async function assignTool(worker) {
    const dataEntrega = new Date().toISOString();
    cache.ferramentas.data[toolToAllocate] = {
        ...cache.ferramentas.data[toolToAllocate],
        status: 'alocada', colaborador: worker, dataEntrega
    };
    closeModal();
    renderTools();
    showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'alocada', colaborador: worker, dataEntrega })
        });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao guardar. Tente novamente.', 'error');
    }
}

async function returnTool(id) {
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id],
        status: 'disponivel', colaborador: '', dataEntrega: ''
    };
    renderTools();
    showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'disponivel', colaborador: '', dataEntrega: '' })
        });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao guardar. Tente novamente.', 'error');
    }
}

async function deleteTool(id) {
    delete cache.ferramentas.data[id];
    renderAdminTools();
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao apagar. Tente novamente.', 'error');
    }
}

// =============================================
// FUNCIONÁRIOS — RENDER & MUTAÇÕES
// =============================================
async function renderWorkers() {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id, v]) => ({ id, nome: v.nome })) : [];
    const list    = document.getElementById('workers-list');
    if (!list) return;

    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionário adicionado.</div>';
        return;
    }

    workers.forEach(w => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);';
        const label = document.createElement('span');
        label.style.cssText = 'font-weight:600;font-size:0.9rem;';
        label.textContent = `👤 ${w.nome}`;
        const btn = document.createElement('button');
        btn.style.cssText = 'color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;';
        btn.textContent = '🗑️';
        btn.onclick = () => openConfirmModal({
            icon: '👤',
            title: 'Apagar funcionário?',
            desc: `"${escapeHtml(w.nome)}" será removido permanentemente.`,
            onConfirm: () => deleteWorker(w.id)
        });
        row.appendChild(label);
        row.appendChild(btn);
        list.appendChild(row);
    });
}

async function deleteWorker(id) {
    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();
    try {
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' });
    } catch (e) {
        invalidateCache('funcionarios');
        showToast('Erro ao apagar. Tente novamente.', 'error');
    }
}

// =============================================
// MODAL — ENTREGAR FERRAMENTA
// =============================================
async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid, v]) => ({ id: wid, nome: v.nome })) : [];
    if (workers.length === 0) return showToast('Adicione funcionários na Administração', 'error');

    toolToAllocate = id;
    const selectList = document.getElementById('worker-select-list');
    selectList.innerHTML = '';
    workers.forEach(w => {
        const opt = document.createElement('div');
        opt.className = 'worker-option';
        opt.textContent = `👤 ${w.nome}`;
        opt.onclick = () => assignTool(w.nome);
        selectList.appendChild(opt);
    });
    document.getElementById('worker-modal').classList.add('active');
}

function closeModal() {
    document.getElementById('worker-modal').classList.remove('active');
}

// =============================================
// MODAL — CONFIRMAÇÃO GENÉRICA (substitui confirm())
// =============================================
let confirmCallback = null;

function openConfirmModal({ icon = '⚠️', title, desc, onConfirm }) {
    confirmCallback = onConfirm;
    document.getElementById('confirm-modal-icon').textContent  = icon;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent  = desc;
    document.getElementById('confirm-modal').classList.add('active');
}

function closeConfirmModal() {
    confirmCallback = null;
    document.getElementById('confirm-modal').classList.remove('active');
}

// =============================================
// MODAL — APAGAR PRODUTO (swipe left)
// =============================================
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    const desc = document.getElementById('delete-modal-desc');
    desc.textContent = `"${String(item.codigo || '').toUpperCase()} — ${item.nome}" será removido permanentemente.`;
    document.getElementById('delete-modal').classList.add('active');
}

function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-modal').classList.remove('active');
}

// =============================================
// MODAL — EDITAR PRODUTO (swipe right)
// =============================================
function openEditModal(id, item) {
    document.getElementById('edit-id').value     = id;
    document.getElementById('edit-codigo').value = item.codigo || '';
    document.getElementById('edit-nome').value   = item.nome || '';
    document.getElementById('edit-tipo').value   = item.tipo || '';
    document.getElementById('edit-loc').value    = item.localizacao || '';
    document.getElementById('edit-qtd').value    = item.quantidade ?? 0;
    document.getElementById('edit-modal').classList.add('active');
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('active');
}

// =============================================
// SWIPE GESTURES
// FIX: listeners de mousemove/mouseup no wrapper, não no window
// =============================================
const SWIPE_THRESHOLD = 80;

function attachSwipe(card, wrapper, id, item) {
    let startX = 0, currentX = 0, isDragging = false;

    function onStart(x) {
        startX    = x;
        currentX  = 0;
        isDragging = true;
        card.classList.add('is-swiping');
    }

    function onMove(x) {
        if (!isDragging) return;
        currentX = x - startX;
        const clamped = Math.max(-140, Math.min(140, currentX));
        card.style.transform = `translateX(${clamped}px)`;
        wrapper.classList.remove('swiping-left', 'swiping-right');
        if (clamped < -20)      wrapper.classList.add('swiping-left');
        else if (clamped > 20)  wrapper.classList.add('swiping-right');
    }

    function onEnd() {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('is-swiping');
        wrapper.classList.remove('swiping-left', 'swiping-right');
        snapBack(card);
        if      (currentX < -SWIPE_THRESHOLD) openDeleteModal(id, item);
        else if (currentX >  SWIPE_THRESHOLD) openEditModal(id, item);
    }

    // Touch
    card.addEventListener('touchstart', e => onStart(e.touches[0].clientX), { passive: true });
    card.addEventListener('touchmove',  e => onMove(e.touches[0].clientX),  { passive: true });
    card.addEventListener('touchend',   onEnd);

    // FIX: mouse listeners no document (um único par reutilizado), não no window por card
    card.addEventListener('mousedown', e => { onStart(e.clientX); e.preventDefault(); });
    card._moveHandler = e => { if (isDragging) onMove(e.clientX); };
    card._upHandler   = () => { if (isDragging) onEnd(); };
    document.addEventListener('mousemove', card._moveHandler);
    document.addEventListener('mouseup',   card._upHandler);
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once: true });
}

// =============================================
// PIN — VERIFICAÇÃO DE ACESSO (SHA-256)
// =============================================
let pinSessionVerified = false;
let pinBuffer          = '';
let pendingAdminNav    = false;

function checkAdminAccess() {
    const savedHash = localStorage.getItem('hiperfrio-pin-hash');
    if (!savedHash || pinSessionVerified) return true;
    pendingAdminNav = true;
    openPinModal();
    return false;
}

function openPinModal() {
    pinBuffer = '';
    updatePinDots('pin-dots', 0);
    document.getElementById('pin-error').textContent = '';
    document.getElementById('pin-modal').classList.add('active');
}

function closePinModal() {
    pendingAdminNav = false;
    pinBuffer = '';
    document.getElementById('pin-modal').classList.remove('active');
}

function pinKey(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots('pin-dots', pinBuffer.length);
    if (pinBuffer.length === 4) setTimeout(validatePin, 150);
}

function pinDel() {
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots('pin-dots', pinBuffer.length);
}

async function validatePin() {
    const savedHash = localStorage.getItem('hiperfrio-pin-hash');
    const entered   = await hashPin(pinBuffer);
    if (entered === savedHash) {
        pinSessionVerified = true;
        document.getElementById('pin-modal').classList.remove('active');
        if (pendingAdminNav) { pendingAdminNav = false; nav('view-admin'); }
    } else {
        showPinError('pin-dots', 'pin-error', 'PIN incorreto');
        pinBuffer = '';
    }
}

// ---- CONFIGURAR PIN ----
let pinSetupBuffer     = '';
let pinSetupFirstEntry = '';
let pinSetupStep       = 'first';

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
}

function closePinSetupModal() {
    document.getElementById('pin-setup-modal').classList.remove('active');
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
        pinSetupBuffer = '';
        pinSetupStep = 'confirm';
        updatePinDots('pin-setup-dots', 0);
        document.getElementById('pin-setup-desc').textContent = 'Repete o PIN para confirmar';
    } else {
        if (pinSetupBuffer === pinSetupFirstEntry) {
            const hash = await hashPin(pinSetupBuffer);
            localStorage.setItem('hiperfrio-pin-hash', hash);
            // FIX: remover chave antiga em texto simples se existir
            localStorage.removeItem('hiperfrio-pin');
            pinSessionVerified = true;
            closePinSetupModal();
            updatePinStatusUI();
            showToast('PIN definido com sucesso!');
        } else {
            showPinError('pin-setup-dots', 'pin-setup-error', 'PINs não coincidem. Tenta novamente.');
            pinSetupBuffer = ''; pinSetupFirstEntry = ''; pinSetupStep = 'first';
            setTimeout(() => {
                document.getElementById('pin-setup-desc').textContent = 'Escolhe um PIN de 4 dígitos';
            }, 1000);
        }
    }
}

function pinSetupDel() {
    pinSetupBuffer = pinSetupBuffer.slice(0, -1);
    updatePinDots('pin-setup-dots', pinSetupBuffer.length);
}

function removePin() {
    localStorage.removeItem('hiperfrio-pin-hash');
    localStorage.removeItem('hiperfrio-pin'); // remove legado
    pinSessionVerified = false;
    closePinSetupModal();
    updatePinStatusUI();
    showToast('PIN removido');
}

function updatePinDots(containerId, count) {
    document.querySelectorAll(`#${containerId} span`).forEach((dot, i) => {
        dot.classList.toggle('filled', i < count);
        dot.classList.remove('error');
    });
}

function showPinError(dotsId, errorId, msg) {
    document.querySelectorAll(`#${dotsId} span`).forEach(dot => {
        dot.classList.remove('filled');
        dot.classList.add('error');
    });
    document.getElementById(errorId).textContent = msg;
    setTimeout(() => {
        document.querySelectorAll(`#${dotsId} span`).forEach(dot => dot.classList.remove('error'));
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
    const data = await fetchCollection('stock', false);
    if (!data || Object.keys(data).length === 0) {
        showToast('Não há produtos para exportar', 'error');
        return;
    }
    const headers = ['Referência', 'Nome', 'Tipo', 'Localização', 'Quantidade'];
    const rows = Object.values(data).map(item => [
        `"${(item.codigo || '').toUpperCase()}"`,
        `"${(item.nome || '').replace(/"/g, '""')}"`,
        `"${(item.tipo || 'Geral').replace(/"/g, '""')}"`,
        `"${(item.localizacao || '').toUpperCase()}"`,
        item.quantidade ?? 0
    ]);
    const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: `hiperfrio-stock-${new Date().toISOString().slice(0, 10)}.csv`
    });
    a.click();
    URL.revokeObjectURL(url);
    showToast(`${Object.keys(data).length} produtos exportados!`);
}

// =============================================
// ADMIN TABS
// =============================================
function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');
    document.getElementById('panel-' + tab)?.classList.add('active');
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
// INICIALIZAÇÃO (dentro de DOMContentLoaded)
// FIX: todos os form listeners e event bindings aqui dentro
// =============================================
document.addEventListener('DOMContentLoaded', () => {

    // Tema
    if (localStorage.getItem('hiperfrio-tema') === 'dark') {
        document.body.classList.add('dark-mode');
        const t = document.getElementById('theme-toggle-admin');
        if (t) t.checked = true;
    }

    // Migração: se ainda existe PIN em texto simples, migra para hash
    const legacyPin = localStorage.getItem('hiperfrio-pin');
    if (legacyPin && !localStorage.getItem('hiperfrio-pin-hash')) {
        hashPin(legacyPin).then(hash => {
            localStorage.setItem('hiperfrio-pin-hash', hash);
            localStorage.removeItem('hiperfrio-pin');
        });
    }

    // Carrega stock e pré-aquece cache
    renderList();
    fetchCollection('ferramentas');
    fetchCollection('funcionarios');

    // PIN UI
    updatePinStatusUI();

    // Pesquisa com debounce
    const searchInput = document.getElementById('inp-search');
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => renderList(e.target.value), 300);
        };
    }

    // Online/Offline — banner + sync da fila
    updateOfflineBanner();
    window.addEventListener('offline', () => {
        updateOfflineBanner();
        showToast('Sem ligação — alterações guardadas localmente', 'error');
    });
    window.addEventListener('online', async () => {
        updateOfflineBanner();
        await syncQueue();
    });

    // FIX: confirm modal OK button
    document.getElementById('confirm-modal-ok').onclick = () => {
        const cb = confirmCallback;
        closeConfirmModal();
        if (cb) cb();
    };

    // FIX: delete confirm button
    document.getElementById('delete-confirm-btn').onclick = async () => {
        if (!pendingDeleteId) return;
        const id   = pendingDeleteId;
        const item = cache.stock.data[id];
        closeDeleteModal();
        delete cache.stock.data[id];
        renderList(document.getElementById('inp-search')?.value || '');
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        } catch (e) {
            cache.stock.data[id] = item;
            renderList(document.getElementById('inp-search')?.value || '');
            showToast('Erro ao apagar produto', 'error');
        }
    };

    // Formulário: Novo Produto
    const formAdd = document.getElementById('form-add');
    if (formAdd) {
        formAdd.onsubmit = async e => {
            e.preventDefault();
            const btn = formAdd.querySelector('button[type=submit]');
            btn.disabled = true;
            const payload = {
                nome:       document.getElementById('inp-nome').value.trim(),
                tipo:       document.getElementById('inp-tipo').value.trim() || 'Geral',
                localizacao:document.getElementById('inp-loc').value.trim().toUpperCase(),
                quantidade: parseInt(document.getElementById('inp-qtd').value) || 0,
                codigo:     document.getElementById('inp-codigo').value.trim().toUpperCase()
            };
            try {
                const res = await apiFetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
                if (res) {
                    const result = await res.json();
                    if (result?.name) {
                        if (!cache.stock.data) cache.stock.data = {};
                        cache.stock.data[result.name] = payload;
                    }
                } else {
                    // Offline: adiciona ao cache com id temporário
                    if (!cache.stock.data) cache.stock.data = {};
                    cache.stock.data[`_tmp_${Date.now()}`] = payload;
                }
                showToast('Produto Registado!');
                nav('view-search');
                e.target.reset();
            } catch (err) {
                invalidateCache('stock');
                showToast('Erro ao registar produto', 'error');
            } finally {
                btn.disabled = false;
            }
        };
    }

    // Formulário: Catalogar Lote
    const formBulk = document.getElementById('form-bulk');
    if (formBulk) {
        formBulk.onsubmit = async e => {
            e.preventDefault();
            const btn = formBulk.querySelector('button[type=submit]');
            btn.disabled = true;
            const payload = {
                localizacao: document.getElementById('bulk-loc').value.trim().toUpperCase(),
                codigo:      document.getElementById('bulk-codigo').value.trim().toUpperCase(),
                nome:        document.getElementById('bulk-nome').value.trim(),
                quantidade:  parseInt(document.getElementById('bulk-qtd').value) || 0,
                tipo: 'Geral'
            };
            try {
                const res = await apiFetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
                if (res) {
                    const result = await res.json();
                    if (result?.name) {
                        if (!cache.stock.data) cache.stock.data = {};
                        cache.stock.data[result.name] = payload;
                    }
                } else {
                    if (!cache.stock.data) cache.stock.data = {};
                    cache.stock.data[`_tmp_${Date.now()}`] = payload;
                }
                showToast(`${payload.codigo} adicionado ao lote!`);
                document.getElementById('bulk-codigo').value = '';
                document.getElementById('bulk-nome').value   = '';
                document.getElementById('bulk-qtd').value    = '';
                document.getElementById('bulk-codigo').focus();
            } catch (err) {
                invalidateCache('stock');
                showToast('Erro ao adicionar ao lote', 'error');
            } finally {
                btn.disabled = false;
            }
        };
    }

    // Formulário: Editar Produto
    const formEdit = document.getElementById('form-edit');
    if (formEdit) {
        formEdit.onsubmit = async e => {
            e.preventDefault();
            const id      = document.getElementById('edit-id').value;
            const btn     = formEdit.querySelector('button[type=submit]');
            btn.disabled  = true;
            const updated = {
                codigo:      document.getElementById('edit-codigo').value.trim().toUpperCase(),
                nome:        document.getElementById('edit-nome').value.trim(),
                tipo:        document.getElementById('edit-tipo').value.trim() || 'Geral',
                localizacao: document.getElementById('edit-loc').value.trim().toUpperCase(),
                quantidade:  parseInt(document.getElementById('edit-qtd').value) || 0,
            };
            cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
            closeEditModal();
            renderList(document.getElementById('inp-search')?.value || '');
            showToast('Produto atualizado!');
            try {
                await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify(updated)
                });
            } catch (err) {
                invalidateCache('stock');
                showToast('Erro ao guardar alterações', 'error');
            } finally {
                btn.disabled = false;
            }
        };
    }

    // Formulário: Funcionário
    const formWorker = document.getElementById('form-worker');
    if (formWorker) {
        formWorker.onsubmit = async e => {
            e.preventDefault();
            const nome = document.getElementById('worker-name').value.trim();
            if (!nome) return;
            try {
                const res = await apiFetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome }) });
                if (!cache.funcionarios.data) cache.funcionarios.data = {};
                if (res) {
                    const result = await res.json();
                    if (result?.name) cache.funcionarios.data[result.name] = { nome };
                } else {
                    cache.funcionarios.data[`_tmp_${Date.now()}`] = { nome };
                }
                document.getElementById('worker-name').value = '';
                renderWorkers();
                showToast('Funcionário adicionado');
            } catch (err) {
                invalidateCache('funcionarios');
                showToast('Erro ao adicionar funcionário', 'error');
            }
        };
    }

    // Formulário: Ferramenta
    const formToolReg = document.getElementById('form-tool-reg');
    if (formToolReg) {
        formToolReg.onsubmit = async e => {
            e.preventDefault();
            const nome    = document.getElementById('reg-tool-name').value.trim();
            const payload = { nome, status: 'disponivel' };
            try {
                const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify(payload) });
                if (!cache.ferramentas.data) cache.ferramentas.data = {};
                if (res) {
                    const result = await res.json();
                    if (result?.name) cache.ferramentas.data[result.name] = payload;
                } else {
                    cache.ferramentas.data[`_tmp_${Date.now()}`] = payload;
                }
                document.getElementById('reg-tool-name').value = '';
                renderAdminTools();
                showToast('Ferramenta registada');
            } catch (err) {
                invalidateCache('ferramentas');
                showToast('Erro ao registar ferramenta', 'error');
            }
        };
    }
});

// =============================================
// REGISTO PWA
// =============================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(() => console.log('PWA Service Worker registado'))
            .catch(err => console.warn('PWA: Erro no Service Worker', err));
    });
}
