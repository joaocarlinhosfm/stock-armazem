// ───────────────────────────────────────
// stockimport.js — Hiperfrio v6.64
// Importação de inventário a partir de Excel (Administração → Importar Stock).
// Carrega DEPOIS de stock.js e ANTES de tools.js.
//
// Regras:
//   • Compara a coluna "Ref" do Excel com o campo `codigo` do stock.
//   • Referência existe        → substitui APENAS a quantidade.
//   • Referência não existe    → cria artigo novo (só se a Ref tiver conteúdo).
//   • Linhas sem Ref e a linha "TOTAL" são ignoradas.
//   • Casos ambíguos ficam em "A rever" e NÃO são tocados até o utilizador decidir:
//       – quantidade vazia/inválida  → escrever a quantidade, ou ignorar
//       – Ref repetida no Excel      → escolher uma linha, somar, ou ignorar
//       – Ref repetida no stock      → escolher que artigo atualizar, ou ignorar
//   • Diferenças para baixo contam como saída nos relatórios (tipo
//     'saida_inventario'); aumentos não contam (não existe tipo de entrada).
//   • Pré-visualização obrigatória antes de gravar. Só gestores, só online.
//
// Dependências:
//   utils.js   → $id, $el, escapeHtml, showToast, fmtQty, loadXlsx, BASE_URL
//   auth.js    → requireManagerAccess, authUrl
//   reports.js → MOV_URL, _mesKey
//   app.js     → fetchCollection, cache, renderDashboard
//   stock.js   → renderList
// ───────────────────────────────────────

const _SI = { entries: null, plan: null, stock: null, decisions: {}, fileName: '', sig: '', busy: false };

// Nomes de cabeçalho aceites (normalizados: sem acentos, minúsculas, só a-z0-9)
const _SI_HDR = {
    ref: ['ref', 'referencia', 'codigo', 'cod'],
    qtd: ['quantidade', 'qtd', 'qtde', 'qty', 'quant'],
    des: ['designacao', 'descricao', 'nome', 'descritivo'],
    uni: ['unidade', 'un', 'uni', 'unid'],
};

const _SI_UNITS = {
    un: 'un', und: 'un', unid: 'un', unidade: 'un', unidades: 'un', pc: 'un', pcs: 'un',
    kg: 'kg', kgs: 'kg', quilo: 'kg', quilos: 'kg',
    l: 'L', lt: 'L', lts: 'L', litro: 'L', litros: 'L',
    m: 'm', mt: 'm', mts: 'm', metro: 'm', metros: 'm',
    m2: 'm2',
};

function _siNorm(s) {
    return String(s ?? '').replace(/²/g, '2').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _siKey(ref) {
    return String(ref ?? '').replace(/\s+/g, '').toUpperCase();
}

// Procura a linha de cabeçalho nas primeiras 40 linhas.
function _siFindHeader(rows) {
    const lim = Math.min(rows.length, 40);
    for (let r = 0; r < lim; r++) {
        const cols = {};
        (rows[r] || []).forEach((cell, i) => {
            const n = _siNorm(cell);
            if (!n) return;
            for (const k of Object.keys(_SI_HDR)) {
                if (cols[k] === undefined && _SI_HDR[k].includes(n)) cols[k] = i;
            }
        });
        if (cols.ref !== undefined && cols.qtd !== undefined) return { row: r, cols };
    }
    return null;
}

function _siParseQty(raw) {
    let n = NaN;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string') {
        const s = raw.trim().replace(/\s/g, '');
        if (/^-?\d+([.,]\d+)?$/.test(s)) n = parseFloat(s.replace(',', '.'));
    }
    if (!Number.isFinite(n)) return NaN;
    return Math.round(n * 1000) / 1000;
}

function _siParseUnit(raw) {
    const txt = String(raw ?? '').trim();
    if (!txt) return { unit: 'un', known: false, warn: '' };
    const u = _SI_UNITS[_siNorm(txt)];
    if (u) return { unit: u, known: true, warn: '' };
    return { unit: 'un', known: false, warn: `unidade "${txt}" desconhecida → un` };
}

// Linhas do Excel → entradas válidas + linhas inválidas (com dados para poderem ser corrigidas).
function _siParseRows(rows, hdr, startRow) {
    const { cols } = hdr;
    const entries = [], invalid = [];
    for (let i = hdr.row + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const refRaw = String(row[cols.ref] ?? '').trim();
        if (!refRaw) continue;                                   // sem Ref → ignora
        const key = _siKey(refRaw);
        if (/^TOTAL(IS|GERAL)?$/.test(key)) continue;             // linha de totais
        const linha = startRow + i + 1;
        const nome = cols.des !== undefined ? String(row[cols.des] ?? '').trim().toUpperCase() : '';
        const u = cols.uni !== undefined ? _siParseUnit(row[cols.uni]) : { unit: 'un', known: false, warn: '' };
        const qtdRaw = row[cols.qtd];
        const qtd = _siParseQty(qtdRaw);
        if (!Number.isFinite(qtd) || qtd < 0) {
            const vazio = qtdRaw === '' || qtdRaw == null;
            invalid.push({ id: `iv:${linha}`, linha, ref: refRaw.toUpperCase(), key, nome, unidade: u.unit, unitKnown: u.known, warn: u.warn,
                           motivo: vazio ? 'quantidade vazia' : `quantidade inválida (${qtdRaw})` });
            continue;
        }
        entries.push({ linha, ref: refRaw.toUpperCase(), key, nome, qtd, unidade: u.unit, unitKnown: u.known, warn: u.warn });
    }
    return { entries, invalid };
}

// Compara com o stock e classifica cada linha. `decisions` = o que o utilizador
// já resolveu nas linhas "A rever" (chaves: iv:<linha> | dx:<ref> | ds:<ref>).
function _siBuildPlan(parsed, stockData, decisions = {}) {
    const stockByKey = {};
    Object.entries(stockData || {}).forEach(([id, item]) => {
        if (!item || id.startsWith('_tmp_')) return;
        const k = _siKey(item.codigo);
        if (!k) return;
        (stockByKey[k] = stockByKey[k] || []).push(id);
    });

    const plan = { updates: [], creates: [], same: 0, review: [], saidaTotal: 0, saidaItens: 0, subidaTotal: 0 };
    const dec = id => decisions[id];
    const isNum = v => Number.isFinite(v) && v >= 0;

    // 1) linhas válidas + linhas inválidas a que o utilizador deu uma quantidade
    const list = parsed.entries.map(e => ({ ...e }));
    parsed.invalid.forEach(iv => {
        const d = dec(iv.id);
        if (d && isNum(d.qtd)) {
            list.push({ linha: iv.linha, ref: iv.ref, key: iv.key, nome: iv.nome, qtd: d.qtd, unidade: iv.unidade, unitKnown: iv.unitKnown, warn: iv.warn });
        } else {
            plan.review.push({ id: iv.id, tipo: 'qtd', ref: iv.ref, nome: iv.nome, linha: iv.linha, unidade: iv.unidade, motivo: iv.motivo, ignorado: !!(d && d.ignore) });
        }
    });

    // 2) referências repetidas no Excel
    const groups = {};
    list.forEach(e => (groups[e.key] = groups[e.key] || []).push(e));
    const finals = [];
    Object.values(groups).forEach(g => {
        if (g.length === 1) { finals.push(g[0]); return; }
        const id = `dx:${g[0].key}`, d = dec(id);
        if (d && isNum(d.qtd)) { finals.push({ ...g[0], qtd: d.qtd }); return; }
        plan.review.push({
            id, tipo: 'dupExcel', ref: g[0].ref, nome: (g.find(x => x.nome) || {}).nome || '', unidade: g[0].unidade,
            linha: Math.min(...g.map(x => x.linha)),
            linhas: g.map(x => ({ linha: x.linha, qtd: x.qtd })).sort((a, b) => a.linha - b.linha),
            soma: Math.round(g.reduce((t, x) => t + x.qtd, 0) * 1000) / 1000,
            motivo: 'referência repetida no Excel', ignorado: !!(d && d.ignore),
        });
    });
    finals.sort((a, b) => a.linha - b.linha);

    // 3) comparar com o stock
    finals.forEach(e => {
        const ids = stockByKey[e.key];
        if (!ids) {
            plan.creates.push({ key: e.key, linha: e.linha, codigo: e.ref, nome: e.nome || e.ref, quantidade: e.qtd, unidade: e.unidade, warn: e.warn });
            return;
        }
        let id;
        if (ids.length === 1) {
            id = ids[0];
        } else {
            const rid = `ds:${e.key}`, d = dec(rid);
            if (d && d.stockId && ids.includes(d.stockId)) {
                id = d.stockId;
            } else {
                plan.review.push({
                    id: rid, tipo: 'dupStock', ref: e.ref, nome: e.nome, linha: e.linha, qtd: e.qtd, unidade: e.unidade,
                    motivo: `referência repetida no stock (${ids.length} artigos)`, ignorado: !!(d && d.ignore),
                    candidatos: ids.map(i => ({ id: i, nome: stockData[i].nome || '', local: stockData[i].localizacao || '',
                                                qtd: Number(stockData[i].quantidade) || 0, unidade: stockData[i].unidade || 'un' })),
                });
                return;
            }
        }
        const item = stockData[id];
        const old = Math.round((Number(item.quantidade) || 0) * 1000) / 1000;
        if (Math.abs(old - e.qtd) < 1e-9) { plan.same++; return; }
        const unidade = item.unidade || 'un';
        const warn = (e.unitKnown && e.unidade !== unidade) ? `Excel: ${e.unidade} ≠ stock: ${unidade}` : '';
        const diff = Math.round((e.qtd - old) * 1000) / 1000;
        plan.updates.push({ id, codigo: item.codigo || e.ref, nome: item.nome || '', unidade, old, new: e.qtd, diff, warn });
        if (diff < 0) { plan.saidaTotal += -diff; plan.saidaItens++; } else { plan.subidaTotal += diff; }
    });

    plan.updates.sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'pt'));
    plan.creates.sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'pt'));
    plan.review.sort((a, b) => a.linha - b.linha);
    plan.saidaTotal  = Math.round(plan.saidaTotal  * 1000) / 1000;
    plan.subidaTotal = Math.round(plan.subidaTotal * 1000) / 1000;
    return plan;
}

// Assinatura do plano — detecta se o stock mudou entre pré-visualização e aplicação.
function _siSignature(plan) {
    return plan.updates.map(u => `${u.id}:${u.old}>${u.new}`).join('|') + '#' + plan.creates.map(c => c.key).join('|');
}

// ── UI ──────────────────────────────────────────────────────────────────────

function renderStockImport() {
    _SI.entries = null; _SI.plan = null; _SI.stock = null; _SI.decisions = {}; _SI.fileName = ''; _SI.sig = ''; _SI.busy = false;
    const input = $id('si-file-input');
    if (input) input.value = '';
    const prev = $id('si-preview');
    if (prev) prev.innerHTML = '';
}

function _siFmt(q, unidade) { return fmtQty(q, unidade); }

function _siRowUpd(u) {
    const cls = u.diff < 0 ? 'si-down' : 'si-up';
    const sign = u.diff > 0 ? '+' : '';
    return `<div class="si-row">
        <div class="si-row-main"><b>${escapeHtml(u.codigo)}</b><span>${escapeHtml(u.nome)}</span>${u.warn ? `<em class="si-tag">${escapeHtml(u.warn)}</em>` : ''}</div>
        <div class="si-row-val">${escapeHtml(_siFmt(u.old, u.unidade))} → <strong>${escapeHtml(_siFmt(u.new, u.unidade))}</strong> <i class="${cls}">${sign}${u.diff}</i></div>
    </div>`;
}

function _siRowNew(c) {
    return `<div class="si-row">
        <div class="si-row-main"><b>${escapeHtml(c.codigo)}</b><span>${escapeHtml(c.nome)}</span>${c.warn ? `<em class="si-tag">${escapeHtml(c.warn)}</em>` : ''}</div>
        <div class="si-row-val"><strong>${escapeHtml(_siFmt(c.quantidade, c.unidade))}</strong></div>
    </div>`;
}

// Cartão de uma linha "A rever" com as acções possíveis (i = índice em plan.review).
function _siReviewCard(r, i) {
    const head = `<div class="si-rv-head"><b>${escapeHtml(r.ref)}</b>${r.nome ? `<span>${escapeHtml(r.nome)}</span>` : ''}
        <em class="si-rv-why">${escapeHtml(r.motivo)} · linha ${r.linha}</em></div>`;
    if (r.ignorado) {
        return `<div class="si-rv si-rv-ign">${head}<div class="si-rv-actions">
            <span class="si-rv-hint">Ignorado — não será alterado</span>
            <button type="button" class="si-mini" onclick="siRvRevert(${i})">Reverter</button></div></div>`;
    }
    const ign = `<button type="button" class="si-mini" onclick="siRvIgnore(${i})">Ignorar</button>`;
    let body = '';
    if (r.tipo === 'qtd') {
        body = `<div class="si-rv-actions">
            <input id="si-rv-qty-${i}" class="si-rv-input" type="text" inputmode="decimal" placeholder="Quantidade (${escapeHtml(r.unidade)})" onkeydown="if(event.key==='Enter'){event.preventDefault();siRvQty(${i});}">
            <button type="button" class="si-mini si-mini-ok" onclick="siRvQty(${i})">Usar</button>${ign}</div>`;
    } else if (r.tipo === 'dupExcel') {
        body = `<div class="si-rv-opts">`
            + r.linhas.map((l, j) => `<button type="button" class="si-opt" onclick="siRvLine(${i},${j})"><span>Linha ${l.linha}</span><strong>${escapeHtml(fmtQty(l.qtd, r.unidade))}</strong></button>`).join('')
            + `<button type="button" class="si-opt" onclick="siRvSum(${i})"><span>Somar</span><strong>${escapeHtml(fmtQty(r.soma, r.unidade))}</strong></button></div>
            <div class="si-rv-actions"><span class="si-rv-hint">Toca no valor a usar</span>${ign}</div>`;
    } else if (r.tipo === 'dupStock') {
        body = `<div class="si-rv-opts si-rv-col">`
            + r.candidatos.map((c, j) => `<button type="button" class="si-opt si-opt-wide" onclick="siRvStock(${i},${j})">
                <span>${escapeHtml(c.nome || r.ref)} · ${c.local ? escapeHtml(c.local) : 'sem local'}</span>
                <strong>${escapeHtml(fmtQty(c.qtd, c.unidade))} → ${escapeHtml(fmtQty(r.qtd, c.unidade))}</strong></button>`).join('')
            + `</div><div class="si-rv-actions"><span class="si-rv-hint">Que artigo atualizar? (Excel: ${escapeHtml(fmtQty(r.qtd, r.unidade))})</span>${ign}</div>`;
    }
    return `<div class="si-rv">${head}${body}</div>`;
}

function _siSection(title, count, rowsHtml, openByDefault = false, extraCls = '') {
    if (!count) return '';
    return `<details class="si-sec"${openByDefault ? ' open' : ''}>
        <summary>${escapeHtml(title)} <span class="si-count">${count}</span></summary>
        <div class="si-list ${extraCls}">${rowsHtml}</div>
    </details>`;
}

function _siRenderPreview() {
    const prev = $id('si-preview');
    const p = _SI.plan;
    if (!prev || !p) return;
    const nothing = p.updates.length === 0 && p.creates.length === 0;

    let html = `<div class="si-file">📄 ${escapeHtml(_SI.fileName)}</div>
    <div class="si-summary">
        <div class="si-chip si-chip-upd"><b>${p.updates.length}</b><span>A atualizar</span></div>
        <div class="si-chip si-chip-new"><b>${p.creates.length}</b><span>Novos</span></div>
        <div class="si-chip"><b>${p.same}</b><span>Sem alteração</span></div>
        <div class="si-chip si-chip-warn"><b>${p.review.filter(r => !r.ignorado).length}</b><span>A rever</span></div>
    </div>`;

    if (p.updates.length) {
        html += `<p class="si-note">Saídas a registar nos relatórios: <strong>${p.saidaTotal}</strong> (${p.saidaItens} artigo${p.saidaItens === 1 ? '' : 's'}).
        Aumentos de stock: <strong>${p.subidaTotal}</strong> (não contam como saída).</p>`;
    }
    if (p.review.some(r => !r.ignorado)) {
        html += `<p class="si-note si-note-warn">As linhas em «A rever» <strong>não serão alteradas</strong> até decidires o que fazer com cada uma.</p>`;
    }

    html += _siSection('Quantidades a atualizar', p.updates.length, p.updates.map(_siRowUpd).join(''));
    html += _siSection('Artigos novos a criar (sem localização)', p.creates.length, p.creates.map(_siRowNew).join(''));
    html += _siSection('A rever', p.review.length, p.review.map(_siReviewCard).join(''), true, 'si-list-rv');

    if (nothing) {
        html += `<div class="si-empty">Nada para atualizar — o stock já coincide com o Excel${p.review.some(r => !r.ignorado) ? ', exceto as linhas a rever' : ''}.</div>
        <div class="si-actions"><button type="button" class="si-btn-ghost" onclick="siCancel()">Fechar</button></div>`;
    } else {
        html += `<label class="si-check"><input type="checkbox" id="si-backup" checked> Descarregar cópia dos valores atuais (CSV) antes de aplicar</label>
        <div class="si-actions">
            <button type="button" class="btn-primary" id="si-apply" onclick="siApply()">Aplicar importação</button>
            <button type="button" class="si-btn-ghost" onclick="siCancel()">Cancelar</button>
        </div>`;
    }
    prev.innerHTML = html;
}

// ── Decisões nas linhas "A rever" ───────────────────────────────────────────
// Guarda a decisão e volta a calcular o plano (a linha passa a atualizar/criar,
// ou fica marcada como ignorada). Mantém secções abertas, scroll e a caixa da cópia.
function _siReplan() {
    const prev = $id('si-preview');
    const opens  = prev ? [...prev.querySelectorAll('details.si-sec')].map(d => d.open) : [];
    const backup = $id('si-backup')?.checked;
    const scrolls = [];
    for (let e = prev; e; e = e.parentElement) { if (e.scrollTop > 0) scrolls.push([e, e.scrollTop]); }
    const winY = window.scrollY;

    _SI.plan = _siBuildPlan(_SI.entries, _SI.stock, _SI.decisions);
    _SI.sig  = _siSignature(_SI.plan);
    _siRenderPreview();

    if (prev) {
        prev.querySelectorAll('details.si-sec').forEach((d, i) => { if (opens[i] !== undefined) d.open = opens[i]; });
        const b = $id('si-backup'); if (b && backup !== undefined) b.checked = backup;
    }
    scrolls.forEach(([e, t]) => { e.scrollTop = t; });
    window.scrollTo(0, winY);
}

function _siRv(i) { return _SI.plan?.review?.[i]; }
function siRvIgnore(i) { const r = _siRv(i); if (!r) return; _SI.decisions[r.id] = { ignore: true }; _siReplan(); }
function siRvRevert(i) { const r = _siRv(i); if (!r) return; delete _SI.decisions[r.id]; _siReplan(); }
function siRvQty(i) {
    const r = _siRv(i); if (!r) return;
    const v = _siParseQty($id(`si-rv-qty-${i}`)?.value?.trim());
    if (!Number.isFinite(v) || v < 0) { showToast('Escreve uma quantidade válida (0 ou mais)', 'error'); return; }
    _SI.decisions[r.id] = { qtd: v }; _siReplan();
}
function siRvLine(i, j) { const r = _siRv(i); if (!r || !r.linhas?.[j]) return; _SI.decisions[r.id] = { qtd: r.linhas[j].qtd }; _siReplan(); }
function siRvSum(i)     { const r = _siRv(i); if (!r) return; _SI.decisions[r.id] = { qtd: r.soma }; _siReplan(); }
function siRvStock(i, j){ const r = _siRv(i); if (!r || !r.candidatos?.[j]) return; _SI.decisions[r.id] = { stockId: r.candidatos[j].id }; _siReplan(); }

function siCancel() { renderStockImport(); }

async function siHandleFile(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const prev = $id('si-preview');
    if (!requireManagerAccess()) { input.value = ''; return; }
    if (!navigator.onLine) {
        showToast('Sem ligação — a importação precisa de internet', 'error');
        input.value = '';
        return;
    }
    prev.innerHTML = '<div class="pat-loading">A ler ficheiro e a comparar com o stock...</div>';

    try {
        await loadXlsx();
        const buf = await file.arrayBuffer();
        const wb  = XLSX.read(buf, { type: 'array' });

        // Primeira folha que tenha cabeçalho Ref + Quantidade
        let parsed = null, usedSheet = '';
        for (const name of wb.SheetNames) {
            const ws = wb.Sheets[name];
            if (!ws || !ws['!ref']) continue;
            const startRow = XLSX.utils.decode_range(ws['!ref']).s.r;
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
            const hdr = _siFindHeader(rows);
            if (hdr) { parsed = _siParseRows(rows, hdr, startRow); usedSheet = name; break; }
        }
        if (!parsed) {
            prev.innerHTML = `<div class="clientes-preview-error">Não encontrei as colunas «Ref» e «Quantidade» nas primeiras 40 linhas de nenhuma folha.</div>`;
            input.value = '';
            return;
        }
        if (parsed.entries.length === 0 && parsed.invalid.length === 0) {
            prev.innerHTML = `<div class="clientes-preview-error">Nenhuma referência preenchida encontrada na folha «${escapeHtml(usedSheet)}».</div>`;
            input.value = '';
            return;
        }

        // Stock fresco do servidor (a cache pode ter até 5 min)
        const stock = await fetchCollection('stock', true);
        _SI.entries   = parsed;
        _SI.stock     = stock;
        _SI.decisions = {};
        _SI.fileName = `${file.name} · folha «${usedSheet}» · ${parsed.entries.length + parsed.invalid.length} referências lidas`;
        _SI.plan     = _siBuildPlan(parsed, stock);
        _SI.sig      = _siSignature(_SI.plan);
        input.value  = '';
        _siRenderPreview();
    } catch (e) {
        console.error('[stockimport] ler ficheiro:', e);
        prev.innerHTML = `<div class="clientes-preview-error">Erro ao processar ficheiro: ${escapeHtml(e.message)}</div>`;
        input.value = '';
    }
}

// ── Gravação ────────────────────────────────────────────────────────────────

// Pedido directo (sem fila offline): a importação exige ligação e tem de ser atómica.
async function _siRequest(url, method, body) {
    const signed = await authUrl(url);
    const res = await _fetchWithTimeout(signed, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

function _siDownloadBackup(plan) {
    try {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = ['Ref;Designacao;Quantidade anterior;Quantidade nova;Unidade'];
        plan.updates.forEach(u => lines.push([esc(u.codigo), esc(u.nome), u.old, u.new, esc(u.unidade)].join(';')));
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const name = `backup-stock-antes-import-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) {
        console.warn('[stockimport] backup falhou:', e?.message);
    }
}

async function siApply() {
    if (_SI.busy || !_SI.plan || !_SI.entries) return;
    if (!requireManagerAccess()) return;
    if (!navigator.onLine) { showToast('Sem ligação — a importação precisa de internet', 'error'); return; }

    const btn = $id('si-apply');
    const wantBackup = !!$id('si-backup')?.checked;
    _SI.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'A aplicar...'; }

    try {
        // 1) Revalidar contra o stock actual — se mudou desde a pré-visualização, pedir nova confirmação
        const fresh = await fetchCollection('stock', true);
        const plan = _siBuildPlan(_SI.entries, fresh, _SI.decisions);
        if (_siSignature(plan) !== _SI.sig) {
            _SI.plan  = plan;
            _SI.stock = fresh;
            _SI.sig   = _siSignature(plan);
            _SI.busy  = false;
            _siRenderPreview();
            showToast('O stock mudou entretanto — revê e confirma de novo', 'error');
            return;
        }

        // 2) Cópia de segurança
        if (wantBackup) _siDownloadBackup(plan);

        // 3) Actualizar quantidades — um único PATCH multi-caminho (tudo ou nada)
        if (plan.updates.length) {
            const body = {};
            plan.updates.forEach(u => { body[`${u.id}/quantidade`] = u.new; });
            await _siRequest(`${BASE_URL}/stock.json`, 'PATCH', body);
            plan.updates.forEach(u => { if (fresh[u.id]) fresh[u.id].quantidade = u.new; });
        }

        // 4) Criar artigos novos (POST, em blocos de 8)
        const createdOk = [], createdFail = [];
        for (let i = 0; i < plan.creates.length; i += 8) {
            const chunk = plan.creates.slice(i, i + 8);
            const results = await Promise.allSettled(chunk.map(async c => {
                const payload = { nome: c.nome, localizacao: '', quantidade: c.quantidade, unidade: c.unidade, notas: '', codigo: c.codigo };
                const res = await _siRequest(`${BASE_URL}/stock.json`, 'POST', payload);
                const r = await res.json();
                return { id: r?.name, payload };
            }));
            results.forEach((r, j) => {
                if (r.status === 'fulfilled') createdOk.push(r.value);
                else createdFail.push(chunk[j].codigo);
            });
        }
        createdOk.forEach(c => { if (c.id) fresh[c.id] = c.payload; });

        // 5) Registar movimentos (só descidas) — um PATCH; falha aqui não reverte o stock
        let movOk = true;
        const drops = plan.updates.filter(u => u.diff < 0);
        if (drops.length) {
            try {
                const ts = Date.now(), mes = _mesKey(0), mov = {};
                drops.forEach((u, i) => {
                    mov[`inv_${ts}_${i}_${Math.random().toString(36).slice(2, 6)}`] = {
                        tipo: 'saida_inventario', itemId: u.id, codigo: String(u.codigo).toUpperCase(),
                        nome: u.nome || '', quantidade: Math.abs(u.diff), ts, mes,
                    };
                });
                await _siRequest(`${MOV_URL}.json`, 'PATCH', mov);
            } catch (e) {
                movOk = false;
                console.error('[stockimport] movimentos:', e);
            }
        }

        // 6) Refrescar UI
        cache.stock.data = fresh;
        cache.stock.lastFetch = Date.now();
        try { renderList(window._searchInputEl?.value || '', true); } catch (_) {}
        try { renderDashboard(); } catch (_) {}

        _siRenderDone({ plan, createdOk: createdOk.length, createdFail, movOk, drops: drops.length });
    } catch (e) {
        console.error('[stockimport] aplicar:', e);
        invalidateCache('stock');
        _SI.busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Aplicar importação'; }
        showToast('Erro ao aplicar — nenhuma quantidade foi alterada. Tenta de novo.', 'error');
        return;
    }
    _SI.busy = false;
}

function _siRenderDone({ plan, createdOk, createdFail, movOk, drops }) {
    const prev = $id('si-preview');
    if (!prev) return;
    let html = `<div class="si-done">
        <div class="si-done-title">✓ Importação concluída</div>
        <ul class="si-done-list">
            <li><strong>${plan.updates.length}</strong> quantidades atualizadas</li>
            <li><strong>${createdOk}</strong> artigos novos criados <span class="si-muted">(sem localização — filtra por «Sem local» no Stock)</span></li>
            <li><strong>${drops}</strong> saídas registadas nos relatórios (${plan.saidaTotal} un)</li>
            <li><strong>${plan.review.length}</strong> linhas por rever ou ignoradas (não alteradas)</li>
        </ul>`;
    if (createdFail.length) {
        html += `<p class="si-note si-note-warn">Não foi possível criar: ${createdFail.map(escapeHtml).join(', ')}. As quantidades já estão gravadas; importa de novo para criar estas.</p>`;
    }
    if (!movOk) {
        html += `<p class="si-note si-note-warn">O stock foi atualizado, mas as saídas <strong>não ficaram registadas</strong> nos relatórios.</p>`;
    }
    html += `<div class="si-actions"><button type="button" class="btn-primary" onclick="renderStockImport()">Nova importação</button></div></div>`;
    prev.innerHTML = html;
    showToast('Importação concluída');
}
