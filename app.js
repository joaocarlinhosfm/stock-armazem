const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// --- ESTADO GLOBAL ---
let editModeId = null; 
let cachedData = {};   

// --- SISTEMA DE NOTIFICAÇÕES (TOAST) ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icon = type === 'success' ? '✅' : '❌';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

// --- INICIALIZAÇÃO E TEMA ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
}

(function applyThemeOnLoad() {
    const savedTheme = localStorage.getItem('hiperfrio-tema');
    if (savedTheme === 'dark') document.body.classList.add('dark-mode');
})();

// --- NAVEGAÇÃO ---
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

function nav(viewId, isEdit = false) {
    if (viewId === 'view-register' && !isEdit) {
        resetRegisterForm("Novo Produto");
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(viewId === 'view-search') renderList();
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

// --- RENDERIZAÇÃO DA LISTA COM DUAL SWIPE ---
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    if (!filter && listEl.innerHTML === "") {
        listEl.innerHTML = "<div style='text-align:center; padding:40px; color:gray;'>A sincronizar stock...</div>";
    }

    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {}; 
        
        listEl.innerHTML = ''; 
        if (!data) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Sem dados.</div>';

        const itens = Object.entries(data)
            .map(([id, val]) => ({ id, ...val }))
            .filter(i => 
                (i.nome && i.nome.toLowerCase().includes(filter.toLowerCase())) ||
                (i.codigo && i.codigo.toLowerCase().includes(filter.toLowerCase())) ||
                (i.localizacao && i.localizacao.toLowerCase().includes(filter.toLowerCase()))
            )
            .reverse();

        if(itens.length === 0) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Nenhum produto encontrado.</div>';

        itens.forEach(item => {
            const el = document.createElement('div');
            el.className = 'item-card';
            el.dataset.id = item.id;
            
            const qtd = item.quantidade || 0;
            const lowStockClass = qtd <= 2 ? 'low-stock' : '';

            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                
                <div class="card-content">
                    <div class="card-header-compact">
                        <span class="item-ref">${item.codigo || '-'}</span>
                        <span class="item-name">${item.nome || '-'}</span>
                    </div>
                    <div class="card-footer-compact">
                        <div class="badge-loc">📍 ${item.localizacao || 'S/ LOC'}</div>
                        <div class="qtd-pill">
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', -1)">−</button>
                            <span class="qtd-value ${lowStockClass}">${qtd}</span>
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', 1)">+</button>
                        </div>
                    </div>
                </div>
            `;
            listEl.appendChild(el);
            setupDualSwipe(el, item.id);
        });
    } catch (e) {
        listEl.innerHTML = "<div style='text-align:center; padding:40px; color:var(--danger);'>Erro de ligação.</div>";
    }
}

// --- LÓGICA DE SWIPE DUPLO ---
function setupDualSwipe(cardElement, id) {
    const content = cardElement.querySelector('.card-content');
    let startX = 0;
    let currentX = 0;
    const threshold = 80;

    content.addEventListener('touchstart', e => {
        if(e.target.closest('.btn-qtd')) return;
        startX = e.touches[0].clientX;
        content.classList.add('swiping');
    }, {passive: true});

    content.addEventListener('touchmove', e => {
        if(e.target.closest('.btn-qtd')) return;
        const touch = e.touches[0].clientX;
        currentX = touch - startX;
        content.style.transform = `translateX(${currentX}px)`;
    }, {passive: true});

    content.addEventListener('touchend', () => {
        content.classList.remove('swiping');
        if (currentX > threshold) {
            content.style.transform = `translateX(0px)`; 
            startEditMode(id);
        } else if (currentX < -threshold) {
            deleteItem(id, cardElement);
        } else {
            content.style.transform = `translateX(0px)`;
        }
        currentX = 0;
    });
}

// --- MODO DE EDIÇÃO ---
function startEditMode(id) {
    const item = cachedData[id];
    if (!item) return showToast("Erro ao carregar dados do item.", "error");

    editModeId = id; 
    document.getElementById('form-title').innerText = "Editar Produto";
    document.getElementById('btn-form-submit').innerText = "Guardar Alterações";
    
    const inpCodigo = document.getElementById('inp-codigo');
    const inpQtd = document.getElementById('inp-qtd');
    
    // Na edição, bloqueamos o Código, mas a Quantidade fica livre!
    inpCodigo.value = item.codigo;
    inpCodigo.disabled = true;
    
    inpQtd.value = item.quantidade;
    inpQtd.disabled = false; 
    
    document.getElementById('inp-nome').value = item.nome;
    document.getElementById('inp-tipo').value = item.tipo || '';
    document.getElementById('inp-loc').value = item.localizacao || '';

    // Passar true para não limpar o formulário
    nav('view-register', true);
}

function resetRegisterForm(title) {
    editModeId = null;
    document.getElementById('form-add').reset();
    document.getElementById('form-title').innerText = title;
    document.getElementById('btn-form-submit').innerText = "Criar Ficha de Produto";
    document.getElementById('inp-codigo').disabled = false;
    document.getElementById('inp-qtd').disabled = false;
}

// --- AÇÕES DE DADOS ---
async function changeQtd(id, delta) {
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    
    qtdSpan.innerText = novaQtd;
    
    if (novaQtd <= 2) {
        qtdSpan.classList.add('low-stock');
    } else {
        qtdSpan.classList.remove('low-stock');
    }

    try { 
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) }); 
    } catch (e) { 
        qtdSpan.innerText = qtdAtual; 
        showToast("Erro de ligação. A quantidade não foi gravada.", "error");
    }
}

async function deleteItem(id, cardElement) {
    if(confirm("Tem a certeza que deseja apagar este item?")) {
        cardElement.style.transform = `translateX(-100%)`; 
        setTimeout(() => cardElement.remove(), 200);
        try { 
            await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' }); 
            showToast("Produto apagado com sucesso.");
        } catch(e) {
            showToast("Erro ao apagar no servidor.", "error");
        };
    } else {
        cardElement.querySelector('.card-content').style.transform = 'translateX(0px)';
    }
}

// --- SUBMISSÃO DO FORMULÁRIO (NOVO OU EDIÇÃO) ---
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {};
    
    if (editModeId === null) {
        // Só tenta ler e enviar o código se for um item novo
        payload.codigo = document.getElementById('inp-codigo').value.toUpperCase();
    }
    
    // A quantidade e os restantes dados são enviados sempre
    payload.quantidade = parseInt(document.getElementById('inp-qtd').value) || 0;
    payload.nome = document.getElementById('inp-nome').value;
    payload.tipo = document.getElementById('inp-tipo').value;
    payload.localizacao = document.getElementById('inp-loc').value.toUpperCase();

    const url = editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL;
    const method = editModeId ? 'PATCH' : 'POST';

    try {
        await fetch(url, { method: method, body: JSON.stringify(payload) });
        e.target.reset();
        nav('view-search');
        showToast(editModeId ? "Alterações guardadas!" : "Novo produto criado!");
    } catch (err) {
        showToast("Erro ao guardar. Tente novamente.", "error");
    }
};

// --- SUBMISSÃO DO CATALOGAR LOTE (Função C) ---
document.getElementById('form-bulk').onsubmit = async (e) => { 
    e.preventDefault(); 
    
    // Lemos também o novo campo bulk-qtd opcional
    const qtdInput = document.getElementById('bulk-qtd');
    const quantidadeDesejada = qtdInput && qtdInput.value ? parseInt(qtdInput.value) : 0;

    const item = { 
        codigo: document.getElementById('bulk-codigo').value.toUpperCase(), 
        nome: document.getElementById('bulk-nome').value, 
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(), 
        quantidade: quantidadeDesejada 
    }; 
    
    try {
        await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); 
        
        // Limpar o formulário para o próximo item
        document.getElementById('bulk-codigo').value = ""; 
        document.getElementById('bulk-nome').value = ""; 
        if(qtdInput) qtdInput.value = ""; 
        
        document.getElementById('bulk-codigo').focus(); 
        showToast("Lote guardado com sucesso!");
    } catch(err) {
        showToast("Erro ao guardar lote.", "error");
    }
};

// --- ARRANQUE DA APLICAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = document.body.classList.contains('dark-mode');
    
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    
    if (navigator.onLine) { 
        document.getElementById('status-ponto').style.background = "#22c55e"; 
        document.getElementById('status-texto').innerText = "Online"; 
    }
});
