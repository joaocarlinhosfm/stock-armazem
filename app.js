const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// --- INICIALIZAÇÃO E TEMA (Executa Imediatamente) ---
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('hiperfrio-tema', isDark ? 'dark' : 'light');
}

(function applyThemeOnLoad() {
    const savedTheme = localStorage.getItem('hiperfrio-tema');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
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
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(viewId === 'view-search') renderList();
    document.getElementById('side-menu').classList.remove('open');
    document.getElementById('menu-overlay').classList.remove('active');
}

// --- RENDERIZAÇÃO DA LISTA COM SWIPE ---
async function renderList(filter = "") {
    const listEl = document.getElementById('stock-list');
    if (!filter && listEl.innerHTML === "") {
        listEl.innerHTML = "<div style='text-align:center; padding:40px; color:gray;'>A sincronizar stock...</div>";
    }

    try {
        const res = await fetch(DB_URL);
        const data = await res.json();
        listEl.innerHTML = '';
        if (!data) return listEl.innerHTML = '<div style="text-align:center; padding:40px; color:gray;">Sem dados.</div>';

        let topHtml = `<header style="margin:-16px -16px 16px -16px;">
            <button id="menu-btn" onclick="toggleMenu()">☰</button>
            <h1>O Meu Stock</h1>
            <div style="width: 30px;"></div>
        </header>`;
        
        listEl.innerHTML = topHtml;

        const itens = Object.entries(data)
            .map(([id, val]) => ({ id, ...val }))
            .filter(i => 
                (i.nome && i.nome.toLowerCase().includes(filter.toLowerCase())) ||
                (i.codigo && i.codigo.toLowerCase().includes(filter.toLowerCase())) ||
                (i.localizacao && i.localizacao.toLowerCase().includes(filter.toLowerCase()))
            )
            .reverse();

        if(itens.length === 0) {
            listEl.innerHTML += '<div style="text-align:center; padding:40px; color:gray;">Nenhum produto encontrado.</div>';
            return;
        }

        itens.forEach(item => {
            const el = document.createElement('div');
            el.className = 'item-card';
            el.dataset.id = item.id;
            
            el.innerHTML = `
                <div class="card-delete-layer">🗑️ Apagar</div>
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
            setupSwipe(el, item.id);
        });
    } catch (e) {
        listEl.innerHTML = "<div style='text-align:center; padding:40px; color:red;'>Erro de ligação. Modo Offline ativo.</div>";
    }
}

// --- LOGICA DE SWIPE (Isolada à Camada de Cima) ---
function setupSwipe(cardElement, id) {
    const content = cardElement.querySelector('.card-content');
    let startX = 0;
    let currentX = 0;
    const threshold = -80; 

    content.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        content.classList.add('swiping');
    }, {passive: true});

    content.addEventListener('touchmove', e => {
        const touch = e.touches[0].clientX;
        const diff = touch - startX;
        
        if (diff < 0) {
            currentX = diff;
            content.style.transform = `translateX(${currentX}px)`;
        }
    }, {passive: true});

    content.addEventListener('touchend', () => {
        content.classList.remove('swiping');
        
        if (currentX < threshold) {
            deleteItem(id, cardElement);
        } else {
            content.style.transform = `translateX(0px)`;
        }
        currentX = 0;
    });
}

// --- AÇÕES ---
async function changeQtd(id, delta) {
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    
    qtdSpan.innerText = novaQtd;
    qtdSpan.style.color = "var(--primary)";
    setTimeout(() => { qtdSpan.style.color = "var(--text-main)"; }, 200);

    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: novaQtd })
        });
    } catch (e) { 
        qtdSpan.innerText = qtdAtual; 
        alert("Erro ao sincronizar. Verifica a net.");
    }
}

async function deleteItem(id, cardElement) {
    cardElement.style.opacity = '0';
    setTimeout(() => cardElement.remove(), 300);
    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
    } catch(e) {
        alert("Erro ao apagar no servidor. Atualize a página.");
    }
}

// --- FORMULÁRIOS ---
document.getElementById('form-add').onsubmit = async (e) => {
    e.preventDefault();
    const item = { 
        codigo: document.getElementById('inp-codigo').value.toUpperCase(), 
        nome: document.getElementById('inp-nome').value, 
        tipo: document.getElementById('inp-tipo').value, 
        localizacao: document.getElementById('inp-loc').value.toUpperCase(), 
        quantidade: parseInt(document.getElementById('inp-qtd').value) || 0 
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); 
    e.target.reset(); 
    nav('view-search');
};

document.getElementById('form-bulk').onsubmit = async (e) => {
    e.preventDefault();
    const item = { 
        codigo: document.getElementById('bulk-codigo').value.toUpperCase(), 
        nome: document.getElementById('bulk-nome').value, 
        localizacao: document.getElementById('bulk-loc').value.toUpperCase(), 
        quantidade: 0 
    };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); 
    document.getElementById('bulk-codigo').value = ""; 
    document.getElementById('bulk-nome').value = ""; 
    document.getElementById('bulk-codigo').focus(); 
    const feedback = document.getElementById('bulk-feedback');
    feedback.innerText = "✔ Guardado"; 
    setTimeout(() => feedback.innerText = "", 1500);
};

// --- ARRANQUE --
document.addEventListener('DOMContentLoaded', () => {
    // Sincronizar o estado visual do interruptor com o tema carregado
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = document.body.classList.contains('dark-mode');

    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    
    if (navigator.onLine) { 
        document.getElementById('status-ponto').style.background = "#22c55e"; 
        document.getElementById('status-texto').innerText = "Online"; 
    }
});
a
