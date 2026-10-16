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
//   • Refs repetidas (no Excel ou no stock) NÃO são tocadas — ficam em "A rever".
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

const _SI = { entries: null, plan: null, fileName: '', busy: false };

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

// Linhas do Excel → entradas válidas + linhas inválidas.
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
        const qtdRaw = row[cols.qtd];
        const qtd = _siParseQty(qtdRaw);
        if (!Number.isFinite(qtd) || qtd < 0) {
            const vazio = qtdRaw === '' || qtdRaw == null;
            invalid.push({ linha, ref: refRaw, motivo: vazio ? 'quantidade vazia' : `quantidade inválida (${qtdRaw})` });
            continue;
        }
        const nome = cols.des !== undefined ? String(row[cols.des] ?? '').trim().toUpperCase() : '';
        const u = cols.uni !== undefined ? _siParseUnit(row[cols.uni]) : { unit: 'un', known: false, warn: '' };
        entries.push({ linha, ref: refRaw.toUpperCase(), key, nome, qtd, unidade: u.unit, unitKnown: u.known, warn: u.warn });
    }
    return { entries, invalid };
}

// Compara com o stock e classifica cada linha.
function _siBuildPlan(parsed, stockData) {
    const stockByKey = {};
    Object.entries(stockData || {}).forEach(([id, item]) => {
        if (!item || id.startsWith('_tmp_')) return;
        const k = _siKey(item.codigo);
        if (!k) return;
        (stockByKey[k] = stockByKey[k] || []).push(id);
    });

    const excelCount = {};
    parsed.entries.forEach(e => { excelCount[e.key] = (excelCount[e.key] || 0) + 1; });

    const plan = { updates: [], creates: [], same: 0, review: [...parsed.invalid.map(x => ({ ...x }))], saidaTotal: 0, saidaItens: 0, subidaTotal: 0 };

    parsed.entries.forEach(e => {
        if (excelCount[e.key] > 1) {
            plan.review.push({ linha: e.linha, ref: e.ref, motivo: 'referência repetida no Excel' });
            return;
        }
        const ids = stockByKey[e.key];
        if (!ids) {
            plan.creates.push({ key: e.key, linha: e.linha, codigo: e.ref, nome: e.nome || e.ref, quantidade: e.qtd, unidade: e.unidade, warn: e.warn });
            return;
        }
        if (ids.length > 1) {
            plan.review.push({ linha: e.linha, ref: e.ref, motivo: `referência repetida no stock (${ids.length} artigos)` });
            return;
        }
        const id = ids[0];
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
    _SI.entries = null; _SI.plan = null; _SI.fileName = ''; _SI.busy = false;
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

function _siRowRev(r) {
    return `<div class="si-row">
        <div class="si-row-main"><b>${escapeHtml(r.ref)}</b><span>linha ${r.linha}</span></div>
        <div class="si-row-val si-rev">${escapeHtml(r.motivo)}</div>
    </div>`;
}

function _siSection(title, count, rowsHtml, openByDefault = false) {
    if (!count) return '';
    return `<details class="si-sec"${openByDefault ? ' open' : ''}>
        <summary>${escapeHtml(title)} <span class="si-count">${count}</span></summary>
        <div class="si-list">${rowsHtml}</div>
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
        <div class="si-chip si-chip-warn"><b>${p.review.length}</b><span>A rever</span></div>
    </div>`;

    if (p.updates.length) {
        html += `<p class="si-note">Saídas a registar nos relatórios: <strong>${p.saidaTotal}</strong> (${p.saidaItens} artigo${p.saidaItens === 1 ? '' : 's'}).
        Aumentos de stock: <strong>${p.subidaTotal}</strong> (não contam como saída).</p>`;
    }
    if (p.review.length) {
        html += `<p class="si-note si-note-warn">As linhas em «A rever» <strong>não serão alteradas</strong>.</p>`;
    }

    html += _siSection('Quantidades a atualizar', p.updates.length, p.updates.map(_siRowUpd).join(''));
    html += _siSection('Artigos novos a criar (sem localização)', p.creates.length, p.creates.map(_siRowNew).join(''));
    html += _siSection('A rever (não alterados)', p.review.length, p.review.map(_siRowRev).join(''), true);

    if (nothing) {
        html += `<div class="si-empty">Nada para atualizar — o stock já coincide com o Excel${p.review.length ? ', exceto as linhas a rever' : ''}.</div>
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
        _SI.entries  = parsed;
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
        const plan = _siBuildPlan(_SI.entries, fresh);
        if (_siSignature(plan) !== _SI.sig) {
            _SI.plan = plan;
            _SI.sig  = _siSignature(plan);
            _SI.busy = false;
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
        const dataImp = new Date().toLocaleDateString('pt-PT');
        for (let i = 0; i < plan.creates.length; i += 8) {
            const chunk = plan.creates.slice(i, i + 8);
            const results = await Promise.allSettled(chunk.map(async c => {
                const payload = { nome: c.nome, localizacao: '', quantidade: c.quantidade, unidade: c.unidade, notas: `Importado do Excel em ${dataImp}`, codigo: c.codigo };
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
            <li><strong>${plan.review.length}</strong> linhas por rever (não alteradas)</li>
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
