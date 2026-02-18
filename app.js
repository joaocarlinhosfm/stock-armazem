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
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- TEMA E INICIALIZAÇÃO ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
}

(function applyThemeOnLoad() {
    const savedTheme = localStorage.getItem('hiperfrio-tema');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        const toggle = document.getElementById('theme-toggle');
        if(toggle) toggle.checked = true;
    }
})();

// --- NAVEGAÇÃO ---
function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function nav(viewId, isEdit = false) {
    if (viewId === 'view-register' && !isEdit) {
        resetRegisterForm("Novo Produto");
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    if(viewId === 'view-search') renderList();
    
    // Fecha o menu
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
    window.scrollTo(0,0);
}

// --- RENDERIZAÇÃO DA LISTA ---
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    
    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        cachedData = data || {}; 
        
        listEl.innerHTML = ''; 
        if (!data) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Sem produtos em stock.</div>';

        const itens = Object.entries(data)
            .map(([id, val]) => ({ id, ...val }))
            .filter(i => 
                (i.nome && i.nome.toLowerCase().includes(filter.toLowerCase())) ||
                (i.codigo && String(i.codigo).includes(filter))
            )
            .reverse();

        itens.forEach(item => {
            const el = document.createElement('div');
            el.className = 'item-card';
            el.dataset.id = item.id;
            
            const qtd = item.quantidade || 0;
            // Efeito de pulsar apenas se a quantidade for EXATAMENTE 0
            const lowStockClass = qtd === 0 ? 'low-stock' : '';

            el.innerHTML = `
                <div class="card-bg-layer layer-edit">✏️ Editar</div>
                <div class="card-bg-layer layer-delete">🗑️ Apagar</div>
                
                <div class="card-content">
                    <div style="display:flex; flex-direction:column; margin-bottom:12px;">
                        <span style="font-size:0.75rem; font-weight:800; color:var(--primary); letter-spacing:0.5px;">REF: ${item.codigo}</span>
                        <span style="font-size:1.05rem; font-weight:600;">${item.nome}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="background:var(--primary-soft); color:var(--primary); padding:6px 10px; border-radius:8px; font-size:0.8rem; font-weight:700;">📍 ${item.localizacao || 'S/ LOC'}</div>
                        <div style="display:flex; align-items:center; gap:12px; background:var(--bg); padding:4px 8px; border-radius:12px;">
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', -1)" style="width:32px; height:32px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">−</button>
                            <span class="qtd-value ${lowStockClass}" data-id="${item.id}">${qtd}</span>
                            <button class="btn-qtd" onclick="changeQtd('${item.id}', 1)" style="width:32px; height:32px; border-radius:50%; border:1px solid var(--border); background:var(--card-bg); color:var(--text-main); font-weight:bold;">+</button>
                        </div>
                    </div>
                </div>
            `;
            listEl.appendChild(el);
            setupSwipe(el, item.id);
        });
    } catch (e) {
        showToast("Erro ao carregar dados.", "error");
    }
}

// --- LÓGICA DE SWIPE (OTIMIZADA ANDROID) ---
function setupSwipe(cardElement, id) {
    const content = cardElement.querySelector('.card-content');
    let startX = 0, startY = 0, currentX = 0;
    let isScrolling = false;

    content.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isScrolling = false;
        content.style.transition = 'none';
    }, {passive: true});

    content.addEventListener('touchmove', e => {
        const touchX = e.touches[0].clientX;
        const touchY = e.touches[0].clientY;
        currentX = touchX - startX;
        const currentY = touchY - startY;

        // Se o movimento vertical for maior, assumimos que é scroll e cancelamos o swipe
        if (Math.abs(currentY) > Math.abs(currentX)) {
            isScrolling = true;
        }

        if (!isScrolling) {
            content.style.transform = `translateX(${currentX}px)`;
        }
    }, {passive: true});

    content.addEventListener('touchend', () => {
        content.style.transition = 'transform 0.3s ease';
        if (!isScrolling) {
            if (currentX > 80) {
                startEditMode(id);
            } else if (currentX < -80) {
                deleteItem(id, cardElement);
            }
        }
        content.style.transform = `translateX(0px)`;
        currentX = 0;
    });
}

// --- MODIFICAR QUANTIDADE RÁPIDA ---
async function changeQtd(id, delta) {
    const span = document.querySelector(`.qtd-value[data-id="${id}"]`);
    if(!span) return;

    let novaQtd = Math.max(0, parseInt(span.innerText) + delta);
    span.innerText = novaQtd;

    // Atualiza efeito visual
    if (novaQtd === 0) span.classList.add('low-stock');
    else span.classList.remove('low-stock');

    try { 
        await fetch(`${BASE_URL}/stock/${id}.json`, { 
            method: 'PATCH', 
            body: JSON.stringify({ quantidade: novaQtd }) 
        }); 
    } catch (e) { 
        showToast("Erro ao sincronizar quantidade.", "error");
    }
}

// --- MODO DE EDIÇÃO ---
function startEditMode(id) {
    const item = cachedData[id];
    if (!item) return;

    editModeId = id; 
    document.getElementById('form-title').innerText = "Editar Produto";
    document.getElementById('btn-form-submit').innerText = "Guardar Alterações";
    
    // Preencher campos
    const inpCodigo = document.getElementById('inp-codigo');
    inpCodigo.value = item.codigo;
    inpCodigo.disabled = true; // Bloqueia apenas a referência
    
    document.getElementById('inp-nome').value = item.nome;
    document.getElementById('inp-tipo').value = item.tipo || '';
    document.getElementById('inp-loc').value = item.localizacao || '';
    
    const inpQtd = document.getElementById('inp-qtd');
    inpQtd.value = item.quantidade;
    inpQtd.disabled = false; // Permite editar quantidade na edição

    nav('view-register', true);
}

function resetRegisterForm(title) {
    editModeId = null;
    document.getElementById('form-add').reset();
    document.getElementById('form-title').innerText = title;
    document.getElementById('btn-form-submit').innerText = "Gravar Produto";
    document.getElementById('inp-codigo').disabled = false;
    document.getElementById('inp-qtd').disabled = false;
}

// --- SUBMISSÕES ---

// 1. Formulário Individual (Novo ou Editar)
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
        nome: document.getElementById('inp-nome').value,
        tipo: document.getElementById('inp-tipo').value,
        localizacao: document.getElementById('inp-loc').value.toUpperCase(),
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0
    };
    
    if (editModeId === null) {
        payload.codigo = document.getElementById('inp-codigo').value;
    }

    const url = editModeId ? `${BASE_URL}/stock/${editModeId}.json` : DB_URL;
    const method = editModeId ? 'PATCH' : 'POST';

    try {
        await fetch(url, { method: method, body: JSON.stringify(payload) });
        showToast(editModeId ? "Alterações guardadas!" : "Produto criado!");
        nav('view-search');
    } catch (err) {
        showToast("Erro ao comunicar com servidor.", "error");
    }
};

// 2. Formulário de Lote (Catalogação rápida)
document.getElementById('form-bulk').onsubmit = async (e) => { 
    e.preventDefault(); 
    
    const qtdInput = document.getElementById('bulk-qtd');
    const item = { 
        codigo: document.getElementById('bulk-codigo').value, 
        nome: document.getElementById('bulk-nome').value, 
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(), 
        quantidade: (qtdInput && qtdInput.value) ? parseInt(qtdInput.value) : 0 
    }; 
    
    try {
        await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); 
        showToast("Item de lote adicionado!");
        
        // Limpa apenas campos do item, mantém a localização fixa
        document.getElementById('bulk-codigo').value = ""; 
        document.getElementById('bulk-nome').value = ""; 
        if(qtdInput) qtdInput.value = ""; 
        document.getElementById('bulk-codigo').focus(); 
    } catch(err) {
        showToast("Erro ao gravar lote.", "error");
    }
};

// --- APAGAR ---
async function deleteItem(id, cardElement) {
    if(confirm("Deseja apagar este produto permanentemente?")) {
        cardElement.style.opacity = '0.3';
        try { 
            await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' }); 
            cardElement.remove();
            showToast("Produto removido.");
        } catch(e) {
            showToast("Erro ao apagar.", "error");
            cardElement.style.opacity = '1';
        };
    }
}

// --- ARRANQUE ---
document.addEventListener('DOMContentLoaded', () => {
    renderList();
    
    const searchInp = document.getElementById('inp-search');
    if(searchInp) {
        searchInp.oninput = (e) => renderList(e.target.value);
    }
    
    if (navigator.onLine) { 
        const ponto = document.getElementById('status-ponto');
        if(ponto) ponto.style.background = "#22c55e"; 
    }
});
