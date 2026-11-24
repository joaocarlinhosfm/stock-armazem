// ─────────────────────────────────────────────────────────────────────────────
// tools.js — Gestão Armazém v6.85
// Ferramentas (com identificação destacada por nº único de 3 ou 4 dígitos),
// histórico, funcionários, timeline e modais partilhados.
// Carrega DEPOIS de reports.js e stock.js, ANTES de pats.js.
//
// Dependências:
//   utils.js  → BASE_URL, $id, $el, escapeHtml, showToast, modalOpen, modalClose,
//               focusModal, _calcDias, formatDate, SVG_EDIT, SVG_DEL, SVG_USER
//   auth.js   → requireManagerAccess, authUrl
//   app.js    → cache, fetchCollection, invalidateCache, apiFetch,
//               renderDashboard, nav
// ─────────────────────────────────────────────────────────────────────────────

const _TOOL_ALERT_DAYS = 7; // alinhado com dashboard.js (≥ 7 dias fora = em atraso)

let _toolsStatusFilter = 'all'; // 'all' | 'disponivel' | 'alocada' | 'overdue'
let _toolsSearchQuery  = '';

// Normaliza texto para pesquisa sem acentos e case-insensitive
function _normToolText(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

// Extrai o número único de 3 ou 4 dígitos e o nome limpo de uma ferramenta.
// Suporta tanto o campo dedicado `tool.numero` como registos antigos onde o
// número de 3 ou 4 dígitos estava dentro de `tool.nome` (ex.: "BERBEQUIM 1042",
// "1042 - BERBEQUIM", "MANÓMETROS (0321)").
function _parseToolIdentity(tool) {
    const rawNum  = String(tool?.numero ?? '').trim();
    const rawNome = String(tool?.nome   ?? '').trim();

    const mNum = rawNum.match(/(?:^|[^A-Za-z0-9])(\d{4})(?![A-Za-z0-9])/);
    let numero = mNum ? mNum[1] : '';
    let nome   = rawNome;

    if (!numero && rawNome) {
        let m = rawNome.match(/^\s*#?(\d{4})(?![A-Za-z0-9])\s*[-–—:\/·]?\s*(.*)$/);
        if (m) {
            numero = m[1];
            nome   = m[2];
        } else {
            m = rawNome.match(/^(.*?)(?:^|[^A-Za-z0-9])(\d{4})(?:\)|\])?\s*$/);
            if (m) {
                numero = m[2];
                nome   = m[1];
            } else {
                m = rawNome.match(/(?:^|[^A-Za-z0-9])(\d{4})(?![A-Za-z0-9])/);
                if (m) {
                    numero = m[1];
                    const idx = m.index + m[0].indexOf(numero);
                    nome = rawNome.slice(0, idx) + ' ' + rawNome.slice(idx + 4);
                }
            }
        }
    } else if (numero && rawNome) {
        // Evita repetir o mesmo nº de 3 ou 4 dígitos se também estiver no nome
        const reStart = new RegExp(`^\\s*#?${numero}(?![A-Za-z0-9])\\s*[-–—:\\/·]?\\s*`);
        const reEnd   = new RegExp(`(?:^|[^A-Za-z0-9])${numero}(?:\\)|\\])?\\s*$`);
        nome = nome.replace(reStart, '').replace(reEnd, '');
    }

    nome = nome
        .replace(/\(\s*\)|\[\s*\]/g, '')
        .replace(/^[\s\-–—:\/·#(\[]+|[\s\-–—:\/·#(\[]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return { numero, nome };
}

// Etiqueta textual unificada para modais, alertas, dashboard, relatórios e CSV
function _toolDisplayLabel(tool) {
    const { numero, nome } = _parseToolIdentity(tool);
    if (numero && nome) return `#${numero} · ${nome}`;
    if (numero)         return `#${numero}`;
    return nome || '—';
}

// Verifica se já existe outra ferramenta com o mesmo nº de 3 ou 4 dígitos
function _findDuplicateToolNum(numero, ignoreId = null) {
    if (!numero) return null;
    const data = cache.ferramentas.data || {};
    for (const [id, t] of Object.entries(data)) {
        if (id === ignoreId || !t) continue;
        const { numero: existingNum } = _parseToolIdentity(t);
        if (existingNum === numero) return { id, tool: t };
    }
    return null;
}

function toolsFilterSet(btn, filter) {
    _toolsStatusFilter = filter || 'all';
    renderTools();
}

function toolsSearchClear() {
    _toolsSearchQuery = '';
    const inp = $id('inp-tools-search');
    if (inp) { inp.value = ''; inp.focus(); }
    const clr = $id('inp-tools-search-clear');
    if (clr) clr.classList.add('hidden');
    renderTools();
}

async function renderTools() {
    const list = $id('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');

    const entries = Object.entries(data || {});
    const isOverdueTool = t => t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) >= _TOOL_ALERT_DAYS;

    // Stat chips
    const totalCount = entries.length;
    const dispCount  = entries.filter(([, t]) => t.status !== 'alocada').length;
    const alocCount  = entries.filter(([, t]) => t.status === 'alocada').length;
    const overCount  = entries.filter(([, t]) => isOverdueTool(t)).length;

    const sub = $id('tools-header-sub');
    if (sub) {
        sub.textContent = `${totalCount} ferramenta${totalCount !== 1 ? 's' : ''} · ${alocCount} em campo`;
    }
    const setTxt = (id, v) => { const e = $id(id); if (e) e.textContent = v; };
    setTxt('ts-total', totalCount);
    setTxt('ts-disp',  dispCount);
    setTxt('ts-aloc',  alocCount);
    setTxt('ts-over',  overCount);

    // Se não há ferramentas em atraso, esconde o stat/pill de atraso (e se estava seleccionado, volta a 'all')
    if (overCount === 0 && _toolsStatusFilter === 'overdue') _toolsStatusFilter = 'all';
    const overStat = document.querySelector('.tools-stat.ts-red');
    if (overStat) overStat.style.display = overCount > 0 ? '' : 'none';
    const overFilterBtn = $id('tools-filter-overdue');
    if (overFilterBtn) overFilterBtn.style.display = overCount > 0 ? '' : 'none';

    // Sincronizar destaque nos filtros e nos stat chips clicáveis
    document.querySelectorAll('.tools-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === _toolsStatusFilter);
    });
    document.querySelectorAll('.tools-stat[data-filter]').forEach(stat => {
        stat.classList.toggle('active', stat.dataset.filter === _toolsStatusFilter);
    });

    list.innerHTML = '';
    if (totalCount === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div><div class="empty-state-title">Sem ferramentas</div><div class="empty-state-sub">Adiciona ferramentas em Administração → Ferramentas.</div></div>`;
        return;
    }

    const qNorm = _normToolText(_toolsSearchQuery);

    // Ordenação por nº de 3 ou 4 dígitos crescente (ferramentas sem número ficam depois, por nome)
    const _sortByNum = ([, a], [, b]) => {
        const ia = _parseToolIdentity(a);
        const ib = _parseToolIdentity(b);
        if (ia.numero && ib.numero) return ia.numero.localeCompare(ib.numero);
        if (ia.numero) return -1;
        if (ib.numero) return 1;
        return (ia.nome || '').localeCompare(ib.nome || '', 'pt');
    };

    const overdueList = entries.filter(([, t]) => isOverdueTool(t)).sort(([, a], [, b]) => _calcDias(b.dataEntrega) - _calcDias(a.dataEntrega));
    const alocList    = entries.filter(([, t]) => t.status === 'alocada' && !isOverdueTool(t)).sort(_sortByNum);
    const dispList    = entries.filter(([, t]) => t.status !== 'alocada').sort(_sortByNum);

    const TOOL_SVG   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
    const RETURN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>`;
    const USER_SVG   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    const CLOCK_SVG  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const CHEV_SVG   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

    function _matchesFilters(t) {
        const isAv      = t.status !== 'alocada';
        const isOverdue = isOverdueTool(t);

        if (_toolsStatusFilter === 'disponivel' && !isAv) return false;
        if (_toolsStatusFilter === 'alocada'    && isAv)  return false;
        if (_toolsStatusFilter === 'overdue'    && !isOverdue) return false;

        if (qNorm) {
            const { numero, nome } = _parseToolIdentity(t);
            const hay = _normToolText(`${numero} ${nome} ${t.nome || ''} ${t.colaborador || ''}`);
            const tokens = qNorm.split(/\s+/).filter(Boolean);
            if (!tokens.every(tok => hay.includes(tok))) return false;
        }
        return true;
    }

    function _makeCard(id, t) {
        if (!_matchesFilters(t)) return null;

        const { numero, nome } = _parseToolIdentity(t);
        const displayLabel     = _toolDisplayLabel(t);
        const isAv             = t.status !== 'alocada';
        const isOverdue        = isOverdueTool(t);
        const statusCls        = isAv ? 'tool-available' : (isOverdue ? 'tool-overdue' : 'tool-allocated');

        const card = $el('div', { className: `tool-card ${statusCls}` });

        // Long-press (mobile) / clique direito (desktop) → histórico
        let lpTimer = null;
        let lpFired = false;
        card.addEventListener('contextmenu', e => {
            e.preventDefault();
            openHistoryModal(id, displayLabel);
        });
        card.addEventListener('touchstart', () => {
            lpFired = false;
            lpTimer = setTimeout(() => {
                lpFired = true;
                openHistoryModal(id, displayLabel);
            }, 600);
        }, { passive: true });
        card.addEventListener('touchend',  () => clearTimeout(lpTimer), { passive: true });
        card.addEventListener('touchmove', () => clearTimeout(lpTimer), { passive: true });

        // Placa de identificação destacada (nº de 3 ou 4 dígitos)
        const idPlate = $el('div', { className: 'tool-id-badge' + (numero ? '' : ' no-num') });
        if (numero) {
            const lbl = $el('span', { className: 'tool-id-prefix', textContent: 'Nº' });
            const val = $el('span', { className: 'tool-id-num',    textContent: numero });
            idPlate.appendChild(lbl);
            idPlate.appendChild(val);
        } else {
            idPlate.innerHTML = `${TOOL_SVG}<span class="tool-id-none">S/Nº</span>`;
        }
        card.appendChild(idPlate);

        // Informação principal (nome + estado/técnico)
        const info = $el('div', { className: 'tool-info' });

        const nomeEl = $el('div', { className: 'tool-nome' });
        nomeEl.textContent = nome || 'Ferramenta';
        info.appendChild(nomeEl);

        const subRow = $el('div', { className: 'tool-sub' });
        if (isAv) {
            const availPill = $el('span', { className: 'tool-pill tool-pill-avail' });
            availPill.innerHTML = `<span class="tool-status-dot"></span>Em armazém`;
            subRow.appendChild(availPill);
        } else {
            const days = t.dataEntrega ? _calcDias(t.dataEntrega) : null;

            const colabBadge = $el('span', { className: `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-colab'}` });
            colabBadge.innerHTML = `${USER_SVG}<span>${escapeHtml((t.colaborador || '—').toUpperCase())}</span>`;
            subRow.appendChild(colabBadge);

            if (days !== null) {
                const daysBadge = $el('span', { className: `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-days'}` });
                const daysTxt = days === 0 ? 'Hoje' : days === 1 ? '1d fora' : `${days}d fora`;
                daysBadge.innerHTML = `${CLOCK_SVG}<span>${daysTxt}</span>`;
                subRow.appendChild(daysBadge);
            }

            if (isOverdue) {
                const ovd = $el('span', { className: 'tool-badge tool-badge-overdue tool-badge-alert', textContent: 'Em atraso' });
                subRow.appendChild(ovd);
            }
        }
        info.appendChild(subRow);
        card.appendChild(info);

        // Acção à direita
        if (isAv) {
            card.onclick = () => {
                if (lpFired) { lpFired = false; return; }
                openModal(id);
            };
            const deliverBtn = $el('span', { className: 'tool-deliver-pill' });
            deliverBtn.innerHTML = `<span class="tool-deliver-txt">Entregar</span>${CHEV_SVG}`;
            card.appendChild(deliverBtn);
        } else {
            card.onclick = () => {
                if (lpFired) { lpFired = false; return; }
                openHistoryModal(id, displayLabel);
            };
            const retBtn = $el('button', { type: 'button', className: 'tool-return-btn' });
            retBtn.innerHTML = `${RETURN_SVG}<span class="tool-return-txt">Devolver</span>`;
            retBtn.title     = 'Devolver ferramenta';
            retBtn.onclick   = e => {
                e.stopPropagation();
                openConfirmModal({
                    title: 'Confirmar devolução?',
                    desc: `"${displayLabel}" será marcada como disponível em armazém.`,
                    type: 'success', okLabel: 'Devolver',
                    onConfirm: () => returnTool(id)
                });
            };
            card.appendChild(retBtn);
        }

        return card;
    }

    const listFrag = document.createDocumentFragment();

    function _addSection(label, items, toneCls = '') {
        const cards = [];
        items.forEach(([id, t]) => {
            const card = _makeCard(id, t);
            if (card) cards.push(card);
        });
        if (!cards.length) return 0;

        const secHead = $el('div', { className: `tools-section-head ${toneCls}` });
        const lbl = $el('span', { className: 'tools-section-label', textContent: label });
        const cnt = $el('span', { className: 'tools-section-count', textContent: String(cards.length) });
        secHead.appendChild(lbl);
        secHead.appendChild(cnt);
        listFrag.appendChild(secHead);

        const grid = $el('div', { className: 'tools-section-grid' });
        cards.forEach(c => grid.appendChild(c));
        listFrag.appendChild(grid);
        return cards.length;
    }

    let rendered = 0;
    rendered += _addSection('Em atraso',   overdueList, 'tone-overdue');
    rendered += _addSection('Em campo',    alocList,    'tone-allocated');
    rendered += _addSection('Em armazém',  dispList,    'tone-available');

    list.appendChild(listFrag);

    if (rendered === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><div class="empty-state-title">Sem resultados</div><div class="empty-state-sub">Nenhuma ferramenta corresponde à pesquisa ou filtro.</div></div>`;
    }
}

async function renderAdminTools() {
    if (!requireManagerAccess({ silent: true })) return;
    const data = await fetchCollection('ferramentas');
    const list = $id('admin-tools-list');
    if (!list) return;
    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>'; return;
    }

    const HIST_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

    const sorted = Object.entries(data).sort(([, a], [, b]) => {
        const ia = _parseToolIdentity(a);
        const ib = _parseToolIdentity(b);
        if (ia.numero && ib.numero) {
            return ia.numero.localeCompare(ib.numero, undefined, { numeric: true }) || ia.numero.localeCompare(ib.numero);
        }
        if (ia.numero) return -1;
        if (ib.numero) return 1;
        return (ia.nome || '').localeCompare(ib.nome || '', 'pt');
    });

    sorted.forEach(([id, t]) => {
        const { numero, nome } = _parseToolIdentity(t);
        const displayLabel = _toolDisplayLabel(t);

        const row = $el('div', { className: 'admin-list-row admin-tool-row' });

        // Identidade: nº de 3 ou 4 dígitos + nome
        const head = $el('div', { className: 'admin-tool-head' });
        if (numero) {
            const numPill = $el('span', { className: 'tool-admin-num', textContent: `#${numero}` });
            head.appendChild(numPill);
        } else {
            const noNum = $el('span', { className: 'tool-admin-num tool-admin-num-empty', textContent: 'S/Nº' });
            head.appendChild(noNum);
        }
        const lbl = $el('span', { className: 'admin-list-label', textContent: nome || 'Ferramenta' });
        head.appendChild(lbl);

        // Barra de acções
        const actions = $el('div', { className: 'admin-tool-actions' });

        const editBtn = $el('button', { type: 'button', className: 'admin-tool-btn admin-tool-btn-edit' });
        editBtn.innerHTML = `${SVG_EDIT} <span>Editar</span>`;
        editBtn.onclick   = () => openEditToolModal(id, t);

        const histBtn = $el('button', { type: 'button', className: 'admin-tool-btn admin-tool-btn-hist' });
        histBtn.innerHTML = `${HIST_SVG} <span>Histórico</span>`;
        histBtn.onclick   = () => openHistoryModal(id, displayLabel);

        const delBtn = $el('button', { type: 'button', className: 'admin-tool-btn admin-tool-btn-del' });
        delBtn.innerHTML = `${SVG_DEL} <span>Eliminar</span>`;
        delBtn.onclick   = () => openConfirmModal({
            title: 'Apagar ferramenta?',
            desc: `"${displayLabel}" será removida permanentemente.`,
            type: 'danger',
            onConfirm: () => deleteTool(id)
        });

        actions.appendChild(editBtn);
        actions.appendChild(histBtn);
        actions.appendChild(delBtn);
        row.appendChild(head);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

// HISTÓRICO DAS FERRAMENTAS
const HISTORY_MAX = 50; // máximo de registos por ferramenta

async function addToolHistoryEvent(toolId, acao, colaborador) {
    const event = { acao, colaborador: colaborador || '', data: new Date().toISOString() };
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico.json`, {
            method: 'POST', body: JSON.stringify(event)
        });
        const histCache = cache.ferramentas.data?.[toolId]?.historico;
        const histCount = histCache ? Object.keys(histCache).length : 0;
        if (histCount >= HISTORY_MAX) {
            try {
                const url = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (data && Object.keys(data).length > HISTORY_MAX) {
                        const sorted = Object.entries(data).sort((a, b) => new Date(a[1].data) - new Date(b[1].data));
                        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico/${sorted[0][0]}.json`, { method: 'DELETE' });
                    }
                }
            } catch (e) { console.warn('Limpeza histórico:', e?.message || e); }
        }
    } catch (e) { console.warn('addToolHistoryEvent:', e?.message || e); /* best-effort */ }
}

async function openHistoryModal(toolId, toolName) {
    const toolObj = cache.ferramentas.data?.[toolId];
    const label   = toolObj ? _toolDisplayLabel(toolObj) : (toolName || '—');
    $id('history-modal-tool-name').textContent = label;
    const listEl = $id('history-list');
    listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';
    modalOpen('history-modal');
    focusModal('history-modal');

    try {
        if (!navigator.onLine) {
            listEl.innerHTML = '<div class="empty-msg">Sem ligação — histórico indisponível offline.</div>';
            return;
        }
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        listEl.innerHTML = '';

        if (!data) {
            listEl.innerHTML = '<div class="empty-msg">Sem registos de histórico.</div>';
            return;
        }

        const events = Object.values(data).sort((a, b) => new Date(b.data) - new Date(a.data));

        events.forEach(ev => {
            const row = $el('div');
            row.className = `history-row ${ev.acao === 'atribuida' ? 'history-out' : 'history-in'}`;
            const icon = ev.acao === 'atribuida' ? '→' : '↩';
            const txt = ev.acao === 'atribuida'
                ? `Entregue a ${ev.colaborador || '?'}`
                : `Devolvida${ev.colaborador ? ` por ${ev.colaborador}` : ''}`;
            const date = formatDate(ev.data);
            const iconEl = $el('span', { className: 'history-icon', textContent: icon });
            const info   = $el('div',  { className: 'history-info' });
            const lbl    = $el('span', { className: 'history-label', textContent: txt });
            const dt     = $el('span', { className: 'history-date',  textContent: date });
            info.appendChild(lbl);
            info.appendChild(dt);
            row.appendChild(iconEl);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = '<div class="empty-msg">Erro ao carregar histórico.</div>';
    }
}

async function assignTool(worker) {
    const dataEntrega = new Date().toISOString();
    const id = toolToAllocate;
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status: 'alocada', colaborador: worker, dataEntrega
    };
    modalClose('worker-modal'); renderTools(); renderDashboard(); showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method: 'PATCH', body: JSON.stringify({ status: 'alocada', colaborador: worker, dataEntrega })
        });
        await addToolHistoryEvent(id, 'atribuida', worker);
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar.', 'error'); }
}

async function returnTool(id) {
    const colaborador     = cache.ferramentas.data[id]?.colaborador || '';
    const dataEntregaOrig = cache.ferramentas.data[id]?.dataEntrega || '';
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status: 'disponivel', colaborador: '', dataEntrega: ''
    };
    renderTools(); renderDashboard(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method: 'PATCH', body: JSON.stringify({ status: 'disponivel', colaborador: '', dataEntrega: '' })
        });
        await addToolHistoryEvent(id, 'devolvida', colaborador);
    } catch (e) {
        console.warn('returnTool erro:', e?.message || e);
        cache.ferramentas.data[id] = {
            ...cache.ferramentas.data[id], status: 'alocada', colaborador, dataEntrega: dataEntregaOrig
        };
        invalidateCache('ferramentas'); showToast('Erro ao guardar.', 'error');
    }
}

function openEditToolModal(id, tool) {
    const { numero, nome } = _parseToolIdentity(tool);
    $id('edit-tool-id').value   = id;
    const numEl = $id('edit-tool-num');
    if (numEl) numEl.value      = numero;
    $id('edit-tool-name').value = nome || tool.nome || '';
    modalOpen('edit-tool-modal');
    focusModal('edit-tool-modal');
}

async function saveEditTool() {
    if (!requireManagerAccess()) return;
    const id     = $id('edit-tool-id').value;
    const rawNum = ($id('edit-tool-num')?.value || '').replace(/\D/g, '');
    let   nome   = $id('edit-tool-name').value.trim().toUpperCase();

    if (!nome) { showToast('Nome obrigatório', 'error'); return; }

    let numero = rawNum;
    if (numero && (numero.length < 3 || numero.length > 4)) {
        showToast('O nº da ferramenta deve ter 3 ou 4 dígitos', 'error');
        $id('edit-tool-num')?.focus();
        return;
    }
    // Se deixou o campo nº vazio mas incluiu 3 ou 4 dígitos no nome, separa automaticamente
    if (!numero) {
        const parsed = _parseToolIdentity({ nome });
        if (parsed.numero) {
            numero = parsed.numero;
            if (parsed.nome) nome = parsed.nome;
        }
    } else {
        const cleaned = _parseToolIdentity({ numero, nome });
        if (cleaned.nome) nome = cleaned.nome;
    }

    if (numero) {
        const dup = _findDuplicateToolNum(numero, id);
        if (dup) {
            showToast(`Já existe uma ferramenta com o nº ${numero} (${_toolDisplayLabel(dup.tool)})`, 'error');
            $id('edit-tool-num')?.focus();
            return;
        }
    }

    const patch = { nome, numero: numero || null };
    if (cache.ferramentas.data?.[id]) {
        cache.ferramentas.data[id] = { ...cache.ferramentas.data[id], ...patch };
    }
    modalClose('edit-tool-modal');
    renderAdminTools();
    renderTools();
    renderDashboard();
    showToast('Ferramenta actualizada!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method: 'PATCH', body: JSON.stringify(patch)
        });
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar', 'error'); }
}

async function deleteTool(id) {
    if (!requireManagerAccess()) return;
    const tool = cache.ferramentas.data?.[id];
    const _doDelete = async () => {
        delete cache.ferramentas.data[id]; renderAdminTools(); renderTools(); renderDashboard();
        try {
            await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method: 'DELETE' });
            showToast('Ferramenta apagada');
        } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao apagar.', 'error'); }
    };
    if (tool?.status === 'alocada') {
        openConfirmModal({
            title: 'Ferramenta alocada!',
            desc: `"${_toolDisplayLabel(tool)}" está com ${tool.colaborador || '?'}. Apagar irá forçar a devolução sem registo. Confirmas?`,
            type: 'warn', okLabel: 'Forçar apagar',
            onConfirm: _doDelete
        });
    } else {
        await _doDelete();
    }
}

// FUNCIONÁRIOS
async function renderWorkers() {
    if (!requireManagerAccess({ silent: true })) return;
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id, v]) => ({ id, nome: v.nome })) : [];
    const list    = $id('workers-list');
    if (!list) return;

    const badge = $id('workers-count-badge');
    if (badge) badge.textContent = workers.length ? `${workers.length} registados` : '';

    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionário adicionado.</div>'; return;
    }
    workers.forEach(w => {
        const row = $el('div', { className: 'admin-list-row' });

        const avatar = $el('div', { className: 'admin-list-avatar' });
        const initials = w.nome.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
        avatar.textContent = initials || '?';

        const lbl = $el('span', { className: 'admin-list-label', textContent: w.nome });
        const btn = $el('button', { className: 'admin-list-delete' });
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
        btn.onclick = () => openConfirmModal({
            title: 'Apagar funcionário?',
            desc: `"${w.nome}" será removido permanentemente.`,
            type: 'danger',
            onConfirm: () => deleteWorker(w.id)
        });
        row.appendChild(avatar); row.appendChild(lbl); row.appendChild(btn);
        list.appendChild(row);
    });
}

async function deleteWorker(id) {
    if (!requireManagerAccess()) return;
    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();
    try {
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method: 'DELETE' });
    } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao apagar.', 'error'); }
}

// MODAL — entregar ferramenta
let toolToAllocate = null;

async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid, v]) => ({ id: wid, nome: v.nome })) : [];
    if (workers.length === 0) return showToast('Adicione funcionários na Administração', 'error');
    toolToAllocate = id;

    const toolData = cache.ferramentas.data?.[id];
    const { numero, nome } = _parseToolIdentity(toolData || {});
    const toolDesc = $id('worker-modal-tool-name');
    if (toolDesc) {
        if (numero) {
            toolDesc.innerHTML = `<span class="tool-modal-num">#${escapeHtml(numero)}</span><span>${escapeHtml(nome || 'Ferramenta')}</span>`;
        } else {
            toolDesc.textContent = nome || '';
        }
    }

    const sel = $id('worker-select-list');
    sel.innerHTML = '';
    workers.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
    workers.forEach(w => {
        const opt = $el('div', { className: 'worker-option', textContent: w.nome });
        opt.onclick = () => assignTool(w.nome);
        sel.appendChild(opt);
    });
    modalOpen('worker-modal');
    focusModal('worker-modal');
}

// MODAL — confirmação genérica
let confirmCallback = null;

const _CONFIRM_ICONS = {
    danger:  { svg: '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>', color: '#dc2626' },
    success: { svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', color: '#16a34a' },
    confirm: { svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>', color: '#2563eb' },
    warn:    { svg: '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" style="color:#ca8a04"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>', color: '#ca8a04' },
};

function openConfirmModal({ title, desc, onConfirm, type = 'danger', okLabel = null, hideCancel = false }) {
    confirmCallback = onConfirm;
    const cfg = _CONFIRM_ICONS[type] || _CONFIRM_ICONS.danger;

    const iconWrap = $id('confirm-modal-icon-wrap');
    if (iconWrap) {
        iconWrap.innerHTML = cfg.svg;
        iconWrap.className = 'confirm-modal-icon-wrap type-' + type;
    }
    $id('confirm-modal-title').textContent = title;
    $id('confirm-modal-desc').textContent  = desc || '';

    const okBtn = $id('confirm-modal-ok');
    okBtn.className = 'confirm-btn-ok type-' + type;
    okBtn.textContent = okLabel || (type === 'danger' ? 'Apagar' : 'Confirmar');

    const slot = $id('confirm-modal-slot');
    if (slot) slot.innerHTML = '';

    const cancelBtn = document.querySelector('#confirm-modal .confirm-btn-cancel');
    if (cancelBtn) cancelBtn.style.display = hideCancel ? 'none' : '';

    modalOpen('confirm-modal');
    focusModal('confirm-modal');
}
function closeConfirmModal() {
    confirmCallback = null;
    const slot = $id('confirm-modal-slot');
    if (slot) slot.innerHTML = '';
    const cancelBtn = document.querySelector('#confirm-modal .confirm-btn-cancel');
    if (cancelBtn) cancelBtn.style.display = '';
    modalClose('confirm-modal');
}

// MODAL — apagar produto (swipe left)
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    openConfirmModal({
        title: 'Apagar produto?',
        desc: `"${String(item.codigo || '').toUpperCase()} — ${item.nome}" será removido permanentemente.`,
        type: 'danger',
        okLabel: 'Apagar',
        onConfirm: () => {
            pendingDeleteId = null;
            if (typeof window._deleteProductCallback === 'function') window._deleteProductCallback(id, item);
        }
    });
}
function closeDeleteModal() {
    pendingDeleteId = null;
    closeConfirmModal();
}

// MODAL — editar produto (swipe right)
function openEditModal(id, item) {
    $id('edit-id').value     = id;
    $id('edit-codigo').value = item.codigo || '';
    $id('edit-nome').value   = item.nome || '';
    $id('edit-loc').value    = item.localizacao || '';
    $id('edit-qtd').value    = item.quantidade ?? 0;
    setUnitSelector('edit', item.unidade || 'un');
    $id('edit-notas').value  = item.notas || '';
    const editGasMax   = $id('edit-gas-max');
    const editGasAlert = $id('edit-gas-alerta');
    if (editGasMax)   editGasMax.value   = item.gasMax    != null ? item.gasMax    : '';
    if (editGasAlert) editGasAlert.value = item.gasAlerta != null ? item.gasAlerta : '';
    _loadImgEdit(item.imgUrl || '');
    modalOpen('edit-modal');
    focusModal('edit-modal');
}

// EXPORTAR HISTÓRICO E TIMELINE
async function exportToolHistoryCSV() {
    const btn = $id('export-hist-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    try {
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData || Object.keys(ferrData).length === 0) {
            showToast('Sem ferramentas para exportar', 'error');
            return;
        }
        const headers = ['Nº', 'Ferramenta', 'Ação', 'Colaborador', 'Data'];
        const rows = [];
        for (const [, t] of Object.entries(ferrData)) {
            if (!t.historico) continue;
            const { numero, nome } = _parseToolIdentity(t);
            for (const ev of Object.values(t.historico)) {
                rows.push({
                    ts: ev.data ? new Date(ev.data).getTime() : 0,
                    cols: [
                        `"${numero}"`,
                        `"${(nome || t.nome || '').replace(/"/g, '""')}"`,
                        `"${ev.acao || ''}"`,
                        `"${(ev.colaborador || '').replace(/"/g, '""')}"`,
                        `"${ev.data ? new Date(ev.data).toLocaleString('pt-PT') : ''}"`
                    ]
                });
            }
        }
        if (rows.length === 0) {
            showToast('Sem histórico para exportar', 'error');
            return;
        }
        rows.sort((a, b) => b.ts - a.ts);
        const csv  = [headers.join(';'), ...rows.map(r => r.cols.join(';'))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        Object.assign($el('a'), {
            href: url,
            download: `gestao-armazem-historico-ferramentas-${new Date().toISOString().slice(0, 10)}.csv`
        }).click();
        URL.revokeObjectURL(url);
        showToast(`${rows.length} registos exportados!`);
    } catch(e) {
        showToast('Erro ao exportar histórico', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar Histórico'; }
    }
}

async function openToolTimeline() {
    const el = $id('timeline-list');
    el.innerHTML = '<div class="empty-msg">A carregar...</div>';
    modalOpen('timeline-modal');
    focusModal('timeline-modal');

    try {
        if (!navigator.onLine) {
            el.innerHTML = '<div class="empty-msg">Sem ligação — timeline indisponível offline.</div>';
            return;
        }
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData) { el.innerHTML = '<div class="empty-msg">Sem dados.</div>'; return; }

        const events = [];
        for (const [id, t] of Object.entries(ferrData)) {
            const { numero, nome } = _parseToolIdentity(t);
            if (t.historico) {
                for (const ev of Object.values(t.historico)) {
                    events.push({ ...ev, toolNum: numero, toolNome: nome || t.nome, toolId: id });
                }
            }
            if (t.status === 'alocada' && t.dataEntrega) {
                const days = _calcDias(t.dataEntrega);
                events.push({
                    data: t.dataEntrega,
                    acao: 'alocada_agora',
                    colaborador: t.colaborador,
                    toolNum: numero,
                    toolNome: nome || t.nome,
                    toolId: id,
                    _dias: days
                });
            }
        }
        events.sort((a, b) => new Date(b.data) - new Date(a.data));

        el.innerHTML = '';
        if (events.length === 0) {
            el.innerHTML = '<div class="empty-msg">Sem eventos registados.</div>'; return;
        }

        let lastDate = '';
        events.slice(0, 100).forEach(ev => {
            const d       = new Date(ev.data);
            const dateStr = d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
            if (dateStr !== lastDate) {
                const sep = $el('div', { className: 'tl-date-sep', textContent: dateStr });
                el.appendChild(sep);
                lastDate = dateStr;
            }
            const isOut = ev.acao === 'atribuida' || ev.acao === 'alocada_agora';
            const row   = $el('div', { className: `tl-event ${isOut ? 'tl-out' : 'tl-in'}` });

            const icoEl = $el('span', { className: 'tl-tool-icon' });
            if (ev.toolNum) {
                icoEl.className   = 'tl-tool-num';
                icoEl.textContent = ev.toolNum;
            } else {
                icoEl.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
            }

            const info = $el('div', { className: 'tl-info' });
            const name = $el('span', { className: 'tl-tool-name', textContent: ev.toolNome || '?' });

            const action = $el('span', { className: 'tl-action' });
            if (ev.acao === 'alocada_agora') {
                action.textContent = `Com ${ev.colaborador || '?'} há ${ev._dias}d`;
                if (ev._dias >= _TOOL_ALERT_DAYS) action.className += ' tl-action-overdue';
            } else if (ev.acao === 'atribuida') {
                action.textContent = `→ Entregue a ${ev.colaborador || '?'}`;
            } else {
                action.textContent = `↩ Devolvida${ev.colaborador ? ' por ' + ev.colaborador : ''}`;
            }

            const time = $el('span', { className: 'tl-time', textContent: d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) });

            info.appendChild(name);
            info.appendChild(action);
            row.appendChild(icoEl);
            row.appendChild(info);
            row.appendChild(time);
            el.appendChild(row);
        });
    } catch(e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar timeline.</div>';
    }
}
