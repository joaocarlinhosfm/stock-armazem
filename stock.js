// ─────────────────────────────────────────────────────────────────────────────
// stock.js — Hiperfrio v6.61
// Gestão de stock: render, ordenação, filtros, swipe, changeQtd, exportCSV.
// Carrega DEPOIS de reports.js e ANTES de tools.js, pats.js.
//
// Dependências:
//   utils.js   → $id, $el, fmtQty, escapeHtml, showToast, modalOpen,
//                modalClose, focusModal, _debounce, loadXlsx, UNITS, UNIT_SHORT
//   auth.js    → currentRole, requireManagerAccess, apiFetch, authUrl
//   reports.js → registarMovimento
//   app.js     → cache, fetchCollection, invalidateCache, renderDashboard,
//                openConfirmModal, openDeleteModal, openEditModal, nav
// ─────────────────────────────────────────────────────────────────────────────

// ORDENAÇÃO DO STOCK
let _stockSort = 'recente'; // 'recente' | 'nome' | 'qtd-asc' | 'qtd-desc' | 'local'
let _pendingZeroFilter  = false;
let _bulkCount = 0; // contador de produtos adicionados no lote actual
let _toolsFilter = 'all';
function toolsFilterSet(btn, filter) {
    _toolsFilter = filter;
    document.querySelectorAll('.tools-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    const search = $id('inp-tools-search');
    if (search) search.value = '';
    renderTools();
}
let _zeroFilterActive  = false; // zero-stock filter está activo (persiste entre navegações)

// Menu de ordenação — criado no body para evitar clipping por stacking contexts
function _getSortMenu() {
    let menu = $id('sort-menu');
    if (!menu) {
        menu = $el('div');
        menu.id        = 'sort-menu';
        menu.className = 'sort-menu';
        const options  = [
            { val: 'recente',  label: 'Mais recente' },
            { val: 'nome',     label: 'Nome A→Z'     },
            { val: 'qtd-asc',  label: 'Quantidade ↑' },
            { val: 'qtd-desc', label: 'Quantidade ↓' },
            { val: 'local',    label: 'Localização'  },
        ];
        options.forEach(o => {
            const btn = $el('button');
            btn.className   = 'sort-option' + (o.val === _stockSort ? ' active' : '');
            btn.id          = `sort-${o.val}`;
            btn.textContent = o.label;
            btn.onclick     = () => setStockSort(o.val);
            menu.appendChild(btn);
        });
        document.body.appendChild(menu);
    }
    return menu;
}

function toggleSortMenu() {
    const btn  = $id('sort-dropdown-btn');
    const menu = _getSortMenu();
    const isOpen = menu.classList.contains('open');

    if (isOpen) {
        _closeSortMenu();
        return;
    }

    // Posiciona o menu sob o botão usando coordenadas absolutas
    const rect = btn.getBoundingClientRect();
    menu.style.top   = `${rect.bottom + window.scrollY + 6}px`;
    menu.style.right = `${window.innerWidth - rect.right - window.scrollX}px`;
    menu.style.left  = 'auto';
    menu.classList.add('open');
    btn.classList.add('active');

    // Fecha ao clicar fora (próximo tick para não capturar o click actual)
    setTimeout(() => {
        document.addEventListener('click', _onOutsideSortClick);
    }, 0);
}

function _onOutsideSortClick(e) {
    const wrap = $id('sort-dropdown-wrap');
    const menu = $id('sort-menu');
    if (!wrap?.contains(e.target) && !menu?.contains(e.target)) {
        _closeSortMenu();
    }
}

function _closeSortMenu() {
    $id('sort-menu')?.classList.remove('open');
    $id('sort-dropdown-btn')?.classList.remove('active');
    document.removeEventListener('click', _onOutsideSortClick);
}

// Fecha sort menu em scroll ou resize (posição desactualizada)
window.addEventListener('scroll', () => {
    if ($id('sort-menu')?.classList.contains('open')) _closeSortMenu();
}, { passive: true });
let _sortResizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_sortResizeTimer);
    _sortResizeTimer = setTimeout(() => {
        if ($id('sort-menu')?.classList.contains('open')) _closeSortMenu();
    }, 100);
});

function setStockSort(val) {
    _stockSort = val;
    // Actualiza estado visual das opções
    document.querySelectorAll('.sort-option').forEach(btn => {
        btn.classList.toggle('active', btn.id === `sort-${val}`);
    });
    // Fecha o menu
    _closeSortMenu();
    renderList(window._searchInputEl?.value || '', true);
}

function getSortedEntries(entries) {
    const copy = [...entries];
    switch (_stockSort) {
        case 'nome':     return copy.sort((a,b) => (a[1].nome||'').localeCompare(b[1].nome||'', 'pt'));
        case 'qtd-asc':  return copy.sort((a,b) => (a[1].quantidade||0) - (b[1].quantidade||0));
        case 'qtd-desc': return copy.sort((a,b) => (b[1].quantidade||0) - (a[1].quantidade||0));
        case 'local':    return copy.sort((a,b) => (a[1].localizacao||'').localeCompare(b[1].localizacao||'', 'pt'));
        default:         return copy.reverse(); // mais recente primeiro
    }
}

// Cache do sort — reutiliza o array ordenado enquanto dados + modo não mudam.
// Filtrar enquanto o utilizador escreve deixa de ordenar 500 itens por tecla.
let _sortedCache = null;
let _sortedCacheKey = '';
function _getSortedEntriesCached(entries) {
    const key = `${cache.stock.lastFetch}|${_stockSort}|${entries.length}`;
    if (_sortedCache && _sortedCacheKey === key) return _sortedCache;
    _sortedCache = getSortedEntries(entries);
    _sortedCacheKey = key;
    return _sortedCache;
}
function _invalidateSortedCache() { _sortedCache = null; _sortedCacheKey = ''; }

// STOCK — RENDER
// FIX: usa [...entries].reverse() para não mutar o cache
// FIX: qty-display.is-zero para stock a 0
// FIX: filtragem por show/hide nos cards existentes sem recriar DOM
// Filtra stock para mostrar apenas produtos com quantidade 0
function filterZeroStock() {
    _zeroFilterActive = true;
    // Desktop: usa o sistema de tabs nativo
    if (_stockDesktopActive()) {
        _desktopFilter = 'zero';
        _setDesktopFilter('zero');
        return;
    }
    const listEl = $id('stock-list');
    if (!listEl) return;
    const wrappers = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    wrappers.forEach(wrapper => {
        const id   = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        const isZero = item && (item.quantidade || 0) === 0;
        wrapper.style.display = isZero ? '' : 'none';
    });
    let badge = $id('zero-filter-badge');
    if (!badge) {
        badge = $el('div');
        badge.id        = 'zero-filter-badge';
        badge.className = 'zero-filter-badge';
        const _badgeTxt = $el('span');
        _badgeTxt.textContent = '! A mostrar apenas produtos sem stock';
        const _badgeBtn = $el('button');
        _badgeBtn.textContent = '✕ Limpar';
        _badgeBtn.onclick = clearZeroFilter;
        badge.appendChild(_badgeTxt);
        badge.appendChild(_badgeBtn);
        listEl.parentNode.insertBefore(badge, listEl);
        // Scroll para o topo e foca o badge
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => badge.classList.add('badge-pulse'), 100);
    }
}

const ZONE_HISTORY_KEY = 'hiperfrio-zone-history';
// localStorage pode estar corrompido (quota, extensões) — sempre try/catch.
function _loadZoneHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ZONE_HISTORY_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch(_e) {
        localStorage.removeItem(ZONE_HISTORY_KEY);
        return [];
    }
}
function _saveZoneToHistory(zona) {
    if (!zona) return;
    const hist = _loadZoneHistory();
    const updated = [zona, ...hist.filter(z => z !== zona)].slice(0, 8);
    try { localStorage.setItem(ZONE_HISTORY_KEY, JSON.stringify(updated)); }
    catch(_e) { /* quota cheia — esqueça, não é fatal */ }
    _refreshZoneDatalist();
}
function _refreshZoneDatalist() {
    const dl = $id('zone-datalist');
    if (!dl) return;
    const hist = _loadZoneHistory();
    dl.innerHTML = hist.map(z => `<option value="${escapeHtml(z)}">`).join('');
}

function closeBatch() {
    if (_bulkCount === 0) { nav('view-search'); return; }
    const zona = $id('bulk-loc')?.value?.trim() || '?';
    openConfirmModal({
        icon: '📦',
        title: 'Fechar lote?',
        desc: `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''} na zona "${zona}". Fechar e ir para o stock?`,
        onConfirm: () => {
            // Limpa o formulário completo
            $id('form-bulk')?.reset();
            setUnitSelector('bulk', 'un');
            $id('bulk-notas').value = '';
            _bulkCount = 0; _updateBulkCounter();
            nav('view-search');
        }
    });
}

function _updateBulkCounter() {
    const el = $id('bulk-counter');
    if (!el) return;
    el.textContent = _bulkCount === 0 ? '' : `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''}`;
    el.style.display = _bulkCount > 0 ? 'block' : 'none';
}

function clearSearch() {
    const inp = $id('inp-search');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); }
}

function clearZeroFilter() {
    _zeroFilterActive = false;
    const badge = $id('zero-filter-badge');
    if (badge) badge.remove();
    renderList('', false);
}

function _itemMatchesFilter(item, filterLower, filterUpper) {
    if (!filterLower) return true;
    return (item.nome || '').toLowerCase().includes(filterLower)
        || String(item.codigo || '').toUpperCase().includes(filterUpper)
        || (item.localizacao || '').toLowerCase().includes(filterLower)
        || (item.notas || '').toLowerCase().includes(filterLower);
}

// STOCK — VISTA DESKTOP (>= 768px)
// Layout em grid 3 colunas com cards informativos.
// Mobile mantém o swipe-wrapper inalterado.

let _desktopFilter = 'all'; // 'all' | 'stock' | 'zero' | 'nolocal'

function _stockDesktopActive() {
    return window.innerWidth >= 768;
}

// Reconstrói o header desktop com KPIs e filtros por tab
function _renderDesktopHeader(data) {
    const entries = Object.values(data || {});
    const total   = entries.length;
    const semStock = entries.filter(i => (i.quantidade || 0) === 0).length;
    const comStock = total - semStock;
    const semLocal = entries.filter(i => !i.localizacao).length;

    let hdr = $id('stock-desktop-hdr');
    if (!hdr) {
        hdr = $el('div');
        hdr.id = 'stock-desktop-hdr';
        hdr.className = 'sdh';
        const listEl = $id('stock-list');
        listEl?.parentNode.insertBefore(hdr, listEl);
    }

    hdr.innerHTML = `
        <div class="sdh-top">
            <div class="sdh-meta">
                <h1 class="sdh-title">Catálogo de Produtos</h1>
                <p class="sdh-sub">Gestão de stock em tempo real · ${new Date().toLocaleDateString('pt-PT', {weekday:'long', day:'numeric', month:'long'})}</p>
            </div>
            <div class="sdh-kpis">
                <div class="sdh-kpi">
                    <span class="sdh-kpi-label">Total itens</span>
                    <span class="sdh-kpi-val">${total.toLocaleString('pt-PT')}</span>
                </div>
                <div class="sdh-kpi sdh-kpi-warn">
                    <span class="sdh-kpi-label">Sem stock</span>
                    <span class="sdh-kpi-val ${semStock > 0 ? 'sdh-kpi-red' : 'sdh-kpi-green'}">${semStock}</span>
                </div>
            </div>
        </div>
        <div class="sdh-tabs">
            <button class="sdh-tab ${_desktopFilter==='all'    ? 'sdh-tab-active' : ''}" onclick="_setDesktopFilter('all')">
                Todos os itens <span class="sdh-tab-count">${total}</span>
            </button>
            <button class="sdh-tab ${_desktopFilter==='stock'  ? 'sdh-tab-active' : ''}" onclick="_setDesktopFilter('stock')">
                Em Stock <span class="sdh-tab-count sdh-tab-count-green">${comStock}</span>
            </button>
            <button class="sdh-tab ${_desktopFilter==='zero'   ? 'sdh-tab-active' : ''}" onclick="_setDesktopFilter('zero')">
                Sem Stock <span class="sdh-tab-count sdh-tab-count-red">${semStock}</span>
            </button>
            <button class="sdh-tab ${_desktopFilter==='nolocal'? 'sdh-tab-active' : ''}" onclick="_setDesktopFilter('nolocal')">
                Sem Posição <span class="sdh-tab-count">${semLocal}</span>
            </button>
        </div>`;
}

function _setDesktopFilter(f) {
    _desktopFilter = f;
    // Re-aplica visibilidade nos cards existentes sem re-render completo
    const listEl = $id('stock-list');
    if (!listEl) return;
    const q = window._searchInputEl?.value?.toLowerCase() || '';
    const data = cache.stock.data || {};
    listEl.querySelectorAll('.sdc-wrapper[data-id]').forEach(w => {
        const id   = w.dataset.id;
        const item = data[id];
        if (!item) { w.style.display = 'none'; return; }
        const passFilter = _desktopFilterMatch(item);
        const passSearch = !q || _itemMatchesFilter(item, q, q.toUpperCase());
        w.style.display = (passFilter && passSearch) ? '' : 'none';
    });
    // Actualiza tabs activos
    document.querySelectorAll('.sdh-tab').forEach(t => {
        const f2 = t.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        t.classList.toggle('sdh-tab-active', f2 === _desktopFilter);
    });
}

function _desktopFilterMatch(item) {
    switch (_desktopFilter) {
        case 'stock':   return (item.quantidade || 0) > 0;
        case 'zero':    return (item.quantidade || 0) === 0;
        case 'nolocal': return !item.localizacao;
        default:        return true;
    }
}

// Constrói um card desktop para um item do stock
function _buildDesktopCard(id, item) {
    const qty    = item.quantidade || 0;
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= 5; // alerta para quantidades muito baixas
    const unidade = item.unidade && item.unidade !== 'un' ? item.unidade : 'un';

    const wrapper = $el('div', { className: 'sdc-wrapper' });
    wrapper.dataset.id = id;

    const card = $el('div');
    card.className = 'sdc' + (isZero ? ' sdc-zero' : isLow ? ' sdc-low' : '');

    // ── Header do card ────────────────────────────────────────────────────
    const hdr = $el('div', { className: 'sdc-hdr' });

    // Badge de alerta
    if (isZero) {
        const badge = $el('span', { className: 'sdc-badge sdc-badge-out', textContent: 'SEM STOCK' });
        hdr.appendChild(badge);
    } else if (isLow) {
        const badge = $el('span', { className: 'sdc-badge sdc-badge-low', textContent: 'BAIXO' });
        hdr.appendChild(badge);
    }

    // Ref + Nome
    const meta = $el('div', { className: 'sdc-meta' });

    const ref = $el('div', { className: 'sdc-ref' });
    ref.textContent = 'REF: ' + (item.codigo || '—').toUpperCase();

    const nome = $el('div', { className: 'sdc-nome' });
    nome.textContent = (item.nome || '').toUpperCase();

    meta.appendChild(ref);
    meta.appendChild(nome);

    // Localização dentro do meta — fica colada ao nome
    if (item.localizacao) {
        const loc = $el('div', { className: 'sdc-loc' });
        loc.innerHTML = `<svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/></svg>`;
        loc.appendChild(document.createTextNode(' ' + item.localizacao.toUpperCase()));
        meta.appendChild(loc);
    }

    hdr.appendChild(meta);

    // Thumbnail no canto superior direito (só se tiver imagem)
    if (item.imgUrl) {
        const imgThumb = $el('div', { className: 'sdc-img-thumb' });
        const img = $el('img');
        img.src     = item.imgUrl;
        img.alt     = item.nome || '';
        img.onerror = () => { imgThumb.style.display = 'none'; };
        imgThumb.appendChild(img);
        hdr.appendChild(imgThumb);
    }

    card.appendChild(hdr);

    // ── Notas ─────────────────────────────────────────────────────────────
    if (item.notas) {
        const notas = $el('div', { className: 'sdc-notas' });
        notas.textContent = item.notas;
        card.appendChild(notas);
    }

    // ── Stock actual + controlo de quantidade ─────────────────────────────
    const foot = $el('div', { className: 'sdc-foot' });

    const stockInfo = $el('div', { className: 'sdc-stock-info' });

    const stockLabel = $el('div', { className: 'sdc-stock-label', textContent: 'ESTOQUE ATUAL' });

    const stockVal = $el('div');
    stockVal.className = 'sdc-stock-val' + (isZero ? ' sdc-stock-zero' : '');
    stockVal.innerHTML = `<span class="sdc-qty" id="sdcqty-${id}">${fmtQty(qty, item.unidade)}</span>`;

    stockInfo.appendChild(stockLabel);
    stockInfo.appendChild(stockVal);

    const controls = $el('div', { className: 'sdc-controls' });

    const btnM = $el('button', { className: 'sdc-btn-qty', textContent: '−' });
    btnM.disabled    = qty === 0;
    btnM.id          = `sdcbtnm-${id}`;
    btnM.onclick     = (e) => { e.stopPropagation(); changeQtd(id, -1); _syncDesktopQty(id); };

    const qtyDisplay = $el('span', { className: 'sdc-qty-display' });
    qtyDisplay.id          = `sdcdisp-${id}`;
    qtyDisplay.textContent = qty;

    const btnP = $el('button', { className: 'sdc-btn-qty', textContent: '+' });
    btnP.id          = `sdcbtnp-${id}`;
    btnP.onclick     = (e) => { e.stopPropagation(); changeQtd(id, 1); _syncDesktopQty(id); };

    controls.appendChild(btnM);
    controls.appendChild(qtyDisplay);
    controls.appendChild(btnP);

    foot.appendChild(stockInfo);
    foot.appendChild(controls);
    card.appendChild(foot);

    // ── Acções (editar / apagar) — só para gestores ───────────────────────
    if (currentRole === 'manager') {
        const actions = $el('div', { className: 'sdc-actions' });

        const btnEdit = $el('button', { className: 'sdc-action-btn sdc-action-edit' });
        btnEdit.innerHTML   = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg> Editar';
        btnEdit.onclick     = (e) => { e.stopPropagation(); openEditModal(id, item); };

        const btnDel = $el('button', { className: 'sdc-action-btn sdc-action-del' });
        btnDel.innerHTML    = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg> Apagar';
        btnDel.onclick      = (e) => { e.stopPropagation(); openDeleteModal(id, item); };

        actions.appendChild(btnEdit);
        actions.appendChild(btnDel);
        card.appendChild(actions);
    }

    wrapper.appendChild(card);
    return wrapper;
}

// Sincroniza o display de qty no card desktop após changeQtd
function _syncDesktopQty(id) {
    setTimeout(() => {
        const qty = cache.stock.data?.[id]?.quantidade ?? 0;
        const item = cache.stock.data?.[id];
        const disp = $id(`sdcdisp-${id}`);
        const qtyEl = $id(`sdcqty-${id}`);
        const btnM  = $id(`sdcbtnm-${id}`);
        const wrapper = document.querySelector(`.sdc-wrapper[data-id="${id}"]`);
        const card  = wrapper?.querySelector('.sdc');
        if (disp) disp.textContent = qty;
        if (qtyEl && item) qtyEl.textContent = fmtQty(qty, item.unidade);
        if (btnM)  btnM.disabled = qty === 0;
        if (card) {
            card.classList.toggle('sdc-zero', qty === 0);
            card.classList.toggle('sdc-low',  qty > 0 && qty <= 5);
        }
    }, 700); // após o debounce do changeQtd
}

async function renderList(filter = '', force = false) {
    const listEl = $id('stock-list');
    if (!listEl) return;

    // Liga event delegation uma só vez (noop após primeiro call)
    _ensureStockListDelegation();

    if (!cache.stock.data) listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';

    const data    = await fetchCollection('stock', force);
    const entries = Object.entries(data);

    // ── Vista Desktop — grid de cards ─────────────────────────────────────
    if (_stockDesktopActive()) {
        _renderDesktopHeader(data);
        listEl.className = 'stock-grid';

        // Re-render por filtro/pesquisa sem destruir os cards
        const existingDesktop = listEl.querySelectorAll('.sdc-wrapper[data-id]');
        if (existingDesktop.length > 0 && !force) {
            const q = filter.toLowerCase();
            existingDesktop.forEach(w => {
                const id   = w.dataset.id;
                const item = data[id];
                if (!item) { w.style.display = 'none'; return; }
                const passFilter = _desktopFilterMatch(item);
                const passSearch = !q || _itemMatchesFilter(item, q, filter.toUpperCase());
                w.style.display = (passFilter && passSearch) ? '' : 'none';
            });
            return;
        }

        listEl.innerHTML = '';
        if (entries.length === 0) {
            listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
            return;
        }

        const filterLowerD = filter.toLowerCase();
        const fragD = document.createDocumentFragment();
        _getSortedEntriesCached(entries).forEach(([id, item]) => {
            const passFilter = _desktopFilterMatch(item);
            const passSearch = _itemMatchesFilter(item, filterLowerD, filter.toUpperCase());
            const card = _buildDesktopCard(id, item);
            card.style.display = (passFilter && passSearch) ? '' : 'none';
            fragD.appendChild(card);
        });
        listEl.appendChild(fragD);

        if (_pendingZeroFilter) {
            _pendingZeroFilter = false;
            _desktopFilter = 'zero';
            _setDesktopFilter('zero');
        }
        return;
    }

    // ── Vista Mobile — swipe cards ────────────────────────────────────────
    listEl.className = '';
    $id('stock-desktop-hdr')?.remove();

    // Paginação real: cada mudança de filtro força re-render completo.
    // Como só materializamos PAGE_SIZE cards, o re-render é rápido (~30-60ms
    // para 80 cards); evita manter 500 wrappers no DOM com display:none.

    // Full render
    listEl.innerHTML = '';

    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
        return;
    }

    // Hint contextual — swipe para gestores, leitura para funcionários
    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!filter && !localStorage.getItem(hintKey)) {
        const hint = $el('div', { className: 'swipe-hint' });
        if (currentRole === 'worker') {
            const msg = $el('span');
            msg.textContent = '👁️ Modo consulta — apenas visualização';
            hint.appendChild(msg);
        } else {
            const l = $el('span'); l.textContent = '✏️ Swipe direita para editar';
            const r = $el('span'); r.textContent = '🗑️ Swipe esquerda para apagar';
            hint.appendChild(l); hint.appendChild(r);
        }
        listEl.appendChild(hint);
        localStorage.setItem(hintKey, '1');
    }

    const filterLower = filter.toLowerCase();
    const PAGE_SIZE = 80;

    // Filtra primeiro, materializa DOM depois — paginação real.
    // Entries fora da página não geram DOM, só ficam em _stockDeferredEntries.
    const sorted = _getSortedEntriesCached(entries);
    const matched = [];
    for (const e of sorted) {
        if (_itemMatchesFilter(e[1], filterLower, filter.toUpperCase())) matched.push(e);
    }
    const found = matched.length;

    // Primeiros PAGE_SIZE viram DOM agora, restantes ficam em fila
    const shown = matched.slice(0, PAGE_SIZE);
    _stockDeferredEntries = matched.slice(PAGE_SIZE);

    // DocumentFragment evita N reflows — um único appendChild no fim
    const frag = document.createDocumentFragment();
    for (const [id, item] of shown) {
        frag.appendChild(_buildStockCardMobile(id, item));
    }
    listEl.appendChild(frag);

    // Botão "Mostrar mais" — materializa o próximo batch só quando tocado
    _renderLoadMoreBtn(listEl);

    if (filter && found === 0) {
        const em = $el('div', { className: 'empty-msg', textContent: 'Nenhum resultado encontrado.' });
        listEl.appendChild(em);
    }

    // Aplica filtro zero-stock se estava pendente (vindo do dashboard)
    if (_pendingZeroFilter) {
        _pendingZeroFilter = false;
        filterZeroStock();
    }
}

// Entries que passaram o filtro mas estão além do PAGE_SIZE inicial.
// Materializadas em batches quando o utilizador toca "Mostrar mais".
let _stockDeferredEntries = [];

function _renderLoadMoreBtn(listEl) {
    $id('load-more-btn')?.remove();
    if (_stockDeferredEntries.length === 0) return;
    const PAGE_SIZE = 80;
    const n = _stockDeferredEntries.length;
    const btn = $el('button');
    btn.id = 'load-more-btn';
    btn.className = 'btn-load-more';
    btn.textContent = `Mostrar mais ${n} produto${n > 1 ? 's' : ''}`;
    btn.onclick = () => {
        const batch = _stockDeferredEntries.splice(0, PAGE_SIZE);
        const frag = document.createDocumentFragment();
        for (const [id, item] of batch) {
            frag.appendChild(_buildStockCardMobile(id, item));
        }
        btn.remove();
        listEl.appendChild(frag);
        _renderLoadMoreBtn(listEl); // refaz o botão se ainda há mais
    };
    listEl.appendChild(btn);
}

// Constrói um card de stock para a vista mobile. Listeners tratados por
// delegation no contentor — nada de onclick/addEventListener individuais.
function _buildStockCardMobile(id, item) {
    const wrapper = $el('div', { className: 'swipe-wrapper' });
    wrapper.dataset.id = id;

    // Swipe backgrounds
    const bgL = $el('div'); bgL.className = 'swipe-bg swipe-bg-left';
    const iL  = $el('span'); iL.className = 'swipe-bg-icon'; iL.textContent = '';
    bgL.appendChild(iL);
    const bgR = $el('div'); bgR.className = 'swipe-bg swipe-bg-right';
    const iR  = $el('span'); iR.className = 'swipe-bg-icon'; iR.textContent = '';
    bgR.appendChild(iR);
    wrapper.appendChild(bgL); wrapper.appendChild(bgR);

    const el = $el('div', { className: 'item-card' });

    const refLabel = $el('div', { className: 'ref-label', textContent: 'REFERÊNCIA' });

    const refVal = $el('div', { className: 'ref-value' });
    refVal.textContent = String(item.codigo || '').toUpperCase();

    const nomEl = $el('div', { className: 'card-nome' });
    nomEl.textContent = item.nome || '';

    const hr = $el('hr', { className: 'card-divider' });

    const row = $el('div', { className: 'card-bottom-row' });

    const pill = $el('div', { className: 'loc-pill' });
    const pinIcon = $el('span');
    pinIcon.style.fontSize = '0.85rem';
    pinIcon.textContent = '';
    pill.appendChild(pinIcon);
    pill.appendChild(document.createTextNode(' ' + (item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL')));

    const qtyBox = $el('div', { className: 'qty-pill-box' });

    const qty = item.quantidade || 0;

    const btnM = $el('button', { className: 'btn-qty', textContent: '−' });
    btnM.disabled = qty === 0;
    btnM.id = `btn-minus-${id}`;

    const qtySpan = $el('span');
    qtySpan.className = 'qty-display' + (qty === 0 ? ' is-zero' : '');
    qtySpan.id = `qty-${id}`;
    qtySpan.textContent = fmtQty(qty, item.unidade);

    const btnP = $el('button', { className: 'btn-qty', textContent: '+' });
    btnP.id = `btn-plus-${id}`;

    qtyBox.appendChild(btnM); qtyBox.appendChild(qtySpan); qtyBox.appendChild(btnP);
    row.appendChild(pill); row.appendChild(qtyBox);

    if (item.notas) {
        const notasRow = $el('div', { className: 'card-notas' });
        notasRow.title = item.notas;
        notasRow.textContent = `📝 ${item.notas}`;
        el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
        el.appendChild(notasRow);
    } else {
        el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
    }
    el.appendChild(hr); el.appendChild(row);

    wrapper.appendChild(el);
    return wrapper;
}

// Edição inline de quantidade — abre mini-form no lugar do span
function openInlineQtyEdit(id, item) {
    const qtyEl = $id(`qty-${id}`);
    if (!qtyEl || qtyEl.querySelector('input')) return; // já em edição
    const currentQty = cache.stock.data?.[id]?.quantidade ?? item.quantidade ?? 0; // PONTO 5: lê do cache actualizado
    const wrap = $el('div', { className: 'qty-inline-edit' });
    const inp = $el('input');
    inp.type  = 'number';
    inp.min   = '0';
    inp.step  = 'any';
    inp.value = currentQty;
    inp.className = 'qty-inline-input';
    inp.setAttribute('inputmode', 'decimal');
    const confirmFn = async () => {
        const newVal = parseFloat(inp.value);
        if (isNaN(newVal) || newVal < 0) { cancelFn(); return; }
        const oldValInline = cache.stock.data?.[id]?.quantidade ?? 0;
        wrap.replaceWith(qtyEl);
        qtyEl.textContent = fmtQty(newVal, item.unidade);
        qtyEl.classList.toggle('is-zero', newVal === 0);
        $id(`btn-minus-${id}`)?.toggleAttribute('disabled', newVal === 0);
        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newVal;
        if (_stockSort === 'qtd-asc' || _stockSort === 'qtd-desc') _invalidateSortedCache();
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: newVal }) });
            // Registar movimento só após PATCH OK — senão, falha de rede deixa
            // saída fantasma no relatório. Se PATCH caiu no queue offline
            // (apiFetch devolve null), registamos também porque o movimento
            // vai para a mesma queue e ambos sincronizam juntos.
            if (newVal < oldValInline) {
                registarMovimento('saida_manual', id, item.codigo, item.nome, oldValInline - newVal);
            }
            renderDashboard();
        } catch(_e) {
            // Rollback do cache — PATCH falhou mesmo online
            if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = oldValInline;
            showToast('Erro ao guardar','error');
        }
    };
    const cancelFn = () => { wrap.replaceWith(qtyEl); };
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmFn(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelFn(); }
    });
    inp.addEventListener('blur', () => setTimeout(cancelFn, 150));
    const ok = $el('button', { className: 'qty-inline-ok', textContent: '✓' });
    ok.addEventListener('mousedown', e => { e.preventDefault(); confirmFn(); });
    wrap.appendChild(inp);
    wrap.appendChild(ok);
    qtyEl.replaceWith(wrap);
    inp.focus();
    inp.select();
}

async function forceRefresh() {
    setRefreshSpinning(true);
    await Promise.all([
        renderList($id('inp-search')?.value || '', true),
        renderDashboard()
    ]);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

// Debounce de escrita para changeQtd — agrupa toques rápidos numa só chamada à Firebase
const _qtyTimers = {};
const _qtyPendingBase = {};

async function _readServerStockQty(id, fallbackQty = 0) {
    if (!navigator.onLine) return fallbackQty;
    try {
        const url = await authUrl(`${BASE_URL}/stock/${id}/quantidade.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const qty = await res.json();
        const parsed = typeof qty === 'number' ? qty : parseFloat(qty);
        return Number.isFinite(parsed) ? parsed : fallbackQty;
    } catch (e) {
        console.warn('[Stock] fallback para cache local:', id, e?.message);
        return fallbackQty;
    }
}

async function _commitStockDelta(id, baseQty, finalQty) {
    if (finalQty === undefined) return baseQty;
    if (!navigator.onLine) {
        await apiFetch(`${BASE_URL}/stock/${id}.json`, {
            method: 'PATCH', body: JSON.stringify({ quantidade: finalQty })
        });
        return finalQty;
    }

    const delta = finalQty - baseQty;
    const latestQty = await _readServerStockQty(id, cache.stock.data?.[id]?.quantidade ?? baseQty);
    const mergedQty = Math.max(0, latestQty + delta);
    await apiFetch(`${BASE_URL}/stock/${id}.json`, {
        method: 'PATCH', body: JSON.stringify({ quantidade: mergedQty })
    });
    return mergedQty;
}

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(30);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    if (!Object.prototype.hasOwnProperty.call(_qtyPendingBase, id)) {
        _qtyPendingBase[id] = oldQty;
    }
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return;

    // NOTA: registarMovimento antigamente era chamado aqui, antes do commit.
    // Se o PATCH falhasse, o cache ficava correcto mas o movimento persistia,
    // inflando o relatório. Agora é feito no callback do setTimeout, só após
    // _commitStockDelta resolver com sucesso, usando baseQty→savedQty como total real.

    // Actualiza cache + DOM imediatamente (optimistic)
    stockData[id].quantidade = newQty;
    // Invalida o cache do sort — ordenações qtd-asc/qtd-desc precisam de recalcular
    if (_stockSort === 'qtd-asc' || _stockSort === 'qtd-desc') _invalidateSortedCache();
    const qtyEl   = $id(`qty-${id}`);
    const minusEl = $id(`btn-minus-${id}`);
    const itemUnidade = stockData[id]?.unidade;
    if (qtyEl) {
        qtyEl.textContent = fmtQty(newQty, itemUnidade);
        qtyEl.classList.toggle('is-zero', newQty === 0);
    }
    if (minusEl) minusEl.disabled = newQty === 0;

    // Mostra indicador de "a guardar" após 300ms sem actividade
    if (qtyEl) qtyEl.classList.add('qty-saving');
    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        const baseQty = _qtyPendingBase[id] ?? oldQty;
        try {
            const savedQty = await _commitStockDelta(id, baseQty, finalQty);
            stockData[id].quantidade = savedQty;
            if (qtyEl) {
                qtyEl.textContent = fmtQty(savedQty, stockData[id]?.unidade);
                qtyEl.classList.toggle('is-zero', savedQty === 0);
            }
            if (minusEl) minusEl.disabled = savedQty === 0;
            if (qtyEl) qtyEl.classList.remove('qty-saving');

            // Só agora, com commit confirmado: registar a saída pelo total real
            // (diferença base→saved, não delta clique-a-clique). Se houve múltiplos
            // -/+ no período do debounce, só o saldo líquido conta como saída.
            const movido = baseQty - savedQty;
            if (movido > 0) {
                const _itm = stockData[id];
                registarMovimento('saida_manual', id, _itm?.codigo, _itm?.nome, movido);
            }
        } catch (e) {
            console.warn('changeQtd erro:', e?.message || e);
            if (qtyEl) qtyEl.classList.remove('qty-saving');
            stockData[id].quantidade = baseQty;
            if (qtyEl)   { qtyEl.textContent = fmtQty(baseQty, stockData[id]?.unidade); qtyEl.classList.toggle('is-zero', baseQty === 0); }
            if (minusEl)   minusEl.disabled = baseQty === 0;
            showToast('Erro ao guardar quantidade', 'error');
        }
        delete _qtyTimers[id];
        delete _qtyPendingBase[id];
    }, 600);
}

// SWIPE GESTURES
// FIX: único par de listeners globais — sem acumulação por card
const SWIPE_THRESHOLD = 80;
let _swipeCard    = null;
let _swipeWrapper = null;
let _swipeStartX  = 0;
let _swipeStartY  = 0;
let _swipeCurrentX = 0;
let _swipeDragging = false;
let _swipeMeta    = null; // { id, item }
let _swipeIntent  = null; // 'horizontal' | 'vertical' | null

document.addEventListener('mousemove', e => {
    if (!_swipeDragging) return;
    _onSwipeMove(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => {
    if (!_swipeDragging) return;
    _onSwipeEnd();
});

// ── Event delegation no contentor #stock-list ─────────────────────────────────
// Um único conjunto de listeners no contentor trata de todos os cards,
// em vez de 4+ listeners por card × N cards. Reduz memória e melhora filtros.
// Chamado uma só vez em _ensureStockListDelegation().
let _stockDelegationReady = false;
function _ensureStockListDelegation() {
    if (_stockDelegationReady) return;
    const listEl = $id('stock-list');
    if (!listEl) return; // view ainda não no DOM — tentará de novo no próximo renderList
    _stockDelegationReady = true;

    // Resolve card/wrapper/id/item de um evento sobre um descendente
    function _resolveCtx(target) {
        const wrapper = target.closest('.swipe-wrapper[data-id]');
        if (!wrapper) return null;
        const id = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        if (!item) return null;
        const card = wrapper.querySelector('.item-card');
        return { wrapper, card, id, item };
    }

    // Click nos botões +/− e no qty-display (double-tap abre edição inline).
    // Worker: click em qualquer parte do card que não seja botão abre detalhe.
    const _qtyTapState = new Map(); // id → { timer }
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-qty');
        if (btn) {
            const ctx = _resolveCtx(btn);
            if (!ctx) return;
            const isPlus = btn.id?.startsWith('btn-plus-') || btn.textContent.trim() === '+';
            const isMinus = btn.id?.startsWith('btn-minus-') || btn.textContent.trim() === '−';
            if (isPlus)  changeQtd(ctx.id,  1);
            if (isMinus) changeQtd(ctx.id, -1);
            return;
        }
        const qty = e.target.closest('.qty-display');
        if (qty) {
            const ctx = _resolveCtx(qty);
            if (!ctx) return;
            const state = _qtyTapState.get(ctx.id) || {};
            if (state.timer) {
                clearTimeout(state.timer);
                _qtyTapState.delete(ctx.id);
                openInlineQtyEdit(ctx.id, ctx.item);
            } else {
                state.timer = setTimeout(() => _qtyTapState.delete(ctx.id), 350);
                _qtyTapState.set(ctx.id, state);
            }
            return;
        }
        // Worker: click no card abre popup de detalhe
        if (currentRole === 'worker') {
            const ctx = _resolveCtx(e.target);
            if (ctx) openProductDetail(ctx.id, ctx.item);
        }
    });

    // Swipe: só para gestores. Touchstart começa o drag, mousedown idem.
    // Exclui .btn-qty (cliques no +/-) e .qty-display (double-tap para edição inline)
    // para evitar conflito entre tap/double-tap e abrir detalhe.
    listEl.addEventListener('touchstart', (e) => {
        if (currentRole === 'worker') return;
        if (e.target.closest('.btn-qty, .qty-display')) return;
        const ctx = _resolveCtx(e.target);
        if (!ctx || !ctx.card) return;
        _onSwipeStart(ctx.card, ctx.wrapper, ctx.id, ctx.item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchmove', (e) => {
        if (!_swipeDragging) return;
        if (e.target.closest('.btn-qty, .qty-display')) return;
        _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchend', (e) => {
        if (!_swipeDragging) return;
        if (e.target.closest('.btn-qty, .qty-display')) return;
        _onSwipeEnd();
    }, { passive: true });

    listEl.addEventListener('mousedown', (e) => {
        if (currentRole === 'worker') return;
        if (e.target.closest('.btn-qty, .qty-display')) return;
        const ctx = _resolveCtx(e.target);
        if (!ctx || !ctx.card) return;
        _onSwipeStart(ctx.card, ctx.wrapper, ctx.id, ctx.item, e.clientX, e.clientY);
        e.preventDefault();
    });
}

// Função no-op para manter compatibilidade com call-sites antigos (openProductDetail tap-no-swipe).
// O comportamento real de swipe+tap+click já é tratado por _ensureStockListDelegation().
function attachSwipe(_card, _wrapper, _id, _item) { /* noop — substituído por delegation */ }

function _onSwipeStart(card, wrapper, id, item, x, y = 0) {
    _swipeCard     = card;
    _swipeWrapper  = wrapper;
    _swipeMeta     = { id, item };
    _swipeStartX   = x;
    _swipeStartY   = y;
    _swipeCurrentX = 0;
    _swipeDragging  = true;
    _swipeIntent   = null;
    // Don't add is-swiping yet — wait to know direction
}

function _onSwipeMove(x, y = 0) {
    if (!_swipeDragging || !_swipeCard) return;
    const dx = x - _swipeStartX;
    const dy = y - _swipeStartY;

    // Determine intent on first meaningful movement
    if (_swipeIntent === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        _swipeIntent = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (_swipeIntent === 'horizontal') _swipeCard.classList.add('is-swiping');
    }

    // Only track horizontal swipes
    if (_swipeIntent !== 'horizontal') return;

    _swipeCurrentX = dx;
    const clamped  = Math.max(-140, Math.min(140, dx));
    _swipeCard.style.transform = `translateX(${clamped}px)`;
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (clamped < -20)     _swipeWrapper.classList.add('swiping-left');
    else if (clamped > 20) _swipeWrapper.classList.add('swiping-right');
}

function _onSwipeEnd() {
    if (!_swipeDragging || !_swipeCard) return;
    _swipeDragging = false;
    _swipeCard.classList.remove('is-swiping');
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (_swipeIntent === 'horizontal') {
        snapBack(_swipeCard);
        if      (_swipeCurrentX < -SWIPE_THRESHOLD) openDeleteModal(_swipeMeta.id, _swipeMeta.item);
        else if (_swipeCurrentX >  SWIPE_THRESHOLD) openEditModal(_swipeMeta.id, _swipeMeta.item);
    } else if (_swipeIntent === null) {
        // Tap puro (sem swipe) — abre popup de detalhe
        openProductDetail(_swipeMeta.id, _swipeMeta.item);
    }
    _swipeCard = _swipeWrapper = _swipeMeta = null;
    _swipeIntent = null;
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once:true });
}

// ── Popup de detalhe do produto (mobile tap) ──────────────────────────────
function openProductDetail(id, item) {
    const data = cache.stock.data?.[id] || item; // usa dados mais recentes se disponível

    // Imagem
    const imgWrap = $id('pdm-img-wrap');
    const img     = $id('pdm-img');
    if (data.imgUrl) {
        img.src = data.imgUrl;
        img.alt = data.nome || '';
        imgWrap.style.display = '';
    } else {
        imgWrap.style.display = 'none';
    }

    // Ref + nome
    $id('pdm-ref').textContent  = 'REF: ' + (data.codigo || '—').toUpperCase();
    $id('pdm-nome').textContent = (data.nome || '').toUpperCase();

    // Localização
    const locWrap = $id('pdm-loc-wrap');
    if (data.localizacao) {
        $id('pdm-loc').textContent = data.localizacao.toUpperCase();
        locWrap.style.display = '';
    } else {
        locWrap.style.display = 'none';
    }

    // Quantidade
    const qty = data.quantidade ?? 0;
    const qtyEl = $id('pdm-qty');
    qtyEl.textContent = fmtQty(qty, data.unidade);
    qtyEl.className   = 'pdm-value pdm-qty' + (qty === 0 ? ' pdm-qty-zero' : '');

    // Notas
    const notasWrap = $id('pdm-notas-wrap');
    if (data.notas) {
        $id('pdm-notas').textContent = data.notas;
        notasWrap.style.display = '';
    } else {
        notasWrap.style.display = 'none';
    }

    // Acções — só gestores
    const actions = $id('pdm-actions');
    if (currentRole === 'manager') {
        actions.style.display = '';
        $id('pdm-btn-edit').onclick = () => {
            modalClose('product-detail-modal');
            openEditModal(id, data);
        };
        $id('pdm-btn-del').onclick = () => {
            modalClose('product-detail-modal');
            openDeleteModal(id, data);
        };
    } else {
        actions.style.display = 'none';
    }

    modalOpen('product-detail-modal');
    focusModal('product-detail-modal');
}

// EXPORTAR CSV
async function exportCSV() {
    const btn = $id('export-csv-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    const data = await fetchCollection('stock', false);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para exportar','error');
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
        return;
    }
    const headers = ['Referência','Nome','Localização','Quantidade','Unidade'];
    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_tmp_')));
    const rows = Object.values(cleanData).map(item => [
        `"${(item.codigo||'').toUpperCase()}"`,
        `"${(item.nome||'').replace(/"/g,'""')}"`,
        `"${(item.localizacao||'').toUpperCase()}"`,
        item.quantidade ?? 0,
        item.unidade || 'un'
    ]);
    const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    Object.assign($el('a'), {
        href: url,
        download: `hiperfrio-stock-${new Date().toISOString().slice(0,10)}.csv`
    }).click();
    URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
    showToast(`${Object.keys(cleanData).length} produtos exportados!`);
}


// INICIALIZAÇÃO
// DETECÇÃO DE CÓDIGO DUPLICADO
function checkDuplicateCodigo(codigo, onConfirm) {
    if (!codigo || codigo.toUpperCase() === 'SEMREF') {
        onConfirm(); return; // SEMREF é sempre permitido em duplicado
    }
    const stock = cache.stock.data || {};
    const dupes = Object.values(stock).filter(
        item => (item.codigo || '').toUpperCase() === codigo.toUpperCase()
    );
    if (dupes.length === 0) {
        onConfirm(); return;
    }
    // Existe duplicado — mostra modal de confirmação
    const names = dupes.map(d => d.nome || '(sem nome)').join(', ');
    $id('dup-modal-desc').textContent =
        `O código "${codigo.toUpperCase()}" já existe em: ${names}. Queres registar mesmo assim?`;
    $id('dup-confirm-btn').onclick = () => { modalClose('dup-modal'); onConfirm(); };
    modalOpen('dup-modal');
    focusModal('dup-modal');
}

