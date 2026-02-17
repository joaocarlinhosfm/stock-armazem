// --- CONFIGURAÇÃO ---
const LINK_FIREBASE = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const BASE_URL = LINK_FIREBASE.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO E MENU ---
window.toggleMenu = function() {
    const menu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    menu.classList.toggle('open');
    overlay.classList.toggle('active');
}

window.nav = function(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        if(viewId === 'view-search') renderList();
    }
    // Fecha o menu lateral após clicar (se estiver aberto)
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

// --- LÓGICA DE REDE E DADOS ---
function atualizarStatusRede() {
    const ponto = document.getElementById('status-ponto');
    const txt = document.getElementById('status-texto');
    if (navigator.onLine) {
        document.body.classList.remove('offline');
        ponto.style.backgroundColor = "#22c55e"; // Success green
        txt.innerText = "Online";
    } else {
        document.body.classList.add('offline');
        ponto.style.backgroundColor = "#ef4444"; // Danger red
        txt.innerText = "Offline";
    }
}
window.addEventListener('online', atualizarStatusRede);
window.addEventListener('offline', atualizarStatusRede);

async function getStock() {
    try {
        const response = await fetch(DB_URL);
        const data = await response.json();
        return data ? Object.keys(data).map(key => ({ fireId: key, ...data[key] })) : [];
    } catch (e) { 
        console.error("Erro ao obter stock:", e);
        return []; 
    }
}

window.renderList = async function(filterText = '') {
    const listEl = document.getElementById('stock-list');
    if(!listEl) return;
    
    listEl.innerHTML = '<p style="text-align:center;">A carregar stock...</p>';
    
    const stock = await getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(i => 
        (i.nome || "").toLowerCase().includes(term) || 
        (i.codigo || "").toLowerCase().includes(term) || 
        (i.localizacao || "").toLowerCase().includes(term)
    );

    listEl.innerHTML = filtered.length ? '' : '<p style="text-align:center; color: #64748b;">Nenhum produto encontrado.</p>';

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        const qtd = item.quantidade || 0;
        
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome || 'Sem Nome'}</h3>
                <p>REF: <strong>${item.codigo || '---'}</strong></p>
                <p>${item.tipo || '---'} | 📍 ${item.localizacao || '---'}</p>
                <div class="qtd-control">
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', -1)">-</button>
                    <span class="qtd-value">${qtd}</span>
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', 1)">+</button>
                </div>
            </div>
            <button class="btn-delete" onclick="deleteItem('${item.fireId}')">Apagar</button>
        `;
        listEl.appendChild(div);
    });
}

// --- QUANTIDADE E ELIMINAÇÃO ---
window.updateQtd = async function(id, change) {
    if(!navigator.onLine) return alert("Sem ligação à Internet!");
    try {
        const url = `${BASE_URL}/stock/${id}.json`;
        const resp = await fetch(url);
        const item = await resp.json();
        let novaQtd = (item.quantidade || 0) + change;
        if(novaQtd < 0) novaQtd = 0; // Evita quantidades negativas
        
        await fetch(url, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
        
        // Recarrega a lista mantendo a pesquisa atual
        const searchInput = document.getElementById('inp-search');
        renderList(searchInput ? searchInput.value : '');
    } catch (e) { 
        alert("Erro ao atualizar a quantidade."); 
        console.error(e);
    }
};

window.deleteItem = async function(id) {
    if(!navigator.onLine) return alert("Sem ligação à Internet!");
    if(confirm("Tem a certeza que deseja apagar este produto definitivamente?")) {
        try {
            await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
            renderList();
        } catch(e) {
            alert("Erro ao apagar o produto.");
        }
    }
};

// --- REGISTOS (Único e Bulk) ---
const formRegister = document.getElementById('form-register');
if(formRegister) {
    formRegister.addEventListener('submit', async (e) => {
        e.preventDefault();
        const item = {
            codigo: document.getElementById('inp-codigo').value.trim().toUpperCase(),
            nome: document.getElementById('inp-nome').value.trim(),
            tipo: document.getElementById('inp-tipo').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
        };
        try {
            await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
            e.target.reset();
            nav('view-home');
            alert("Produto registado com sucesso!");
        } catch(e) {
            alert("Erro ao registar o produto.");
        }
    });
}

const formBulk = document.getElementById('form-bulk');
if(formBulk) {
    formBulk.addEventListener('submit', async (e) => {
        e.preventDefault();
        const feedback = document.getElementById('bulk-feedback');
        const codigoInput = document.getElementById('bulk-codigo');
        const nomeInput = document.getElementById('bulk-nome');
        
        const item = {
            codigo: codigoInput.value.trim().toUpperCase(),
            nome: nomeInput.value.trim(),
            localizacao: document.getElementById('bulk-loc').value.trim().toUpperCase(),
            quantidade: 0 // Assume quantidade zero ao catalogar por zona
        };
        
        feedback.innerText = "A gravar...";
        feedback.style.color = "#f59e0b"; // Warning color (loading)

        try {
            await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
            codigoInput.value = ''; 
            nomeInput.value = ''; 
            codigoInput.focus(); // Foca de volta no código para o próximo Scan
            feedback.style.color = "#22c55e"; // Success color
            feedback.innerText = `✔ ${item.codigo} guardado!`;
        } catch(e) {
            feedback.style.color = "#ef4444"; // Danger color
            feedback.innerText = "Erro ao gravar. Tente de novo.";
        }
    });
}

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('inp-search');
    if(searchInput) {
        searchInput.addEventListener('input', (e) => renderList(e.target.value));
    }
    
    atualizarStatusRede();
    
    // Registo do Service Worker para PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(() => console.log("Service Worker registado com sucesso."))
            .catch(err => console.error("Erro ao registar Service Worker:", err));
    }
});
