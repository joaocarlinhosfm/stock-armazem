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

// NAVEGAÇÃO LIMPA
function nav(viewId) {
    // Esconde TUDO primeiro
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    // Mostra apenas o pretendido
    const target = document.getElementById(viewId);
    if(target) target.classList.add('active');
    
    // Carrega dados se necessário
    if(viewId === 'view-search') renderList();
    if(viewId === 'view-tools') renderTools();
    if(viewId === 'view-admin') { renderWorkers(); renderAdminTools(); }
    
    toggleMenu();
    window.scrollTo(0,0);
}

async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    if(!listEl) return;
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
                <div style="font-size:0.75rem; font-weight:800; color:var(--primary)">REF: ${item.codigo}</div>
                <div style="font-size:1.1rem; font-weight:700; margin:4px 0">${item.nome}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
                    <span style="font-size:0.85rem; color:var(--text-muted)">📍 ${item.localizacao || 'S/ LOC'}</span>
                    <div style="display:flex; align-items:center; gap:15px">
                        <button onclick="changeQtd('${id}', -1)" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border); background:var(--bg); color:var(--text-main); font-weight:bold;">−</button>
                        <span style="font-weight:800; font-size:1.1rem">${item.quantidade || 0}</span>
                        <button onclick="changeQtd('${id}', 1)" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border); background:var(--bg); color:var(--text-main); font-weight:bold;">+</button>
                    </div>
                </div>`;
            listEl.appendChild(el);
        });
    } catch (e) {}
}

async function renderTools(filter = "") {
    const list = document.getElementById('tools-list');
    if(!list) return;
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
            el.innerHTML = `<div><div style="font-weight:800;">${t.nome}</div><div style="font-size:0.8rem; opacity:0.8;">${isAv ? '📦 EM ARMAZÉM' : '👤 ' + t.colaborador.toUpperCase()}</div></div><span>${isAv ? '➔' : '↩'}</span>`;
            list.appendChild(el);
        });
    } catch(e) {}
}

async function renderAdminTools() {
    const list = document.getElementById('admin-tools-list');
    if(!list) return;
    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        list.innerHTML = '';
        if(!data) return;
        Object.entries(data).forEach(([id, t]) => {
            const row = document.createElement('div');
            row.style = "display:flex; justify-content:space-between; align-items:center; padding:12px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border)";
            row.innerHTML = `<span style="font-weight:600;">${t.nome}</span><button onclick="deleteTool('${id}')" style="background:none; border:none; color:var(--danger); font-size:1.2rem;">🗑️</button>`;
            list.appendChild(row);
        });
    } catch(e){}
}

async function renderWorkers() {
    const list = document.getElementById('workers-list');
    if(!list) return;
    try {
        const res = await fetch(`${BASE_URL}/funcionarios.json`);
        const data = await res.json();
        cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
        list.innerHTML = '';
        cachedWorkers.forEach(w => {
            list.innerHTML += `<div style="display:flex; justify-content:space-between; padding:12px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border)">
                <span style="font-weight:600;">👤 ${w.nome}</span>
                <button onclick="deleteWorker('${w.id}')" style="background:none; border:none; color:var(--danger); font-size:1.2rem;">🗑️</button>
            </div>`;
        });
    } catch(e){}
}

async function changeQtd(id, delta) {
    const res = await fetch(`${BASE_URL}/stock/${id}.json`);
    const item = await res.json();
    let n = Math.max(0, (item.quantidade || 0) + delta);
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: n }) });
    renderList(document.getElementById('inp-search').value);
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
    showToast("Produto guardado!"); nav('view-search');
};

document.getElementById('form-worker').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('worker-name').value;
    await fetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome }) });
    document.getElementById('worker-name').value = ''; renderWorkers();
};

document.getElementById('form-tool-reg').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('reg-tool-name').value;
    await fetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify({ nome, status: 'disponivel' }) });
    document.getElementById('reg-tool-name').value = ''; renderAdminTools();
};

function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários na Gestão", "error");
    toolToAllocate = id;
    const container = document.getElementById('worker-select-list');
    container.innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`).join('');
    document.getElementById('worker-modal').classList.add('active');
}
function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

async function assignTool(worker) {
    await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker }) });
    closeModal(); renderTools(); showToast("Entregue!");
}

async function returnTool(id) {
    if(confirm("Confirmar devolução?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
        renderTools(); showToast("Devolvida!");
    }
}

async function deleteTool(id) { if(confirm("Apagar ferramenta?")) { await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' }); renderAdminTools(); } }
async function deleteWorker(id) { if(confirm("Apagar funcionário?")) { await fetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' }); renderWorkers(); } }

function toggleTheme() { 
    document.body.classList.toggle('dark-mode'); 
    localStorage.setItem('hiperfrio-tema', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); 
}

document.addEventListener('DOMContentLoaded', () => {
    if(localStorage.getItem('hiperfrio-tema') === 'dark') { document.body.classList.add('dark-mode'); document.getElementById('theme-toggle').checked = true; }
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    document.getElementById('inp-search-tools').oninput = (e) => renderTools(e.target.value);
});
