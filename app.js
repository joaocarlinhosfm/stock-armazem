// --- Configuração e Estado ---
const STORAGE_KEY = 'stock';

// --- Autocomplete ---
function atualizarSugestoes() {
    const stock = getStock();
    const datalist = document.getElementById('lista-sugestoes');
    datalist.innerHTML = ''; // Limpar sugestões antigas

    // 1. Extrair apenas os nomes
    const nomes = stock.map(item => item.nome);
    
    // 2. Remover duplicados (Set) para não sugerir o mesmo nome 10 vezes
    const nomesUnicos = [...new Set(nomes)];

    // 3. Criar as opções no HTML
    nomesUnicos.forEach(nome => {
        const option = document.createElement('option');
        option.value = nome;
        datalist.appendChild(option);
    });
}
// --- Navegação ---
function nav(viewId) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
    
    // Se for para a pesquisa, atualiza a lista e o autocomplete
    if(viewId === 'view-search') {
        atualizarSugestoes(); // <--- ADICIONA ISTO
        renderList();
    }
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

// Adicionar Item
document.getElementById('form-register').addEventListener('submit', (e) => {
    e.preventDefault();
    
    const nome = document.getElementById('inp-nome').value.trim();
    const tipo = document.getElementById('inp-tipo').value.trim();
    
    // Mantemos o UpperCase para ficar tudo maiúsculo, mas aceita qualquer formato
    const loc = document.getElementById('inp-loc').value.trim().toUpperCase();

    // --- REMOVIDO O BLOCO DE VALIDAÇÃO REGEX ---
    /* const locRegex = /^\d{3}-\d{2}[A-Z]$/;
    if (!locRegex.test(loc)) {
        alert('Localização inválida! ...');
        return;
    } 
    */
    // -------------------------------------------

    const novoItem = { id: Date.now(), nome, tipo, localizacao: loc };
    const stock = getStock();
    stock.push(novoItem);
    saveStock(stock);

    alert('Item registado com sucesso!');
    e.target.reset();
    nav('view-home');
    
    // Se já implementaste o autocomplete, chama-o aqui também para atualizar a lista
    if(typeof atualizarSugestoes === 'function') {
        atualizarSugestoes();
    }
});

// Renderizar Lista (Com filtro)
function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
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
document.getElementById('inp-search').addEventListener('input', (e) => {
    renderList(e.target.value);
});

// Apagar Item
window.deleteItem = function(id) {
    if(confirm('Tem a certeza que deseja apagar este item?')) {
        let stock = getStock();
        stock = stock.filter(item => item.id !== id);
        saveStock(stock);
        
        // Atualiza a lista visual e também as sugestões
        renderList(document.getElementById('inp-search').value);
        atualizarSugestoes(); // <--- ADICIONA ISTO
    }
};

// --- PWA: Registar Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker registado'))
        .catch(err => console.error('Erro SW:', err));
}