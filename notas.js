// ─────────────────────────────────────────────────────────────────────────────
// notas.js — Gestão Armazém v6.90
// Widget de Notas Rápidas em tempo real no Dashboard (/notas_rapidas).
// Sincroniza via Firebase Realtime Database (`db.ref('notas_rapidas').on('value')`)
// com a PWA mobile de apontamentos rápidos e permite criar, filtrar, concluir,
// reabrir e eliminar notas directamente a partir do Dashboard.
//
// Estrutura Firebase (/notas_rapidas/{id}):
//   { texto, categoria: 'geral'|'material'|'urgente', concluida, origem, criadoEm }
//
// Dependências:
//   utils.js  → $id, escapeHtml, showToast
//   auth.js   → currentRole, requireManagerAccess
//   tools.js  → openConfirmModal
//   index.html → window.db (firebase.database())
// ─────────────────────────────────────────────────────────────────────────────

const _NOTAS_NODE = 'notas_rapidas';

const _NOTAS_CATS = {
    urgente:  { label: 'Urgente',  cls: 'urgente',  rank: 0 },
    material: { label: 'Material', cls: 'material', rank: 1 },
    geral:    { label: 'Geral',    cls: 'geral',    rank: 2 },
};

let _notasData         = {};
let _notasLoaded       = false;
let _notasError        = null;
let _notasStatusFilter = 'pendentes'; // 'pendentes' | 'todas' | 'concluidas'
let _notasCatFilter    = 'todas';     // 'todas' | 'urgente' | 'material' | 'geral'
let _notasRef          = null;
let _notasCb           = null;
let _notasErrCb        = null;

const _NOTAS_ICO_CHECK  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const _NOTAS_ICO_TRASH  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const _NOTAS_ICO_PHONE  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
const _NOTAS_ICO_PC     = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const _NOTAS_ICO_PLUS   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const _NOTAS_ICO_EMPTY  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

function _getNotasDb() {
    if (window.db) return window.db;
    if (typeof firebase !== 'undefined' && typeof firebase.database === 'function') {
        try {
            window.db = firebase.database();
            return window.db;
        } catch (e) {
            console.warn('[Notas] falha ao obter firebase.database():', e?.message);
        }
    }
    return null;
}

// Inicia a escuta em tempo real no nó /notas_rapidas (idempotente)
function startNotasListener() {
    if (_notasRef) return;
    const database = _getNotasDb();
    if (!database) return;

    _notasRef = database.ref(_NOTAS_NODE);
    _notasCb = snap => {
        _notasData   = snap.val() || {};
        _notasLoaded = true;
        _notasError  = null;
        _updateNotasCardInPlace();
    };
    _notasErrCb = err => {
        console.warn('[Notas] erro de escuta RTDB:', err?.message || err);
        _notasLoaded = true;
        _notasError  = err?.message || 'Erro de ligação às notas';
        _updateNotasCardInPlace();
    };
    _notasRef.on('value', _notasCb, _notasErrCb);
}

// Desliga a escuta em tempo real (chamado em switchRole)
function stopNotasListener() {
    if (_notasRef && _notasCb) {
        try { _notasRef.off('value', _notasCb); } catch (_) {}
    }
    _notasRef    = null;
    _notasCb     = null;
    _notasErrCb  = null;
    _notasData   = {};
    _notasLoaded = false;
    _notasError  = null;
}

function _normNotaCat(cat) {
    const k = String(cat || 'geral').toLowerCase().trim();
    return _NOTAS_CATS[k] ? k : 'geral';
}

function _fmtNotaData(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return 'Agora';
    const d   = new Date(n);
    const now = new Date();
    const hh  = String(d.getHours()).padStart(2, '0');
    const mm  = String(d.getMinutes()).padStart(2, '0');
    const hora = `${hh}:${mm}`;

    const dDay   = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diffD  = Math.round((nowDay - dDay) / 86_400_000);

    if (diffD === 0) return `Hoje, ${hora}`;
    if (diffD === 1) return `Ontem, ${hora}`;
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) return `${dd}/${mo}, ${hora}`;
    return `${dd}/${mo}/${d.getFullYear()}, ${hora}`;
}

function _getNotasEntries() {
    return Object.entries(_notasData || {})
        .filter(([, v]) => v && typeof v === 'object' && typeof v.texto === 'string')
        .map(([id, v]) => ({
            id,
            texto:     v.texto.trim(),
            categoria: _normNotaCat(v.categoria),
            concluida: !!v.concluida,
            origem:    String(v.origem || 'dashboard'),
            criadoEm:  Number(v.criadoEm) || 0,
        }));
}

function _computeNotasStats(list) {
    let pendentes = 0, concluidas = 0, urgentes = 0;
    const byCat = { urgente: 0, material: 0, geral: 0 };

    for (const n of list) {
        if (n.concluida) {
            concluidas++;
        } else {
            pendentes++;
            if (n.categoria === 'urgente') urgentes++;
        }
        const matchStatus =
            _notasStatusFilter === 'todas' ||
            (_notasStatusFilter === 'pendentes'  && !n.concluida) ||
            (_notasStatusFilter === 'concluidas' &&  n.concluida);
        if (matchStatus && byCat[n.categoria] !== undefined) {
            byCat[n.categoria]++;
        }
    }
    return { total: list.length, pendentes, concluidas, urgentes, byCat };
}

function _filterAndSortNotas(list) {
    const filtered = list.filter(n => {
        if (_notasStatusFilter === 'pendentes'  &&  n.concluida) return false;
        if (_notasStatusFilter === 'concluidas' && !n.concluida) return false;
        if (_notasCatFilter !== 'todas' && n.categoria !== _notasCatFilter) return false;
        return true;
    });

    // Ordenação: pendentes primeiro → urgentes em destaque no topo → mais recentes primeiro
    return filtered.sort((a, b) => {
        if (a.concluida !== b.concluida) return a.concluida ? 1 : -1;
        if (!a.concluida) {
            const aUrg = a.categoria === 'urgente' ? 0 : 1;
            const bUrg = b.categoria === 'urgente' ? 0 : 1;
            if (aUrg !== bUrg) return aUrg - bUrg;
        }
        return b.criadoEm - a.criadoEm;
    });
}

function _notasPillHtml(stats) {
    if (!_notasLoaded) return '<span class="dv4-pill dv4-pill-info" id="dv4-notas-pill">…</span>';
    if (stats.pendentes === 0) return '<span class="dv4-pill dv4-pill-ok" id="dv4-notas-pill">0 pendentes</span>';
    const cls = stats.urgentes > 0 ? 'dv4-pill-bad' : 'dv4-pill-info';
    const txt = stats.pendentes === 1 ? '1 pendente' : `${stats.pendentes} pendentes`;
    return `<span class="dv4-pill ${cls}" id="dv4-notas-pill">${txt}</span>`;
}

function _notasFiltersHtml(stats) {
    const stTabs = [
        { key: 'pendentes',  label: 'Pendentes',  cnt: stats.pendentes },
        { key: 'todas',      label: 'Todas',      cnt: stats.total },
        { key: 'concluidas', label: 'Concluídas', cnt: stats.concluidas },
    ].map(t => `<button type="button" class="dv4-tab${_notasStatusFilter === t.key ? ' active' : ''}" data-dv-act="notas-status" data-dv-id="${t.key}">${t.label}<span class="dv4-nt-cnt">${t.cnt}</span></button>`).join('');

    const catPills = [
        { key: 'todas',    label: 'Todas',    cnt: null },
        { key: 'urgente',  label: 'Urgente',  cnt: stats.byCat.urgente },
        { key: 'material', label: 'Material', cnt: stats.byCat.material },
        { key: 'geral',    label: 'Geral',    cnt: stats.byCat.geral },
    ].map(c => {
        const active = _notasCatFilter === c.key ? ' active' : '';
        const cntHtml = c.cnt !== null ? ` <span class="dv4-ncat-cnt">${c.cnt}</span>` : '';
        return `<button type="button" class="dv4-ncat dv4-ncat-${c.key}${active}" data-dv-act="notas-cat" data-dv-id="${c.key}">${c.label}${cntHtml}</button>`;
    }).join('');

    return `<div class="dv4-tabs dv4-notas-stabs">${stTabs}</div>
            <div class="dv4-notas-cats">${catPills}</div>`;
}

function _notasListHtml(list) {
    if (!_notasLoaded) {
        return '<div class="dv4-notas-empty">A sincronizar notas em tempo real…</div>';
    }
    if (_notasError) {
        return `<div class="dv4-notas-empty">Sem ligação em tempo real (${escapeHtml(_notasError)}).</div>`;
    }

    const visible = _filterAndSortNotas(list);
    if (!visible.length) {
        const msg = _notasStatusFilter === 'pendentes'
            ? (_notasCatFilter === 'todas' ? 'Sem notas pendentes — tudo despachado.' : 'Sem notas pendentes nesta categoria.')
            : _notasStatusFilter === 'concluidas'
                ? 'Nenhuma nota concluída.'
                : 'Ainda sem notas rápidas registadas.';
        return `<div class="dv4-empty">${_NOTAS_ICO_EMPTY}<span>${msg}</span></div>`;
    }

    const isManager = currentRole === 'manager';

    return visible.map(n => {
        const catMeta  = _NOTAS_CATS[n.categoria] || _NOTAS_CATS.geral;
        const isMobile = n.origem === 'mobile-pwa';
        const origHtml = isMobile
            ? `<span class="dv4-nota-orig" title="Enviada pela PWA mobile">${_NOTAS_ICO_PHONE} Telemóvel</span>`
            : `<span class="dv4-nota-orig" title="Criada no Dashboard">${_NOTAS_ICO_PC} Dashboard</span>`;
        const rowCls = `dv4-nota-row dv4-nota-cat-${catMeta.cls}${n.concluida ? ' is-done' : ''}`;
        const safeId = escapeHtml(n.id);

        return `<div class="${rowCls}">
            <button type="button" class="dv4-nota-chk${n.concluida ? ' checked' : ''}"
                data-dv-act="notas-toggle" data-dv-id="${safeId}"
                title="${n.concluida ? 'Reabrir nota' : 'Marcar como concluída'}"
                aria-label="${n.concluida ? 'Reabrir nota' : 'Marcar como concluída'}"
                ${isManager ? '' : 'disabled'}>${n.concluida ? _NOTAS_ICO_CHECK : ''}</button>
            <div class="dv4-nota-body">
                <div class="dv4-nota-text">${escapeHtml(n.texto)}</div>
                <div class="dv4-nota-meta">
                    <span class="dv4-nota-badge dv4-nb-${catMeta.cls}">${catMeta.label}</span>
                    ${origHtml}
                    <span class="dv4-nota-time">${escapeHtml(_fmtNotaData(n.criadoEm))}</span>
                </div>
            </div>
            ${isManager ? `<button type="button" class="dv4-nota-del" data-dv-act="notas-del" data-dv-id="${safeId}" title="Apagar nota" aria-label="Apagar nota">${_NOTAS_ICO_TRASH}</button>` : ''}
        </div>`;
    }).join('');
}

// Chamado por _dvDraw() em dashboard.js para renderizar o cartão completo
function _dvNotasCard() {
    // Garante que o listener está activo se o utilizador já está autenticado
    if (!_notasRef && window._firebaseReady) startNotasListener();

    const list      = _getNotasEntries();
    const stats     = _computeNotasStats(list);
    const isManager = currentRole === 'manager';

    const clearBtn = isManager
        ? `<button type="button" class="dv4-link dv4-notas-clear" id="dv4-notas-clear" data-dv-act="notas-clear" style="${stats.concluidas > 0 ? '' : 'display:none'}">Limpar concluídas</button>`
        : '';

    const formHtml = isManager ? `
        <form class="dv4-notas-form" id="dv4-notas-form" onsubmit="notasSubmit(event)" autocomplete="off">
            <input type="text" id="dv4-notas-inp" class="dv4-notas-inp" placeholder="Adicionar nota rápida ou material…" maxlength="300" aria-label="Nova nota rápida">
            <select id="dv4-notas-cat" class="dv4-notas-sel" aria-label="Categoria da nota">
                <option value="geral">Geral</option>
                <option value="material">Material</option>
                <option value="urgente">Urgente</option>
            </select>
            <button type="submit" id="dv4-notas-add" class="dv4-notas-add" title="Adicionar nota" aria-label="Adicionar nota">${_NOTAS_ICO_PLUS}</button>
        </form>` : '';

    return `<section class="dv4-card dv4-notas-card" id="dv4-notas-card">
        <div class="dv4-card-hd">
            <h3 class="dv4-card-title">Notas Rápidas</h3>
            ${_notasPillHtml(stats)}
            ${clearBtn}
        </div>
        ${formHtml}
        <div id="dv4-notas-filters">${_notasFiltersHtml(stats)}</div>
        <div class="dv4-notas-list" id="dv4-notas-list">${_notasListHtml(list)}</div>
    </section>`;
}

// Re-render cirúrgico (actualiza apenas contador, filtros e lista sem mexer no input)
function _updateNotasCardInPlace() {
    const card = $id('dv4-notas-card');
    if (!card) return;

    const list  = _getNotasEntries();
    const stats = _computeNotasStats(list);

    const oldPill = $id('dv4-notas-pill');
    if (oldPill) oldPill.outerHTML = _notasPillHtml(stats);

    const clearBtn = $id('dv4-notas-clear');
    if (clearBtn) {
        clearBtn.style.display = (stats.concluidas > 0 && currentRole === 'manager') ? '' : 'none';
    }

    const filtersEl = $id('dv4-notas-filters');
    if (filtersEl) filtersEl.innerHTML = _notasFiltersHtml(stats);

    const listEl = $id('dv4-notas-list');
    if (listEl) listEl.innerHTML = _notasListHtml(list);
}

// ── Acções CRUD (Firebase Realtime Database) ────────────────────────────────

async function notasSubmit(e) {
    if (e) e.preventDefault();
    if (!requireManagerAccess()) return;

    const inp = $id('dv4-notas-inp');
    const sel = $id('dv4-notas-cat');
    const btn = $id('dv4-notas-add');
    const texto = (inp?.value || '').trim();
    if (!texto) {
        inp?.focus();
        return;
    }

    const categoria = _normNotaCat(sel?.value);
    const database  = _getNotasDb();
    if (!database) {
        showToast('Base de dados ainda não inicializada', 'error');
        return;
    }

    if (btn) btn.disabled = true;
    try {
        await database.ref(_NOTAS_NODE).push({
            texto,
            categoria,
            concluida: false,
            origem:    'dashboard',
            criadoEm:  firebase.database.ServerValue.TIMESTAMP,
        });
        if (inp) { inp.value = ''; inp.focus(); }
        // Se estava em "Concluídas", muda para "Pendentes" para ver a nota criada
        if (_notasStatusFilter === 'concluidas') {
            _notasStatusFilter = 'pendentes';
            _updateNotasCardInPlace();
        }
    } catch (err) {
        console.warn('[Notas] erro ao criar:', err?.message || err);
        showToast('Erro ao gravar nota', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function notasToggle(id) {
    if (!requireManagerAccess()) return;
    if (!id || !_notasData?.[id]) return;
    const database = _getNotasDb();
    if (!database) return;

    const next = !_notasData[id].concluida;
    try {
        await database.ref(`${_NOTAS_NODE}/${id}`).update({ concluida: next });
    } catch (err) {
        console.warn('[Notas] erro ao actualizar estado:', err?.message || err);
        showToast('Erro ao actualizar nota', 'error');
    }
}

async function notasDelete(id) {
    if (!requireManagerAccess()) return;
    if (!id) return;
    const database = _getNotasDb();
    if (!database) return;

    try {
        await database.ref(`${_NOTAS_NODE}/${id}`).remove();
        showToast('Nota apagada');
    } catch (err) {
        console.warn('[Notas] erro ao apagar:', err?.message || err);
        showToast('Erro ao apagar nota', 'error');
    }
}

function notasClearDone() {
    if (!requireManagerAccess()) return;
    const doneIds = _getNotasEntries().filter(n => n.concluida).map(n => n.id);
    if (!doneIds.length) return;

    openConfirmModal({
        title: `Limpar ${doneIds.length} nota${doneIds.length > 1 ? 's' : ''} concluída${doneIds.length > 1 ? 's' : ''}?`,
        desc:  'As notas concluídas serão removidas permanentemente da base de dados.',
        type:  'danger',
        okLabel: 'Limpar',
        onConfirm: async () => {
            const database = _getNotasDb();
            if (!database) return;
            const updates = {};
            doneIds.forEach(id => { updates[id] = null; });
            try {
                await database.ref(_NOTAS_NODE).update(updates);
                showToast(`${doneIds.length} nota${doneIds.length > 1 ? 's' : ''} removida${doneIds.length > 1 ? 's' : ''}`);
            } catch (err) {
                console.warn('[Notas] erro ao limpar concluídas:', err?.message || err);
                showToast('Erro ao limpar notas concluídas', 'error');
            }
        }
    });
}

function notasSetStatus(status) {
    if (!['pendentes', 'todas', 'concluidas'].includes(status)) return;
    _notasStatusFilter = status;
    _updateNotasCardInPlace();
}

function notasSetCat(cat) {
    if (!['todas', 'urgente', 'material', 'geral'].includes(cat)) return;
    _notasCatFilter = cat;
    _updateNotasCardInPlace();
}

// Dispatcher de acções delegadas a partir de dashboard.js (_dvAction)
function notasHandleAction(act, id) {
    switch (act) {
        case 'notas-status': notasSetStatus(id); return true;
        case 'notas-cat':    notasSetCat(id);    return true;
        case 'notas-toggle': notasToggle(id);    return true;
        case 'notas-del':    notasDelete(id);    return true;
        case 'notas-clear':  notasClearDone();   return true;
        default: return false;
    }
}
