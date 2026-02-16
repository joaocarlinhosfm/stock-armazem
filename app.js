// --- CONFIGURAÇÃO ---
const LINK_FIREBASE = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const BASE_URL = LINK_FIREBASE.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO E MENU ---
function toggleMenu() {
    const menu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    menu.classList.toggle('open');
    overlay.classList.toggle('active');
}

function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        if(viewId === 'view-main') renderList();
    }
    // Fecha o menu lateral após clicar
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

// --- LÓGICA DE DADOS ---
async function getStock() {
    try {
        const response = await fetch(DB_URL);
        const data = await response.json();
        return data ? Object.keys(data).map(key => ({ fireId: key, ...data[key] })) : [];
    } catch (e) { return []; }
}

async function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
    listEl.innerHTML = '<p style="text-align:center;">A carregar stock...</p>';
    
    const stock = await getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(i => 
        (i.nome?.toLowerCase().includes(term)) || 
        (i.codigo?.toLowerCase().includes(term)) || 
        (i.localizacao?.toLowerCase().includes(term))
    );

    listEl.innerHTML = filtered.length ? '' : '<p style="text-align:center;">Vazio.</p>';

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}</h3>
                <p>REF: <strong>${item.codigo || '---'}</strong> | 📍 ${item.localizacao || '---'}</p>
                <div class="qtd-control">
                    <button class="btn-qtd" onclick="updateQuantity('${item.fireId}', -1)">-</button>
                    <span class="qtd-value">${item.quantidade || 0}</span>
                    <button class="btn-qtd" onclick="updateQuantity('${item.fireId}', 1)">+</button>
                </div>
            </div>
            <button style="position:absolute; top:10px; right:10px; background:none; border:none; color:#ccc;" onclick="deleteItem('${item.fireId}')">✕</button>
        `;
        listEl.appendChild(div);
    });
}

// --- QUANTIDADE RÁPIDA ---
window.updateQuantity = async function(id, change) {
    const url = `${BASE_URL}/stock/${id}.json`;
    const resp = await fetch(url);
    const item = await resp.json();
    let novaQtd = (item.quantidade || 0) + change;
    if (novaQtd < 0) novaQtd = 0;
    await fetch(url, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
    renderList(document.getElementById('inp-search').value);
};

// --- REGISTOS (Único e Bulk) ---
document.getElementById('form-register')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = {
        codigo: document.getElementById('inp-codigo').value.toUpperCase(),
        nome: document.getElementById('inp-nome').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
    e.target.reset();
    nav('view-main');
});

document.getElementById('form-bulk')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('bulk-feedback');
    const codigoInput = document.getElementById('bulk-codigo');
    const nomeInput = document.getElementById('bulk-nome');
    const item = {
        codigo: codigoInput.value.toUpperCase(),
        nome: nomeInput.value,
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(),
        quantidade: 0
    };
    feedback.innerText = "A gravar...";
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
    codigoInput.value = ''; nomeInput.value = ''; codigoInput.focus();
    feedback.innerText = `✔ ${item.codigo} guardado!`;
});

// --- INICIALIZAÇÃO ---
document.getElementById('inp-search').addEventListener('input', (e) => renderList(e.target.value));
document.addEventListener('DOMContentLoaded', () => {
    renderList(); // Carrega logo a lista ao abrir
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
});
