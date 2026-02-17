const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

function toggleMenu() {
    const menu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    if (menu.classList.contains('open')) {
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
    
    // Fecha o menu de forma segura
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    listEl.innerHTML = "<div style='text-align:center; padding:40px; color:gray;'>A sincronizar stock...</div>";
    
    try {
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        listEl.innerHTML = "";
        
        if(!data) return listEl.innerHTML = "<div style='text-align:center; padding:20px;'>Sem produtos no sistema.</div>";

        const term = filter.toLowerCase();
        Object.keys(data).forEach(id => {
            const item = data[id];
            if (item.nome.toLowerCase().includes(term) || item.codigo.toLowerCase().includes(term) || (item.localizacao || "").toLowerCase().includes(term)) {
                const div = document.createElement('div');
                div.className = 'item-card';
                div.innerHTML = `
                    <button class="btn-delete" onclick="apagarProduto('${id}')">Apagar</button>
                    <span class="item-ref">${item.codigo}</span>
                    <span class="item-name">${item.nome}</span>
                    <span class="badge-loc">📍 ${item.localizacao || 'S/ Local'}</span>
                    
                    <div class="qtd-pill">
                        <button class="btn-qtd" onclick="changeQtd('${id}', -1)">-</button>
                        <span class="qtd-value">${item.quantidade || 0}</span>
                        <button class="btn-qtd" onclick="changeQtd('${id}', 1)">+</button>
                    </div>
                `;
                listEl.appendChild(div);
            }
        });
    } catch (e) { listEl.innerHTML = "<div style='color:red; text-align:center;'>Erro de ligação.</div>"; }
}

async function changeQtd(id, delta) {
    const resp = await fetch(`${BASE_URL}/stock/${id}.json`);
    const item = await resp.json();
    const novaQtd = Math.max(0, (item.quantidade || 0) + delta);
    await fetch(`${BASE_URL}/stock/${id}.json`, {
        method: 'PATCH',
        body: JSON.stringify({ quantidade: novaQtd })
    });
    renderList(document.getElementById('inp-search').value);
}

async function apagarProduto(id) {
    if(confirm("Deseja eliminar este item permanentemente?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList(document.getElementById('inp-search').value);
    }
}

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
    nav('view-search');
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
    document.getElementById('bulk-feedback').innerText = "✔ Item Guardado";
    setTimeout(() => document.getElementById('bulk-feedback').innerText = "", 1500);
};

document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    if (navigator.onLine) {
        document.getElementById('status-ponto').style.background = "#22c55e";
        document.getElementById('status-texto').innerText = "Ligado à Nuvem";
    }
});
