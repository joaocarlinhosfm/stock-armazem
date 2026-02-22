const DB_URL  = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// =============================================
// CACHE EM MEMÓRIA
// Cada entrada guarda { data, lastFetch }
// Só vai à Firebase se os dados tiverem > TTL ms
// =============================================
const CACHE_TTL = 60_000; // 60 segundos

const cache = {
    stock:        { data: null, lastFetch: 0 },
    ferramentas:  { data: null, lastFetch: 0 },
    funcionarios: { data: null, lastFetch: 0 },
};

// Busca uma coleção — usa cache se ainda estiver válido
async function fetchCollection(name, force = false) {
    const entry = cache[name];
    const isStale = (Date.now() - entry.lastFetch) > CACHE_TTL;

    if (!force && !isStale && entry.data !== null) {
        return entry.data; // cache hit — sem fetch
    }

    try {
        const res = await fetch(`${BASE_URL}/${name}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        entry.data = data || {};
        entry.lastFetch = Date.now();
        return entry.data;
    } catch (e) {
        console.error(`Erro ao buscar ${name}:`, e);
        showToast(`Erro ao carregar dados`, 'error');
        return entry.data || {}; // devolve cache antigo se existir
    }
}

// Invalida cache de uma coleção (força fetch na próxima chamada)
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
    t.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function setRefreshSpinning(spinning) {
    const btn = document.getElementById('btn-refresh');
    if (btn) btn.classList.toggle('spinning', spinning);
}

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    const overlay = document.getElementById('menu-overlay');
    if (overlay) overlay.classList.toggle('active');
}

function nav(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');

    if (viewId === 'view-search') renderList();
    if (viewId === 'view-tools') renderTools();
    if (viewId === 'view-admin') { renderWorkers(); renderAdminTools(); }

    // Sidebar active state
    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const viewToNavId = {
        'view-search':   'nav-search',
        'view-tools':    'nav-tools',
        'view-register': 'nav-register',
        'view-bulk':     'nav-bulk',
        'view-admin':    'nav-admin'
    };
    const navLi = document.getElementById(viewToNavId[viewId]);
    if (navLi) navLi.classList.add('active');

    // Bottom nav active state
    document.querySelectorAll('.bottom-nav-item').forEach(btn => btn.classList.remove('active'));
    const viewToBnav = {
        'view-search':   'bnav-search',
        'view-tools':    'bnav-tools',
        'view-register': 'bnav-register',
        'view-bulk':     'bnav-bulk',
        'view-admin':    'bnav-admin'
    };
    const bnavBtn = document.getElementById(viewToBnav[viewId]);
    if (bnavBtn) bnavBtn.classList.add('active');

    const menu = document.getElementById('side-menu');
    if (menu && menu.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
}

// =============================================
// STOCK — RENDER & MUTAÇÕES
// =============================================
async function renderList(filter = "", force = false) {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    // Mostra loading apenas se o cache estiver vazio
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

    // Show swipe hint on first load (only if never dismissed)
    if (!filter && !localStorage.getItem('swipe-hint-seen')) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        hint.innerHTML = `<span>✏️ Swipe direita para editar</span><span>🗑️ Swipe esquerda para apagar</span>`;
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

        wrapper.innerHTML = `
            <div class="swipe-bg swipe-bg-left"><span class="swipe-bg-icon">🗑️</span></div>
            <div class="swipe-bg swipe-bg-right"><span class="swipe-bg-icon">✏️</span></div>`;

        const el = document.createElement('div');
        el.className = 'item-card';
        el.innerHTML = `
            <div class="ref-label">REFERÊNCIA</div>
            <div class="ref-value">${String(item.codigo).toUpperCase()}</div>
            <div style="font-size:0.9rem;font-weight:600;color:var(--text-muted);margin-bottom:12px;line-height:1.2;">${item.nome}</div>
            <hr style="border:0;border-top:1px solid var(--border);margin-bottom:10px;opacity:0.5;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="loc-pill">
                    <span style="font-size:0.85rem;">📍</span>
                    ${item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL'}
                </div>
                <div class="qty-pill-box">
                    <button class="btn-qty" onclick="changeQtd('${id}', -1)">−</button>
                    <span class="qty-display" id="qty-${id}">${item.quantidade || 0}</span>
                    <button class="btn-qty" onclick="changeQtd('${id}', 1)">+</button>
                </div>
            </div>`;

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        listEl.appendChild(wrapper);
    });

    if (filter && found === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum resultado encontrado.</div>';
    }
}

// Botão de refresh manual — força fetch da Firebase
async function forceRefresh() {
    setRefreshSpinning(true);
    await renderList(document.getElementById('inp-search')?.value || '', true);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(50);

    const stockData = cache.stock.data;
    if (!stockData || !stockData[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return; // já está em 0, não faz nada

    // Atualização otimista: cache + DOM imediatos
    stockData[id].quantidade = newQty;
    const qtyEl = document.getElementById(`qty-${id}`);
    if (qtyEl) qtyEl.textContent = newQty;

    // Envia para Firebase em background
    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: newQty })
        });
    } catch (e) {
        // Reverte se falhar
        stockData[id].quantidade = oldQty;
        if (qtyEl) qtyEl.textContent = oldQty;
        showToast('Erro ao guardar quantidade', 'error');
    }
}

// =============================================
// FERRAMENTAS — RENDER & MUTAÇÕES
// =============================================
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
        const div = document.createElement('div');
        div.onclick = () => isAv ? openModal(id) : returnTool(id);
        div.style.cssText = `padding:14px;border-radius:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;background:${isAv ? '#dcfce7' : '#fee2e2'};color:${isAv ? '#166534' : '#991b1b'};border:1px solid ${isAv ? '#22c55e' : '#ef4444'}`;
        div.innerHTML = `
            <div>
                <div style="font-weight:800;font-size:0.95rem;">${t.nome}</div>
                <div style="font-size:0.75rem;margin-top:4px;font-weight:600;">
                    ${isAv ? '📦 EM ARMAZÉM' : '👤 ' + t.colaborador.toUpperCase()}
                </div>
            </div>
            <span style="font-size:1.1rem;">${isAv ? '➔' : '↩'}</span>`;
        list.appendChild(div);
    });
}

async function renderAdminTools() {
    const data = await fetchCollection('ferramentas');
    const list = document.getElementById('admin-tools-list');
    if (!list) return;

    list.innerHTML = data && Object.keys(data).length > 0
        ? Object.entries(data).map(([id, t]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);">
                <span style="font-weight:600;font-size:0.9rem;">🪛 ${t.nome}</span>
                <button onclick="deleteTool('${id}')" style="color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;">🗑️</button>
            </div>`).join('')
        : '<div class="empty-msg">Nenhuma ferramenta registada.</div>';
}

async function assignTool(worker) {
    // Atualização otimista no cache
    cache.ferramentas.data[toolToAllocate] = {
        ...cache.ferramentas.data[toolToAllocate],
        status: 'alocada',
        colaborador: worker
    };
    closeModal();
    renderTools();
    showToast(`Entregue a ${worker}!`);

    try {
        await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'alocada', colaborador: worker })
        });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao guardar. Tente novamente.', 'error');
    }
}

async function returnTool(id) {
    if (!confirm("Confirmar devolução?")) return;

    // Atualização otimista no cache
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id],
        status: 'disponivel',
        colaborador: ''
    };
    renderTools();
    showToast("Devolvida!");

    try {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'disponivel', colaborador: '' })
        });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao guardar. Tente novamente.', 'error');
    }
}

async function deleteTool(id) {
    if (!confirm("Apagar ferramenta?")) return;

    delete cache.ferramentas.data[id];
    renderAdminTools();

    try {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' });
    } catch (e) {
        invalidateCache('ferramentas');
        showToast('Erro ao apagar. Tente novamente.', 'error');
    }
}

// =============================================
// FUNCIONÁRIOS — RENDER & MUTAÇÕES
// =============================================
async function renderWorkers() {
    const data = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id, v]) => ({ id, nome: v.nome })) : [];

    const list = document.getElementById('workers-list');
    if (!list) return;
    list.innerHTML = workers.length > 0
        ? workers.map(w => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:10px;margin-bottom:8px;border:1px solid var(--border);">
                <span style="font-weight:600;font-size:0.9rem;">👤 ${w.nome}</span>
                <button onclick="deleteWorker('${w.id}')" style="color:var(--danger);background:none;border:none;font-size:1.1rem;cursor:pointer;">🗑️</button>
            </div>`).join('')
        : '<div class="empty-msg">Nenhum funcionário adicionado.</div>';
}

async function deleteWorker(id) {
    if (!confirm("Apagar funcionário?")) return;

    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();

    try {
        await fetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' });
    } catch (e) {
        invalidateCache('funcionarios');
        showToast('Erro ao apagar. Tente novamente.', 'error');
    }
}

// =============================================
// MODAL FERRAMENTAS
// =============================================
async function openModal(id) {
    const data = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid, v]) => ({ id: wid, nome: v.nome })) : [];

    if (workers.length === 0) return showToast("Adicione funcionários na Administração", "error");

    toolToAllocate = id;
    document.getElementById('worker-select-list').innerHTML = workers.map(w =>
        `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`
    ).join('');
    document.getElementById('worker-modal').classList.add('active');
}

function closeModal() {
    document.getElementById('worker-modal').classList.remove('active');
}

// =============================================
// FORMULÁRIOS
// =============================================
const formAdd = document.getElementById('form-add');
if (formAdd) {
    formAdd.onsubmit = async (e) => {
        e.preventDefault();
        const payload = {
            nome: document.getElementById('inp-nome').value,
            tipo: document.getElementById('inp-tipo').value || 'Geral',
            localizacao: document.getElementById('inp-loc').value.toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0,
            codigo: document.getElementById('inp-codigo').value.toUpperCase()
        };
        try {
            const res = await fetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
            const result = await res.json();
            if (result?.name) {
                if (!cache.stock.data) cache.stock.data = {};
                cache.stock.data[result.name] = payload;
            }
            showToast("Produto Registado!");
            nav('view-search');
            e.target.reset();
        } catch (err) {
            invalidateCache('stock');
            showToast('Erro ao registar produto', 'error');
        }
    };
}

const formBulk = document.getElementById('form-bulk');
if (formBulk) {
    formBulk.onsubmit = async (e) => {
        e.preventDefault();
        const payload = {
            localizacao: document.getElementById('bulk-loc').value.toUpperCase(),
            codigo: document.getElementById('bulk-codigo').value.toUpperCase(),
            nome: document.getElementById('bulk-nome').value,
            quantidade: parseInt(document.getElementById('bulk-qtd').value) || 0,
            tipo: 'Geral'
        };
        try {
            const res = await fetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
            const result = await res.json();
            if (result?.name) {
                if (!cache.stock.data) cache.stock.data = {};
                cache.stock.data[result.name] = payload;
            }
            showToast(`${payload.codigo} adicionado ao lote!`);
            // Mantém zona, limpa os restantes campos
            document.getElementById('bulk-codigo').value = '';
            document.getElementById('bulk-nome').value = '';
            document.getElementById('bulk-qtd').value = '';
            document.getElementById('bulk-codigo').focus();
        } catch (err) {
            invalidateCache('stock');
            showToast('Erro ao adicionar ao lote', 'error');
        }
    };
}

const formWorker = document.getElementById('form-worker');
if (formWorker) {
    formWorker.onsubmit = async (e) => {
        e.preventDefault();
        const nome = document.getElementById('worker-name').value.trim();
        try {
            const res = await fetch(`${BASE_URL}/funcionarios.json`, {
                method: 'POST',
                body: JSON.stringify({ nome })
            });
            const result = await res.json();
            if (!cache.funcionarios.data) cache.funcionarios.data = {};
            if (result?.name) cache.funcionarios.data[result.name] = { nome };
            document.getElementById('worker-name').value = '';
            renderWorkers();
            showToast("Funcionário adicionado");
        } catch (err) {
            invalidateCache('funcionarios');
            showToast('Erro ao adicionar funcionário', 'error');
        }
    };
}

const formToolReg = document.getElementById('form-tool-reg');
if (formToolReg) {
    formToolReg.onsubmit = async (e) => {
        e.preventDefault();
        const nome = document.getElementById('reg-tool-name').value.trim();
        const payload = { nome, status: 'disponivel' };
        try {
            const res = await fetch(`${BASE_URL}/ferramentas.json`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (result?.name) cache.ferramentas.data[result.name] = payload;
            document.getElementById('reg-tool-name').value = '';
            renderAdminTools();
            showToast("Ferramenta registada");
        } catch (err) {
            invalidateCache('ferramentas');
            showToast('Erro ao registar ferramenta', 'error');
        }
    };
}

// =============================================
// ADMIN TABS
// =============================================
function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('panel-' + tab).classList.add('active');
}

// =============================================
// TEMA
// =============================================
function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
    const adminToggle = document.getElementById('theme-toggle-admin');
    if (adminToggle) adminToggle.checked = isDark;
}

// =============================================
// INICIALIZAÇÃO
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('hiperfrio-tema') === 'dark') {
        document.body.classList.add('dark-mode');
        const adminToggle = document.getElementById('theme-toggle-admin');
        if (adminToggle) adminToggle.checked = true;
    }

    // Carrega stock (vista inicial)
    renderList();

    // Pré-aquece o cache das outras coleções em background
    fetchCollection('ferramentas');
    fetchCollection('funcionarios');

    const searchInput = document.getElementById('inp-search');
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => renderList(e.target.value), 300);
        };
    }
});


// =============================================
// SWIPE GESTURES
// =============================================
const SWIPE_THRESHOLD = 80; // px to trigger action

function attachSwipe(card, wrapper, id, item) {
    let startX = 0, currentX = 0, isDragging = false;

    function onStart(x) {
        startX = x;
        currentX = 0;
        isDragging = true;
        card.classList.add('is-swiping');
    }

    function onMove(x) {
        if (!isDragging) return;
        currentX = x - startX;
        // Limit drag to 140px each side
        const clamped = Math.max(-140, Math.min(140, currentX));
        card.style.transform = `translateX(${clamped}px)`;

        // Update background indicator
        wrapper.classList.remove('swiping-left', 'swiping-right');
        if (clamped < -20) wrapper.classList.add('swiping-left');
        else if (clamped > 20) wrapper.classList.add('swiping-right');
    }

    function onEnd() {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('is-swiping');
        wrapper.classList.remove('swiping-left', 'swiping-right');

        if (currentX < -SWIPE_THRESHOLD) {
            // Swipe left → delete confirmation
            snapBack(card);
            openDeleteModal(id, item);
        } else if (currentX > SWIPE_THRESHOLD) {
            // Swipe right → edit form
            snapBack(card);
            openEditModal(id, item);
        } else {
            snapBack(card);
        }
    }

    // Touch events
    card.addEventListener('touchstart', e => onStart(e.touches[0].clientX), { passive: true });
    card.addEventListener('touchmove',  e => onMove(e.touches[0].clientX),  { passive: true });
    card.addEventListener('touchend',   () => onEnd());

    // Mouse events (desktop)
    card.addEventListener('mousedown', e => { onStart(e.clientX); e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (isDragging) onMove(e.clientX); });
    window.addEventListener('mouseup',   () => { if (isDragging) onEnd(); });
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once: true });
}

// =============================================
// DELETE MODAL
// =============================================
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    document.getElementById('delete-modal-desc').textContent =
        `"${String(item.codigo).toUpperCase()} — ${item.nome}" será removido permanentemente.`;
    document.getElementById('delete-modal').classList.add('active');
}

function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-modal').classList.remove('active');
}

document.getElementById('delete-confirm-btn').onclick = async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    closeDeleteModal();

    // Remove do cache e re-renderiza imediatamente
    const item = cache.stock.data[id];
    delete cache.stock.data[id];
    renderList(document.getElementById('inp-search')?.value || '');
    showToast('Produto apagado');

    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
    } catch (e) {
        // Reverte se falhar
        cache.stock.data[id] = item;
        renderList(document.getElementById('inp-search')?.value || '');
        showToast('Erro ao apagar produto', 'error');
    }
};

// =============================================
// EDIT MODAL
// =============================================
function openEditModal(id, item) {
    document.getElementById('edit-id').value    = id;
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

const formEdit = document.getElementById('form-edit');
if (formEdit) {
    formEdit.onsubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('edit-id').value;
        const updated = {
            codigo:      document.getElementById('edit-codigo').value.toUpperCase(),
            nome:        document.getElementById('edit-nome').value,
            tipo:        document.getElementById('edit-tipo').value || 'Geral',
            localizacao: document.getElementById('edit-loc').value.toUpperCase(),
            quantidade:  parseInt(document.getElementById('edit-qtd').value) || 0,
        };

        // Atualiza cache e UI imediatamente
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        closeEditModal();
        renderList(document.getElementById('inp-search')?.value || '');
        showToast('Produto atualizado!');

        try {
            await fetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH',
                body: JSON.stringify(updated)
            });
        } catch (err) {
            invalidateCache('stock');
            showToast('Erro ao guardar alterações', 'error');
        }
    };
}

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
