const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

let editModeId = null;
let cachedData = {};
let cachedWorkers = [];
let toolToAllocate = null;

// --- TOASTS ---
function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
    t.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// --- NAVEGAÇÃO ---
function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function nav(viewId, isEdit = false) {
    if (viewId === 'view-register' && !isEdit) resetRegisterForm("Novo Produto");
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    if(viewId === 'view-search') renderList();
    if(viewId === 'view-tools') renderTools();
    if(viewId === 'view-admin') { renderWorkers(); renderAdminTools(); }
    
    toggleMenu(); // Fecha se estiver aberto
    window.scrollTo(0,0);
}

// --- GESTÃO DE STOCK ---
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {};
        listEl.innerHTML = '';
        if(!data) return;
        Object.entries(data).reverse().forEach(([id, item]) => {
            if(filter && !item.nome.toLowerCase().includes(filter.toLowerCase()) && !item.codigo.toUpperCase().includes(filter.toUpperCase())) return;
            const el = document.createElement('div');
            el.className = 'item-card';
            const lowClass = item.quantidade === 0 ? 'low-stock' : '';
            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                <div class="card-content">
                    <div style="font-size:0.7rem; font-weight:bold; color:var(--primary)">REF: ${item.codigo}</div>
                    <div style="font-size:1.1rem; font-weight:600; margin:4px 0">${item.nome}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center">
                        <span style="font-size:0.8rem; color:var(--text-muted)">📍 ${item.localizacao || 'S/ LOC'}</span>
                        <div style="display:flex; align-items:center; gap:10px">
                            <button onclick="changeQtd('${id}', -1)" class="btn-qtd">➖</button>
                            <span class="${lowClass}" data-id="${id}" style="font-weight:bold">${item.quantidade || 0}</span>
                            <button onclick="changeQtd('${id}', 1)" class="btn-qtd">➕</button>
                        </div>
                    </div>
                </div>`;
            listEl.appendChild(el);
            setupSwipe(el, id);
        });
    } catch (e) { showToast("Erro ao carregar stock", "error"); }
}

async function changeQtd(id, delta) {
    const span = document.querySelector(`span[data-id="${id}"]`);
    let n = Math.max(0, parseInt(span.innerText) + delta);
    span.innerText = n;
    n === 0 ? span.classList.add('low-stock') : span.classList.remove('low-stock');
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: n }) });
}

// --- FERRAMENTAS & FUNCIONÁRIOS ---
async function renderTools(filter = "") {
    const list = document.getElementById('tools-list');
    list.innerHTML = "Carregando...";
    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        list.innerHTML = '';
        if(!data) return;
        Object.entries(data).reverse().forEach(([id, t]) => {
            if(filter && !t.nome.toLowerCase().includes(filter.toLowerCase())) return;
            const isAv = t.status === 'disponivel';
            const el = document.createElement('div');
            el.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}`;
            el.onclick = () => isAv ? openModal(id) : returnTool(id);
            el.innerHTML = `
                <div>
                    <div style="font-weight:bold; font-size:1.1rem">${t.nome}</div>
                    <div style="font-size:0.8rem; margin-top:5px">${isAv ? '📦 Em Armazém' : '👤 Com: ' + t.colaborador}</div>
                </div>
                <span>${isAv ? '➔' : '↩'}</span>`;
            list.appendChild(el);
        });
    } catch(e) {}
}

async function renderAdminTools() {
    const list = document.getElementById('admin-tools-list');
    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        list.innerHTML = '<h4>Inventário Ativo</h4>';
        if(!data) return;
        Object.entries(data).forEach(([id, t]) => {
            const row = document.createElement('div');
            row.style = "display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid var(--border)";
            row.innerHTML = `<span>${t.nome}</span><button onclick="deleteTool('${id}')" style="background:none; border:none; color:red">🗑️</button>`;
            list.appendChild(row);
        });
    } catch(e){}
}

async function deleteTool(id) {
    if(confirm("Remover ferramenta do sistema?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' });
        renderAdminTools();
        showToast("Ferramenta removida");
    }
}

async function renderWorkers() {
    const list = document.getElementById('workers-list');
    try {
        const res = await fetch(`${BASE_URL}/funcionarios.json`);
        const data = await res.json();
        cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
        list.innerHTML = '';
        cachedWorkers.forEach(w => {
            list.innerHTML += `<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid var(--border)">
                <span>👤 ${w.nome}</span>
                <button onclick="deleteWorker('${w.id}')" style="background:none; border:none; color:red">🗑️</button>
            </div>`;
        });
    } catch(e){}
}

// --- SUBMISSÕES ---
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    if(!editModeId) payload.codigo = document.getElementById('inp-codigo').value.toUpperCase();
    const url = editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL;
    await fetch(url, { method: editModeId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    showToast("Sucesso!");
    nav('view-search');
};

document.getElementById('form-worker').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('worker-name').value;
    await fetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome }) });
    document.getElementById('worker-name').value = '';
    renderWorkers();
    showToast("Funcionário adicionado");
};

document.getElementById('form-tool-reg').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('reg-tool-name').value;
    await fetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify({ nome, status: 'disponivel' }) });
    document.getElementById('reg-tool-name').value = '';
    renderAdminTools();
    showToast("Ferramenta adicionada");
};

// --- MODAL ---
function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários primeiro", "error");
    toolToAllocate = id;
    const container = document.getElementById('worker-select-list');
    container.innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">${w.nome}</div>`).join('');
    document.getElementById('worker-modal').classList.add('active');
}

function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

async function assignTool(worker) {
    await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker }) });
    closeModal();
    renderTools();
    showToast("Ferramenta entregue");
}

async function returnTool(id) {
    if(confirm("Confirmar devolução?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
        renderTools();
        showToast("Ferramenta em armazém");
    }
}

// --- UTILS (SWIPE, THEME) ---
function setupSwipe(el, id) {
    const content = el.querySelector('.card-content');
    let startX = 0, currentX = 0, isScrolling = false;
    content.addEventListener('touchstart', e => { startX = e.touches[0].clientX; content.style.transition = 'none'; isScrolling = false; }, {passive:true});
    content.addEventListener('touchmove', e => {
        currentX = e.touches[0].clientX - startX;
        if(Math.abs(e.touches[0].clientY - startX) > Math.abs(currentX)) isScrolling = true;
        if(!isScrolling) content.style.transform = `translateX(${currentX}px)`;
    }, {passive:true});
    content.addEventListener('touchend', () => {
        content.style.transition = 'transform 0.3s';
        if(currentX > 80 && !isScrolling) startEditMode(id);
        else if(currentX < -80 && !isScrolling) deleteItem(id, el);
        content.style.transform = 'translateX(0)';
    });
}

function toggleTheme() { document.body.classList.toggle('dark-mode'); }
function resetRegisterForm(t) { editModeId = null; document.getElementById('form-add').reset(); document.getElementById('form-title').innerText = t; document.getElementById('inp-codigo').disabled = false; }
async function deleteItem(id, el) { if(confirm("Apagar produto?")) { await fetch(`${BASE_URL}/stock/${id}.json`, {method:'DELETE'}); el.remove(); } }

document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    document.getElementById('inp-search-tools').oninput = (e) => renderTools(e.target.value);
});
