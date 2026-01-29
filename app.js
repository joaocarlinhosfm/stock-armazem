// --- Configuração e Estado ---
const STORAGE_KEY = 'stock';

// --- Navegação ---
function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');
    
    if(viewId === 'view-search') {
        atualizarSugestoes();
        renderList();
    }
}

// --- Lógica de Negócio ---

function getStock() {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
}

function saveStock(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function atualizarSugestoes() {
    const stock = getStock();
    const datalist = document.getElementById('lista-sugestoes');
    if (!datalist) return;
    
    datalist.innerHTML = '';
    // Só sugerimos nomes de itens que tenham stock > 0
    const nomes = stock
        .filter(item => (item.quantidade || 0) > 0) 
        .map(item => item.nome);
        
    const nomesUnicos = [...new Set(nomes)];

    nomesUnicos.forEach(nome => {
        const option = document.createElement('option');
        option.value = nome;
        datalist.appendChild(option);
    });
}

// Registo de Novo Item
const formRegister = document.getElementById('form-register');
if (formRegister) {
    formRegister.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const nome = document.getElementById('inp-nome').value.trim();
        const tipo = document.getElementById('inp-tipo').value.trim();
        const loc = document.getElementById('inp-loc').value.trim().toUpperCase();
        
        // --- ALTERAÇÃO: Ler Quantidade ---
        // Se estiver vazio, assume 0. Converte para número inteiro.
        let qtd = parseInt(document.getElementById('inp-qtd').value);
        if (isNaN(qtd)) qtd = 0; 
        
        const novoItem = { 
            id: Date.now(), 
            nome, 
            tipo, 
            localizacao: loc,
            quantidade: qtd // Guardamos a quantidade
        };

        const stock = getStock();
        stock.push(novoItem);
        saveStock(stock);

        alert('Item registado com sucesso!');
        e.target.reset();
        nav('view-home');
    });
}

// Renderizar Lista
function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    listEl.innerHTML = '';
    
    const stock = getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(item => {
        // --- ALTERAÇÃO 1: Removemos o filtro que escondia stock zero ---
        // Agora todos passam, independentemente da quantidade.
        
        // Verificar Texto (Nome, Tipo ou Local)
        const matchText = item.nome.toLowerCase().includes(term) ||
                          item.tipo.toLowerCase().includes(term) ||
                          item.localizacao.toLowerCase().includes(term);
        
        return matchText;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = '<p style="text-align:center; color:#888;">Nenhum item encontrado.</p>';
        return;
    }

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        
        // Garantir que qtd é lido corretamente
        const qtd = item.quantidade !== undefined ? item.quantidade : 0;

        // --- ALTERAÇÃO 2: Lógica Visual ---
        // Se qtd > 0, cria o HTML do texto. Se for 0, deixa string vazia.
        const qtdHtml = qtd > 0 
            ? `<span style="font-size:0.8em; color:#2196F3; font-weight:bold;"> (Qtd: ${qtd})</span>` 
            : '';

        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome} ${qtdHtml}</h3> 
                <p>Tipo: ${item.tipo}</p>
                <p><strong>📍 ${item.localizacao || 'Sem Local'}</strong></p>
            </div>
            <button class="btn-delete" onclick="deleteItem(${item.id})">Apagar</button>
        `;
        listEl.appendChild(div);
    });
}

// Pesquisa em tempo real
const inpSearch = document.getElementById('inp-search');
if (inpSearch) {
    inpSearch.addEventListener('input', (e) => {
        renderList(e.target.value);
    });
}

// Apagar Item
window.deleteItem = function(id) {
    if(confirm('Tem a certeza que deseja apagar este item?')) {
        let stock = getStock();
        stock = stock.filter(item => item.id !== id);
        saveStock(stock);
        
        const searchVal = document.getElementById('inp-search') ? document.getElementById('inp-search').value : '';
        renderList(searchVal);
        atualizarSugestoes();
    }
};

// PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker registado'))
        .catch(err => console.error('Erro SW:', err));
}