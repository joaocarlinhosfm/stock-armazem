// --- Configuração e Estado ---
const STORAGE_KEY = 'stock';

// --- Navegação ---
function nav(viewId) {
    // Esconde todas as views
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    // Mostra a view desejada
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.add('active');
    } else {
        console.error('Erro: Ecrã não encontrado ->', viewId);
    }
    
    // Se for para a pesquisa, atualiza a lista e as sugestões
    if(viewId === 'view-search') {
        atualizarSugestoes();
        renderList();
    }
}

// --- Lógica de Negócio ---

// Ler dados
function getStock() {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
}

// Gravar dados
function saveStock(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// Atualizar Sugestões (Autocomplete)
function atualizarSugestoes() {
    const stock = getStock();
    const datalist = document.getElementById('lista-sugestoes');
    
    if (!datalist) return; // Segurança caso o HTML não tenha a lista
    
    datalist.innerHTML = ''; // Limpar antigas

    // Busca nomes, remove duplicados e cria opções
    const nomes = stock.map(item => item.nome);
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
        // Apenas converte para maiúsculas, sem validação de formato
        const loc = document.getElementById('inp-loc').value.trim().toUpperCase();

        const novoItem = { id: Date.now(), nome, tipo, localizacao: loc };
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

    const filtered = stock.filter(item => 
        item.nome.toLowerCase().includes(term) ||
        item.tipo.toLowerCase().includes(term) ||
        item.localizacao.toLowerCase().includes(term)
    );

    if (filtered.length === 0) {
        listEl.innerHTML = '<p style="text-align:center; color:#888;">Nenhum item encontrado.</p>';
        return;
    }

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'item-card';
        div.innerHTML = `
            <div class="item-info">
                <h3>${item.nome}</h3>
                <p>Tipo: ${item.tipo}</p>
                <p><strong>📍 ${item.localizacao}</strong></p>
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

// Apagar Item (Global para ser acessível no HTML)
window.deleteItem = function(id) {
    if(confirm('Tem a certeza que deseja apagar este item?')) {
        let stock = getStock();
        stock = stock.filter(item => item.id !== id);
        saveStock(stock);
        
        // Atualiza a visualização se estivermos no ecrã de pesquisa
        const searchVal = document.getElementById('inp-search') ? document.getElementById('inp-search').value : '';
        renderList(searchVal);
        atualizarSugestoes();
    }
};

// --- PWA: Registar Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker registado'))
        .catch(err => console.error('Erro SW:', err));
}