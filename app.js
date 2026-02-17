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
    
    // Atualiza a lista caso voltemos ao ecrã principal
    if(viewId === 'view-search') renderList();
    
    // Fecha o menu de forma segura
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    
    // Apenas mostra "A carregar" se a lista estiver completamente vazia
    if (!filter && listEl.innerHTML === "") {
        listEl.innerHTML = "<div style='text-align:center; padding:40px; color:gray;'>A sincronizar stock...</div>";
    }
    
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
                div.setAttribute('data-id', id); // Essencial para a atualização rápida
                
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
    } catch (e) { 
        listEl.innerHTML = "<div style='color:red; text-align:center; padding:20px;'>Erro de ligação à rede.</div>"; 
        console.error("Erro ao obter dados:", e);
    }
}

// ATUALIZAÇÃO INSTANTÂNEA E SILENCIOSA (Corrigida)
async function changeQtd(id, delta) {
    if(!navigator.onLine) return alert("Sem ligação à Internet!");
    
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    
    // Lê o valor atual na tela e calcula o novo
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    
    // Atualiza imediatamente na tela (Optimistic UI)
    qtdSpan.innerText = novaQtd;
    
    // Feedback visual (O erro de código estava aqui, já corrigido com aspas)
    qtdSpan.style.color = "#2563eb"; 
    setTimeout(() => { qtdSpan.style.color = "inherit"; }, 200);

    try {
        // Envia para o Firebase em segundo plano
        await fetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: novaQtd })
        });
    } catch (e) {
        alert("Erro ao sincronizar. O valor foi reposto.");
        qtdSpan.innerText = qtdAtual; // Reverte o número em caso de erro de rede
    }
}

async function apagarProduto(id) {
    if(confirm("Deseja eliminar este item permanentemente?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        // Recarrega a lista para remover o item eliminado
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

// Quando a app arranca
document.addEventListener('DOMContentLoaded', () => {
    renderList();
    
    const searchInput = document.getElementById('inp-search');
    if(searchInput) {
        searchInput.oninput = (e) => renderList(e.target.value);
    }
    
    if (navigator.onLine) {
        const ponto = document.getElementById('status-ponto');
        const texto = document.getElementById('status-texto');
        if(ponto) ponto.style.background = "#22c55e";
        if(texto) texto.innerText = "Ligado à Nuvem";
    }
});
