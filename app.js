const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// --- ESTADO GLOBAL ---
let editModeId = null; // Guarda o ID se estivermos a editar, null se for novo
let cachedData = {};   // Guarda os dados para acesso rápido na edição

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

function nav(viewId) {
    // Se for para a vista de registo sem ser via swipe, resetamos o modo de edição
    if (viewId === 'view-register' && editModeId === null) {
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
        cachedData = data || {}; // Guardar em cache para edição rápida
        
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
            
            // Estrutura com 3 camadas: Fundo Edit (Esq), Fundo Delete (Dir), Conteúdo (Frente)
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
                            <span class="qtd-value">${item.quantidade || 0}</span>
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

// --- LÓGICA DE SWIPE DUPLO (DIREITA E ESQUERDA) ---
function setupDualSwipe(cardElement, id) {
    const content = cardElement.querySelector('.card-content');
    let startX = 0;
    let currentX = 0;
    const threshold = 80; // Distância mínima para ativar a ação

    content.addEventListener('touchstart', e => {
        // Ignora se tocar nos botões de quantidade
        if(e.target.closest('.btn-qtd')) return;
        startX = e.touches[0].clientX;
        content.classList.add('swiping');
    }, {passive: true});

    content.addEventListener('touchmove', e => {
        if(e.target.closest('.btn-qtd')) return;
        const touch = e.touches[0].clientX;
        currentX = touch - startX;
        // Move o cartão com o dedo
        content.style.transform = `translateX(${currentX}px)`;
    }, {passive: true});

    content.addEventListener('touchend', () => {
        content.classList.remove('swiping');
        
        if (currentX > threshold) {
            // --- SWIPE RIGHT -> EDITAR ---
            content.style.transform = `translateX(0px)`; // Volta ao sítio
            startEditMode(id);
        } else if (currentX < -threshold) {
            // --- SWIPE LEFT -> APAGAR ---
            deleteItem(id, cardElement);
        } else {
            // --- CANCELADO ---
            content.style.transform = `translateX(0px)`;
        }
        currentX = 0;
    });
}

// --- MODO DE EDIÇÃO ---
function startEditMode(id) {
    const item = cachedData[id];
    if (!item) return alert("Erro ao carregar dados do item.");

    editModeId = id; // Marca que estamos a editar este ID

    // Preenche o formulário existente
    document.getElementById('form-title').innerText = "Editar Produto";
    document.getElementById('btn-form-submit').innerText = "Guardar Alterações";
    
    const inpCodigo = document.getElementById('inp-codigo');
    const inpQtd = document.getElementById('inp-qtd');
    
    // Preenche e bloqueia campos que não se podem mudar
    inpCodigo.value = item.codigo;
    inpCodigo.disabled = true;
    inpQtd.value = item.quantidade;
    inpQtd.disabled = true;
    
    // Preenche campos editáveis
    document.getElementById('inp-nome').value = item.nome;
    document.getElementById('inp-tipo').value = item.tipo || '';
    document.getElementById('inp-loc').value = item.localizacao || '';

    // Navega para a vista do formulário
    nav('view-register');
}

// Função auxiliar para limpar o formulário para modo "Novo"
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
    // (Esta função mantém-se igual à anterior, podes manter a que tinhas)
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    qtdSpan.innerText = novaQtd;
    qtdSpan.style.color = "var(--primary)";
    setTimeout(() => { qtdSpan.style.color = "var(--text-main)"; }, 200);
    try { await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) }); } 
    catch (e) { qtdSpan.innerText = qtdAtual; }
}

async function deleteItem(id, cardElement) {
    if(confirm("Tem a certeza que deseja apagar este item?")) {
        cardElement.style.transform = `translateX(-100%)`; // Animação de saída
        setTimeout(() => cardElement.remove(), 200);
        try { await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' }); } catch(e) {};
    } else {
        // Se cancelar, volta o cartão ao sítio
        cardElement.querySelector('.card-content').style.transform = 'translateX(0px)';
    }
}

// --- SUBMISSÃO DO FORMULÁRIO (REGISTAR OU EDITAR) ---
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    
    const payload = {};
    // Se for novo, precisamos de tudo. Se for edição, só do que muda.
    if (editModeId === null) {
        // --- MODO NOVO (POST) ---
        payload.codigo = document.getElementById('inp-codigo').value.toUpperCase();
        payload.quantidade = parseInt(document.getElementById('inp-qtd').value) || 0;
    }
    
    // Campos sempre enviáveis (Nome, Tipo, Local)
    payload.nome = document.getElementById('inp-nome').value;
    payload.tipo = document.getElementById('inp-tipo').value;
    payload.localizacao = document.getElementById('inp-loc').value.toUpperCase();

    const url = editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL;
    const method = editModeId ? 'PATCH' : 'POST';

    try {
        await fetch(url, { method: method, body: JSON.stringify(payload) });
        e.target.reset();
        nav('view-search');
    } catch (err) {
        alert("Erro ao guardar. Tente novamente.");
    }
};

// (O resto do ficheiro mantém-se igual: form-bulk, DOMContentLoaded...)
document.getElementById('form-bulk').onsubmit = async (e) => { /* ... (Mantém o teu código do bulk) ... */ e.preventDefault(); const item = { codigo: document.getElementById('bulk-codigo').value.toUpperCase(), nome: document.getElementById('bulk-nome').value, localizacao: document.getElementById('bulk-loc').value.toUpperCase(), quantidade: 0 }; await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); document.getElementById('bulk-codigo').value = ""; document.getElementById('bulk-nome').value = ""; document.getElementById('bulk-codigo').focus(); const feedback = document.getElementById('bulk-feedback'); feedback.innerText = "✔ Guardado"; setTimeout(() => feedback.innerText = "", 1500); };

document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = document.body.classList.contains('dark-mode');
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    if (navigator.onLine) { document.getElementById('status-ponto').style.background = "#22c55e"; document.getElementById('status-texto').innerText = "Online"; }
});
