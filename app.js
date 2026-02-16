// CONFIGURAÇÃO
const FIREBASE_LINK = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; // Substitui pelo teu link real
const BASE_URL = FIREBASE_LINK.replace(/\/$/, ""); 
const DB_URL = `${BASE_URL}/stock.json`;

// Navegação
function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    // Forçar atualização de dados em qualquer vista
    atualizarDados(); 
    
    if(viewId === 'view-search') renderList();
}

// DROPDOWN - Atualiza a lista de sugestões com base no que já existe no Firebase
async function atualizarSugestoes() {
    try {
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        if (!data) return;

        const datalist = document.getElementById('lista-sugestoes');
        datalist.innerHTML = '';
        
        const nomesUnicos = [...new Set(Object.values(data).map(item => item.nome))];
        
        nomesUnicos.forEach(nome => {
            const opt = document.createElement('option');
            opt.value = nome;
            datalist.appendChild(opt);
        });
        console.log("Dropdown atualizado com:", nomesUnicos.length, "itens");
    } catch (e) { console.error("Erro no dropdown:", e); }
}

async function renderList(filter = '') {
    const list = document.getElementById('stock-list');
    list.innerHTML = '<p style="text-align:center;">A sincronizar...</p>';
    
    const resp = await fetch(DB_URL);
    const data = await resp.json();
    const stock = data ? Object.keys(data).map(k => ({ fireId: k, ...data[k] })) : [];
    
    const term = filter.toLowerCase();
    const filtered = stock.filter(i => (i.nome || "").toLowerCase().includes(term) || (i.localizacao || "").toLowerCase().includes(term));

    list.innerHTML = '';
    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}</h3>
                <p>${item.tipo} | 📍 ${item.localizacao || '---'}</p>
                <div class="qtd-control">
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', -1)">-</button>
                    <span class="qtd-value">${item.quantidade || 0}</span>
                    <button class="btn-qtd" onclick="updateQtd('${item.fireId}', 1)">+</button>
                </div>
            </div>
            <button class="btn-delete" onclick="deleteItem('${item.fireId}')">🗑️</button>
        `;
        list.appendChild(div);
    });
}

// BULK REGISTO - Guarda e limpa o form sem sair da página
const form = document.getElementById('form-register');
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('bulk-feedback');
    const nomeInp = document.getElementById('inp-nome');

    const item = {
        nome: nomeInp.value.trim(),
        tipo: document.getElementById('inp-tipo').value.trim(),
        localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };

    try {
        await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
        feedback.innerText = `✅ Último: ${item.nome} guardado!`;
        
        // Limpa apenas o nome e quantidade para o próximo item (mantém o tipo e local para ser rápido)
        nomeInp.value = '';
        document.getElementById('inp-qtd').value = '';
        nomeInp.focus();
        
        atualizarSugestoes(); // Atualiza dropdown para o próximo input
    } catch (e) { alert("Erro ao guardar."); }
});

// Funções de Update e Delete (iguais às anteriores)
window.updateQtd = async function(id, change) {
    const url = `${BASE_URL}/stock/${id}.json`;
    const resp = await fetch(url);
    const item = await resp.json();
    let novaQtd = (item.quantidade || 0) + change;
    if(novaQtd < 0) novaQtd = 0;
    await fetch(url, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
    renderList(document.getElementById('inp-search').value);
};

window.deleteItem = async function(id) {
    if(confirm("Eliminar?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList();
    }
};

function atualizarDados() {
    atualizarStatusRede();
    atualizarSugestoes();
}

function atualizarStatusRede() {
    const p = document.getElementById('status-ponto');
    const t = document.getElementById('status-texto');
    if (navigator.onLine) { 
        p.style.backgroundColor = "#2ecc71"; t.innerText = "Online"; 
    } else { 
        p.style.backgroundColor = "#e74c3c"; t.innerText = "Offline"; 
    }
}

document.getElementById('inp-search').addEventListener('input', (e) => renderList(e.target.value));
window.addEventListener('online', atualizarStatusRede);
window.addEventListener('offline', atualizarStatusRede);
document.addEventListener('DOMContentLoaded', atualizarDados);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
