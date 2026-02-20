const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

let cachedWorkers = [];
let toolToAllocate = null;

function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    if(type === 'error') t.style.borderLeftColor = 'var(--danger)';
    t.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function nav(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(viewId === 'view-search') renderList();
    if(viewId === 'view-tools') renderTools();
    if(viewId === 'view-admin') { renderWorkers(); renderAdminTools(); }
    toggleMenu();
    window.scrollTo(0,0);
}

async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        listEl.innerHTML = '';
        if(!data) return;
        Object.entries(data).reverse().forEach(([id, item]) => {
            if(filter && !item.nome.toLowerCase().includes(filter.toLowerCase()) && !String(item.codigo).toUpperCase().includes(filter.toUpperCase())) return;
            const el = document.createElement('div');
            el.className = 'item-card';
            el.innerHTML = `
                <div style="font-size:0.7rem; font-weight:800; color:var(--primary)">REF: ${item.codigo}</div>
                <div style="font-size:1.1rem; font-weight:700; margin:4px 0">${item.nome}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
                    <span style="font-size:0.8rem; color:var(--text-muted)">📍 ${item.localizacao || 'S/ LOC'}</span>
                    <div style="display:flex; align-items:center; gap:12px">
                        <button onclick="changeQtd('${id}', -1)" style="width:34px; height:34px; border-radius:50%; border:1px solid var(--border); background:var(--bg); color:var(--text-main); font-weight:bold;">−</button>
                        <span style="font-weight:800;">${item.quantidade || 0}</span>
                        <button onclick="changeQtd('${id}', 1)" style="width:34px; height:34px; border-radius:50%; border:1px solid var(--border); background:var(--bg); color:var(--text-main); font-weight:bold;">+</button>
                    </div>
                </div>`;
            listEl.appendChild(el);
        });
    } catch (e) {}
}

async function changeQtd(id, delta) {
    const res = await fetch(`${BASE_URL}/stock/${id}.json`);
    const item = await res.json();
    let n = Math.max(0, (item.quantidade || 0) + delta);
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: n }) });
    renderList(document.getElementById('inp-search').value);
}

async function renderTools() {
    const list = document.getElementById('tools-list');
    const res = await fetch(`${BASE_URL}/ferramentas.json`);
    const data = await res.json();
    list.innerHTML = '';
    if(!data) return;
    Object.entries(data).reverse().forEach(([id, t]) => {
        const isAv = t.status === 'disponivel';
        const el = document.createElement('div');
        el.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}`;
        el.onclick = () => isAv ? openModal(id) : returnTool(id);
        el.innerHTML = `<div><div style="font-weight:800;">${t.nome}</div><div style="font-size:0.8rem;">${isAv ? 'DISPONÍVEL' : t.colaborador}</div></div><span>${isAv ? '➔' : '↩'}</span>`;
        list.appendChild(el);
    });
}

async function renderWorkers() {
    const res = await fetch(`${BASE_URL}/funcionarios.json`);
    const data = await res.json();
    cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
    const list = document.getElementById('workers-list');
    list.innerHTML = cachedWorkers.map(w => `<div style="display:flex; justify-content:space-between; padding:10px; background:var(--bg); border-radius:10px; margin-bottom:5px;"><span>${w.nome}</span><button onclick="deleteWorker('${w.id}')" style="color:red; background:none; border:none;">🗑️</button></div>`).join('');
}

async function renderAdminTools() {
    const res = await fetch(`${BASE_URL}/ferramentas.json`);
    const data = await res.json();
    const list = document.getElementById('admin-tools-list');
    list.innerHTML = data ? Object.entries(data).map(([id, t]) => `<div style="display:flex; justify-content:space-between; padding:10px; background:var(--bg); border-radius:10px; margin-bottom:5px;"><span>${t.nome}</span><button onclick="deleteTool('${id}')" style="color:red; background:none; border:none;">🗑️</button></div>`).join('') : '';
}

document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0,
        codigo: document.getElementById('inp-codigo').value.toUpperCase()
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
    showToast("Sucesso!"); nav('view-search'); e.target.reset();
};

function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários na Gestão", "error");
    toolToAllocate = id;
    document.getElementById('worker-select-list').innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">${w.nome}</div>`).join('');
    document.getElementById('worker-modal').classList.add('active');
}

function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

async function assignTool(worker) {
    await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker }) });
    closeModal(); renderTools();
}

async function returnTool(id) {
    if(confirm("Confirmar devolução?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
        renderTools();
    }
}

async function deleteTool(id) { if(confirm("Apagar?")) { await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' }); renderAdminTools(); } }
async function deleteWorker(id) { if(confirm("Apagar?")) { await fetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' }); renderWorkers(); } }

function toggleTheme() { document.body.classList.toggle('dark-mode'); }

document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
});
