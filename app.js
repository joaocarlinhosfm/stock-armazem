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
                <div class="ref-label">REFERÊNCIA</div>
                <div class="ref-value">${String(item.codigo).toUpperCase()}</div>
                
                <div style="font-size: 1rem; font-weight: 600; color: var(--text-muted); margin-bottom: 15px;">
                    ${item.nome}
                </div>

                <hr style="border:0; border-top:1px solid var(--border); margin-bottom:15px;">

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="loc-pill">
                        <span>📍</span> ${item.localizacao || 'SEM LOCAL'}
                    </div>
                    
                    <div class="qty-pill-box">
                        <button class="btn-qty" onclick="changeQtd('${id}', -1)">−</button>
                        <span class="qty-display">${item.quantidade || 0}</span>
                        <button class="btn-qty" onclick="changeQtd('${id}', 1)">+</button>
                    </div>
                </div>
            `;
            listEl.appendChild(el);
        });
    } catch (e) { console.error(e); }
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
        list.innerHTML += `
            <div onclick="${isAv ? `openModal('${id}')` : `returnTool('${id}')`}" 
                 style="padding:18px; border-radius:16px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; background:${isAv ? '#dcfce7' : '#fee2e2'}; color:${isAv ? '#166534' : '#991b1b'}; border:1px solid ${isAv ? '#22c55e' : '#ef4444'}">
                <div><div style="font-weight:800;">${t.nome}</div><div style="font-size:0.8rem;">${isAv ? 'EM ARMAZÉM' : t.colaborador.toUpperCase()}</div></div>
                <span>${isAv ? '➔' : '↩'}</span>
            </div>`;
    });
}

async function renderWorkers() {
    const res = await fetch(`${BASE_URL}/funcionarios.json`);
    const data = await res.json();
    cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
    const list = document.getElementById('workers-list');
    list.innerHTML = cachedWorkers.map(w => `<div style="display:flex; justify-content:space-between; padding:12px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border);"><span style="font-weight:600;">👤 ${w.nome}</span><button onclick="deleteWorker('${w.id}')" style="color:var(--danger); background:none; border:none; font-size:1.2rem;">🗑️</button></div>`).join('');
}

async function renderAdminTools() {
    const res = await fetch(`${BASE_URL}/ferramentas.json`);
    const data = await res.json();
    const list = document.getElementById('admin-tools-list');
    list.innerHTML = data ? Object.entries(data).map(([id, t]) => `<div style="display:flex; justify-content:space-between; padding:12px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border);"><span style="font-weight:600;">🪛 ${t.nome}</span><button onclick="deleteTool('${id}')" style="color:var(--danger); background:none; border:none; font-size:1.2rem;">🗑️</button></div>`).join('') : '';
}

document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value || 'Geral',
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0,
        codigo: document.getElementById('inp-codigo').value.toUpperCase()
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(payload) });
    showToast("Produto Registado!"); nav('view-search'); e.target.reset();
};

function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários na Gestão", "error");
    toolToAllocate = id;
    document.getElementById('worker-select-list').innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`).join('');
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
    if(localStorage.getItem('hiperfrio-tema') === 'dark') { document.body.classList.add('dark-mode'); }
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
});
