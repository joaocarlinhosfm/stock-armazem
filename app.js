// --- CONFIGURAÇÃO FIREBASE ---
// Exemplo: https://projeto-armazem-default-rtdb.europe-west1.firebasedatabase.app/
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/"; 
const DB_URL = `${BASE_URL}/stock.json`;

// --- NAVEGAÇÃO ---
async function nav(viewId) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');
    
    if(viewId === 'view-search') {
        // No modo online, renderList já trata do carregamento
        renderList();
        atualizarSugestoes();
    }
}

// --- LÓGICA DE BASE DE DADOS ONLINE ---

// LER: Vai buscar o stock ao Firebase
async function getStock() {
    try {
        const response = await fetch(DB_URL);
        const data = await response.json();
        
        if (!data) return [];

        // O Firebase devolve um objeto de objetos. Convertemos para Array:
        return Object.keys(data).map(key => ({
            fireId: key, // Guardamos a chave única para poder apagar depois
            ...data[key]
        }));
    } catch (error) {
        console.error("Erro ao ler dados:", error);
        return [];
    }
}

// ESCREVER: Guarda um novo item
async function saveStockOnline(item) {
    try {
        const response = await fetch(DB_URL, {
            method: 'POST',
            body: JSON.stringify(item)
        });
        return await response.json();
    } catch (error) {
        console.error("Erro ao gravar:", error);
        alert("Erro de ligação. Verifica a internet.");
    }
}

// APAGAR: Remove do Firebase
window.deleteItem = async function(fireId) {
    if(confirm('Deseja apagar este item para todos os utilizadores?')) {
        try {
            const deleteUrl = `${BASE_URL}/stock/${fireId}.json`;
            await fetch(deleteUrl, { method: 'DELETE' });
            renderList(document.getElementById('inp-search').value);
            atualizarSugestoes();
        } catch (error) {
            alert("Erro ao apagar item.");
        }
    }
};

// --- INTERFACE E EVENTOS ---

// --- MONITOR DE LIGAÇÃO ---

function atualizarStatusRede() {
    const statusTexto = document.getElementById('status-texto');
    const corpo = document.body;

    if (navigator.onLine) {
        statusTexto.innerText = "Online";
        corpo.classList.remove('offline');
        // Se voltou a ter net, refresca a lista para garantir dados novos
        renderList(document.getElementById('inp-search')?.value || '');
    } else {
        statusTexto.innerText = "Offline (Modo de Leitura)";
        corpo.classList.add('offline');
    }
}

// Ouvir eventos do browser
window.addEventListener('online', atualizarStatusRede);
window.addEventListener('offline', atualizarStatusRede);

// Executar ao iniciar para definir estado atual
atualizarStatusRede();

// --- AJUSTE NO SAVE (Opcional) ---

// Podemos avisar o utilizador se ele tentar gravar sem net
async function saveStockOnline(item) {
    if (!navigator.onLine) {
        alert("Atenção: Estás sem internet. O registo não será guardado na nuvem até teres ligação.");
        return;
    }
    // ... resto da função fetch original ...
}
// Autocomplete
async function atualizarSugestoes() {
    const stock = await getStock();
    const datalist = document.getElementById('lista-sugestoes');
    if (!datalist) return;
    
    datalist.innerHTML = '';
    const nomesUnicos = [...new Set(stock.map(item => item.nome))];

    nomesUnicos.forEach(nome => {
        const option = document.createElement('option');
        option.value = nome;
        datalist.appendChild(option);
    });
}

// Formulário de Registo
const formRegister = document.getElementById('form-register');
if (formRegister) {
    formRegister.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Bloquear o botão para evitar múltiplos cliques
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerText = "A gravar...";

        const item = {
            nome: document.getElementById('inp-nome').value.trim(),
            tipo: document.getElementById('inp-tipo').value.trim(),
            localizacao: document.getElementById('inp-loc').value.trim().toUpperCase(),
            quantidade: parseInt(document.getElementById('inp-qtd').value) || 0,
            dataCriacao: new Date().toISOString()
        };

        await saveStockOnline(item);
        
        btn.disabled = false;
        btn.innerText = "Guardar";
        
        alert('Registo efetuado com sucesso!');
        e.target.reset();
        nav('view-home');
    });
}

// Renderizar Lista com Filtro
async function renderList(filterText = '') {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    listEl.innerHTML = '<p style="text-align:center;">A sincronizar com a nuvem...</p>';
    
    const stock = await getStock();
    const term = filterText.toLowerCase();

    const filtered = stock.filter(item => 
        item.nome.toLowerCase().includes(term) ||
        item.tipo.toLowerCase().includes(term) ||
        item.localizacao.toLowerCase().includes(term)
    );

    listEl.innerHTML = ''; // Limpa o "A carregar"

    if (filtered.length === 0) {
        listEl.innerHTML = '<p style="text-align:center; color:#888;">Nenhum item encontrado.</p>';
        return;
    }

    filtered.forEach(item => {
        const div = document