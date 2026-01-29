// --- CONFIGURAÇÃO ---
// ATENÇÃO: Substitui pelo teu link real do Firebase
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app"; 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO ---
function nav(viewId) {
    console.log("A navegar para:", viewId);
    const views = document.querySelectorAll('.view');
    views.forEach(el => el.classList.remove('active'));
    
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
        if (!navigator.onLine) {
            alert("Sem internet! Não é possível gravar online.");
            return;
        }

        const item = {
            nome: document.getElementById('inp-nome').value.trim(),
            tipo: document.getElementById('inp-tipo').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
        };

        try {
            const response = await fetch(DB_URL, { 
                method: 'POST', 
                body: JSON.stringify(item) 
            });
            if(response.ok) {
                alert("Guardado com sucesso!");
                form.reset();
                nav('view-home');
            }
        } catch (err) { 
            alert("Erro ao comunicar com o servidor."); 
        }
    });
}

// --- APAGAR ---
window.deleteItem = async function(id) {
    if (confirm("Apagar item para todos?")) {
        try {
            const deleteUrl = `${BASE_URL}/stock/${id}.json`;
            await fetch(deleteUrl, { method: 'DELETE' });
            renderList(document.getElementById('inp-search')?.value || '');
        } catch (err) {
            alert("Erro ao apagar.");
        }
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
    inpSearch.addEventListener('input', (e) => {
        renderList(e.target.value);
    });
}

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    atualizarStatusRede();
    console.log("App carregada.");
});

// PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    });
}