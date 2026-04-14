// ─────────────────────────────────────────────────────────────────────────────
// utils.js — Hiperfrio v6.55
// Fase 1 da modularização: utilitários puros sem dependências externas.
// Carrega ANTES de auth.js e app.js.
//
// Contém:
//   • Constantes SVG
//   • Helpers DOM ($id, $el, modalOpen, modalClose, focusModal)
//   • Recuperação de IndexedDB corrompido
//   • _calcDias, _debounce, _fetchWithTimeout
//   • Lazy loading de XLSX
//   • escapeHtml, showToast, formatDate, fmtQty
//   • toggleMenu, avatar dropdown
//   • UNITS, UNIT_SHORT, selectUnit, setUnitSelector, toggleUnitMenu
// ─────────────────────────────────────────────────────────────────────────────

// ── SVG CONSTANTS — definidos uma vez, reutilizados em toda a app ─────────────
const SVG_EDIT   = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>';
const SVG_DEL    = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
const SVG_CHECK  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_ARROW  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
const SVG_INFO   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
const SVG_USER   = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
const SVG_CAL    = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
const SVG_MAP    = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
const SVG_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_SPIN   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="animation:dash-spin .7s linear infinite"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

// ── DOM HELPERS ───────────────────────────────────────────────────────────────

/** Atalho para document.getElementById */
const $id = id => document.getElementById(id);

/** Cria um elemento e aplica propriedades de uma só vez.
 *  Exemplo: $el('div', { className: 'card', textContent: 'Olá' }) */
function $el(tag, props = {}) {
    const el = document.createElement(tag);
    Object.assign(el, props);
    return el;
}

/** Abre um modal: adiciona 'active' e foca o primeiro elemento focável */
function modalOpen(id) {
    $id(id)?.classList.add('active');
    focusModal(id);
}

/** Fecha um modal: remove 'active' */
function modalClose(id) {
    $id(id)?.classList.remove('active');
}

/** Foca o primeiro elemento interactivo dentro de um modal */
function focusModal(id) {
    const modal = $id(id);
    if (!modal) return;
    const focusable = modal.querySelector('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

// ── Recuperação automática de IndexedDB corrompido ────────────────────────────
(function _guardIDB() {
    const _origOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function(name, version) {
        const req = _origOpen(name, version);
        req.addEventListener('error', function(e) {
            if (e.target?.error?.name === 'UnknownError') {
                console.warn('[IDB] corrupção detectada, a limpar e recarregar...');
                Promise.all([
                    'caches' in window ? caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))) : Promise.resolve(),
                    'serviceWorker' in navigator ? navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister()))) : Promise.resolve(),
                    indexedDB.databases ? indexedDB.databases().then(dbs => Promise.all(dbs.map(db => indexedDB.deleteDatabase(db.name)))) : Promise.resolve(),
                ]).then(() => window.location.reload(true));
            }
        });
        return req;
    };
})();

// ── _calcDias — dias de calendário entre dois pontos ─────────────────────────
// tsEnd opcional — se omitido usa hoje. Conta 1 dia a partir das 00:00.
function _calcDias(tsOrStr, tsEnd) {
    if (!tsOrStr) return 0;
    let origem;
    if (typeof tsOrStr === 'string') {
        if (tsOrStr.includes('T') || tsOrStr.includes(' ')) {
            const dt = new Date(tsOrStr);
            origem = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
        } else {
            const [y, m, d] = tsOrStr.split('-').map(Number);
            origem = new Date(y, m - 1, d);
        }
    } else {
        const dt = new Date(tsOrStr);
        origem = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    }
    if (isNaN(origem.getTime())) return 0;
    const fim = tsEnd ? new Date(tsEnd) : new Date();
    const fimZero = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate());
    return Math.max(0, Math.round((fimZero - origem) / 86400000));
}

// ── _debounce — função utilitária centralizada ────────────────────────────────
function _debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ── _fetchWithTimeout — evita botões bloqueados se a API não responder ─────────
function _fetchWithTimeout(url, opts, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// ── Lazy loading de XLSX (~1 MB) — só carrega quando necessário ───────────────
function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = $el('script');
        s.src = src; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}
let _xlsxLoading = null;
async function loadXlsx() {
    if (typeof XLSX !== 'undefined') return;
    if (!_xlsxLoading) _xlsxLoading = _loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    await _xlsxLoading;
}

// ── XSS — escapar sempre dados do utilizador ──────────────────────────────────
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Toast de feedback ─────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
    const container = $id('toast-container');
    const t = $el('div', { className: 'toast' });
    if (type === 'error') t.style.borderLeftColor = 'var(--danger)';
    const icon = $el('span');
    icon.textContent = type === 'success' ? '✅' : '✗';
    const text = $el('span');
    text.textContent = msg;
    t.appendChild(icon);
    t.appendChild(text);
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ── Formatar data ISO para pt-PT ──────────────────────────────────────────────
function formatDate(iso) {
    if (!iso) return 'Data desconhecida';
    const d = new Date(iso), pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Indicador de refresh ──────────────────────────────────────────────────────
function setRefreshSpinning(s) { $id('btn-refresh')?.classList.toggle('spinning', s); }

// ── Menu lateral ──────────────────────────────────────────────────────────────
function toggleMenu() {
    $id('side-menu').classList.toggle('open');
    $id('menu-overlay')?.classList.toggle('active');
}

// ── Avatar dropdown (header) ──────────────────────────────────────────────────
function toggleAvatarMenu() {
    const dd = $id('avatar-dropdown');
    if (!dd) return;
    const isOpen = dd.classList.contains('open');
    isOpen ? closeAvatarMenu() : dd.classList.add('open');
}
function closeAvatarMenu() {
    $id('avatar-dropdown')?.classList.remove('open');
}
// Fecha ao clicar fora
document.addEventListener('click', function(e) {
    const wrap = $id('header-avatar-wrap');
    if (wrap && !wrap.contains(e.target)) closeAvatarMenu();
});

// ── Unidades de medida ────────────────────────────────────────────────────────
// Fonte única de verdade — adicionar aqui para afectar toda a app
const UNITS = [
    { value: 'un', label: 'Unidade',      short: 'Unidade' },
    { value: 'kg', label: 'Quilos (kg)',  short: 'kg'      },
    { value: 'L',  label: 'Litros (L)',   short: 'Litros'  },
    { value: 'm',  label: 'Metros (m)',   short: 'm'       },
    { value: 'm2', label: 'Metros² (m²)', short: 'm²'      },
];
const UNIT_SHORT    = Object.fromEntries(UNITS.map(u => [u.value, u.short]));
const UNIT_PREFIXES = ['inp', 'bulk', 'edit'];

/** Formata quantidade — só mostra unidade se não for "un" */
function fmtQty(quantidade, unidade) {
    const qty = quantidade ?? 0;
    if (!unidade || unidade === 'un') return String(qty);
    return `${qty} ${UNIT_SHORT[unidade] || unidade}`;
}

// Fecha todos os menus de unidade abertos
function _closeAllUnitMenus() {
    UNIT_PREFIXES.forEach(p => {
        $id(`${p}-unit-menu`)?.classList.remove('open');
        $id(`${p}-unit-btn`)?.classList.remove('active');
    });
}

// Listener nomeado para poder ser removido com segurança
function _onOutsideUnitClick(e) {
    const isInsideAny = UNIT_PREFIXES.some(p =>
        $id(`${p}-unit-wrap`)?.contains(e.target)
    );
    if (!isInsideAny) {
        _closeAllUnitMenus();
        document.removeEventListener('click', _onOutsideUnitClick);
    }
}

function toggleUnitMenu(prefix) {
    const menu   = $id(`${prefix}-unit-menu`);
    const btn    = $id(`${prefix}-unit-btn`);
    const isOpen = menu.classList.contains('open');
    _closeAllUnitMenus();
    document.removeEventListener('click', _onOutsideUnitClick);
    if (!isOpen) {
        menu.classList.add('open');
        btn.classList.add('active');
        setTimeout(() => document.addEventListener('click', _onOutsideUnitClick), 0);
    }
}

function selectUnit(prefix, unit) {
    $id(`${prefix}-unidade`).value = unit;
    const label = $id(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[unit] || unit;
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === unit);
    });
    const gasFields = $id(`${prefix}-gas-fields`);
    if (gasFields) gasFields.style.display = unit === 'kg' ? '' : 'none';
    $id(`${prefix}-unit-menu`)?.classList.remove('open');
    $id(`${prefix}-unit-btn`)?.classList.remove('active');
}

function setUnitSelector(prefix, unit) {
    const val = unit || 'un';
    $id(`${prefix}-unidade`).value = val;
    const label = $id(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[val] || val;
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === val);
    });
    const gasFields = $id(`${prefix}-gas-fields`);
    if (gasFields) gasFields.style.display = val === 'kg' ? '' : 'none';
}
