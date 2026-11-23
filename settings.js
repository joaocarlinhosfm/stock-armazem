// ─────────────────────────────────────────────────────────────────────────────
// settings.js — Gestão Armazém v6.81
// Definições e utilitários de manutenção: chave/proxy Anthropic (Claude Vision),
// palavras-chave OCR, pesquisa de imagens de produtos (SerpApi) e limpeza de
// referências duplicadas no stock (runDedup).
//
// DEPENDÊNCIAS:
//   utils.js — BASE_URL, $id, $el, showToast, modalOpen, focusModal,
//              _fetchWithTimeout, SVG_SEARCH, SVG_SPIN
//   auth.js  — authUrl
//   tools.js — openConfirmModal
//   stock.js — renderList
//   app.js   — cache, apiFetch, invalidateCache
// ─────────────────────────────────────────────────────────────────────────────

// ANTHROPIC API KEY — gestão local
const ANTHROPIC_KEY_STORAGE  = 'hiperfrio-anthropic-key';

// Chave Anthropic em sessionStorage (não persiste entre sessões nem é acessível
// por outras abas — reduz exposição vs localStorage)
function _getAnthropicKey() {
    return sessionStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
}
// Migração única: mover chave antiga de localStorage para sessionStorage e limpar
(function _migrateAnthropicKey() {
    const old = localStorage.getItem(ANTHROPIC_KEY_STORAGE);
    if (old) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, old);
        localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
    }
})();

function _isProxyUrl(val) {
    return val.startsWith('https://') || val.startsWith('http://');
}

function saveAnthropicKey() {
    const val = $id('inp-anthropic-key').value.trim();
    if (val && !_isProxyUrl(val) && !val.startsWith('sk-ant-')) {
        showToast('Valor inválido — introduz o URL do Worker (https://...) ou uma chave sk-ant-...', 'error');
        return;
    }
    if (val) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, val);
        $id('inp-anthropic-key').value = '';
        const tipo = _isProxyUrl(val) ? 'Proxy configurado' : 'Chave configurada';
        showToast(`${tipo} — OCR por foto usa agora Claude Vision ✓`, 'ok');
    } else {
        sessionStorage.removeItem(ANTHROPIC_KEY_STORAGE);
        showToast('Configuração removida — OCR volta ao modo local', 'ok');
    }
    _updateOcrKeyStatus();
}

function _updateOcrKeyStatus() {
    const val = _getAnthropicKey();
    let text, color;
    if (!val) {
        text  = 'Não configurada — usa OCR local';
        color = '';
    } else if (_isProxyUrl(val)) {
        text  = `✓ Claude Vision activo (${new URL(val).hostname})`;
        color = 'var(--ok, #16a34a)';
    } else {
        text  = `✓ Claude Vision activo (${val.slice(0,10)}…)`;
        color = 'var(--ok, #16a34a)';
    }
    ['ocr-api-status', 'ocr-api-status-modal'].forEach(id => {
        const el = $id(id);
        if (el) { el.textContent = text; el.style.color = color; }
    });
}

function openOcrSettings() {
    _updateOcrKeyStatus();
    _loadOcrKeywordsInput();
    // Pré-preenche o campo da chave
    const key = _getAnthropicKey();
    const inp = $id('inp-anthropic-key');
    if (inp && key) inp.value = key;
    modalOpen('ocr-settings-modal');
    focusModal('ocr-settings-modal');
}

// ── IMAGENS DE PRODUTOS — Google Custom Search + URL manual
// ── SerpApi Image Search ─────────────────────────────────────────────────
// Gratuito: 250 pesquisas/mês, sem cartão de crédito
// Documenta: serpapi.com/google-images-api
const GIMG_KEY_STORAGE = 'hiperfrio-serpapi-key'; // localStorage key

function _getSerpApiKey() {
    return localStorage.getItem(GIMG_KEY_STORAGE) || '';
}

function openGimgSettings() {
    const keyInp = $id('gimg-api-key-input');
    if (keyInp) keyInp.value = _getSerpApiKey();
    $id('gimg-settings-modal')?.classList.add('active');
    focusModal('gimg-settings-modal');
}
function closeGimgSettings() {
    $id('gimg-settings-modal')?.classList.remove('active');
}
function saveGimgKeys() {
    const key = $id('gimg-api-key-input')?.value.trim();
    if (!key) { showToast('Cola a chave SerpApi', 'error'); return; }
    localStorage.setItem(GIMG_KEY_STORAGE, key);
    showToast('Chave SerpApi guardada ✓');
    _updateGimgStatus();
    closeGimgSettings();
}
function clearGimgKeys() {
    localStorage.removeItem(GIMG_KEY_STORAGE);
    showToast('Chave removida');
    _updateGimgStatus();
    closeGimgSettings();
}

// MANUTENÇÃO — Limpar referências duplicadas no stock
// Lógica: agrupa todos os produtos por `codigo` (referência).
// Quando há mais do que um produto com o mesmo codigo, mantém o que tem
// mais informação (maior quantidade ou mais campos preenchidos) e apaga
// os restantes via DELETE na Firebase.
async function runDedup() {
    const btn    = $id('dedup-btn');
    const status = $id('dedup-status');

    if (btn) { btn.disabled = true; btn.textContent = 'A varrer...'; }
    if (status) status.textContent = 'A ler base de dados…';

    try {
        // 1 — Lê o stock completo directamente do servidor (sempre fresco)
        const url  = await authUrl(`${BASE_URL}/stock.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data || typeof data !== 'object') {
            if (status) status.textContent = 'Base de dados vazia.';
            return;
        }

        // 2 — Agrupa por código (normalizado: trim + uppercase)
        const grupos = {}; // { codigo: [ [firebaseKey, itemObj], ... ] }
        for (const [key, item] of Object.entries(data)) {
            if (!item || typeof item !== 'object') continue;
            const cod = (item.codigo || '').toString().trim().toUpperCase();
            if (!cod) continue; // ignora produtos sem referência
            if (!grupos[cod]) grupos[cod] = [];
            grupos[cod].push([key, item]);
        }

        // 3 — Encontra grupos com duplicados
        const duplicados = Object.entries(grupos).filter(([, arr]) => arr.length > 1);

        if (duplicados.length === 0) {
            if (status) status.textContent = 'Sem duplicados encontrados ✓';
            showToast('Sem duplicados encontrados ✓', 'ok');
            return;
        }

        // 4 — Mostra confirmação antes de apagar
        const totalApagar = duplicados.reduce((acc, [, arr]) => acc + arr.length - 1, 0);
        const linhas = duplicados.map(([cod, arr]) => {
            // Escolhe o melhor: maior quantidade; empate → mais campos preenchidos
            arr.sort((a, b) => {
                const qa = a[1].quantidade || 0;
                const qb = b[1].quantidade || 0;
                if (qb !== qa) return qb - qa;
                return Object.keys(b[1]).length - Object.keys(a[1]).length;
            });
            const [manterKey, manterItem] = arr[0];
            const apagar = arr.slice(1);
            return `• REF ${cod}: ${arr.length} entradas → manter "${manterItem.nome || manterKey}" (qty ${manterItem.quantidade ?? 0}), apagar ${apagar.length}`;
        }).join('\n');

        openConfirmModal({
            title: `Apagar ${totalApagar} produto${totalApagar > 1 ? 's' : ''} duplicado${totalApagar > 1 ? 's' : ''}?`,
            type: 'danger',
            desc: `Referências com duplicados (${duplicados.length}):\n\n${linhas}\n\nO produto com maior quantidade (ou mais informação) é mantido. Esta acção não pode ser desfeita.`,
            onConfirm: async () => {
                if (btn) btn.textContent = 'A apagar…';
                if (status) status.textContent = `A apagar ${totalApagar} duplicado(s)…`;

                let apagados = 0;
                let erros    = 0;

                for (const [, arr] of duplicados) {
                    // arr já está ordenado: arr[0] = manter, arr[1..] = apagar
                    for (const [key] of arr.slice(1)) {
                        try {
                            await apiFetch(`${BASE_URL}/stock/${key}.json`, { method: 'DELETE' });
                            // Remove do cache local imediatamente
                            if (cache.stock.data?.[key]) delete cache.stock.data[key];
                            apagados++;
                        } catch (e) {
                            console.error('[dedup] Erro ao apagar', key, e);
                            erros++;
                        }
                    }
                }

                // Invalida cache e re-renderiza
                invalidateCache('stock');
                await renderList('', true);

                const msg = erros > 0
                    ? `${apagados} duplicado(s) removido(s), ${erros} erro(s)`
                    : `${apagados} duplicado(s) removido(s) ✓`;
                if (status) status.textContent = msg;
                showToast(msg, erros > 0 ? 'error' : 'ok');
            }
        });

    } catch (e) {
        console.error('[dedup] Erro:', e);
        if (status) status.textContent = 'Erro: ' + (e?.message || e);
        showToast('Erro ao varrer: ' + (e?.message || e), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Varrer ›'; }
    }
}

function _updateGimgStatus() {
    const key = _getSerpApiKey();
    const el = $id('gimg-api-status');
    if (el) el.textContent = key
        ? 'SerpApi configurada — pesquisa automática activa'
        : 'Não configurada — configura o SerpApi para pesquisa automática';
}

// ── Pré-visualização ao colar URL manual ─────────────────────────────────
function imgUrlPreview(url) {
    const thumb       = $id('img-edit-thumb');
    const placeholder = $id('img-edit-placeholder');
    const clearBtn    = $id('img-clear-btn');
    if (!thumb) return;
    if (url && url.startsWith('http')) {
        thumb.src             = url;
        thumb.style.display   = 'block';
        if (placeholder) placeholder.style.display = 'none';
        if (clearBtn)    clearBtn.style.display     = 'inline-flex';
    } else {
        thumb.style.display   = 'none';
        if (placeholder) placeholder.style.display = 'flex';
        if (clearBtn)    clearBtn.style.display     = 'none';
    }
}

function imgClear() {
    const inp = $id('edit-img-url');
    if (inp) inp.value = '';
    imgUrlPreview('');
    $id('img-search-results').style.display = 'none';
}

// Carrega imgUrl no modal quando se abre editar produto
function _loadImgEdit(imgUrl) {
    const inp = $id('edit-img-url');
    if (inp) inp.value = imgUrl || '';
    imgUrlPreview(imgUrl || '');
    $id('img-search-results').style.display = 'none';
}

// ── Pesquisa automática SerpApi Google Images ────────────────────────────
// Documentação: https://serpapi.com/images-results
const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

async function imgSearchAuto() {
    const btn    = $id('img-search-btn');
    const nome   = $id('edit-nome')?.value.trim();  // só o nome, sem referência

    if (!nome) { showToast('Preenche primeiro o nome do produto', 'error'); return; }

    const key = _getSerpApiKey();

    if (!key) {
        // Sem chave: abre Google Images no browser
        const encoded = encodeURIComponent(nome + ' produto refrigeração HVAC');
        window.open(`https://www.google.com/search?tbm=isch&q=${encoded}`, '_blank');
        showToast('Sem chave SerpApi — a abrir Google Images no browser', 'info');
        return;
    }

    // Detecta se a chave é um URL de proxy (Cloudflare Worker)
    // ou uma chave SerpApi directa (que vai falhar por CORS)
    const isProxy = key.startsWith('http://') || key.startsWith('https://');

    const SPIN_SVG   = SVG_SPIN;
    const SEARCH_SVG = SVG_SEARCH;

    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + ' A pesquisar...';

    try {
        const q = encodeURIComponent(nome + ' HVAC refrigeração');
        let url;

        if (isProxy) {
            // Proxy Cloudflare Worker — passa o query como parâmetro
            url = `${key}?q=${q}`;
        } else {
            // Chamada directa SerpApi (pode falhar por CORS no browser)
            url = `${SERPAPI_ENDPOINT}?engine=google_images&q=${q}&num=6&safe=active&api_key=${key}`;
            console.warn('[imgSearch] AVISO: chamada directa ao SerpApi falha por CORS no browser. Configura um Cloudflare Worker como proxy.');
        }

        const res = await _fetchWithTimeout(url, {}, 12000);

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('[imgSearch] Erro HTTP:', res.status, errText);
            if (res.status === 401) throw new Error('Chave SerpApi inválida — verifica em Definições');
            if (res.status === 429) throw new Error('Quota esgotada (250 pesquisas/mês no plano gratuito)');
            throw new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
        }

        const data  = await res.json();

        if (data.error) throw new Error(data.error);

        const items = (data.images_results || []).slice(0, 6);
        if (items.length === 0) {
            showToast('Sem resultados — tenta outro nome ou cola um URL', 'error');
            return;
        }

        // Grelha de miniaturas clicáveis
        const resultsEl = $id('img-search-results');
        resultsEl.innerHTML = '';
        resultsEl.style.display = 'grid';

        items.forEach((item, i) => {
            const thumbUrl = item.thumbnail;
            const origUrl  = item.original;

            const wrap = $el('div', { className: 'img-result-thumb' });
            wrap.title     = item.title || '';

            const img = $el('img');
            img.src     = thumbUrl;
            img.alt     = item.title || '';
            img.onerror = () => {
                console.warn('[imgSearch] Falhou a carregar miniatura:', thumbUrl?.slice(0, 60));
                wrap.style.display = 'none';
            };
            img.onclick = () => {
                const chosen = origUrl || thumbUrl;
                $id('edit-img-url').value = chosen;
                imgUrlPreview(chosen);
                resultsEl.querySelectorAll('.img-result-thumb').forEach(t => t.classList.remove('selected'));
                wrap.classList.add('selected');
            };
            wrap.appendChild(img);
            resultsEl.appendChild(wrap);
        });

    } catch(e) {
        if (e?.message === 'Failed to fetch' || e?.name === 'TypeError') {
            showToast('Erro CORS — configura um Cloudflare Worker como proxy em Definições.', 'error');
        } else {
            showToast('Erro na pesquisa: ' + (e?.message || e), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = SEARCH_SVG + ' Pesquisar imagem';
    }
}

async function testAnthropicProxy() {
    const val = _getAnthropicKey();
    if (!val) { showToast('Configura primeiro o URL do Worker', 'error'); return; }

    const btn = $id('btn-test-ocr');
    if (btn) { btn.disabled = true; btn.textContent = '◷ A testar…'; }

    try {
        const isProxy = _isProxyUrl(val);
        const endpoint = isProxy ? val : 'https://api.anthropic.com/v1/messages';
        const headers = { 'Content-Type': 'application/json' };
        if (!isProxy) {
            headers['x-api-key'] = val;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-allow-browser'] = 'true';
        }

        const resp = await _fetchWithTimeout(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'Hi' }]
            })
        }, 15000); // timeout mais curto para o teste

        const data = await resp.json();
        if (data.content || data.id) {
            showToast('✓ Ligação OK — Claude Vision pronto a usar!', 'ok');
        } else if (data.error) {
            showToast('Erro da API: ' + (data.error.message || JSON.stringify(data.error)), 'error');
        } else {
            showToast('Resposta inesperada: ' + JSON.stringify(data).slice(0, 80), 'error');
        }
    } catch(e) {
        showToast('Falha na ligação: ' + (e.message || e), 'error');
        console.error('[testProxy]', e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Testar ligação'; }
    }
}

// OCR KEYWORDS — palavras-chave de estabelecimento
const OCR_KEYWORDS_KEY = 'hiperfrio-ocr-keywords';

function saveOcrKeywords() {
    const val = $id('inp-ocr-keywords').value.trim();
    if (val) localStorage.setItem(OCR_KEYWORDS_KEY, val);
    else localStorage.removeItem(OCR_KEYWORDS_KEY);
    showToast('Palavras-chave guardadas ✓', 'ok');
}

function _getOcrKeywords() {
    return (localStorage.getItem(OCR_KEYWORDS_KEY) || '')
        .split('\n').map(k => k.trim()).filter(Boolean);
}

function _loadOcrKeywordsInput() {
    const el = $id('inp-ocr-keywords');
    if (el) el.value = _getOcrKeywords().join('\n');
}
