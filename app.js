const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

function toggleMenu() {
    const menu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    const isOpen = menu.classList.contains('open');
    
    if (isOpen) {
        menu.classList.remove('open');
        overlay.classList.remove('active');
    } else {
        menu.classList.add('open');
        overlay.classList.add('active');
    }
}

function nav(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(viewId === 'view-search') renderList();
    
    // CORREÇÃO DO BUG: Em vez de "toggle", garantimos apenas que o menu se fecha!
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    listEl.innerHTML = "A carregar...";
    
    try {
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        listEl.innerHTML = "";
        
        if(!data) return listEl.innerHTML = "Stock vazio.";

        const term = filter.toLowerCase();
        Object.keys(data).forEach(id => {
            const item = data[id];
            if (item.nome.toLowerCase().includes(term) || item.codigo.toLowerCase().includes(term) || (item.localizacao || "").toLowerCase().includes(term)) {
                const div = document.createElement('div');
                div.className = 'item-card';
                div.innerHTML = `
                    <div style="font-weight:bold; padding-right: 80px;">${item.nome}</div>
                    <div style="font-size:0.8rem; color:gray; margin-top:5px;">REF: ${item.codigo} | Local: ${item.localizacao || '---'}</div>
                    <div class="qtd-control">
                        <button class="btn-qtd" onclick="changeQtd('${id}', -1)">-</button>
                        <span class="qtd-value">${item.quantidade || 0}</span>
                        <button class="btn-qtd" onclick="changeQtd('${id}', 1)">+</button>
                    </div>
                    <button class="btn-delete" onclick="apagarProduto('${id}')">Apagar</button>
                `;
                listEl.appendChild(div);
            }
        });
    } catch (e) { listEl.innerHTML = "Erro ao carregar dados."; }
}

async function changeQtd(id, delta) {
    if(!navigator.onLine) return alert("Sem ligação à Internet!");
    const resp = await fetch(`${BASE_URL}/stock/${id}.json`);
    const item = await resp.json();
    
    // Math.max garante que a quantidade nunca fica abaixo de zero
    const novaQtd = Math.max(0, (item.quantidade || 0) + delta);
    
    await fetch(`${BASE_URL}/stock/${id}.json`, {
        method: 'PATCH',
        body: JSON.stringify({ quantidade: novaQtd })
    });
    // Atualiza a lista mantendo o texto da pesquisa
    renderList(document.getElementById('inp-search').value);
}

async function apagarProduto(id) {
    if(!navigator.onLine) return alert("Sem ligação à Internet!");
    if(confirm("Tem a certeza que deseja apagar este produto definitivamente?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList(document.getElementById('inp-search').value);
    }
}

// Formulários
document.getElementById('form-register').onsubmit = async (e) => {
    e.preventDefault();
    const item = {
        codigo: document.getElementById('inp-codigo').value.toUpperCase(),
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
    e.target.reset();
    nav('view-search'); // Agora já não abre o menu graças à correção em cima
};

document.getElementById('form-bulk').onsubmit = async (e) => {
    e.preventDefault();
    const item = {
        codigo: document.getElementById('bulk-codigo').value.toUpperCase(),
        nome: document.getElementById('bulk-nome').value,
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(),
        quantidade: 0
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
    document.getElementById('bulk-codigo').value = "";
    document.getElementById('bulk-nome').value = "";
    document.getElementById('bulk-codigo').focus();
    document.getElementById('bulk-feedback').innerText = "Guardado!";
    setTimeout(() => document.getElementById('bulk-feedback').innerText = "", 2000);
};

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    
    if (navigator.onLine) {
        document.getElementById('status-ponto').style.background = "#22c55e";
        document.getElementById('status-texto').innerText = "Online";
    }
});
