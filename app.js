// No início do ficheiro app.js
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

// Chamar esta função IMEDIATAMENTE antes de qualquer outra coisa
(function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
})();

// Atualizar o estado do checkbox quando o DOM carregar
document.addEventListener('DOMContentLoaded', () => {
    const toggleInput = document.getElementById('theme-toggle');
    if (toggleInput) {
        toggleInput.checked = document.body.classList.contains('dark-mode');
    }
    
    renderList(); // A tua função de carregar stock
    
    // ... restante dos teus listeners (search, etc)
});

// Garante que a função changeQtd usa as cores das variáveis
async function changeQtd(id, delta) {
    const card = document.querySelector(`.item-card[data-id="${id}"]`);
    if(!card) return;
    const qtdSpan = card.querySelector('.qtd-value');
    let qtdAtual = parseInt(qtdSpan.innerText);
    let novaQtd = Math.max(0, qtdAtual + delta);
    
    qtdSpan.innerText = novaQtd;
    qtdSpan.style.color = "var(--primary)"; // Usa a variável, não cor fixa
    setTimeout(() => { qtdSpan.style.color = "var(--text-main)"; }, 200);

    // Fetch para o Firebase...
    try {
        await fetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: novaQtd })
        });
    } catch (e) { qtdSpan.innerText = qtdAtual; }
}
