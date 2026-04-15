// ─────────────────────────────────────────────────────────────────────────────
// tools.js — Hiperfrio v6.55
// Ferramentas, histórico, funcionários, timeline.
// Carrega DEPOIS de reports.js e ANTES de pats.js.
//
// Dependências:
//   utils.js  → $id, $el, escapeHtml, showToast, modalOpen, modalClose,
//               focusModal, _calcDias, _debounce, loadXlsx
//   auth.js   → requireManagerAccess, apiFetch, authUrl
//   app.js    → cache, fetchCollection, invalidateCache,
//               renderDashboard, openConfirmModal, nav
// ─────────────────────────────────────────────────────────────────────────────

async function renderTools() {
    const list = $id('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');

    const TOOL_ALERT_DAYS = 7;

    // Stat chips
    if (data) {
        const entries = Object.values(data);
        const total   = entries.length;
        const disp    = entries.filter(t => t.status === 'disponivel').length;
        const aloc    = entries.filter(t => t.status === 'alocada').length;
        const over    = entries.filter(t => t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS).length;
        const sub = $id('tools-header-sub');
        if (sub) sub.textContent = `${total} ferramenta${total !== 1 ? 's' : ''} · ${aloc} alocada${aloc !== 1 ? 's' : ''}`;
        const el = (id, v) => { const e = $id(id); if(e) e.textContent = v; };
        el('ts-total', total); el('ts-disp', disp); el('ts-aloc', aloc); el('ts-over', over);
        // Esconder stat de atraso se zero
        const overStat = document.querySelector('.ts-red');
        if (overStat) overStat.style.display = over > 0 ? '' : 'none';
    }

    // Filtros activos
    document.querySelectorAll('.tools-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === (_toolsFilter || 'all'));
    });

    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div><div class="empty-state-title">Sem ferramentas</div><div class="empty-state-sub">Adiciona ferramentas em Administração.</div></div>`;
        return;
    }

    const filterLower = typeof _toolsFilter === 'string' && _toolsFilter !== 'all' && !['disponivel','alocada'].includes(_toolsFilter)
        ? _toolsFilter.toLowerCase() : '';
    const statusFilter = ['disponivel','alocada'].includes(_toolsFilter) ? _toolsFilter : null;

    // Separar em grupos: overdue → alocadas → disponíveis
    const all = [...Object.entries(data)].reverse();
    const overdueList  = all.filter(([,t]) => t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS);
    const alocList     = all.filter(([,t]) => t.status === 'alocada' && !(t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS));
    const dispList     = all.filter(([,t]) => t.status !== 'alocada');

    const TOOL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
    const RETURN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>`;
    const CHEVRON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>`;

    function _makeCard(id, t) {
        if (filterLower && !t.nome?.toLowerCase().includes(filterLower)) return null;
        if (statusFilter && t.status !== statusFilter) return null;

        const isAv = t.status === 'disponivel';
        const isOverdue = !isAv && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS;

        const div = $el('div');
        div.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}${isOverdue ? ' tool-overdue' : ''}`;

        // Long press → histórico
        div.addEventListener('contextmenu', e => { e.preventDefault(); openHistoryModal(id, t.nome); });
        div.addEventListener('touchstart', () => {
            _toolLongPressTimer = setTimeout(() => openHistoryModal(id, t.nome), 600);
        }, { passive: true });
        div.addEventListener('touchend',  () => clearTimeout(_toolLongPressTimer), { passive: true });
        div.addEventListener('touchmove', () => clearTimeout(_toolLongPressTimer), { passive: true });

        // Ícone
        const icon = $el('div', { className: 'tool-icon' });
        icon.innerHTML = TOOL_ICON;

        // Info
        const info = $el('div', { className: 'tool-info' });

        const nome = $el('div', { className: 'tool-nome' });
        nome.textContent = t.nome;

        const sub = $el('div', { className: 'tool-sub' });

        if (isAv) {
            const dot = $el('span', { className: 'tool-status-dot' });
            dot.style.background = '#16a34a';
            const lbl = $el('span', { className: 'tool-status-label', textContent: 'Em armazém' });
            sub.appendChild(dot);
            sub.appendChild(lbl);
        } else {
            const days = t.dataEntrega ? _calcDias(t.dataEntrega) : null;
            const colabBadge = $el('span');
            colabBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-colab'}`;
            colabBadge.textContent = (t.colaborador || '').toUpperCase();
            sub.appendChild(colabBadge);
            if (days !== null) {
                const daysBadge = $el('span');
                daysBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-days'}`;
                daysBadge.textContent = days === 0 ? 'hoje' : days === 1 ? '1d fora' : `${days}d fora`;
                sub.appendChild(daysBadge);
            }
            if (isOverdue) {
                const ovd = $el('span', { className: 'tool-badge tool-badge-overdue', textContent: 'verificar' });
                sub.appendChild(ovd);
            }
        }

        info.appendChild(nome);
        info.appendChild(sub);
        div.appendChild(icon);
        div.appendChild(info);

        if (isAv) {
            // Clicar no card → alocar
            div.onclick = () => openModal(id);
            const arrow = $el('span', { className: 'tool-arrow' });
            arrow.innerHTML = CHEVRON;
            div.appendChild(arrow);
        } else {
            // Clicar no card → histórico; botão explícito → devolver
            div.onclick = () => openHistoryModal(id, t.nome);
            const retBtn = $el('button', { className: 'tool-return-btn' });
            retBtn.innerHTML = RETURN_ICON;
            retBtn.title = 'Devolver';
            retBtn.onclick = e => {
                e.stopPropagation();
                openConfirmModal({
                    title: 'Confirmar devolução?',
                    desc: `"${escapeHtml(t.nome)}" será marcada como disponível.`,
                    type: 'confirm', okLabel: 'Devolver',
                    onConfirm: () => returnTool(id)
                });
            };
            div.appendChild(retBtn);
        }

        return div;
    }

    function _addSection(label, items) {
        let added = 0;
        const frag = document.createDocumentFragment();
        items.forEach(([id, t]) => {
            const card = _makeCard(id, t);
            if (card) { frag.appendChild(card); added++; }
        });
        if (added > 0) {
            const lbl = $el('div', { className: 'tools-section-label' });
            lbl.textContent = label;
            list.appendChild(lbl);
            list.appendChild(frag);
        }
        return added;
    }

    let total = 0;
    total += _addSection('Em atraso', overdueList);
    total += _addSection('Alocadas', alocList);
    total += _addSection('Disponíveis', dispList);

    if (total === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta encontrada.</div>';
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
    Object.entries(data).forEach(([id, t]) => {
        const row = $el('div', { className: 'admin-list-row admin-tool-row' });

        // Nome da ferramenta
        const lbl = $el('span', { className: 'admin-list-label' });
        lbl.textContent = t.nome;

        // Barra de acções alinhada à esquerda
        const actions = $el('div', { className: 'admin-tool-actions' });

        const editBtn = $el('button', { className: 'admin-tool-btn admin-tool-btn-edit' });
        editBtn.innerHTML   = '✏️ <span>Editar</span>';
        editBtn.onclick     = () => openEditToolModal(id, t);

        const histBtn = $el('button', { className: 'admin-tool-btn admin-tool-btn-hist' });
        histBtn.innerHTML   = '≡ <span>Histórico</span>';
        histBtn.onclick     = () => openHistoryModal(id, t.nome);

        const delBtn = $el('button', { className: 'admin-tool-btn admin-tool-btn-del' });
        delBtn.innerHTML   = '🗑️ <span>Eliminar</span>';
        delBtn.onclick     = () => openConfirmModal({
            title: 'Apagar ferramenta?',
            desc: `"${escapeHtml(t.nome)}" será removida permanentemente.`,
            type: 'danger',
            onConfirm: () => deleteTool(id)
        });

        actions.appendChild(editBtn);
        actions.appendChild(histBtn);
        actions.appendChild(delBtn);
        row.appendChild(lbl);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

// HISTÓRICO DAS FERRAMENTAS
const HISTORY_MAX = 50; // máximo de registos por ferramenta

async function addToolHistoryEvent(toolId, acao, colaborador) {
    const event = { acao, colaborador: colaborador || '', data: new Date().toISOString() };
    try {
        // Adiciona novo evento
        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico.json`, {
            method: 'POST', body: JSON.stringify(event)
        });
        // Verifica se excede o limite usando o cache de ferramentas (evita fetch extra)
        const histCache = cache.ferramentas.data?.[toolId]?.historico;
        const histCount = histCache ? Object.keys(histCache).length : 0;
        if (histCount >= HISTORY_MAX) {
            // Faz fetch apenas quando necessário para obter os IDs ordenados
            try {
                const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
                const res  = await fetch(url);
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
    $id('history-modal-tool-name').textContent = `🪛 ${toolName}`;
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

        // Converte objeto Firebase em array e ordena do mais recente para o mais antigo
        const events = Object.values(data).sort((a, b) => new Date(b.data) - new Date(a.data));

        events.forEach(ev => {
            const row  = $el('div');
            row.className = `history-row ${ev.acao === 'atribuida' ? 'history-out' : 'history-in'}`;
            const icon = ev.acao === 'atribuida' ? '→' : '↩';
            const label = ev.acao === 'atribuida'
                ? `Entregue a ${ev.colaborador || '?'}`
                : `Devolvida${ev.colaborador ? ` por ${ev.colaborador}` : ''}`;
            const date  = formatDate(ev.data);
            const iconEl = $el('span', { className: 'history-icon' });
            iconEl.textContent = icon;
            const info = $el('div', { className: 'history-info' });
            const lbl = $el('span', { className: 'history-label' });
            lbl.textContent = label;
            const dt = $el('span', { className: 'history-date' });
            dt.textContent = date;
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
        ...cache.ferramentas.data[id], status:'alocada', colaborador:worker, dataEntrega
    };
    modalClose('worker-modal'); renderTools(); renderDashboard(); showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'alocada',colaborador:worker,dataEntrega})
        });
        await addToolHistoryEvent(id, 'atribuida', worker);
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar.','error'); }
}

async function returnTool(id) {
    const colaborador = cache.ferramentas.data[id]?.colaborador || '';
    const dataEntregaOrig = cache.ferramentas.data[id]?.dataEntrega || '';
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'disponivel', colaborador:'', dataEntrega:''
    };
    renderTools(); renderDashboard(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'disponivel',colaborador:'',dataEntrega:''})
        });
        // Regista histórico com colaborador preservado mesmo offline
        await addToolHistoryEvent(id, 'devolvida', colaborador);
    } catch (e) {
        console.warn('returnTool erro:', e?.message || e);
        // Reverte estado local
        cache.ferramentas.data[id] = {
            ...cache.ferramentas.data[id], status:'alocada', colaborador, dataEntrega: dataEntregaOrig
        };
        invalidateCache('ferramentas'); showToast('Erro ao guardar.','error');
    }
}

function openEditToolModal(id, tool) {
    $id('edit-tool-id').value   = id;
    $id('edit-tool-name').value = tool.nome || '';
    modalOpen('edit-tool-modal');
    focusModal('edit-tool-modal');
}

async function saveEditTool() {
    if (!requireManagerAccess()) return;
    const id   = $id('edit-tool-id').value;
    const nome = $id('edit-tool-name').value.trim().toUpperCase();
    if (!nome) { showToast('Nome obrigatório', 'error'); return; }
    if (cache.ferramentas.data?.[id]) {
        cache.ferramentas.data[id] = { ...cache.ferramentas.data[id], nome };
    }
    modalClose('edit-tool-modal');
    renderAdminTools();
    renderTools();
    renderDashboard();
    showToast('Ferramenta actualizada!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body: JSON.stringify({ nome })
        });
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar','error'); }
}

async function deleteTool(id) {
    if (!requireManagerAccess()) return;
    const tool = cache.ferramentas.data?.[id];
    const _doDelete = async () => {
        delete cache.ferramentas.data[id]; renderAdminTools(); renderTools(); renderDashboard();
        try {
            await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method:'DELETE' });
            showToast('Ferramenta apagada');
        } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao apagar.','error'); }
    };
    if (tool?.status === 'alocada') {
        openConfirmModal({
            title: 'Ferramenta alocada!',
            desc: `"${escapeHtml(tool.nome)}" está com ${escapeHtml(tool.colaborador || '?')}. Apagar irá forçar a devolução sem registo. Confirmas?`,
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
    const workers = data ? Object.entries(data).map(([id,v]) => ({id, nome:v.nome})) : [];
    const list    = $id('workers-list');
    if (!list) return;

    // Badge de contagem no card header
    const badge = $id('workers-count-badge');
    if (badge) badge.textContent = workers.length ? `${workers.length} registados` : '';

    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionário adicionado.</div>'; return;
    }
    workers.forEach(w => {
        const row = $el('div', { className: 'admin-list-row' });

        const avatar = $el('div', { className: 'admin-list-avatar' });
        const initials = w.nome.trim().split(/\s+/).map(p => p[0]).slice(0,2).join('').toUpperCase();
        avatar.textContent = initials || '?';

        const lbl = $el('span', { className: 'admin-list-label' });
        lbl.textContent = w.nome;
        const btn = $el('button', { className: 'admin-list-delete' });
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
        btn.onclick = () => openConfirmModal({
            title: 'Apagar funcionário?',
            desc: `"${escapeHtml(w.nome)}" será removido permanentemente.`,
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
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method:'DELETE' });
    } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao apagar.','error'); }
}

// MODAL — entregar ferramenta
let toolToAllocate = null;
let _toolLongPressTimer = null;

async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid,v]) => ({id:wid,nome:v.nome})) : [];
    if (workers.length === 0) return showToast('Adicione funcionários na Administração','error');
    toolToAllocate = id;

    // Mostra o nome e ícone da ferramenta no modal
    const toolData = cache.ferramentas.data?.[id];
    const toolName = toolData?.nome || '';
    const toolIcon = toolData?.icone || '';
    const toolDesc = $id('worker-modal-tool-name');
    if (toolDesc) toolDesc.textContent = toolName ? `${toolIcon} ${toolName}` : '';
    // Actualiza também o ícone grande no topo do modal
    const modalIcon = $id('worker-modal-icon');
    if (modalIcon) modalIcon.textContent = toolIcon;

    const sel = $id('worker-select-list');
    sel.innerHTML = '';
    // Ordenar por nome
    workers.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
    workers.forEach(w => {
        const opt = $el('div', { className: 'worker-option' });
        opt.textContent = w.nome;
        opt.onclick     = () => assignTool(w.nome);
        sel.appendChild(opt);
    });
    modalOpen('worker-modal');
    focusModal('worker-modal');
}

// MODAL — confirmação genérica
let confirmCallback = null;

// SVGs para cada tipo de confirmação
const _CONFIRM_ICONS = {
    danger:  { svg: '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>', color: '#dc2626' },
    success: { svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', color: '#16a34a' },
    confirm: { svg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>', color: '#2563eb' },
    warn:    { svg: '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" style="color:#ca8a04"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>', color: '#ca8a04' },
};

function openConfirmModal({ title, desc, onConfirm, type = 'danger', okLabel = null }) {
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

    // Limpar slot (inventário, etc.)
    const slot = $id('confirm-modal-slot');
    if (slot) slot.innerHTML = '';

    modalOpen('confirm-modal');
    focusModal('confirm-modal');
}
function closeConfirmModal() {
    confirmCallback = null;
    const slot = $id('confirm-modal-slot');
    if (slot) slot.innerHTML = '';
    modalClose('confirm-modal');
}

// MODAL — apagar produto (swipe left)
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    openConfirmModal({
        title: 'Apagar produto?',
        desc: `"${String(item.codigo||'').toUpperCase()} — ${item.nome}" será removido permanentemente.`,
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
    // Campos de gás — só populados se unidade for kg
    const editGasMax   = $id('edit-gas-max');
    const editGasAlert = $id('edit-gas-alerta');
    if (editGasMax)   editGasMax.value   = item.gasMax    != null ? item.gasMax    : '';
    if (editGasAlert) editGasAlert.value = item.gasAlerta != null ? item.gasAlerta : '';
    _loadImgEdit(item.imgUrl || '');
    modalOpen('edit-modal');
    focusModal('edit-modal');
}

// ADMIN TABS
async function exportToolHistoryCSV() {
    const btn = $id('export-hist-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    try {
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData || Object.keys(ferrData).length === 0) {
            showToast('Sem ferramentas para exportar', 'error');
            return;
        }
        const headers = ['Ferramenta','Ícone','Ação','Colaborador','Data'];
        const rows = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (!t.historico) continue;
            for (const ev of Object.values(t.historico)) {
                rows.push([
                    `"${(t.nome||'').replace(/"/g,'""')}"`,
                    `"${t.icone || ''}"`,
                    `"${ev.acao || ''}"`,
                    `"${(ev.colaborador||'').replace(/"/g,'""')}"`,
                    `"${ev.data ? new Date(ev.data).toLocaleString('pt-PT') : ''}"`
                ]);
            }
        }
        if (rows.length === 0) {
            showToast('Sem histórico para exportar', 'error');
            return;
        }
        rows.sort((a, b) => a[4] < b[4] ? 1 : -1); // mais recente primeiro
        const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
        const blob = new Blob(['﻿'+csv], { type:'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        Object.assign($el('a'), {
            href: url,
            download: `hiperfrio-historico-ferramentas-${new Date().toISOString().slice(0,10)}.csv`
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

        // Recolhe todos os eventos de histórico
        const events = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (t.historico) {
                for (const ev of Object.values(t.historico)) {
                    events.push({ ...ev, toolNome: t.nome, toolIcone: t.icone || '', toolId: id });
                }
            }
            // Adiciona estado actual se alocada
            if (t.status === 'alocada' && t.dataEntrega) {
                const days = _calcDias(t.dataEntrega);
                events.push({
                    data: t.dataEntrega,
                    acao: 'alocada_agora',
                    colaborador: t.colaborador,
                    toolNome: t.nome,
                    toolIcone: t.icone || '',
                    toolId: id,
                    _dias: days
                });
            }
        }
        // Ordena do mais recente
        events.sort((a,b) => new Date(b.data) - new Date(a.data));

        el.innerHTML = '';
        if (events.length === 0) {
            el.innerHTML = '<div class="empty-msg">Sem eventos registados.</div>'; return;
        }

        let lastDate = '';
        events.slice(0, 100).forEach(ev => { // max 100 eventos
            const d     = new Date(ev.data);
            const dateStr = d.toLocaleDateString('pt-PT', { day:'numeric', month:'short', year:'numeric' });
            if (dateStr !== lastDate) {
                const sep = $el('div', { className: 'tl-date-sep' });
                sep.textContent = dateStr;
                el.appendChild(sep);
                lastDate = dateStr;
            }
            const row  = $el('div');
            const isOut = ev.acao === 'atribuida' || ev.acao === 'alocada_agora';
            row.className = `tl-event ${isOut ? 'tl-out' : 'tl-in'}`;

            const icoEl = $el('span', { className: 'tl-tool-icon' });
            icoEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

            const info = $el('div', { className: 'tl-info' });

            const name = $el('span', { className: 'tl-tool-name' });
            name.textContent = ev.toolNome || '?';

            const action = $el('span', { className: 'tl-action' });
            if (ev.acao === 'alocada_agora') {
                action.textContent = `🔴 Com ${ev.colaborador || '?'} há ${ev._dias}d`;
                action.className += ' tl-action-overdue';
            } else if (ev.acao === 'atribuida') {
                action.textContent = `→ Entregue a ${ev.colaborador || '?'}`;
            } else {
                action.textContent = `↩ Devolvida${ev.colaborador ? ' por ' + ev.colaborador : ''}`;
            }

            const time = $el('span', { className: 'tl-time' });
            time.textContent = d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });

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

