
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
    const overlay = document.getElementById('menu-overlay');
    if(overlay) overlay.classList.toggle('active');
}

function nav(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    if(viewId === 'view-search') renderList();
    if(viewId === 'view-tools') renderTools();
    if(viewId === 'view-admin') { renderWorkers(); renderAdminTools(); }

    // Update sidebar active state
    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const viewToNavId = {
        'view-search': 'nav-search',
        'view-tools': 'nav-tools',
        'view-register': 'nav-register',
        'view-bulk': 'nav-bulk',
        'view-admin': 'nav-admin'
    };
    const navLi = document.getElementById(viewToNavId[viewId]);
    if(navLi) navLi.classList.add('active');

    // Update bottom nav active state
    document.querySelectorAll('.bottom-nav-item').forEach(btn => btn.classList.remove('active'));
    const viewToBnav = {
        'view-search': 'bnav-search',
        'view-tools': 'bnav-tools',
        'view-register': 'bnav-register',
        'view-bulk': 'bnav-bulk',
        'view-admin': 'bnav-admin'
    };
    const bnavBtn = document.getElementById(viewToBnav[viewId]);
    if(bnavBtn) bnavBtn.classList.add('active');

    // Close mobile menu if open
    const isDesktop = window.innerWidth >= 768;
    if(!isDesktop) toggleMenu();
    window.scrollTo(0,0);
}

// RENDERIZAR LISTA COMPACTA
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
                
                <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-muted); margin-bottom: 12px; line-height: 1.2;">
                    ${item.nome}
                </div>

                <hr style="border:0; border-top:1px solid var(--border); margin-bottom:10px; opacity: 0.5;">

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="loc-pill">
                        <span style="font-size: 0.85rem;">📍</span> 
                        ${item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL'}
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
    } catch (e) { console.error("Erro ao carregar o stock:", e); }
}

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(50);
    const res = await fetch(`${BASE_URL}/stock/${id}.json`);
    const item = await res.json();
    let n = Math.max(0, (item.quantidade || 0) + delta);
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: n }) });
    renderList(document.getElementById('inp-search').value);
}

// FERRAMENTAS & FUNCIONÁRIOS
async function renderTools() {
    const list = document.getElementById('tools-list');
    if(!list) return;
    const res = await fetch(`${BASE_URL}/ferramentas.json`);
    const data = await res.json();
    list.innerHTML = '';
    if(!data) return;
    
    Object.entries(data).reverse().forEach(([id, t]) => {
        const isAv = t.status === 'disponivel';
        list.innerHTML += `
            <div onclick="${isAv ? `openModal('${id}')` : `returnTool('${id}')`}" 
                 style="padding:14px; border-radius:14px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; background:${isAv ? '#dcfce7' : '#fee2e2'}; color:${isAv ? '#166534' : '#991b1b'}; border:1px solid ${isAv ? '#22c55e' : '#ef4444'}">
                <div>
                    <div style="font-weight:800; font-size:0.95rem;">${t.nome}</div>
                    <div style="font-size:0.75rem; margin-top:4px; font-weight:600;">
                        ${isAv ? '📦 EM ARMAZÉM' : '👤 ' + t.colaborador.toUpperCase()}
                    </div>
                </div>
                <span style="font-size:1.1rem;">${isAv ? '➔' : '↩'}</span>
            </div>`;
    });
}

async function renderWorkers() {
    const res = await fetch(`${BASE_URL}/funcionarios.json`);
    const data = await res.json();
    cachedWorkers = data ? Object.entries(data).map(([id, v]) => ({id, nome: v.nome})) : [];
    const list = document.getElementById('workers-list');
    if(!list) return;
    list.innerHTML = cachedWorkers.map(w => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border);">
            <span style="font-weight:600; font-size:0.9rem;">👤 ${w.nome}</span>
            <button onclick="deleteWorker('${w.id}')" style="color:var(--danger); background:none; border:none; font-size:1.1rem; cursor:pointer;">🗑️</button>
        </div>`).join('');
}

async function renderAdminTools() {
    const res = await fetch(`${BASE_URL}/ferramentas.json`);
    const data = await res.json();
    const list = document.getElementById('admin-tools-list');
    if(!list) return;
    list.innerHTML = data ? Object.entries(data).map(([id, t]) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:var(--bg); border-radius:10px; margin-bottom:8px; border:1px solid var(--border);">
            <span style="font-weight:600; font-size:0.9rem;">🪛 ${t.nome}</span>
            <button onclick="deleteTool('${id}')" style="color:var(--danger); background:none; border:none; font-size:1.1rem; cursor:pointer;">🗑️</button>
        </div>`).join('') : '';
}

// FORMULÁRIOS
const formAdd = document.getElementById('form-add');
if(formAdd) {
    formAdd.onsubmit = async (e) => {
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
}

const formWorker = document.getElementById('form-worker');
if(formWorker) {
    formWorker.onsubmit = async (e) => {
        e.preventDefault();
        await fetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome: document.getElementById('worker-name').value }) });
        document.getElementById('worker-name').value = ''; renderWorkers(); showToast("Adicionado");
    };
}

const formToolReg = document.getElementById('form-tool-reg');
if(formToolReg) {
    formToolReg.onsubmit = async (e) => {
        e.preventDefault();
        await fetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify({ nome: document.getElementById('reg-tool-name').value, status: 'disponivel' }) });
        document.getElementById('reg-tool-name').value = ''; renderAdminTools(); showToast("Ferramenta registada");
    };
}

// MODAL FERRAMENTAS
function openModal(id) {
    if(cachedWorkers.length === 0) return showToast("Adicione funcionários na Gestão", "error");
    toolToAllocate = id;
    document.getElementById('worker-select-list').innerHTML = cachedWorkers.map(w => 
        `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`
    ).join('');
    document.getElementById('worker-modal').classList.add('active');
}
function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

async function assignTool(worker) {
    await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker }) });
    closeModal(); renderTools(); showToast(`Entregue a ${worker}!`);
}
async function returnTool(id) {
    if(confirm("Confirmar devolução?")) {
        await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
        renderTools(); showToast("Devolvida!");
    }
}

async function deleteTool(id) { if(confirm("Apagar ferramenta?")) { await fetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' }); renderAdminTools(); } }
async function deleteWorker(id) { if(confirm("Apagar funcionário?")) { await fetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' }); renderWorkers(); } }

function toggleTheme(fromDesktop = false) { 
    document.body.classList.toggle('dark-mode'); 
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
    // Sync both toggles
    const t1 = document.getElementById('theme-toggle');
    const t2 = document.getElementById('theme-toggle-desktop');
    if(t1) t1.checked = isDark;
    if(t2) t2.checked = isDark;
}

// INICIALIZAÇÃO
document.addEventListener('DOMContentLoaded', () => {
    if(localStorage.getItem('hiperfrio-tema') === 'dark') { 
        document.body.classList.add('dark-mode'); 
        const t1 = document.getElementById('theme-toggle');
        const t2 = document.getElementById('theme-toggle-desktop');
        if(t1) t1.checked = true;
        if(t2) t2.checked = true;
    }
    renderList();
    const searchInput = document.getElementById('inp-search');
    if(searchInput) searchInput.oninput = (e) => renderList(e.target.value);
});

// REGISTO PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('PWA Service Worker registado'))
            .catch(err => console.warn('PWA: Erro no Service Worker', err));
    });
}

