// ─────────────────────────────────────────────────────────────────────────────
// guias.js — Hiperfrio v6.56
// Guias Técnicos: separação de material para técnicos.
//
// Fluxo: pendente → (todas linhas recolhidas) → separado → (30 dias) → histórico
// Entrada manual ou por PDF (OCR via Claude Vision, mesma pipeline das encomendas).
// Cada recolha decrementa /stock e regista movimento (tipo: saida_guia).
//
// Firebase:
//   /guias/{id}
//     numero, tecnico, data (YYYY-MM-DD), status, criadoEm, separadoEm
//     linhas: { {lineId}: { codigo, nome, quantidade, unidade, recolhido, recolhidoEm } }
//
// Dependências:
//   utils.js → BASE_URL, $id, $el, escapeHtml, showToast, modalOpen/Close, _calcDias, _fetchWithTimeout
//   auth.js  → authUrl, getAuthToken
//   app.js   → apiFetch, cache, fetchCollection, invalidateCache, _getAnthropicKey, _isProxyUrl
//   reports.js → registarMovimento
// ─────────────────────────────────────────────────────────────────────────────

const GUIAS_URL = `${BASE_URL}/guias`;
const GUIAS_TTL = 60_000;
const GUIAS_HIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

const _guiasCache = { data: null, lastFetch: 0 };

let _guiasTab      = 'pendentes'; // 'pendentes' | 'separadas' | 'historico'
let _guiasEditId   = null;        // id da guia aberta em detalhe
let _guiasSearchQ  = '';

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function _fetchGuias(force = false) {
    const now = Date.now();
    if (!force && _guiasCache.data && now - _guiasCache.lastFetch < GUIAS_TTL) {
        return _guiasCache.data;
    }
    try {
        const url = await authUrl(`${GUIAS_URL}.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        _guiasCache.data = (await res.json()) || {};
        _guiasCache.lastFetch = now;
        // Auto-move: separado há >30 dias vai para histórico
        _autoMoverParaHistorico();
    } catch(e) {
        console.warn('[Guias] fetch falhou:', e?.message);
        _guiasCache.data = _guiasCache.data || {};
    }
    return _guiasCache.data;
}

async function _autoMoverParaHistorico() {
    const agora = Date.now();
    const candidatas = Object.entries(_guiasCache.data || {}).filter(([, g]) =>
        g.status === 'separado' && g.separadoEm && (agora - g.separadoEm) > GUIAS_HIST_TTL_MS
    );
    if (!candidatas.length) return;
    for (const [id, g] of candidatas) {
        try {
            await apiFetch(`${GUIAS_URL}/${id}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'historico' }),
            });
            g.status = 'historico';
        } catch(e) {
            console.warn('[Guias] auto-move falhou:', id, e?.message);
        }
    }
}

// ─── Render principal ─────────────────────────────────────────────────────────
async function renderGuias() {
    const el = $id('guias-list');
    if (!el) return;
    el.innerHTML = '<div class="pat-loading">A carregar...</div>';

    // Sync tab UI
    ['pendentes', 'separadas', 'historico'].forEach(t => {
        $id(`guias-tab-${t}`)?.classList.toggle('active', _guiasTab === t);
    });

    const data = await _fetchGuias();
    const q = _guiasSearchQ.toLowerCase().trim();

    let entries = Object.entries(data || {})
        .filter(([, g]) => {
            if (_guiasTab === 'pendentes') return g.status !== 'separado' && g.status !== 'historico';
            if (_guiasTab === 'separadas') return g.status === 'separado';
            if (_guiasTab === 'historico') return g.status === 'historico';
            return false;
        })
        .filter(([, g]) => {
            if (!q) return true;
            return (g.numero || '').toLowerCase().includes(q) ||
                   (g.tecnico || '').toLowerCase().includes(q);
        })
        .sort((a, b) => (b[1].criadoEm || 0) - (a[1].criadoEm || 0));

    if (entries.length === 0) {
        const msgs = {
            pendentes: 'Nenhuma guia pendente.',
            separadas: 'Nenhuma guia separada.',
            historico: 'Sem histórico.',
        };
        el.innerHTML = `<div class="pat-empty">${msgs[_guiasTab] || ''}</div>`;
        updateGuiasCount();
        return;
    }

    el.innerHTML = '';
    const frag = document.createDocumentFragment();

    if (_guiasTab === 'pendentes') {
        const total = entries.length;
        const countBar = $el('div', { className: 'pat-count-bar' });
        countBar.innerHTML = `<span class="pat-count-lbl">${total} guia${total !== 1 ? 's' : ''} pendente${total !== 1 ? 's' : ''}</span>`;
        frag.appendChild(countBar);
    }

    entries.forEach(([id, g]) => frag.appendChild(_buildGuiaCard(id, g)));
    el.appendChild(frag);

    // Actualizar contador de tab
    const tabEl = $id(`guias-tab-${_guiasTab}`);
    if (tabEl) {
        let cnt = tabEl.querySelector('.pat-tab-cnt');
        if (!cnt) { cnt = $el('span'); cnt.className = 'pat-tab-cnt'; tabEl.appendChild(cnt); }
        cnt.textContent = entries.length;
    }
    updateGuiasCount();
}

function _buildGuiaCard(id, g) {
    const linhas = g.linhas || {};
    const linhasArr = Object.entries(linhas);
    const totalL = linhasArr.length;
    const recolhidasL = linhasArr.filter(([, l]) => l.recolhido).length;
    const pct = totalL > 0 ? Math.round((recolhidasL / totalL) * 100) : 0;
    const dataFmt = g.data ? g.data.split('-').reverse().join('/') : '—';

    const card = $el('div', { className: 'guia-card' });

    // ── Header: técnico + nº + data à esquerda, badge + progresso à direita ──
    const hdr = $el('div', { className: 'guia-card-hdr' });
    const hdrLeft = $el('div', { className: 'guia-card-hdr-left' });
    const tec = $el('span', { className: 'guia-card-tec' });
    tec.textContent = (g.tecnico || 'SEM TÉCNICO').toUpperCase();
    const numSpan = $el('span', { className: 'guia-card-num' });
    numSpan.textContent = `Guia ${g.numero || '—'}`;
    const dtSpan = $el('span', { className: 'guia-card-date' });
    dtSpan.textContent = dataFmt;
    hdrLeft.appendChild(tec);
    hdrLeft.appendChild(numSpan);
    hdrLeft.appendChild(dtSpan);

    const hdrRight = $el('div', { className: 'guia-card-hdr-right' });
    const badge = $el('span', { className: `guia-badge guia-badge-${g.status || 'pendente'}` });
    badge.textContent = g.status === 'separado' ? 'Separada' : g.status === 'historico' ? 'Histórico' : 'Pendente';
    const progress = $el('span', { className: 'guia-card-progress' });
    progress.textContent = `${recolhidasL}/${totalL} · ${pct}%`;
    hdrRight.appendChild(badge);
    hdrRight.appendChild(progress);

    hdr.appendChild(hdrLeft);
    hdr.appendChild(hdrRight);
    card.appendChild(hdr);

    // ── Tabela de materiais ────────────────────────────────────────────
    const table = $el('div', { className: 'guia-card-table' });

    // Header da tabela
    const thead = $el('div', { className: 'guia-card-thead' });
    const cols = ['REFERÊNCIA', 'DESIGNAÇÃO', 'QTD.', 'ESTADO'];
    cols.forEach(c => {
        const th = $el('div', { className: 'guia-card-th', textContent: c });
        thead.appendChild(th);
    });
    table.appendChild(thead);

    // Linhas
    if (linhasArr.length === 0) {
        const empty = $el('div', { className: 'guia-card-empty', textContent: 'Sem materiais.' });
        table.appendChild(empty);
    } else {
        linhasArr.forEach(([lid, l]) => {
            const row = $el('div', { className: 'guia-card-tr' + (l.recolhido ? ' is-recolhido' : '') });

            const ref = $el('div', { className: 'guia-card-td guia-card-td-ref' });
            ref.textContent = l.codigo || '—';

            const nome = $el('div', { className: 'guia-card-td guia-card-td-nome' });
            nome.textContent = l.nome || '';

            const qty = $el('div', { className: 'guia-card-td guia-card-td-qty' });
            qty.textContent = fmtQty(l.quantidade, l.unidade);

            const estado = $el('div', { className: 'guia-card-td guia-card-td-estado' });
            const btn = $el('button', { className: 'guia-card-btn' });
            // Não deixa o click propagar para o card (que navega para detalhe)
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                toggleLinhaRecolhida(id, lid, !l.recolhido);
            });

            if (l.recolhido) {
                btn.className += ' recolhido';
                btn.innerHTML = SVG_CHECK + ' Recolhido';
                btn.title = 'Toca para desfazer';
            } else {
                btn.textContent = 'Recolher';
            }

            // Guardar role só os workers não recolhem (gestor decide)
            if (currentRole === 'worker') {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
            }

            estado.appendChild(btn);

            row.appendChild(ref);
            row.appendChild(nome);
            row.appendChild(qty);
            row.appendChild(estado);
            table.appendChild(row);
        });
    }

    card.appendChild(table);

    // Click no header (fora dos botões) abre detalhe para apagar/editar
    hdr.addEventListener('click', () => openGuiaDetail(id));

    return card;
}

function guiasSetTab(tab) {
    _guiasTab = tab;
    renderGuias();
}

const _debouncedGuiasSearch = _debounce(v => {
    _guiasSearchQ = v || '';
    renderGuias();
}, 300);
function guiasSearchFilter(v) { _debouncedGuiasSearch(v); }

async function updateGuiasCount() {
    // Usado pelo badge no menu/bottom nav, se existir
    await _fetchGuias();
    const pend = Object.values(_guiasCache.data || {})
        .filter(g => g.status !== 'separado' && g.status !== 'historico').length;
    const badges = document.querySelectorAll('.guias-count-badge');
    badges.forEach(b => {
        b.textContent = pend;
        b.style.display = pend > 0 ? '' : 'none';
    });
}

// ─── Modal Nova Guia (manual) ─────────────────────────────────────────────────
function openNovaGuia() {
    _guiasEditId = null;
    $id('guia-modal-title').textContent = 'Nova Guia';
    $id('guia-numero').value = '';
    $id('guia-data').value = new Date().toISOString().split('T')[0];
    $id('guia-tecnico').value = '';
    $id('guia-linhas-wrap').innerHTML = '';
    guiaAddLinha();
    _refreshGuiaTecnicosDatalist();
    modalOpen('guia-modal');
    focusModal('guia-modal');
}

function closeGuiaModal() { modalClose('guia-modal'); }

async function _refreshGuiaTecnicosDatalist() {
    // Reutiliza /funcionarios como lista de técnicos
    const dl = $id('guia-tecnicos-datalist');
    if (!dl) return;
    try {
        const func = await fetchCollection('funcionarios');
        dl.innerHTML = '';
        Object.values(func || {}).forEach(f => {
            if (!f?.nome) return;
            const opt = $el('option');
            opt.value = f.nome;
            dl.appendChild(opt);
        });
    } catch(e) { console.warn('[Guias] datalist técnicos:', e?.message); }
}

function guiaAddLinha(codigo = '', nome = '', qtd = '', unidade = 'un') {
    const wrap = $id('guia-linhas-wrap');
    const div = $el('div', { className: 'guia-linha' });
    div.innerHTML = `
        <input class="blue-input guia-linha-ref"  type="text"   placeholder="Ref."       value="${escapeHtml(String(codigo))}" autocomplete="off" data-lpignore="true" data-form-type="other" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input guia-linha-nome" type="text"   placeholder="Designação" value="${escapeHtml(String(nome))}"   autocomplete="off" data-lpignore="true" data-form-type="other" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input guia-linha-qtd"  type="number" placeholder="Qtd."       value="${qtd}" min="0" step="0.01" inputmode="decimal">
        <input class="guia-linha-un" type="hidden" value="${escapeHtml(String(unidade))}">
        <button class="guia-linha-del" onclick="this.closest('.guia-linha').remove()" aria-label="Remover linha">✕</button>`;
    wrap.appendChild(div);
}

async function saveGuia() {
    const numero  = $id('guia-numero').value.trim();
    const data    = $id('guia-data').value;
    const tecnico = $id('guia-tecnico').value.trim();

    if (!numero)  { showToast('Indica o número da guia', 'error'); return; }
    if (!tecnico) { showToast('Indica o técnico', 'error'); return; }
    if (!data)    { showToast('Indica a data', 'error'); return; }

    const linhaEls = document.querySelectorAll('#guia-linhas-wrap .guia-linha');
    const linhas = {};
    let i = 0;
    for (const el of linhaEls) {
        const codigo = el.querySelector('.guia-linha-ref').value.trim().toUpperCase();
        const nome   = el.querySelector('.guia-linha-nome').value.trim();
        const qtd    = parseFloat(el.querySelector('.guia-linha-qtd').value) || 0;
        const unidade = el.querySelector('.guia-linha-un')?.value || 'un';
        if (!nome && !codigo) continue;
        if (qtd <= 0) continue;
        linhas[`l${i}`] = { codigo, nome: nome.toUpperCase(), quantidade: qtd, unidade, recolhido: false };
        i++;
    }
    if (i === 0) { showToast('Adiciona pelo menos um material', 'error'); return; }

    const payload = {
        numero: numero.toUpperCase(),
        tecnico: tecnico.toUpperCase(),
        data,
        status: 'pendente',
        criadoEm: Date.now(),
        linhas,
    };

    try {
        const res = await apiFetch(`${GUIAS_URL}.json`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (res) {
            const r = await res.json();
            if (r?.name) { _guiasCache.data[r.name] = payload; }
        }
        showToast('Guia criada ✓', 'success');
        closeGuiaModal();
        renderGuias();
    } catch(e) {
        showToast('Erro ao guardar: ' + (e?.message || e), 'error');
    }
}

// ─── Modal Detalhe ───────────────────────────────────────────────────────────
function openGuiaDetail(id) {
    const g = _guiasCache.data?.[id];
    if (!g) return;
    _guiasEditId = id;

    const dataFmt = g.data ? g.data.split('-').reverse().join('/') : '—';
    $id('guia-detail-title').textContent = `Guia Nº ${g.numero || '—'}`;
    $id('guia-detail-sub').textContent = `${g.tecnico || '—'} · ${dataFmt}`;

    _renderGuiaDetailLinhas(g);
    modalOpen('guia-detail-modal');
    focusModal('guia-detail-modal');
}

function _renderGuiaDetailLinhas(g) {
    const wrap = $id('guia-detail-linhas');
    if (!wrap) return; // modal não aberto — recolha veio do card inline
    wrap.innerHTML = '';
    const linhas = g.linhas || {};
    const entries = Object.entries(linhas);

    if (entries.length === 0) {
        wrap.innerHTML = '<div class="pat-empty" style="padding:20px">Sem materiais.</div>';
        return;
    }

    entries.forEach(([lid, l]) => {
        const row = $el('div', { className: 'guia-detail-linha' + (l.recolhido ? ' is-recolhido' : '') });

        const info = $el('div', { className: 'guia-detail-linha-info' });
        const top = $el('div', { className: 'guia-detail-linha-top' });
        const ref = $el('span', { className: 'guia-detail-linha-ref' });
        ref.textContent = l.codigo || '—';
        const qty = $el('span', { className: 'guia-detail-linha-qty' });
        qty.textContent = fmtQty(l.quantidade, l.unidade);
        top.appendChild(ref);
        top.appendChild(qty);
        const nome = $el('div', { className: 'guia-detail-linha-nome' });
        nome.textContent = l.nome || '';
        info.appendChild(top);
        info.appendChild(nome);

        const btn = $el('button', { className: 'guia-detail-linha-btn' });
        if (l.recolhido) {
            btn.className += ' recolhido';
            btn.innerHTML = SVG_CHECK + ' Recolhido';
            btn.title = 'Toca para desfazer';
            btn.onclick = () => toggleLinhaRecolhida(_guiasEditId, lid, false);
        } else {
            btn.textContent = 'Recolher';
            btn.onclick = () => toggleLinhaRecolhida(_guiasEditId, lid, true);
        }

        row.appendChild(info);
        row.appendChild(btn);
        wrap.appendChild(row);
    });
}

async function toggleLinhaRecolhida(gid, lid, makeRecolhido) {
    const g = _guiasCache.data?.[gid];
    if (!g) return;
    const l = g.linhas?.[lid];
    if (!l) return;

    if (makeRecolhido) {
        // Validar: há stock suficiente?
        const stockData = await fetchCollection('stock');
        // Procurar item no stock por código
        const stockEntry = Object.entries(stockData || {})
            .find(([, it]) => (it.codigo || '').toUpperCase() === (l.codigo || '').toUpperCase());

        if (!stockEntry) {
            showToast(`Produto "${l.codigo}" não existe em stock — linha marcada sem decrementar`, 'info');
        } else {
            const [stockId, stockItem] = stockEntry;
            const disponivel = stockItem.quantidade || 0;
            const necessario = l.quantidade || 0;
            if (disponivel < necessario) {
                showToast(`Stock insuficiente (${disponivel} disponíveis, ${necessario} pedidos)`, 'error');
                return;
            }
            // Decrementar stock
            const novaQtd = disponivel - necessario;
            try {
                await apiFetch(`${BASE_URL}/stock/${stockId}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify({ quantidade: novaQtd }),
                });
                if (cache.stock.data?.[stockId]) cache.stock.data[stockId].quantidade = novaQtd;
                // Registar movimento — entra no top-5 do relatório
                registarMovimento('saida_guia', stockId, stockItem.codigo, stockItem.nome, necessario);
            } catch(e) {
                showToast('Erro ao decrementar stock: ' + (e?.message || e), 'error');
                return;
            }
        }
    } else {
        // Desfazer: repôr stock se possível
        const stockData = await fetchCollection('stock');
        const stockEntry = Object.entries(stockData || {})
            .find(([, it]) => (it.codigo || '').toUpperCase() === (l.codigo || '').toUpperCase());
        if (stockEntry) {
            const [stockId, stockItem] = stockEntry;
            const novaQtd = (stockItem.quantidade || 0) + (l.quantidade || 0);
            try {
                await apiFetch(`${BASE_URL}/stock/${stockId}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify({ quantidade: novaQtd }),
                });
                if (cache.stock.data?.[stockId]) cache.stock.data[stockId].quantidade = novaQtd;
            } catch(e) {
                console.warn('[Guias] falha ao repôr stock:', e?.message);
            }
        }
    }

    // Actualizar cache local
    l.recolhido = !!makeRecolhido;
    l.recolhidoEm = makeRecolhido ? Date.now() : null;

    // Persistir linha
    try {
        await apiFetch(`${GUIAS_URL}/${gid}/linhas/${lid}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ recolhido: l.recolhido, recolhidoEm: l.recolhidoEm }),
        });
    } catch(e) {
        showToast('Erro ao guardar: ' + (e?.message || e), 'error');
    }

    // Verificar se todas as linhas estão recolhidas → marcar como separada
    const todas = Object.values(g.linhas || {});
    const todasRecolhidas = todas.length > 0 && todas.every(x => x.recolhido);
    const algumaRecolhida = todas.some(x => x.recolhido);

    if (todasRecolhidas && g.status !== 'separado') {
        g.status = 'separado';
        g.separadoEm = Date.now();
        try {
            await apiFetch(`${GUIAS_URL}/${gid}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'separado', separadoEm: g.separadoEm }),
            });
            showToast('Guia separada ✓', 'success');
        } catch(e) { console.warn('[Guias] falha status separado:', e?.message); }
    } else if (!todasRecolhidas && g.status === 'separado') {
        // Caso: utilizador desfez uma recolha numa guia já separada → volta a pendente
        g.status = 'pendente';
        g.separadoEm = null;
        try {
            await apiFetch(`${GUIAS_URL}/${gid}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'pendente', separadoEm: null }),
            });
        } catch(e) { console.warn('[Guias] revert separado:', e?.message); }
    }

    _renderGuiaDetailLinhas(g);
    renderGuias();
}

async function deleteGuia() {
    if (!_guiasEditId) return;
    const g = _guiasCache.data?.[_guiasEditId];
    if (!g) return;
    if (!confirm(`Apagar a guia "${g.numero}" do técnico "${g.tecnico}"?`)) return;

    try {
        await apiFetch(`${GUIAS_URL}/${_guiasEditId}.json`, { method: 'DELETE' });
        delete _guiasCache.data[_guiasEditId];
        modalClose('guia-detail-modal');
        renderGuias();
        showToast('Guia apagada ✓', 'success');
    } catch(e) {
        showToast('Erro ao apagar: ' + (e?.message || e), 'error');
    }
}

// ─── Importar PDF via Claude Vision ──────────────────────────────────────────
async function guiaImportPdf(inp) {
    const file = inp.files[0];
    if (!file) return;
    inp.value = '';

    const apiKey = _getAnthropicKey();
    if (!apiKey) {
        showToast('Configura o Worker em Definições → Leitura por fotografia', 'error');
        return;
    }

    const label = $id('guia-pdf-label');
    const originalHTML = label ? label.innerHTML : '';
    if (label) {
        label.innerHTML = '◷';
        label.style.pointerEvents = 'none';
        label.style.opacity = '0.6';
    }
    showToast('A analisar PDF…', 'info');

    try {
        const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result.split(',')[1]);
            r.onerror = () => rej(new Error('Erro a ler o ficheiro'));
            r.readAsDataURL(file);
        });

        const prompt = `Analisa este documento PDF de guia de separação/transporte de material para um técnico.

Extrai os seguintes campos e responde APENAS com JSON válido, sem markdown:

{
  "numero": "número da guia ou separação ou null",
  "tecnico": "nome do técnico em MAIÚSCULAS ou null",
  "data": "data no formato YYYY-MM-DD ou null",
  "linhas": [
    { "codigo": "referência do produto ou string vazia", "nome": "designação do produto em MAIÚSCULAS", "qtd": número, "unidade": "un | kg | L | m | m2" }
  ]
}

REGRAS:
- numero: procura "Nº Guia", "N.º Separação", "Guia", "Separação", "Nº"
- tecnico: nome da pessoa a quem o material é entregue — procura "Técnico", "Para", "Destinatário", "Entregue a"
- data: data da guia no formato YYYY-MM-DD (converte DD/MM/YYYY se necessário)
- linhas: extrai TODAS as linhas de material com referência, designação e quantidade
- qtd deve ser número — usa coluna "Qtd", "Quantidade", "Qty"
- unidade: usa "un" por defeito; "kg" se vires kg; "L" se vires litros; "m" metros; "m2" metros quadrados
- Se qtd não existir, usa 1
- Responde APENAS com o JSON`;

        const isProxy  = _isProxyUrl(apiKey);
        const endpoint = isProxy ? apiKey : 'https://api.anthropic.com/v1/messages';
        const headers  = { 'Content-Type': 'application/json' };
        if (!isProxy) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-allow-browser'] = 'true';
        }

        const resp = await _fetchWithTimeout(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1500,
                messages: [{ role: 'user', content: [
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                    { type: 'text', text: prompt },
                ] }],
            }),
        });

        if (!resp.ok) {
            const e = await resp.json().catch(() => ({}));
            if (resp.status === 401) throw new Error('Chave API inválida — actualiza em Definições');
            throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }

        const data   = await resp.json();
        const raw    = data.content?.map(b => b.text || '').join('') || '';
        const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());

        openNovaGuia();
        if (result.numero)  $id('guia-numero').value  = String(result.numero).toUpperCase();
        if (result.tecnico) $id('guia-tecnico').value = String(result.tecnico).toUpperCase();
        if (result.data)    $id('guia-data').value    = result.data;

        if (Array.isArray(result.linhas) && result.linhas.length > 0) {
            $id('guia-linhas-wrap').innerHTML = '';
            for (const l of result.linhas) {
                guiaAddLinha(l.codigo || '', l.nome || '', l.qtd ?? 1, l.unidade || 'un');
            }
        }

        const n = result.linhas?.length || 0;
        showToast(`PDF importado — ${n} material${n !== 1 ? 'ais' : ''} encontrado${n !== 1 ? 's' : ''}. Revê antes de guardar`, 'success');

    } catch(e) {
        showToast('Erro ao importar PDF: ' + (e?.message || e), 'error');
        console.error('[guiaImportPdf]', e);
    } finally {
        if (label) {
            label.innerHTML = originalHTML;
            label.style.pointerEvents = '';
            label.style.opacity = '';
        }
    }
}
