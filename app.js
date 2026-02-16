const FIREBASE_LINK = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const BASE_URL = FIREBASE_LINK.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

// Navegação entre ecrãs
function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        // Sempre que mudamos de vista, atualizamos o dropdown e a lista
        atualizarSugestoes();
        if(viewId === 'view-search') renderList();
    }
}

// Estado da Internet
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

// Buscar Stock ao Firebase
async function getStock() {
    try {
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        return data ? Object.keys(data).map(k => ({ fireId: k, ...data[k] })) : [];
    } catch (e) { return []; }
}

// DROPDOWN INTELIGENTE
async function atualizarSugestoes() {
    const stock = await getStock();
    const dl = document.getElementById('lista-sugestoes');
    if (!dl) return;
    
    dl.innerHTML = '';
    // Pegamos nos nomes únicos já existentes
    const nomesUnicos = [...new Set(stock.map(item => item.nome))];
    
    nomesUnicos.forEach(nome => {
        const opt = document.createElement('option');
        opt.value = nome;
        dl.appendChild(opt);
    });
}

// Renderizar Lista
async function renderList(filter = '') {
    const list = document.getElementById('stock-list');
    list.innerHTML = '<p style="text-align:center;">A carregar nuvem...</p>';
    const stock = await getStock();
    const term = filter.toLowerCase();

    const filtered = stock.filter(i => 
        (i.nome || "").toLowerCase().includes(term) || 
        (i.localizacao || "").toLowerCase().includes(term) ||
        (i.tipo || "").toLowerCase().includes(term)
    );

    list.innerHTML = '';
    if(filtered.length === 0) {
        list.innerHTML = '<p style="text-align:center; color:#888;">Nenhum item encontrado.</p>';
        return;
    }

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

// Botões + e -
window.updateQtd = async function(id, change) {
    if(!navigator.onLine) return alert("Sem ligação à internet!");
    try {
        const url = `${BASE_URL}/stock/${id}.json`;
        const resp = await fetch(url);
        const item = await resp.json();
        let novaQtd = (item.quantidade || 0) + change;
        if(novaQtd < 0) novaQtd = 0;
        
        await fetch(url, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
        renderList(document.getElementById('inp-search').value);
    } catch (e) { alert("Erro ao atualizar stock."); }
};

// Form de Registo
const form = document.getElementById('form-register');
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = {
        nome: document.getElementById('inp-nome').value.trim(),
        tipo: document.getElementById('inp-tipo').value.trim(),
        localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    
    try {
        await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
        alert("Registo concluído!");
        form.reset();
        nav('view-home');
    } catch(e) { alert("Erro ao guardar online."); }
});

// Apagar Item
window.deleteItem = async function(id) {
    if(confirm("Deseja eliminar este produto definitivamente?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList(document.getElementById('inp-search').value);
        atualizarSugestoes();
    }
};

// Input de Pesquisa Dinâmica
document.getElementById('inp-search').addEventListener('input', (e) => renderList(e.target.value));

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    atualizarStatusRede();
    atualizarSugestoes();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
});
