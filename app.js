// --- Configuração e Estado ---
const STORAGE_KEY = 'stock';

// --- Navegação ---
function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    // Se for para a pesquisa, atualiza a lista imediatamente
    if(viewId === 'view-search') renderList();
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
    const loc = document.getElementById('inp-loc').value.trim().toUpperCase();

    // Validação Regex Extra (Javascript)
    const locRegex = /^\d{3}-\d{2}[A-Z]$/;
    if (!locRegex.test(loc)) {
        alert('Localização inválida! Use o formato: 000-00A (ex: 501-23A)');
        return;
    }

    const novoItem = { id: Date.now(), nome, tipo, localizacao: loc };
    const stock = getStock();
    stock.push(novoItem);
    saveStock(stock);

    alert('Item registado com sucesso!');
    e.target.reset();
    nav('view-home');
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
        renderList(document.getElementById('inp-search').value);
    }
};

// --- PWA: Registar Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('Service Worker registado'))
        .catch(err => console.error('Erro SW:', err));
}