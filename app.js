const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

let editModeId = null; 
let cachedData = {};   

// NOTIFICAÇÕES
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '❌'}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// TEMA
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
}
(function(){ if(localStorage.getItem('hiperfrio-tema')==='dark') document.body.classList.add('dark-mode'); })();

// NAVEGAÇÃO
function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function nav(viewId, isEdit = false) {
    if (viewId === 'view-register' && !isEdit) resetRegisterForm("Novo Produto");
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(viewId === 'view-search') renderList();
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

// LISTA E SWIPE
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {}; 
        listEl.innerHTML = '';
        if (!data) return;

        Object.entries(data).reverse().forEach(([id, item]) => {
            if (filter && !item.nome.toLowerCase().includes(filter.toLowerCase()) && !item.codigo.toLowerCase().includes(filter.toLowerCase())) return;
            
            const el = document.createElement('div');
            el.className = 'item-card';
            const lowStockClass = item.quantidade === 0 ? 'low-stock' : '';

            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                <div class="card-content">
                    <div style="display:flex; flex-direction:column; margin-bottom:10px;">
                        <small style="color:var(--primary); font-weight:800;">${item.codigo}</small>
                        <strong style="font-size:1.1rem;">${item.nome}</strong>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="background:var(--primary-soft); padding:4px 8px; border-radius:6px; font-size:0.8rem;">📍 ${item.localizacao || 'S/ LOC'}</span>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <button onclick="changeQtd('${id}', -1)" style="width:30px; height:30px; border-radius:50%; border:1px solid var(--border); background:none; color:var(--text-main);">-</button>
                            <span class="qtd-val ${lowStockClass}" data-id="${id}">${item.quantidade}</span>
                            <button onclick="changeQtd('${id}', 1)" style="width:30px; height:30px; border-radius:50%; border:1px solid var(--border); background:none; color:var(--text-main);">+</button>
                        </div>
                    </div>
                </div>`;
            listEl.appendChild(el);
            setupSwipe(el, id);
        });
    } catch (e) { showToast("Erro ao carregar stock", "error"); }
}

function setupSwipe(el, id) {
    const content = el.querySelector('.card-content');
    let startX = 0, currentX = 0;
    content.addEventListener('touchstart', e => startX = e.touches[0].clientX);
    content.addEventListener('touchmove', e => {
        currentX = e.touches[0].clientX - startX;
        if(Math.abs(currentX) > 20) content.style.transform = `translateX(${currentX}px)`;
    });
    content.addEventListener('touchend', () => {
        if (currentX > 80) startEditMode(id);
        else if (currentX < -80) deleteItem(id, el);
        content.style.transform = `translateX(0px)`;
        currentX = 0;
    });
}

// EDIÇÃO E BOTÕES QTD
async function changeQtd(id, delta) {
    const span = document.querySelector(`.qtd-val[data-id="${id}"]`);
    let novaQtd = Math.max(0, parseInt(span.innerText) + delta);
    span.innerText = novaQtd;
    novaQtd === 0 ? span.classList.add('low-stock') : span.classList.remove('low-stock');
    try { await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) }); } 
    catch(e) { showToast("Erro ao gravar", "error"); }
}

function startEditMode(id) {
    const item = cachedData[id];
    editModeId = id;
    document.getElementById('form-title').innerText = "Editar Produto";
    document.getElementById('inp-codigo').value = item.codigo;
    document.getElementById('inp-codigo').disabled = true;
    document.getElementById('inp-nome').value = item.nome;
    document.getElementById('inp-tipo').value = item.tipo || '';
    document.getElementById('inp-loc').value = item.localizacao || '';
    document.getElementById('inp-qtd').value = item.quantidade;
    document.getElementById('inp-qtd').disabled = false;
    nav('view-register', true);
}

function resetRegisterForm(title) {
    editModeId = null;
    document.getElementById('form-add').reset();
    document.getElementById('form-title').innerText = title;
    document.getElementById('inp-codigo').disabled = false;
    document.getElementById('inp-qtd').disabled = false;
}

// SUBMISSÕES
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    if (!editModeId) payload.codigo = document.getElementById('inp-codigo').value.toUpperCase();

    const url = editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL;
    try {
        await fetch(url, { method: editModeId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
        showToast("Gravado com sucesso!");
        nav('view-search');
    } catch(e) { showToast("Erro ao guardar", "error"); }
};

document.getElementById('form-bulk').onsubmit = async (e) => {
    e.preventDefault();
    const item = {
        codigo: document.getElementById('bulk-codigo').value.toUpperCase(),
        nome: document.getElementById('bulk-nome').value,
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('bulk-qtd').value) || 0
    };
    try {
        await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
        showToast("Lote adicionado!");
        document.getElementById('bulk-codigo').value = '';
        document.getElementById('bulk-nome').value = '';
        document.getElementById('bulk-qtd').value = '';
        document.getElementById('bulk-codigo').focus();
    } catch(e) { showToast("Erro no lote", "error"); }
};

async function deleteItem(id, el) {
    if(confirm("Apagar item?")) {
        el.remove();
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        showToast("Item removido");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    if (navigator.onLine) document.getElementById('status-ponto').style.background = "#22c55e";
});
