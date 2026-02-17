const DB_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app/stock.json";
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

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
        const resp = await fetch(DB_URL);
        const data = await resp.json();
        listEl.innerHTML = "";
        
        if(!data) return listEl.innerHTML = "<div style='text-align:center; padding:20px;'>Sem produtos.</div>";

        const term = filter.toLowerCase();
        Object.keys(data).forEach(id => {
            const item = data[id];
            if (item.nome.toLowerCase().includes(term) || item.codigo.toLowerCase().includes(term) || (item.localizacao || "").toLowerCase().includes(term)) {
                
                // 1. Criar o contentor principal
                const cardContainer = document.createElement('div');
                cardContainer.className = 'item-card';
                cardContainer.setAttribute('data-id', id);
                
                // 2. Injetar a estrutura HTML (Fundo Vermelho + Conteúdo Branco)
                cardContainer.innerHTML = `
                    <div class="card-delete-layer">
                        <span>🗑️ Apagar</span>
                    </div>
                    
                    <div class="card-content">
                        <div class="card-header-compact">
                            <span class="item-ref">${item.codigo}</span>
                            <span class="item-name">${item.nome}</span>
                        </div>
                        
                        <div class="card-footer-compact">
                            <span class="badge-loc">📍 ${item.localizacao || 'S/ Local'}</span>
                            <div class="qtd-pill">
                                <button class="btn-qtd" ontouchstart="event.stopPropagation()" onclick="changeQtd('${id}', -1)">-</button>
                                <span class="qtd-value">${item.quantidade || 0}</span>
                                <button class="btn-qtd" ontouchstart="event.stopPropagation()" onclick="changeQtd('${id}', 1)">+</button>
                            </div>
                        </div>
                    </div>
                `;
                
                // 3. Adicionar o cartão à lista
                listEl.appendChild(cardContainer);

                // 4. Ativar a funcionalidade de Swipe para este cartão
                setupSwipe(cardContainer, id);
            }
        });
    } catch (e) { listEl.innerHTML = "<div style='color:red; text-align:center; padding:20px;'>Erro de rede.</div>"; }
}

// --- LÓGICA DO GMAIL SWIPE-TO-DELETE ---
function setupSwipe(cardContainer, id) {
    const content = cardContainer.querySelector('.card-content');
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    const threshold = window.innerWidth * 0.4; // 40% do ecrã para ativar o delete

    // Início do toque
    cardContainer.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        isDragging = true;
        content.classList.add('swiping'); // Remove transições suaves durante o arraste
    }, { passive: true });

    // Movimento do dedo
    cardContainer.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentX = e.touches[0].clientX;
        const diff = currentX - startX;

        // Só permite arrastar para a esquerda (valores negativos)
        if (diff < 0) {
            // Move o conteúdo com o dedo
            content.style.transform = `translateX(${diff}px)`;
        }
    }, { passive: true });

    // Fim do toque (levantar o dedo)
    cardContainer.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        content.classList.remove('swiping'); // Reativa transições suaves
        const diff = currentX - startX;

        if (diff < -threshold) {
            // --- CONFIRMADO O DELETE ---
            // 1. Anima o cartão para fora do ecrã
            content.style.transform = `translateX(-110%)`;
            // 2. Pergunta se quer mesmo apagar (segurança)
            setTimeout(() => {
                if(confirm("Pretende eliminar este produto permanentemente?")) {
                    apagarProduto(id);
                    cardContainer.style.display = 'none'; // Esconde imediatamente
                } else {
                     // Se cancelar, volta o cartão ao sítio
                     content.style.transform = 'translateX(0)';
                }
            }, 300); // Espera a animação terminar

        } else {
            // --- CANCELADO (não arrastou o suficiente) ---
            // Volta o cartão à posição inicial suavemente
            content.style.transform = 'translateX(0)';
        }
    });
}

// --- FUNÇÕES DE DADOS ---
async function changeQtd(id, delta) {
    if(!navigator.onLine) return alert("Offline");
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    qtdSpan.innerText = novaQtd;
    qtdSpan.style.color = "#2563eb"; 
    setTimeout(() => { qtdSpan.style.color = "inherit"; }, 200);
    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: novaQtd }) });
    } catch (e) { qtdSpan.innerText = qtdAtual; }
}

async function apagarProduto(id) {
    if(!navigator.onLine) return alert("Offline");
    // A confirmação agora é feita no evento do Swipe
    await fetch(`${BASE_URL}/stock/${id}.json`, { method: 'DELETE' });
    renderList(document.getElementById('inp-search').value);
}

// --- FORMULÁRIOS & INIT ---
document.getElementById('form-register').onsubmit = async (e) => {
    e.preventDefault();
    // (Código do formulário igual ao anterior...)
    const item = { codigo: document.getElementById('inp-codigo').value.toUpperCase(), nome: document.getElementById('inp-nome').value, tipo: document.getElementById('inp-tipo').value, localizacao: document.getElementById('inp-loc').value.toUpperCase(), quantidade: parseInt(document.getElementById('inp-qtd').value) || 0 };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); e.target.reset(); nav('view-search');
};

document.getElementById('form-bulk').onsubmit = async (e) => {
    e.preventDefault();
    // (Código do bulk igual ao anterior...)
    const item = { codigo: document.getElementById('bulk-codigo').value.toUpperCase(), nome: document.getElementById('bulk-nome').value, localizacao: document.getElementById('bulk-loc').value.toUpperCase(), quantidade: 0 };
    await fetch(DB_URL, { method: 'POST', body: JSON.stringify(item) }); document.getElementById('bulk-codigo').value = ""; document.getElementById('bulk-nome').value = ""; document.getElementById('bulk-codigo').focus(); document.getElementById('bulk-feedback').innerText = "✔ Guardado"; setTimeout(() => document.getElementById('bulk-feedback').innerText = "", 1500);
};

document.addEventListener('DOMContentLoaded', () => {
    renderList();
    document.getElementById('inp-search').oninput = (e) => renderList(e.target.value);
    if (navigator.onLine) { document.getElementById('status-ponto').style.background = "#22c55e"; document.getElementById('status-texto').innerText = "Online"; }
});
