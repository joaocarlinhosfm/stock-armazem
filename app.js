// --- CONFIGURAÇÃO ---
// ATENÇÃO: Substitui pelo teu link real. Ex: https://projeto-xyz.firebaseio.com/
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO (REPARADA) ---
function nav(viewId) {
    const views = document.querySelectorAll('.view');
    views.forEach(el => el.classList.remove('active'));
    
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
        // Se for pesquisa, carrega os dados
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
        if (!response.ok) throw new Error("Erro na rede");
        const data = await response.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({ fireId: key, ...data[key] }));
    } catch (error) {
        console.error("Erro ao ler:", error);
        return [];
    }
}

async function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    listEl.innerHTML = '<p style="text-align:center;">A carregar...</p>';
    
    const stock = await getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(item => 
        item.nome.toLowerCase().includes(term) ||
        item.tipo.toLowerCase().includes(term) ||
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
        const qtdHtml = qtd > 0 ? `<span style="color:#2196F3;"> (Qtd: ${qtd})</span>` : '';
        
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}${qtdHtml}</h3>
                <p>${item.tipo} | 📍 ${item.localizacao || '---'}</p>
            </div>
            <button class="btn-delete" onclick="deleteItem('${item.fireId}')">Apagar</button>
        `;
        listEl.appendChild(div);
    });
}

// --- REGISTO ---
const form = document.getElementById('form-register');
if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!navigator.onLine) return alert("Sem internet!");

        const item = {
            nome: document.getElementById('inp-nome').value.trim(),
            tipo: document.getElementById('inp-tipo').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
        };

        try {
            await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) });
            alert("Guardado!");
            form.reset();
            nav('view-home');
        } catch (e) { alert("Erro ao guardar"); }
    });
}

// --- APAGAR ---
window.deleteItem = async function(id) {
    if (confirm("Apagar?")) {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
        renderList();
    }
};

// --- AUTOCOMPLETE ---
async function atualizarSugestoes() {
    const stock = await getStock();
    const dl = document.getElementById('lista-sugestoes');
    if (!dl) return;
    dl.innerHTML = '';
    [...new Set(stock.map(i => i.nome))].forEach(n => {
        const op = document.createElement('option');
        op.value = n;
        dl.appendChild(op);
    });
}

// Inicialização
atualizarStatusRede();