const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

let editModeId = null; 
let cachedData = {};   
let cachedWorkers = []; // Guarda os funcionários
let toolToAllocate = null; // ID da ferramenta que estamos a alocar

// --- SISTEMA DE NOTIFICAÇÕES ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- TEMA ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
}
(function(){ if(localStorage.getItem('hiperfrio-tema')==='dark') { document.body.classList.add('dark-mode'); const t = document.getElementById('theme-toggle'); if(t) t.checked = true; } })();

// --- NAVEGAÇÃO ---
function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function nav(viewId, isEdit = false) {
    if (viewId === 'view-register' && !isEdit) resetRegisterForm("Novo Produto");
    
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    // Atualiza dados consoante a vista aberta
    if(viewId === 'view-search') renderList();
    if(viewId === 'view-tools') renderTools();
    if(viewId === 'view-workers') renderWorkers();
    
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
    window.scrollTo(0,0);
}

// ==========================================
// MÓDULO 1: ARMAZÉM E STOCK (Mantido igual)
// ==========================================
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {}; 
        listEl.innerHTML = ''; 
        if (!data) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Sem produtos.</div>';

        const itens = Object.entries(data).map(([id, val]) => ({ id, ...val })).filter(i => (i.nome && i.nome.toLowerCase().includes(filter.toLowerCase())) || (i.codigo && String(i.codigo).toUpperCase().includes(filter.toUpperCase()))).reverse();

        itens.forEach(item => {
            const el = document.createElement('div'); el.className = 'item-card'; el.dataset.id = item.id;
            const qtd = item.quantidade || 0; const lowStockClass = qtd === 0 ? 'low-stock' : '';
            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                <div class="card-content">
                    <div style="display:flex; flex-direction:column; margin-bottom:12px;">
                        <span style="font-size:0.75rem; font-weight:800; color:var(--primary);">REF: ${item.codigo}</span>
                        <span style="font-size:1.05rem; font-weight:600;">${item.nome}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="background:var(--primary-soft); color:var(--primary); padding:6px 10px; border-radius:8px; font-size:0.8rem; font-weight:700;">📍 ${item.localizacao || 'S/ LOC'}</div>
                        <div style="display:flex; align-items:center; gap:12px; background:var(--bg); padding:4px 8px; border-radius:12px;">
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', -1)" style="width:32px; height:32px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">−</button>
                            <span class="qtd-value ${lowStockClass}" data-id="${item.id}">${qtd}</span>
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', 1)" style="width:32px; height:32px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">+</button>
                        </div>
                    </div>
                </div>`;
            listEl.appendChild(el); setupSwipe(el, item.id);
        });
    } catch (e) { showToast("Erro ao carregar.", "error"); }
}

function setupSwipe(el, id) { /* ... mantida a lógica do Android Scroll ... */
    const content = el.querySelector('.card-content');
    let startX = 0, startY = 0, currentX = 0, isScrolling = false;
    content.addEventListener('touchstart', e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; isScrolling = false; content.style.transition = 'none'; }, {passive: true});
    content.addEventListener('touchmove', e => {
        currentX = e.touches[0].clientX - startX;
        if (Math.abs(e.touches[0].clientY - startY) > Math.abs(currentX)) isScrolling = true;
        if (!isScrolling) content.style.transform = `translateX(${currentX}px)`;
    }, {passive: true});
    content.addEventListener('touchend', () => {
        content.style.transition = 'transform 0.3s ease';
        if (!isScrolling) { if (currentX > 80) startEditMode(id); else if (currentX < -80) deleteItem(id, el); }
        content.style.transform = `translateX(0px)`; currentX = 0;
    });
}

async function changeQtd(id, delta) {
    const span = document.querySelector(`.qtd-value[data-id="${id}"]`); if(!span) return;
    let novaQtd = Math.max(0, parseInt(span.innerText) + delta);
    span.innerText = novaQtd; novaQtd === 0 ? span.classList.add('low-stock') : span.classList.remove('low-stock');
    try { await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) }); } catch (e) { showToast("Erro.", "error"); }
}

function startEditMode(id) {
    const item = cachedData[id]; if (!item) return; editModeId = id; 
    document.getElementById('form-title').innerText = "Editar Produto"; document.getElementById('btn-form-submit').innerText = "Guardar Alterações";
    document.getElementById('inp-codigo').value = item.codigo; document.getElementById('inp-codigo').disabled = true; 
    document.getElementById('inp-nome').value = item.nome; document.getElementById('inp-tipo').value = item.tipo || ''; document.getElementById('inp-loc').value = item.localizacao || '';
    document.getElementById('inp-qtd').value = item.quantidade; document.getElementById('inp-qtd').disabled = false;
    nav('view-register', true);
}
function resetRegisterForm(t) { editModeId = null; document.getElementById('form-add').reset(); document.getElementById('form-title').innerText = t; document.getElementById('inp-codigo').disabled = false; }

document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = { nome: document.getElementById('inp-nome').value, tipo: document.getElementById('inp-tipo').value, localizacao: document.getElementById('inp-loc').value.toUpperCase(), quantidade: parseInt(document.getElementById('inp-qtd').value) || 0 };
    if (editModeId === null) payload.codigo = document.getElementById('inp-codigo').value.toUpperCase();
    try { await fetch(editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL, { method: editModeId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); showToast("Gravado!"); nav('view-search'); } catch (err) { showToast("Erro.", "error"); }
};

document.getElementById('form-bulk').onsubmit = async (e) => { 
    e.preventDefault(); const qi = document.getElementById('bulk-qtd');
    const item = { codigo: document.getElementById('bulk-codigo').value.toUpperCase(), nome: document.getElementById('bulk-nome').value, localizacao: document.getElementById('bulk-loc').value.toUpperCase(), quantidade: (qi && qi.value) ? parseInt(qi.value) : 0 }; 
    try { await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); showToast("Lote adicionado!"); document.getElementById('bulk-codigo').value = ""; document.getElementById('bulk-nome').value = ""; if(qi) qi.value = ""; document.getElementById('bulk-codigo').focus(); } catch(err) { showToast("Erro.", "error"); }
};

async function deleteItem(id, el) { if(confirm("Apagar produto?")) { el.style.opacity='0.3'; try { await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' }); el.remove(); showToast("Removido."); } catch(e) { el.style.opacity='1'; } } }

// ==========================================
// MÓDULO 2: FERRAMENTAS & FUNCIONÁRIOS
// ==========================================

// 1. CARREGAR FUNCIONÁRIOS (Usado no modal)
async function fetchWorkersData() {
    try {
        const res = await fetch(`${BASE_URL}/funcionarios.json`);
        const data = await res.json();
        cachedWorkers = data ? Object.entries(data).map(([id, val]) => ({ id, nome: val.nome })).sort((a,b) => a.nome.localeCompare(b.nome)) : [];
    } catch(e) { console.error("Erro a carregar funcionários"); }
}

// 2. RENDERIZAR VISTA DE FERRAMENTAS (Cores Verdes e Vermelhas)
async function renderTools(filter = "") {
    const listEl = document.getElementById('tools-list');
    listEl.innerHTML = "<div style='text-align:center; padding:20px;'>A carregar...</div>";
    await fetchWorkersData(); // Garante que temos a lista de funcionários pronta

    try {
        const res = await fetch(`${BASE_URL}/ferramentas.json`);
        const data = await res.json();
        listEl.innerHTML = '';
        
        if (!data) return listEl.innerHTML = '<div style="text-align:center; padding:20px; color:gray;">Nenhuma ferramenta registada.</div>';

        const itens = Object.entries(data).map(([id, val]) => ({ id, ...val })).filter(i => i.nome.toLowerCase().includes(filter.toLowerCase())).reverse();

        itens.forEach(tool => {
            const isAvailable = tool.status === 'disponivel';
            const cardClass = isAvailable ? 'tool-available' : 'tool-allocated';
            const statusText = isAvailable ? 'No Armazém' : `Com: ${tool.colaborador}`;
            const icon = isAvailable ? '📦' : '👤';

            // O onClick do cartão decide a ação baseada no estado
            const action = isAvailable ? `openWorkerModal('${tool.id}')` : `returnTool('${tool.id}')`;

            const el = document.createElement('div');
            el.className = `tool-card ${cardClass}`;
            el.setAttribute('onclick', action);
            
            el.innerHTML = `
                <div class="tool-info">
                    <h3>${tool.nome}</h3>
                    <div class="tool-status">${icon} ${statusText}</div>
                </div>
                <div style="font-size:1.5rem; opacity:0.5;">
                    ${isAvailable ? '➔' : '↩'}
                </div>
            `;
            listEl.appendChild(el);
        });
    } catch (e) { listEl.innerHTML = "<div style='color:red; text-align:center;'>Erro de rede.</div>"; }
}

// 3. REGISTAR NOVA FERRAMENTA NO INVENTÁRIO (Sempre nasce 'disponivel')
document.getElementById('form-tool-reg').onsubmit = async (e) => {
    e.preventDefault();
    const payload = { nome: document.getElementById('reg-tool-name').value, status: 'disponivel', colaborador: '' };
    try {
        await fetch(`${BASE_URL}/ferramentas.json`, { method: 'POST', body: JSON.stringify(payload) });
        showToast("Ferramenta registada no armazém!");
        e.target.reset(); nav('view-tools');
    } catch (e) { showToast("Erro ao registar", "error"); }
};

// 4. LÓGICA DO MODAL (Atribuir a Funcionário)
function openWorkerModal(toolId) {
    if(cachedWorkers.length === 0) return alert("Primeiro adicione funcionários no menu 'Gerir Funcionários'!");
    toolToAllocate = toolId;
    const list = document.getElementById('worker-select-list');
    list.innerHTML = cachedWorkers.map(w => `<div class="worker-option" onclick="assignTool('${w.nome}')">👤 ${w.nome}</div>`).join('');
    document.getElementById('worker-modal').classList.add('active');
}

function closeModal() { document.getElementById('worker-modal').classList.remove('active'); toolToAllocate = null; }

async function assignTool(workerName) {
    closeModal();
    try {
        await fetch(`${BASE_URL}/ferramentas/${toolToAllocate}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: workerName }) });
        showToast(`Entregue a ${workerName}`);
        renderTools(); // Atualiza a cor para vermelho
    } catch (e) { showToast("Erro ao alocar", "error"); }
}

// 5. DEVOLVER FERRAMENTA (Volta a verde)
async function returnTool(toolId) {
    if(confirm("Confirmar a devolução ao armazém?")) {
        try {
            await fetch(`${BASE_URL}/ferramentas/${toolId}.json`, { method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '' }) });
            showToast("Recebida no armazém!");
            renderTools(); // Atualiza a cor para verde
        } catch(e) { showToast("Erro", "error"); }
    }
}

// 6. GESTÃO DE FUNCIONÁRIOS (Ver, Adicionar, Apagar)
async function renderWorkers() {
    await fetchWorkersData();
    const listEl = document.getElementById('workers-list');
    listEl.innerHTML = cachedWorkers.length === 0 ? '<div style="text-align:center; color:gray;">Sem funcionários.</div>' : '';
    
    cachedWorkers.forEach(w => {
        listEl.innerHTML += `
            <div class="worker-card">
                <span>👤 ${w.nome}</span>
                <button onclick="deleteWorker('${w.id}')" style="background:none; border:none; color:var(--danger); font-size:1.2rem; cursor:pointer;">🗑️</button>
            </div>`;
    });
}

document.getElementById('form-worker').onsubmit = async (e) => {
    e.preventDefault();
    try {
        await fetch(`${BASE_URL}/funcionarios.json`, { method: 'POST', body: JSON.stringify({ nome: document.getElementById('worker-name').value }) });
        showToast("Funcionário adicionado!"); document.getElementById('worker-name').value = ''; renderWorkers();
    } catch(e) { showToast("Erro", "error"); }
};

async function deleteWorker(id) {
    if(confirm("Apagar funcionário da lista?")) {
        try { await fetch(`${BASE_URL}/funcionarios.json/${id}.json`, { method: 'DELETE' }); showToast("Apagado."); renderWorkers(); } catch(e){}
    }
}

// Ligar as barras de pesquisa
document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
document.getElementById('inp-search-tools').oninput = (e) => renderTools(e.target.value);

// --- ARRANQUE ---
document.addEventListener('DOMContentLoaded', () => {
    renderList();
    if (navigator.onLine) { const p = document.getElementById('status-ponto'); if(p) p.style.background = "#22c55e"; }
});
