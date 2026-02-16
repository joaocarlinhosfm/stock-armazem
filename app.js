const FIREBASE_LINK = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; // Ex: https://projeto.firebasedatabase.app
const BASE_URL = FIREBASE_LINK.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        if(viewId === 'view-search') renderList();
    }
}

function atualizarStatusRede() {
    const ponto = document.getElementById('status-ponto');
    const txt = document.getElementById('status-texto');
    if (navigator.onLine) {
        document.body.classList.remove('offline');
        ponto.style.backgroundColor = "#4CAF50";
        txt.innerText = "Online";
    } else {
        document.body.classList.add('offline');
        ponto.style.backgroundColor = "#f44336";
        txt.innerText = "Offline";
    }
}
window.addEventListener('online', atualizarStatusRede);
window.addEventListener('offline', atualizarStatusRede);

async function getStock() {
    try {
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        return data ? Object.keys(data).map(k => ({ fireId: k, ...data[k] })) : [];
    } catch (e) { return []; }
}

async function renderList(filter = '') {
    const list = document.getElementById('stock-list');
    list.innerHTML = '<p style="text-align:center;">A carregar...</p>';
    const stock = await getStock();
    const term = filter.toLowerCase();

    const filtered = stock.filter(i => 
        (i.nome || "").toLowerCase().includes(term) || 
        (i.localizacao || "").toLowerCase().includes(term)
    );

    list.innerHTML = '';
    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        const qtd = item.quantidade || 0;
        
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}</h3>
                <p>${item.tipo} | 📍 ${item.localizacao || '---'}</p>
                <div class="qtd-control">
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', -1)">-</button>
                    <span class="qtd-value">${qtd}</span>
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', 1)">+</button>
                </div>
            </div>
            <button class="btn-delete" onclick="deleteItem('${item.fireId}')">Apagar</button>
        `;
        list.appendChild(div);
    });
}

window.updateQtd = async function(id, change) {
    if(!navigator.onLine) return alert("Sem ligação!");
    try {
        const url = `${BASE_URL}/stock/${id}.json`;
        const resp = await fetch(url);
        const item = await resp.json();
        let novaQtd = (item.quantidade || 0) + change;
        if(novaQtd < 0) novaQtd = 0;
        
        await fetch(url, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
        renderList(document.getElementById('inp-search').value);
    } catch (e) { alert("Erro ao atualizar."); }
};

const form = document.getElementById('form-register');
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = {
        nome: document.getElementById('inp-nome').value.trim(),
        tipo: document.getElementById('inp-tipo').value.trim(),
        localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
    form.reset();
    nav('view-home');
});

window.deleteItem = async function(id) {
    if(confirm("Apagar produto?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList();
    }
};

document.getElementById('inp-search').addEventListener('input', (e) => renderList(e.target.value));
document.addEventListener('DOMContentLoaded', () => {
    atualizarStatusRede();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
});
