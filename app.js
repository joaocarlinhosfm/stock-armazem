const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

let editModeId = null;
let cachedData = {};
let cachedWorkers = [];
let toolToAllocate = null;

// --- SISTEMA DE TOASTS ---
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
    
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
    window.scrollTo(0,0);
}

// --- LOGICA DE STOCK ---
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {};
        listEl.innerHTML = '';
        if(!data) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Sem produtos.</div>';

        Object.entries(data).reverse().forEach(([id, item]) => {
            if(filter && !item.nome.toLowerCase().includes(filter.toLowerCase()) && !String(item.codigo).toUpperCase().includes(filter.toUpperCase())) return;
            const el = document.createElement('div'); el.className = 'item-card';
            const lowClass = (item.quantidade || 0) === 0 ? 'low-stock' : '';
            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                <div class="card-content">
                    <div style="font-size:0.75rem; font-weight:800; color:var(--primary)">REF: ${item.codigo}</div>
                    <div style="font-size:1.15rem; font-weight:700; margin:4px 0">${item.nome}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center">
                        <span style="font-size:0.85rem; color:var(--text-muted)">📍 ${item.localizacao || 'S/ LOC'}</span>
                        <div style="display:flex; align-items:center; gap:12px">
                            <button onclick="changeQtd('${id}', -1)" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">−</button>
                            <span class="${lowClass}" data-id="${id}" style="font-weight:800; font-size:1.1rem">${item.quantidade || 0}</span>
                            <button onclick="changeQtd('${id}', 1)" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">+</button>
                        </div>
                    </div>
                </div>`;
            listEl.appendChild(el); setupSwipe(el, id);
        });
    } catch (e) { showToast("Erro de rede", "error"); }
}

async function changeQtd(id, delta) {
    const span = document.querySelector(`span[data-id="${id}"]`);
    let n = Math.max(0, parseInt(span.innerText) + delta);
    span.innerText = n;
    n === 0 ? span.classList.add('low-stock') : span.classList.remove('low-stock');
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: n }) });
}

// --- LOGICA DE FERRAMENTAS ---
async function renderTools(filter = "") {
    const list = document.getElementById('tools-list');
    list.innerHTML = "<div style='text-align:center; padding:20px;'>A carregar...</div>";
    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        const resW = await fetch(`${BASE_URL}/funcionarios.json`);
        const dataW = await resW.json();
        cachedWorkers = dataW ? Object.entries(dataW).map(([id, v]) => ({id, nome: v.nome})) : [];
        
        list.innerHTML = '';
        if(!data) return list.innerHTML = '<div style="text-align:center; padding:20px; color:gray;">Nenhuma ferramenta.</div>';
        
        Object.entries(data).reverse().forEach(([id, t]) => {
            if(filter && !t.nome.toLowerCase().includes(filter.toLowerCase())) return;
            const isAv = t.status === 'disponivel';
            const el = document.createElement('div');
            el.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}`;
            el.onclick = () => isAv ? openModal(id) : returnTool(id);
            el.innerHTML = `
                <div>
                    <div style="font-weight:800; font-size:1.1rem">${t.nome}</div>
                    <div style="font-size:0.85rem; margin-top:5px; font-weight:600;">${isAv ? '📦 EM ARMAZÉM' : '👤 COM: ' + t.colaborador.toUpperCase()}</div>
                </div>
                <span style="font-size:1.5rem; opacity:0.6;">${isAv ? '➔' : '↩'}</span>`;
            list.appendChild(el);
        });
    } catch(e) {}
}

async function renderAdminTools() {
    const list = document.getElementById('admin-tools-list');
    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        list.innerHTML = '<h4 style="margin:10px 0;">📦 Inventário Ativo</h4>';
        if(!data) return list.innerHTML += '<p style="font-size:0.8rem; color:gray;">Vazio.</p>';
        Object.entries(data).forEach(([id, t]) => {
            const row = document.createElement('div');
            row.style = "display:flex; justify-content:space-between; align-items:center; padding:10px; background:var(--bg); border-radius:10px; margin-bottom:6px; border:1px solid var(--border)";
            row.innerHTML = `<span style="font-weight:600; font-size:0.9rem;">${t.nome}</span><button onclick="deleteTool('${id}')" style="background:none; border:none; color:var(--danger); font-size:1.2rem; cursor:pointer;">🗑️</button>`;
            list.appendChild(row);
        });
    } catch(e){}
}

async function renderWorkers() {
    const list = document.getElementById('workers-list');
    try {
        const res = await fetch(`${BASE_URL}/funcionarios.json`);
        const data = await res.json();
        cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
        list.innerHTML = '';
        if(cachedWorkers.length === 0) list.innerHTML = '<p style="color:gray; font-size:0.8rem;">Sem funcionários.</p>';
        cachedWorkers.forEach(w => {
            list.innerHTML += `<div style="display:flex; justify-content:space-between; padding:10px; background:var(--bg); border-radius:10px; margin-bottom:6px; border:1px solid var(--border)">
                <span style="font-weight:600;">👤 ${w.nome}</span>
                <button onclick="deleteWorker('${w.id}')" style="background:none; border:none; color:var(--danger); font-size:1.2rem; cursor:pointer;">🗑️</button>
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
    await fetch(editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL, { method: editModeId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    showToast("Produto guardado!"); nav('view-search');
};

document.getElementById('form-worker').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('worker-name').value;
    await fetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome }) });
    document.getElementById('worker-name').value = ''; renderWorkers(); showToast("Funcionário adicionado!");
};

document.getElementById('form-tool-reg').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('reg-tool-name').value;
    await fetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify({ nome, status: 'disponivel' }) });
    document.getElementById('reg-tool-name').value = ''; renderAdminTools(); showToast("Ferramenta registada!");
};

// --- MODAL E ALOCAÇÃO ---
function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários primeiro", "error");
    toolToAllocate = id;
    const container = document.getElementById('worker-select-list');
    container.innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`).join('');
    document.getElementById('worker-modal').classList.add('active');
}
function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

async function assignTool(worker) {
    await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker }) });
    closeModal(); renderTools(); showToast(`Entregue a ${worker}`);
}

async function returnTool(id) {
    if(confirm("Confirmar devolução ao armazém?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
        renderTools(); showToast("Ferramenta devolvida!");
    }
}

async function deleteTool(id) { if(confirm("Apagar ferramenta do sistema?")) { await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' }); renderAdminTools(); } }
async function deleteWorker(id) { if(confirm("Apagar funcionário?")) { await fetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' }); renderWorkers(); } }

// --- SWIPE E TEMA ---
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
        content.style.transition = 'transform 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28)';
        if(currentX > 100 && !isScrolling) startEditMode(id);
        else if(currentX < -100 && !isScrolling) deleteItem(id, el);
        content.style.transform = 'translateX(0)';
    });
}

function toggleTheme() { document.body.classList.toggle('dark-mode'); localStorage.setItem('hiperfrio-tema', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); }
function resetRegisterForm(t) { editModeId = null; document.getElementById('form-add').reset(); document.getElementById('form-title').innerText = t; document.getElementById('inp-codigo').disabled = false; }
async function deleteItem(id, el) { if(confirm("Apagar este produto?")) { await fetch(`${BASE_URL}/stock/${id}.json`, {method:'DELETE'}); el.remove(); showToast("Removido!"); } }

function startEditMode(id) {
    const item = cachedData[id]; if(!item) return; editModeId = id;
    document.getElementById('form-title').innerText = "Editar Produto";
    document.getElementById('inp-codigo').value = item.codigo; document.getElementById('inp-codigo').disabled = true;
    document.getElementById('inp-nome').value = item.nome; document.getElementById('inp-tipo').value = item.tipo || '';
    document.getElementById('inp-loc').value = item.localizacao || ''; document.getElementById('inp-qtd').value = item.quantidade || 0;
    nav('view-register', true);
}

// --- START ---
document.addEventListener('DOMContentLoaded', () => {
    if(localStorage.getItem('hiperfrio-tema') === 'dark') { document.body.classList.add('dark-mode'); document.getElementById('theme-toggle').checked = true; }
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    document.getElementById('inp-search-tools').oninput = (e) => renderTools(e.target.value);
});
