// --- CONFIGURAÇÃO ---
// Não te preocupes com a barra / no fim do link, o código corrige sozinho
const LINK_O_TEU_FIREBASE = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const BASE_URL = LINK_O_TEU_FIREBASE.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO ---
function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        if(viewId === 'view-search') {
            renderList();
            atualizarSugestoes();
        }
    }
}

// --- MONITOR DE LIGAÇÃO ---
function atualizarStatusRede() {
    const statusTexto = document.getElementById('status-texto');
    const ponto = document.getElementById('status-ponto');
    if (!statusTexto || !ponto) return;

    if (navigator.onLine) {
        statusTexto.innerText = "Online";
        document.body.classList.remove('offline');
        ponto.style.backgroundColor = "#4CAF50";
    } else {
        statusTexto.innerText = "Offline";
        document.body.classList.add('offline');
        ponto.style.backgroundColor = "#f44336";
    }
}
window.addEventListener('online', atualizarStatusRede);
window.addEventListener('offline', atualizarStatusRede);

// --- LÓGICA FIREBASE ---
async function getStock() {
    try {
        const response = await fetch(DB_URL);
        if (!response.ok) throw new Error("Erro de servidor");
        const data = await response.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({ fireId: key, ...data[key] }));
    } catch (error) { return []; }
}

async function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="text-align:center;">A carregar nuvem...</p>';
    
    const stock = await getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(item => 
        (item.nome && item.nome.toLowerCase().includes(term)) ||
        (item.tipo && item.tipo.toLowerCase().includes(term)) ||
        (item.localizacao && item.localizacao.toLowerCase().includes(term))
    );

    listEl.innerHTML = '';
    if (filtered.length === 0) {
        listEl.innerHTML = '<p style="text-align:center;">Vazio.</p>';
        return;
    }

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        const qtd = item.quantidade || 0;
        
        // NOVO: Controlos de Quantidade Rápidos
        const qtdControl = `
            <div class="qtd-control">
                <button type="button" class="btn-qtd" onclick="updateQuantity('${item.fireId}', -1)">-</button>
                <span class="qtd-value">${qtd}</span>
                <button type="button" class="btn-qtd" onclick="updateQuantity('${item.fireId}', 1)">+</button>
            </div>
        `;
        
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}</h3>
                <p>${item.tipo} | 📍 ${item.localizacao || 'Sem Local'}</p>
                ${qtdControl}
            </div>
            <button class="btn-delete" onclick="deleteItem('${item.fireId}')">Apagar</button>
        `;
        listEl.appendChild(div);
    });
}

// --- ATUALIZAR QUANTIDADE RÁPIDA (+ E -) ---
window.updateQuantity = async function(fireId, change) {
    if (!navigator.onLine) return alert("Sem internet! Não podes alterar o stock agora.");

    try {
        const itemUrl = `${BASE_URL}/stock/${fireId}.json`;
        const resp = await fetch(itemUrl);
        const itemAtual = await resp.json();
        if (!itemAtual) return;

        let novaQtd = (itemAtual.quantidade || 0) + change;
        if (novaQtd < 0) novaQtd = 0; 

        // PATCH altera APENAS a quantidade
        await fetch(itemUrl, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: novaQtd })
        });

        // Recarrega a lista para mostrar o novo número sem apagar a pesquisa
        renderList(document.getElementById('inp-search')?.value || '');
    } catch (err) {
        alert("Erro ao atualizar.");
    }
};

// --- REGISTO NOVO ---
const form = document.getElementById('form-register');
if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!navigator.onLine) return alert("Sem internet! Gravação cancelada.");

        const item = {
            nome: document.getElementById('inp-nome').value.trim(),
            tipo: document.getElementById('inp-tipo').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
        };

        try {
            await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
            alert("Guardado com sucesso!");
            form.reset();
            nav('view-home');
        } catch (err) { alert("Erro ao guardar."); }
    });
}

// --- APAGAR ITEM TODO ---
window.deleteItem = async function(id) {
    if (confirm("Tens a certeza que queres eliminar este produto todo?")) {
        try {
            await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
            renderList(document.getElementById('inp-search')?.value || '');
            atualizarSugestoes();
        } catch (err) { alert("Erro ao apagar."); }
    }
};

// --- AUTOCOMPLETE ---
async function atualizarSugestoes() {
    const stock = await getStock();
    const dl = document.getElementById('lista-sugestoes');
    if (!dl) return;
    dl.innerHTML = '';
    const nomes = stock.map(i => i.nome).filter(n => n);
    [...new Set(nomes)].forEach(n => {
        const op = document.createElement('option');
        op.value = n;
        dl.appendChild(op);
    });
}

// --- PESQUISA ---
const inpSearch = document.getElementById('inp-search');
if (inpSearch) {
    inpSearch.addEventListener('input', (e) => renderList(e.target.value));
}

// --- ARRANQUE INICIAL ---
document.addEventListener('DOMContentLoaded', () => {
    atualizarStatusRede();
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    }
});
