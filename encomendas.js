// ─────────────────────────────────────────────────────────────────────────────
// encomendas.js — Gestão Armazém v6.80
// Encomendas a fornecedor (/encomendas): listagem por estado, vista agregada
// de produtos, importação de PDF via Claude Vision e dar entrada com
// atualização atómica do stock.
//
// DEPENDÊNCIAS:
//   utils.js     — BASE_URL, $id, $el, escapeHtml, showToast, modalOpen,
//                  modalClose, focusModal, _fetchWithTimeout
//   auth.js      — authUrl
//   pats.js      — _getAnthropicKey, _isProxyUrl
//   tools.js     — openConfirmModal
//   stock.js     — findStockByCodigo, _commitStockDelta, renderList
//   dashboard.js — renderDashboard
//   app.js       — cache, fetchCollection, apiFetch
// ─────────────────────────────────────────────────────────────────────────────

// ENCOMENDAS A FORNECEDOR  (REST API — mesmo padrão do resto da app)
// Firebase: /encomendas/{id}
//   num, fornecedor, data, obs, estado, ts
//   linhas: { "0": {ref, nome, qtd, recebido}, ... }

const ENC_URL = `${BASE_URL}/encomendas`;

let _encFilter  = 'pendente';   // filtro base: encomendas pendentes
let _encNextFilter = null;      // filtro pedido por outro ecrã (ex.: Dashboard → Parciais)

// Estado de uma encomenda (as antigas, sem o campo, contam como pendentes)
function _encEstado(enc) { return (enc && enc.estado) || 'pendente'; }
let _encData    = {};
let _encDataTs  = 0;
const ENC_TTL   = 60000;
let _encEditId  = null;
let _encEntradaId   = null;
let _encEntradaLIdx = null;

// ── Carregar dados ────────────────────────────────────────────────────────
async function loadEncomendas(force = false) {
    if (!force && _encDataTs && (Date.now() - _encDataTs < ENC_TTL)) {
        renderEncList();
        return;
    }
    try {
        const res  = await apiFetch(`${ENC_URL}.json`);
        _encData   = res ? await res.json() : {};
        if (!_encData) _encData = {};
        _encDataTs = Date.now();
        renderEncList();
    } catch(e) {
        console.error('[encomendas] load error', e);
    }
}

// Carrega quando navega para a view

// ── Render lista ──────────────────────────────────────────────────────────
let _encProdutosActive = false;

function encToggleProdutosView(btn) {
    _encProdutosActive = !_encProdutosActive;
    btn.classList.toggle('active', _encProdutosActive);
    $id('enc-list').style.display          = _encProdutosActive ? 'none' : '';
    $id('enc-produtos-view').style.display = _encProdutosActive ? '' : 'none';
    // Desactivar filtros de estado quando em modo produtos
    document.querySelectorAll('.enc-filter-btn:not(.enc-filter-produtos)').forEach(b => {
        b.style.opacity        = _encProdutosActive ? '0.4' : '';
        b.style.pointerEvents  = _encProdutosActive ? 'none' : '';
    });
    if (_encProdutosActive) renderEncProdutos();
}

function renderEncProdutos() {
    const wrap = $id('enc-produtos-view');
    if (!wrap) return;

    // Recolher encomendas activas ordenadas por data
    const encs = Object.entries(_encData || {})
        .filter(([, e]) => _encEstado(e) !== 'recebida')
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

    if (encs.length === 0) {
        wrap.innerHTML = `<div class="enc-empty"><div class="enc-empty-title">Sem produtos em encomendas activas</div></div>`;
        return;
    }

    // KPIs globais
    let totalRefs = 0, totalFalta = 0, totalCompleto = 0;
    encs.forEach(([, enc]) => {
        Object.values(enc.linhas || {}).forEach(l => {
            const qtd = parseFloat(l.qtd) || 0;
            const rec = Math.min(parseFloat(l.recebido) || 0, qtd);
            totalRefs++;
            if (rec >= qtd) totalCompleto++; else totalFalta++;
        });
    });

    let html = `
        <div class="enc-prod-summary">
            <div class="enc-prod-stat">
                <span class="enc-prod-stat-val">${totalRefs}</span>
                <span class="enc-prod-stat-lbl">Referências</span>
            </div>
            <div class="enc-prod-stat enc-prod-stat-danger">
                <span class="enc-prod-stat-val">${totalFalta}</span>
                <span class="enc-prod-stat-lbl">Por receber</span>
            </div>
            <div class="enc-prod-stat enc-prod-stat-ok">
                <span class="enc-prod-stat-val">${totalCompleto}</span>
                <span class="enc-prod-stat-lbl">Completas</span>
            </div>
        </div>`;

    encs.forEach(([, enc]) => {
        const linhas   = Object.values(enc.linhas || {});
        if (linhas.length === 0) return;
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : '—';
        const estadoLabel = { pendente: 'Pendente', parcial: 'Parcial', recebida: 'Completa' }[_encEstado(enc)] || 'Pendente';
        const totalQtd = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const totalRec = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct      = totalQtd > 0 ? Math.round(totalRec / totalQtd * 100) : 0;

        html += `
        <div class="enc-prod-group">
            <div class="enc-prod-group-hdr">
                <div class="enc-prod-group-title">
                    <span class="enc-prod-group-num">Encomenda ${escapeHtml(enc.num || '—')}</span>
                    <span class="enc-prod-group-sep">·</span>
                    <span class="enc-prod-group-date">${escapeHtml(dataFmt)}</span>
                    ${enc.fornecedor ? `<span class="enc-prod-group-sep">·</span><span class="enc-prod-group-forn">${escapeHtml(enc.fornecedor)}</span>` : ''}
                </div>
                <div class="enc-prod-group-meta">
                    <span class="enc-badge enc-badge-${_encEstado(enc)}">${estadoLabel}</span>
                    <span class="enc-prod-group-pct">${totalRec}/${totalQtd} un · ${pct}%</span>
                </div>
            </div>
            <table class="enc-prod-table">
                <thead>
                    <tr>
                        <th>Referência</th>
                        <th>Designação</th>
                        <th class="enc-prod-th-num">Enc.</th>
                        <th class="enc-prod-th-num">Rec.</th>
                        <th class="enc-prod-th-num">Falta</th>
                        <th class="enc-prod-th-num">Estado</th>
                    </tr>
                </thead>
                <tbody>`;

        // Ordenar: por receber primeiro
        const sorted = [...linhas].sort((a, b) => {
            const fa = (parseFloat(a.qtd)||0) - Math.min(parseFloat(a.recebido)||0, parseFloat(a.qtd)||0);
            const fb = (parseFloat(b.qtd)||0) - Math.min(parseFloat(b.recebido)||0, parseFloat(b.qtd)||0);
            return fb - fa;
        });

        sorted.forEach(l => {
            const qtd     = parseFloat(l.qtd) || 0;
            const rec     = Math.min(parseFloat(l.recebido) || 0, qtd);
            const falta   = qtd - rec;
            const pctL    = qtd > 0 ? Math.round(rec / qtd * 100) : 0;
            const completo = falta <= 0;
            const rowClass = completo ? 'enc-prod-row-ok' : rec > 0 ? 'enc-prod-row-partial' : 'enc-prod-row-pending';
            const badge   = completo
                ? `<span class="enc-prod-badge enc-prod-badge-ok">Recebido</span>`
                : rec > 0
                    ? `<span class="enc-prod-badge enc-prod-badge-partial">${pctL}%</span>`
                    : `<span class="enc-prod-badge enc-prod-badge-pending">Pendente</span>`;
            const ref  = (l.ref  || '').trim().toUpperCase();
            const nome = (l.nome || l.desc || '').trim();

            html += `
                <tr class="enc-prod-row ${rowClass}">
                    <td class="enc-prod-ref">${escapeHtml(ref || '—')}</td>
                    <td class="enc-prod-nome">${escapeHtml(nome || '—')}</td>
                    <td class="enc-prod-td-num">${qtd}</td>
                    <td class="enc-prod-td-num">${rec}</td>
                    <td class="enc-prod-td-num ${completo ? '' : 'enc-prod-falta'}">${completo ? '—' : falta}</td>
                    <td class="enc-prod-td-num">${badge}</td>
                </tr>`;
        });

        html += `</tbody></table></div>`;
    });

    wrap.innerHTML = html;
}

function renderEncList() {
    const wrap = $id('enc-list');
    if (!wrap) return;

    const all = Object.entries(_encData || {})
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

    // Contagem em cada filtro
    const counts = { pendente: 0, parcial: 0, recebida: 0 };
    all.forEach(([, e]) => { const s = _encEstado(e); if (counts[s] !== undefined) counts[s]++; });
    Object.keys(counts).forEach(k => {
        const el = $id('enc-n-' + k);
        if (el) el.textContent = all.length ? counts[k] : '';
    });

    const entries = all.filter(([, e]) => _encEstado(e) === _encFilter);

    wrap.innerHTML = '';

    if (entries.length === 0) {
        const nomes = { pendente: 'pendente', parcial: 'parcial', recebida: 'completa' };
        const label = all.length === 0 ? 'Nenhuma encomenda registada' : 'Nenhuma encomenda ' + (nomes[_encFilter] || '');
        const sub   = all.length === 0 ? 'Cria a primeira encomenda com o bot\u00e3o acima.' : 'N\u00e3o existem encomendas com este estado.';
        wrap.innerHTML = `
            <div class="enc-empty">
                <div class="enc-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                        <line x1="12" y1="22.08" x2="12" y2="12"/>
                    </svg>
                </div>
                <div class="enc-empty-title">${escapeHtml(label)}</div>
                <div class="enc-empty-text">${escapeHtml(sub)}</div>
            </div>`;
        return;
    }

    entries.forEach(([id, enc]) => {
        const linhas   = Object.values(enc.linhas || {});
        const total    = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const recebido = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct      = total > 0 ? Math.round(recebido / total * 100) : 0;
        const estadoLabel = { pendente: 'Pendente', parcial: 'Parcial', recebida: 'Completa' }[_encEstado(enc)] || 'Pendente';
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : '—';

        // Card
        const card = $el('div', { className: 'enc-card' });
        card.onclick   = () => openEncDetail(id);

        // Top row
        const top = $el('div', { className: 'enc-card-top' });

        const left = $el('div');
        const num = $el('div', { className: 'enc-card-num' });
        num.textContent = 'Encomenda Nº ' + (enc.num || '—');
        const forn = $el('div', { className: 'enc-card-forn' });
        forn.textContent = enc.fornecedor || '—';
        left.appendChild(num);
        left.appendChild(forn);

        const right = $el('div');
        right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px';
        const badge = $el('span');
        badge.className   = 'enc-badge enc-badge-' + _encEstado(enc);
        badge.textContent = estadoLabel;
        const date = $el('span', { className: 'enc-card-date' });
        date.textContent = dataFmt;
        right.appendChild(badge);
        right.appendChild(date);

        top.appendChild(left);
        top.appendChild(right);

        // Progress
        const progWrap = $el('div', { className: 'enc-progress-wrap' });
        const bar = $el('div', { className: 'enc-progress-bar' });
        const fill = $el('div', { className: 'enc-progress-fill' });
        fill.style.width  = pct + '%';
        bar.appendChild(fill);
        const lbl = $el('div', { className: 'enc-progress-label' });
        lbl.textContent = `${recebido} / ${total} unidades recebidas (${pct}%)`;
        progWrap.appendChild(bar);
        progWrap.appendChild(lbl);

        card.appendChild(top);
        card.appendChild(progWrap);
        wrap.appendChild(card);
    });
}

function _encSetFilter(filter) {
    _encFilter = filter;
    document.querySelectorAll('.enc-filter-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
}

function encFilterSet(btn, filter) {
    _encSetFilter(filter);
    renderEncList();
}


// ── Importar PDF de encomenda via Claude ───────────────────────────────────

async function encImportPdf(inp) {
    const file = inp.files[0];
    if (!file) return;
    inp.value = '';

    const apiKey = _getAnthropicKey();
    if (!apiKey) {
        showToast('Configura o Worker em Definições → Leitura por fotografia', 'error');
        return;
    }

    const label = $id('enc-pdf-label');
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

        const prompt = `Analisa este documento PDF de encomenda a fornecedor.

Extrai os seguintes campos e responde APENAS com JSON válido, sem markdown:

{
  "numero": "número da encomenda (alfanumérico) ou null",
  "fornecedor": "nome do fornecedor em MAIÚSCULAS ou null",
  "linhas": [
    { "ref": "referência do produto ou string vazia", "nome": "designação do produto em MAIÚSCULAS", "qtd": número }
  ]
}

REGRAS:
- numero: procura campos "N.º Encomenda", "Ordem de Compra", "OC", "PO", "Ref."
- fornecedor: quem fornece os produtos — procura "Fornecedor", "Supplier", "Para", "A/C"
- linhas: extrai TODAS as linhas de produtos com referência, designação e quantidade encomendada
- qtd deve ser número inteiro — usa coluna "Qtd", "Quantidade", "Qty" ou similar
- Se qtd não existir num produto, usa 1
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
                    { type: 'text', text: prompt }
                ]}]
            })
        });

        if (!resp.ok) {
            const e = await resp.json().catch(() => ({}));
            if (resp.status === 401) throw new Error('Chave API inválida — actualiza em Definições');
            throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }

        const data   = await resp.json();
        const raw    = data.content?.map(b => b.text || '').join('') || '';
        const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());

        openNovaEncomenda();
        if (result.numero)     $id('enc-num').value        = result.numero;
        if (result.fornecedor) $id('enc-fornecedor').value = result.fornecedor;

        if (Array.isArray(result.linhas) && result.linhas.length > 0) {
            $id('enc-linhas-wrap').innerHTML = '';
            for (const l of result.linhas) {
                encAddLinha(l.ref || '', l.nome || '', l.qtd ?? 1);
            }
        }

        const n = result.linhas?.length || 0;
        showToast(`PDF importado — ${n} produto${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}. Revê antes de guardar`, 'ok');

    } catch(e) {
        showToast('Erro ao importar PDF: ' + (e?.message || e), 'error');
        console.error('[encImportPdf]', e);
    } finally {
        if (label) {
            label.innerHTML = originalHTML;
            label.style.pointerEvents = '';
            label.style.opacity = '';
        }
    }
}


// ── Modal criar ───────────────────────────────────────────────────────────
function openNovaEncomenda() {
    _encEditId = null;
    $id('enc-modal-title').textContent = 'Nova Encomenda';
    $id('enc-num').value        = '';
    $id('enc-data').value       = new Date().toISOString().split('T')[0];
    $id('enc-fornecedor').value = '';
    $id('enc-obs').value        = '';
    $id('enc-linhas-wrap').innerHTML = '';
    encAddLinha();
    modalOpen('enc-modal');
    focusModal('enc-modal');
}

function closeEncModal() {
    modalClose('enc-modal');
}

function encAddLinha(ref = '', nome = '', qtd = '') {
    const wrap = $id('enc-linhas-wrap');
    const div = $el('div', { className: 'enc-linha' });
    div.innerHTML = `
        <input class="blue-input enc-linha-ref"  type="text"   placeholder="Ref."       value="${escapeHtml(String(ref))}"  autocomplete="off" spellcheck="false">
        <input class="blue-input enc-linha-nome" type="text"   placeholder="Designação" value="${escapeHtml(String(nome))}" autocomplete="off" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input enc-linha-qtd"  type="number" placeholder="Qtd."       value="${qtd}" min="0" step="0.01">
        <button class="enc-linha-del" onclick="this.closest('.enc-linha').remove()">✕</button>`;
    wrap.appendChild(div);
}

async function saveEncomenda() {
    const num  = $id('enc-num').value.trim();
    const data = $id('enc-data').value;
    const forn = $id('enc-fornecedor').value.trim();
    const obs  = $id('enc-obs').value.trim();

    if (!num)  { showToast('Indica o número da encomenda', 'error'); return; }
    if (!forn) { showToast('Indica o fornecedor', 'error'); return; }

    const linhasEls = document.querySelectorAll('#enc-linhas-wrap .enc-linha');
    const linhas = {};
    let i = 0;
    for (const el of linhasEls) {
        const ref  = el.querySelector('.enc-linha-ref').value.trim().toUpperCase();
        const nome = el.querySelector('.enc-linha-nome').value.trim();
        const qtd  = parseFloat(el.querySelector('.enc-linha-qtd').value) || 0;
        if (!nome && !ref) continue;
        linhas[i] = { ref, nome, qtd, recebido: 0 };
        i++;
    }
    if (i === 0) { showToast('Adiciona pelo menos um produto', 'error'); return; }

    const payload = { num, fornecedor: forn, data, obs, estado: 'pendente', ts: Date.now(), linhas };

    try {
        const res = await apiFetch(`${ENC_URL}.json`, { method: 'POST', body: JSON.stringify(payload) });
        if (res) { const r = await res.json(); if (r?.name) _encData[r.name] = payload; }
        showToast('Encomenda criada ✓', 'ok');
        closeEncModal();
        renderEncList();
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro ao guardar: ' + e.message, 'error');
    }
}

// ── Detalhe ───────────────────────────────────────────────────────────────
function openEncDetail(id) {
    const enc = _encData[id];
    if (!enc) return;
    _encEditId = id;

    const dataFmt = enc.data ? enc.data.split('-').reverse().join('/') : '—';
    $id('enc-detail-title').textContent = `Encomenda Nº ${enc.num || '—'}`;
    $id('enc-detail-sub').textContent   =
        `${enc.fornecedor || '—'} · ${dataFmt}${enc.obs ? ' · ' + enc.obs : ''}`;

    const linhas = enc.linhas || {};
    $id('enc-detail-linhas').innerHTML = Object.entries(linhas).map(([idx, l]) => {
        const qtd      = parseFloat(l.qtd) || 0;
        const recebido = Math.min(parseFloat(l.recebido) || 0, qtd);
        const pct      = qtd > 0 ? Math.round(recebido / qtd * 100) : 0;
        const cor      = pct >= 100 ? '#16a34a' : pct > 0 ? '#f59e0b' : 'var(--primary)';
        const done     = recebido >= qtd && qtd > 0;
        return `<div class="enc-detail-linha">
            <div class="enc-detail-linha-top">
                <div style="flex:1;min-width:0">
                    ${l.ref ? `<span class="enc-detail-ref">${escapeHtml(l.ref)}</span> ` : ''}
                    <span class="enc-detail-nome">${escapeHtml(l.nome || '—')}</span>
                </div>
                <div class="enc-detail-qty">${recebido}/${qtd}</div>
            </div>
            <div class="enc-detail-prog-wrap">
                <div class="enc-detail-prog-bar">
                    <div class="enc-detail-prog-fill" style="width:${pct}%;background:${cor}"></div>
                </div>
                <div class="enc-detail-prog-label">${pct}% recebido</div>
            </div>
            <button class="enc-entrada-btn ${done ? 'enc-entrada-btn-done' : ''}"
                ${done ? 'disabled' : `onclick="openEntradaModal('${id}',${idx})"`}>
                ${done ? '✓ Totalmente recebido' : '↓ Dar entrada'}
            </button>
        </div>`;
    }).join('');

    modalOpen('enc-detail-modal');
    focusModal('enc-detail-modal');
}

async function deleteEncomenda() {
    if (!_encEditId) return;
    const enc = _encData[_encEditId];
    openConfirmModal({
        title: 'Apagar encomenda?',
        desc: `Encomenda Nº ${enc?.num} será apagada permanentemente.`,
        type: 'danger',
        onConfirm: async () => {
            try {
                await apiFetch(`${ENC_URL}/${_encEditId}.json`, { method: 'DELETE' });
                // Remover do cache local imediatamente
                delete _encData[_encEditId];
                showToast('Encomenda apagada', 'ok');
                modalClose('enc-detail-modal');
                renderEncList();
                loadEncomendas(true);
            } catch(e) {
                showToast('Erro: ' + e.message, 'error');
            }
        }
    });
}

// ── Dar entrada ───────────────────────────────────────────────────────────
function openEntradaModal(encId, lIdx) {
    _encEntradaId   = encId;
    _encEntradaLIdx = lIdx;
    const l = _encData[encId]?.linhas?.[lIdx];
    if (!l) return;
    const falta = (parseFloat(l.qtd) || 0) - (parseFloat(l.recebido) || 0);
    $id('enc-entrada-desc').textContent =
        `${l.ref ? '[' + l.ref + '] ' : ''}${l.nome} — faltam ${falta} unidades`;
    const inp = $id('enc-entrada-qty');
    inp.value = falta;
    inp.max   = falta;
    $id('enc-entrada-info').textContent =
        `Já recebido: ${parseFloat(l.recebido) || 0} · Encomendado: ${parseFloat(l.qtd) || 0}`;
    const chk = $id('enc-entrada-stock');
    if (chk) { chk.checked = true; chk.disabled = false; }
    $id('enc-entrada-stock-info').textContent = '';
    modalOpen('enc-entrada-modal');
    focusModal('enc-entrada-modal');
    setTimeout(() => inp.focus(), 100);
    _encUpdateEntradaStockInfo();
}

// ── Entrada → stock ───────────────────────────────────────────────────────
// Procura no stock o artigo com esta referência (sem espaços, sem maiúsculas).
function _encFindStock(ref) {
    const r = findStockByCodigo(ref);          // implementação única, em stock.js
    return r.status === 'empty' ? { status: 'noref' } : r;
}

// Mostra o efeito no stock antes de confirmar (e desactiva a opção se não aplicável).
async function _encUpdateEntradaStockInfo() {
    const infoEl = $id('enc-entrada-stock-info');
    const chk    = $id('enc-entrada-stock');
    const l      = _encData[_encEntradaId]?.linhas?.[_encEntradaLIdx];
    if (!infoEl || !chk || !l) return;
    try { await fetchCollection('stock'); } catch (_) {}
    const qty = parseFloat($id('enc-entrada-qty')?.value) || 0;
    const f = _encFindStock(l.ref);
    chk.disabled = (f.status === 'noref' || f.status === 'multi');
    if (chk.disabled) chk.checked = false;
    if (f.status === 'noref') infoEl.textContent = 'Linha sem referência — o stock não será atualizado.';
    else if (f.status === 'multi') infoEl.textContent = `Referência repetida no stock (${f.count} artigos) — o stock não será atualizado.`;
    else if (f.status === 'none') infoEl.textContent = `A referência não existe no stock — será criado um artigo novo com ${qty} un (sem localização).`;
    else {
        const base = Number(f.item.quantidade) || 0;
        infoEl.textContent = `Stock de ${f.item.codigo}: ${base} → ${Math.round((base + qty) * 1000) / 1000}`;
    }
}

// Soma a entrada ao stock (delta seguro em multi-utilizador). NÃO regista
// movimento: as entradas não entram nos relatórios.
async function _encAdicionarAoStock(l, qty, enc) {
    try {
        if (navigator.onLine) await fetchCollection('stock', true);
        const f = _encFindStock(l.ref);
        if (f.status === 'one') {
            const base  = Number(f.item.quantidade) || 0;
            const { saved } = await _commitStockDelta(f.id, base, base + qty);
            f.item.quantidade = saved;
            return { ok: true, txt: `stock ${f.item.codigo}: ${base} → ${saved}` };
        }
        if (f.status === 'none') {
            const codigo  = String(l.ref).trim().toUpperCase();
            const payload = {
                nome:        String(l.nome || l.ref).trim().toUpperCase(),
                localizacao: '',
                quantidade:  qty,
                unidade:     'un',
                notas:       `Criado por entrada da encomenda ${enc?.num || ''}`.trim(),
                codigo,
            };
            const res = await apiFetch(`${BASE_URL}/stock.json`, { method: 'POST', body: JSON.stringify(payload) });
            if (!cache.stock.data) cache.stock.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
            else cache.stock.data[`_tmp_${Date.now()}`] = payload;
            return { ok: true, txt: `artigo ${codigo} criado no stock` };
        }
        return { ok: false, txt: f.status === 'multi' ? 'referência repetida no stock' : 'linha sem referência' };
    } catch (e) {
        console.warn('[encomenda→stock] falhou:', e?.message);
        return { ok: false, txt: 'erro de ligação' };
    }
}

let _encEntradaBusy = false;

async function confirmarEntrada() {
    if (_encEntradaBusy) return;                       // protege contra duplo toque (somaria 2x ao stock)
    const qty = parseFloat($id('enc-entrada-qty').value);
    if (isNaN(qty) || qty <= 0) { showToast('Quantidade inválida', 'error'); return; }

    const enc = _encData[_encEntradaId];
    const l   = enc?.linhas?.[_encEntradaLIdx];
    if (!l) return;
    const chk      = $id('enc-entrada-stock');
    const addStock = !!(chk && chk.checked && !chk.disabled);
    _encEntradaBusy = true;
    try {

    // Lê o valor ACTUAL do servidor antes de somar — protege contra dois utilizadores
    // a dar entrada na mesma linha ao mesmo tempo (o segundo sobrescreveria o primeiro).
    let recebidoActual = parseFloat(l.recebido) || 0;
    if (navigator.onLine) {
        try {
            const remoteUrl = await authUrl(`${ENC_URL}/${_encEntradaId}/linhas/${_encEntradaLIdx}/recebido.json`);
            const remoteRes = await fetch(remoteUrl);
            if (remoteRes.ok) {
                const remoteVal = await remoteRes.json();
                if (typeof remoteVal === 'number' && !isNaN(remoteVal)) {
                    recebidoActual = remoteVal;
                    // Actualiza cache local com valor real
                    if (_encData[_encEntradaId]?.linhas?.[_encEntradaLIdx]) {
                        _encData[_encEntradaId].linhas[_encEntradaLIdx].recebido = recebidoActual;
                    }
                }
            }
        } catch(e) {
            console.warn('[confirmarEntrada] falha ao ler valor actual:', e?.message);
        }
    }

    const novoRecebido = Math.min(recebidoActual + qty, parseFloat(l.qtd) || 0);
    const novasLinhas  = { ...(enc.linhas || {}) };
    novasLinhas[_encEntradaLIdx] = { ...l, recebido: novoRecebido };
    const novoEstado   = _calcEstado(novasLinhas);

    try {
        await apiFetch(`${ENC_URL}/${_encEntradaId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({
                [`linhas/${_encEntradaLIdx}/recebido`]: novoRecebido,
                estado: novoEstado
            })
        });
        // Actualizar cache local imediatamente
        if (_encData[_encEntradaId]?.linhas?.[_encEntradaLIdx]) {
            _encData[_encEntradaId].linhas[_encEntradaLIdx].recebido = novoRecebido;
            _encData[_encEntradaId].estado = novoEstado;
        }

        // Entrada na encomenda gravada → agora o stock (se pedido)
        const st = addStock ? await _encAdicionarAoStock(l, qty, enc) : null;
        if (st?.ok) { try { renderList(window._searchInputEl?.value || '', true); renderDashboard(); } catch (_) {} }

        const idEnc = _encEntradaId;
        showToast(`Entrada de ${qty} confirmada ✓` + (st?.ok ? ` · ${st.txt}` : ''), 'ok');
        if (st && !st.ok) showToast(`Entrada registada, mas o stock NÃO foi atualizado (${st.txt})`, 'error');
        modalClose('enc-entrada-modal');
        renderEncList();
        openEncDetail(idEnc);
        // Sincroniza com Firebase em background
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro: ' + e.message, 'error');
    }
    } finally { _encEntradaBusy = false; }
}

function _calcEstado(linhas) {
    const arr = Object.values(linhas);
    if (arr.every(l => (parseFloat(l.recebido) || 0) >= (parseFloat(l.qtd) || 0))) return 'recebida';
    if (arr.some(l => (parseFloat(l.recebido) || 0) > 0)) return 'parcial';
    return 'pendente';
}
