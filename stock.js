// ─────────────────────────────────────────────────────────────────────────────
// stock.js — Gestão Armazém v6.86
// Gestão de stock: render mobile/desktop, filtros rápidos, pesquisa sem acentos
// e multi-palavra, ordenação, swipe com ícones, atualização atómica de stock,
// edição inline (mobile + desktop) e exportação CSV.
// Carrega DEPOIS de reports.js e ANTES de tools.js, pats.js.
//
// Dependências:
//   utils.js   → BASE_URL, $id, $el, fmtQty, escapeHtml, showToast, modalOpen,
//                modalClose, focusModal, openImageViewer, setRefreshSpinning,
//                SVG_EDIT, SVG_DEL
//   auth.js    → currentRole, requireManagerAccess, authUrl
//   reports.js → registarMovimento
//   app.js     → cache, fetchCollection, invalidateCache, apiFetch,
//                renderDashboard, openConfirmModal, openDeleteModal,
//                openEditModal, nav
// ─────────────────────────────────────────────────────────────────────────────

// ORDENAÇÃO E FILTROS DO STOCK
let _stockSort         = 'recente'; // 'recente' | 'nome' | 'ref' | 'qtd-asc' | 'qtd-desc' | 'local'
let _stockFilter       = 'all';     // 'all' | 'stock' | 'zero' | 'nolocal'
let _desktopFilter     = 'all';     // alias mantido sincronizado com _stockFilter
let _zeroFilterActive  = false;     // alias mantido sincronizado com _stockFilter === 'zero'
let _pendingZeroFilter = false;     // activado pelo Dashboard antes de nav('view-search')
let _bulkCount         = 0;         // contador de produtos adicionados no lote actual

const _STOCK_LOW_THRESHOLD = 5;

const _STK_PIN_SVG = '<svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/></svg>';
const _STK_SWIPE_EDIT_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const _STK_SWIPE_DEL_SVG  = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

// Normaliza texto para pesquisa sem acentos e case-insensitive
function _normStockText(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function _syncSortSelect() {
    const sel = $id('sort-select');
    if (sel && sel.value !== _stockSort) sel.value = _stockSort;
}

function setStockSort(val) {
    _stockSort = val;
    _syncSortSelect();
    renderList(window._searchInputEl?.value || '', false);
}

function setStockFilter(filter) {
    _stockFilter      = filter || 'all';
    _desktopFilter    = _stockFilter;
    _zeroFilterActive = _stockFilter === 'zero';
    renderList(window._searchInputEl?.value || '', false);
}

function filterZeroStock() {
    setStockFilter('zero');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearZeroFilter() {
    setStockFilter('all');
}

function getSortedEntries(entries) {
    const copy = [...entries];
    switch (_stockSort) {
        case 'nome':     return copy.sort((a, b) => (a[1].nome || '').localeCompare(b[1].nome || '', 'pt', { numeric: true }));
        case 'ref':      return copy.sort((a, b) => {
            const ra = String(a[1].codigo || '').trim(), rb = String(b[1].codigo || '').trim();
            if (!ra && !rb) return 0;
            if (!ra) return 1;
            if (!rb) return -1;
            return ra.localeCompare(rb, 'pt', { numeric: true, sensitivity: 'base' });
        });
        case 'qtd-asc':  return copy.sort((a, b) => (a[1].quantidade || 0) - (b[1].quantidade || 0));
        case 'qtd-desc': return copy.sort((a, b) => (b[1].quantidade || 0) - (a[1].quantidade || 0));
        case 'local':    return copy.sort((a, b) => (a[1].localizacao || '').localeCompare(b[1].localizacao || '', 'pt'));
        default:         return copy.reverse(); // mais recente primeiro
    }
}

// Cache do sort — reutiliza o array ordenado enquanto dados + modo não mudam.
let _sortedCache    = null;
let _sortedCacheKey = '';
function _getSortedEntriesCached(entries) {
    const key = `${cache.stock.lastFetch}|${_stockSort}|${entries.length}`;
    if (_sortedCache && _sortedCacheKey === key) return _sortedCache;
    _sortedCache    = getSortedEntries(entries);
    _sortedCacheKey = key;
    return _sortedCache;
}
function _invalidateSortedCache() { _sortedCache = null; _sortedCacheKey = ''; }

// ── Histórico de zonas para o Lote ──────────────────────────────────────────
const ZONE_HISTORY_KEY = 'hiperfrio-zone-history';
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
    catch(_e) {}
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

// ── Filtragem (texto sem acentos/multi-palavra + estado) ────────────────────
function _itemMatchesQuery(item, tokens) {
    if (!tokens.length) return true;
    const hay = _normStockText(
        `${item.codigo || ''} ${item.nome || ''} ${item.localizacao || ''} ${item.notas || ''}`
    );
    return tokens.every(tok => hay.includes(tok));
}

function _itemMatchesStatus(item, filter = _stockFilter) {
    const qty = Number(item.quantidade) || 0;
    switch (filter) {
        case 'stock':   return qty > 0;
        case 'zero':    return qty === 0;
        case 'nolocal': return !(item.localizacao || '').trim();
        default:        return true;
    }
}

function _stockDesktopActive() {
    return window.innerWidth >= 768;
}

// Actualiza os contadores das pills de filtro e os KPIs desktop em tempo real
function _updateStockFilterCounts(data) {
    const items   = Object.values(data || {});
    const total   = items.length;
    const zero    = items.filter(i => (Number(i.quantidade) || 0) === 0).length;
    const inStock = total - zero;
    const noLocal = items.filter(i => !(i.localizacao || '').trim()).length;

    const setTxt = (id, v) => { const e = $id(id); if (e) e.textContent = v; };
    setTxt('sf-n-all',     total);
    setTxt('sf-n-stock',   inStock);
    setTxt('sf-n-zero',    zero);
    setTxt('sf-n-nolocal', noLocal);

    // Esconde "Sem local" se for 0 (excepto se o filtro estiver activo)
    const noLocBtn = $id('sf-btn-nolocal');
    if (noLocBtn) noLocBtn.style.display = (noLocal > 0 || _stockFilter === 'nolocal') ? '' : 'none';

    const zeroBtn = $id('sf-btn-zero');
    if (zeroBtn) zeroBtn.classList.toggle('has-zero', zero > 0);

    document.querySelectorAll('.stock-filter-btn[data-filter]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === _stockFilter);
    });

    // Sincronizar KPIs desktop se estiverem no DOM
    const kpiTotal = $id('sdh-kpi-total');
    if (kpiTotal) kpiTotal.textContent = total.toLocaleString('pt-PT');
    const kpiZero = $id('sdh-kpi-zero');
    if (kpiZero) {
        kpiZero.textContent = zero;
        kpiZero.className   = 'sdh-kpi-val ' + (zero > 0 ? 'sdh-kpi-red' : 'sdh-kpi-green');
    }
    $id('sdh-kpi-btn-all')?.classList.toggle('active', _stockFilter === 'all');
    $id('sdh-kpi-btn-zero')?.classList.toggle('active', _stockFilter === 'zero');
}

// ── Header Desktop ──────────────────────────────────────────────────────────
function _renderDesktopHeader(data) {
    const items    = Object.values(data || {});
    const total    = items.length;
    const semStock = items.filter(i => (Number(i.quantidade) || 0) === 0).length;

    let hdr = $id('stock-desktop-hdr');
    if (!hdr) {
        hdr = $el('div', { className: 'sdh' });
        hdr.id = 'stock-desktop-hdr';
        const viewSearch = $id('view-search');
        const firstChild = viewSearch?.firstElementChild;
        if (viewSearch && firstChild) viewSearch.insertBefore(hdr, firstChild);
    }

    hdr.innerHTML = `
        <div class="sdh-top">
            <div class="sdh-meta">
                <h1 class="sdh-title">Catálogo de Produtos</h1>
                <p class="sdh-sub">Gestão de stock em tempo real · ${new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            </div>
            <div class="sdh-kpis">
                <button type="button" id="sdh-kpi-btn-all" class="sdh-kpi${_stockFilter === 'all' ? ' active' : ''}" onclick="setStockFilter('all')">
                    <span class="sdh-kpi-label">Total artigos</span>
                    <span class="sdh-kpi-val" id="sdh-kpi-total">${total.toLocaleString('pt-PT')}</span>
                </button>
                <button type="button" id="sdh-kpi-btn-zero" class="sdh-kpi sdh-kpi-warn${_stockFilter === 'zero' ? ' active' : ''}" onclick="setStockFilter(_stockFilter === 'zero' ? 'all' : 'zero')">
                    <span class="sdh-kpi-label">Sem stock</span>
                    <span class="sdh-kpi-val ${semStock > 0 ? 'sdh-kpi-red' : 'sdh-kpi-green'}" id="sdh-kpi-zero">${semStock}</span>
                </button>
            </div>
        </div>`;
}

// ── Card Desktop ────────────────────────────────────────────────────────────
function _buildDesktopCard(id, item) {
    const qty    = Number(item.quantidade) || 0;
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= _STOCK_LOW_THRESHOLD;

    const wrapper = $el('div', { className: 'sdc-wrapper' });
    wrapper.dataset.id = id;

    const card = $el('div', {
        className: 'sdc' + (isZero ? ' sdc-zero' : isLow ? ' sdc-low' : '')
    });

    // ── Header ────────────────────────────────────────────────────────────
    const hdr  = $el('div', { className: 'sdc-hdr' });
    const meta = $el('div', { className: 'sdc-meta' });

    const refRow = $el('div', { className: 'sdc-ref-row' });
    const ref    = $el('span', { className: 'sdc-ref', textContent: (item.codigo || '—').toUpperCase() });
    refRow.appendChild(ref);

    const badge = $el('span', {
        className: 'sdc-badge ' + (isZero ? 'sdc-badge-out' : isLow ? 'sdc-badge-low' : 'hidden'),
        textContent: isZero ? 'SEM STOCK' : isLow ? 'BAIXO' : ''
    });
    badge.id = `sdcbadge-${id}`;
    refRow.appendChild(badge);
    meta.appendChild(refRow);

    const nome = $el('div', { className: 'sdc-nome', textContent: (item.nome || '').toUpperCase() });
    meta.appendChild(nome);

    if (item.localizacao) {
        const loc = $el('div', { className: 'sdc-loc' });
        loc.innerHTML = _STK_PIN_SVG;
        loc.appendChild(document.createTextNode(' ' + item.localizacao.toUpperCase()));
        meta.appendChild(loc);
    }

    hdr.appendChild(meta);

    if (item.imgUrl) {
        const imgThumb = $el('div', { className: 'sdc-img-thumb' });
        const img = $el('img');
        img.src     = item.imgUrl;
        img.alt     = item.nome || '';
        img.loading = 'lazy';
        img.onerror = () => { imgThumb.style.display = 'none'; };
        imgThumb.appendChild(img);
        imgThumb.setAttribute('role', 'button');
        imgThumb.tabIndex = 0;
        imgThumb.title    = 'Ver imagem maior';
        const _openImg = e => { e.stopPropagation(); openImageViewer(item.imgUrl, item.nome, item.codigo); };
        imgThumb.addEventListener('click', _openImg);
        imgThumb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openImg(e); } });
        hdr.appendChild(imgThumb);
    }

    card.appendChild(hdr);

    if (item.notas) {
        const notas = $el('div', { className: 'sdc-notas', textContent: item.notas });
        notas.title = item.notas;
        card.appendChild(notas);
    }

    // ── Rodapé: stock actual + controlo − qty + ───────────────────────────
    const foot = $el('div', { className: 'sdc-foot' });

    const stockInfo  = $el('div', { className: 'sdc-stock-info' });
    const stockLabel = $el('div', { className: 'sdc-stock-label', textContent: 'STOCK ATUAL' });
    const stockVal   = $el('div', { className: 'sdc-stock-val' + (isZero ? ' sdc-stock-zero' : '') });
    stockVal.id      = `sdcval-${id}`;
    stockVal.innerHTML = `<span class="sdc-qty" id="sdcqty-${id}">${escapeHtml(fmtQty(qty, item.unidade))}</span>`;

    stockInfo.appendChild(stockLabel);
    stockInfo.appendChild(stockVal);

    const controls = $el('div', { className: 'sdc-controls' });

    const btnM = $el('button', { type: 'button', className: 'sdc-btn-qty', textContent: '−' });
    btnM.disabled = qty === 0;
    btnM.id       = `sdcbtnm-${id}`;
    btnM.onclick  = e => { e.stopPropagation(); changeQtd(id, -1); };

    const qtyDisplay = $el('span', { className: 'sdc-qty-display', textContent: String(qty) });
    qtyDisplay.id = `sdcdisp-${id}`;
    if (currentRole === 'manager') {
        qtyDisplay.title = 'Clique para editar quantidade';
        qtyDisplay.classList.add('editable');
        qtyDisplay.onclick = e => {
            e.stopPropagation();
            const liveItem = cache.stock.data?.[id] || item;
            openInlineQtyEdit(id, liveItem, 'desktop');
        };
    }

    const btnP = $el('button', { type: 'button', className: 'sdc-btn-qty', textContent: '+' });
    btnP.id      = `sdcbtnp-${id}`;
    btnP.onclick = e => { e.stopPropagation(); changeQtd(id, 1); };

    controls.appendChild(btnM);
    controls.appendChild(qtyDisplay);
    controls.appendChild(btnP);

    foot.appendChild(stockInfo);
    foot.appendChild(controls);
    card.appendChild(foot);

    // ── Acções (editar / apagar) — só para gestores ───────────────────────
    if (currentRole === 'manager') {
        const actions = $el('div', { className: 'sdc-actions' });

        const btnEdit = $el('button', { type: 'button', className: 'sdc-action-btn sdc-action-edit' });
        btnEdit.innerHTML = `${SVG_EDIT} Editar`;
        btnEdit.onclick   = e => { e.stopPropagation(); openEditModal(id, cache.stock.data?.[id] || item); };

        const btnDel = $el('button', { type: 'button', className: 'sdc-action-btn sdc-action-del' });
        btnDel.innerHTML = `${SVG_DEL} Apagar`;
        btnDel.onclick   = e => { e.stopPropagation(); openDeleteModal(id, cache.stock.data?.[id] || item); };

        actions.appendChild(btnEdit);
        actions.appendChild(btnDel);
        card.appendChild(actions);
    }

    wrapper.appendChild(card);
    return wrapper;
}

// ── Card Mobile modernizado ─────────────────────────────────────────────────
function _buildStockCardMobile(id, item) {
    const qty    = Number(item.quantidade) || 0;
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= _STOCK_LOW_THRESHOLD;

    const wrapper = $el('div', { className: 'swipe-wrapper' });
    wrapper.dataset.id = id;

    // Swipe backgrounds com ícones SVG reais
    const bgL = $el('div', { className: 'swipe-bg swipe-bg-left' });
    bgL.innerHTML = `<span class="swipe-bg-content"><span>Apagar</span>${_STK_SWIPE_DEL_SVG}</span>`;
    const bgR = $el('div', { className: 'swipe-bg swipe-bg-right' });
    bgR.innerHTML = `<span class="swipe-bg-content">${_STK_SWIPE_EDIT_SVG}<span>Editar</span></span>`;
    wrapper.appendChild(bgL);
    wrapper.appendChild(bgR);

    const card = $el('div', {
        className: 'item-card' + (isZero ? ' item-zero' : isLow ? ' item-low' : '')
    });

    // Topo: ref + badge + nome + notas | miniatura opcional
    const top  = $el('div', { className: 'mc-top' });
    const main = $el('div', { className: 'mc-main' });

    const refRow = $el('div', { className: 'mc-ref-row' });
    const refVal = $el('span', { className: 'mc-ref', textContent: String(item.codigo || 'SEM REF').toUpperCase() });
    refRow.appendChild(refVal);

    const badge = $el('span', {
        className: 'sdc-badge ' + (isZero ? 'sdc-badge-out' : isLow ? 'sdc-badge-low' : 'hidden'),
        textContent: isZero ? 'SEM STOCK' : isLow ? 'BAIXO' : ''
    });
    badge.id = `mcbadge-${id}`;
    refRow.appendChild(badge);
    main.appendChild(refRow);

    const nomEl = $el('div', { className: 'mc-nome', textContent: (item.nome || '').toUpperCase() });
    main.appendChild(nomEl);

    if (item.notas) {
        const notasRow = $el('div', { className: 'mc-notas', textContent: item.notas });
        notasRow.title = item.notas;
        main.appendChild(notasRow);
    }

    top.appendChild(main);

    if (item.imgUrl) {
        const thumb = $el('div', { className: 'mc-thumb' });
        thumb.setAttribute('role', 'button');
        thumb.title = 'Ver imagem';
        const img = $el('img');
        img.src     = item.imgUrl;
        img.alt     = item.nome || '';
        img.loading = 'lazy';
        img.onerror = () => { thumb.style.display = 'none'; };
        thumb.appendChild(img);
        top.appendChild(thumb);
    }

    card.appendChild(top);

    // Rodapé: localização + controlo de quantidade
    const foot = $el('div', { className: 'mc-foot' });

    const hasLoc = !!(item.localizacao || '').trim();
    const pill   = $el('div', { className: 'loc-pill' + (hasLoc ? '' : ' loc-pill-empty') });
    pill.innerHTML = _STK_PIN_SVG;
    pill.appendChild(document.createTextNode(hasLoc ? item.localizacao.toUpperCase() : 'SEM LOCAL'));

    const qtyBox = $el('div', { className: 'qty-pill-box' });

    const btnM = $el('button', { type: 'button', className: 'btn-qty', textContent: '−' });
    btnM.disabled = qty === 0;
    btnM.id       = `btn-minus-${id}`;

    const qtySpan = $el('span', {
        className: 'qty-display' + (qty === 0 ? ' is-zero' : ''),
        textContent: fmtQty(qty, item.unidade)
    });
    qtySpan.id = `qty-${id}`;

    const btnP = $el('button', { type: 'button', className: 'btn-qty', textContent: '+' });
    btnP.id = `btn-plus-${id}`;

    qtyBox.appendChild(btnM);
    qtyBox.appendChild(qtySpan);
    qtyBox.appendChild(btnP);

    foot.appendChild(pill);
    foot.appendChild(qtyBox);
    card.appendChild(foot);

    wrapper.appendChild(card);
    return wrapper;
}

// Sincronização imediata da UI (mobile + desktop + badges + KPIs) após alterar quantidade
function _syncCardQtyUI(id, qty, saving = false) {
    const item   = cache.stock.data?.[id];
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= _STOCK_LOW_THRESHOLD;
    const fmt    = fmtQty(qty, item?.unidade);

    // Mobile
    const mQty = $id(`qty-${id}`);
    if (mQty) {
        mQty.textContent = fmt;
        mQty.classList.toggle('is-zero', isZero);
        mQty.classList.toggle('qty-saving', saving);
    }
    const mMinus = $id(`btn-minus-${id}`);
    if (mMinus) mMinus.disabled = isZero;
    const mWrapper = document.querySelector(`.swipe-wrapper[data-id="${id}"]`);
    const mCard    = mWrapper?.querySelector('.item-card');
    if (mCard) {
        mCard.classList.toggle('item-zero', isZero);
        mCard.classList.toggle('item-low',  isLow);
    }
    const mBadge = $id(`mcbadge-${id}`);
    if (mBadge) {
        mBadge.className   = 'sdc-badge ' + (isZero ? 'sdc-badge-out' : isLow ? 'sdc-badge-low' : 'hidden');
        mBadge.textContent = isZero ? 'SEM STOCK' : isLow ? 'BAIXO' : '';
    }

    // Desktop
    const dQty  = $id(`sdcqty-${id}`);
    const dDisp = $id(`sdcdisp-${id}`);
    const dMin  = $id(`sdcbtnm-${id}`);
    const dVal  = $id(`sdcval-${id}`);
    if (dQty) {
        dQty.textContent = fmt;
        dQty.classList.toggle('qty-saving', saving);
    }
    if (dDisp) dDisp.textContent = String(qty);
    if (dMin)  dMin.disabled     = isZero;
    if (dVal)  dVal.classList.toggle('sdc-stock-zero', isZero);

    const dWrapper = document.querySelector(`.sdc-wrapper[data-id="${id}"]`);
    const dCard    = dWrapper?.querySelector('.sdc');
    if (dCard) {
        dCard.classList.toggle('sdc-zero', isZero);
        dCard.classList.toggle('sdc-low',  isLow);
    }
    const dBadge = $id(`sdcbadge-${id}`);
    if (dBadge) {
        dBadge.className   = 'sdc-badge ' + (isZero ? 'sdc-badge-out' : isLow ? 'sdc-badge-low' : 'hidden');
        dBadge.textContent = isZero ? 'SEM STOCK' : isLow ? 'BAIXO' : '';
    }

    // Actualiza contadores de filtros e KPIs desktop
    if (cache.stock.data) _updateStockFilterCounts(cache.stock.data);
}

// ── Render principal ────────────────────────────────────────────────────────
let _stockDeferredEntries = [];

async function renderList(filter = '', forceFetch = false) {
    const listEl = $id('stock-list');
    if (!listEl) return;

    _ensureStockListDelegation();

    if (_pendingZeroFilter) {
        _pendingZeroFilter = false;
        _stockFilter       = 'zero';
        _desktopFilter     = 'zero';
        _zeroFilterActive  = true;
    }

    if (!cache.stock.data) listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';

    const data    = await fetchCollection('stock', forceFetch);
    const entries = Object.entries(data || {});

    // Actualizar contadores dos filtros rápidos
    _updateStockFilterCounts(data);
    _syncSortSelect();

    const qNorm  = _normStockText(filter);
    const tokens = qNorm ? qNorm.split(/\s+/).filter(Boolean) : [];
    const sorted = _getSortedEntriesCached(entries);

    // Aplicar filtro de estado + pesquisa ANTES da paginação
    const matched = [];
    for (const entry of sorted) {
        const item = entry[1];
        if (!item) continue;
        if (!_itemMatchesStatus(item, _stockFilter)) continue;
        if (!_itemMatchesQuery(item, tokens))        continue;
        matched.push(entry);
    }

    const isDesktop = _stockDesktopActive();

    // ── Vista Desktop (>= 768px) ──────────────────────────────────────────
    if (isDesktop) {
        _renderDesktopHeader(data);
        listEl.className = 'stock-grid';
        listEl.innerHTML = '';

        if (entries.length === 0) {
            listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
            return;
        }
        if (matched.length === 0) {
            listEl.className = '';
            listEl.innerHTML = _buildEmptyStockState(!!qNorm || _stockFilter !== 'all');
            return;
        }

        const fragD = document.createDocumentFragment();
        for (const [id, item] of matched) {
            fragD.appendChild(_buildDesktopCard(id, item));
        }
        listEl.appendChild(fragD);
        return;
    }

    // ── Vista Mobile (< 768px) ────────────────────────────────────────────
    listEl.className = '';
    $id('stock-desktop-hdr')?.remove();
    listEl.innerHTML = '';

    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
        return;
    }

    // Hint contextual (mostrado 1x)
    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!qNorm && _stockFilter === 'all' && !localStorage.getItem(hintKey)) {
        const hint = $el('div', { className: 'swipe-hint' });
        if (currentRole === 'worker') {
            hint.innerHTML = '<span>Modo consulta — toca num artigo para ver detalhes</span>';
        } else {
            hint.innerHTML = '<span>→ Desliza direita: editar</span><span>← Desliza esquerda: apagar</span>';
        }
        listEl.appendChild(hint);
        localStorage.setItem(hintKey, '1');
    }

    if (matched.length === 0) {
        listEl.innerHTML = _buildEmptyStockState(!!qNorm || _stockFilter !== 'all');
        return;
    }

    const PAGE_SIZE = 80;
    const shown     = matched.slice(0, PAGE_SIZE);
    _stockDeferredEntries = matched.slice(PAGE_SIZE);

    const frag = document.createDocumentFragment();
    for (const [id, item] of shown) {
        frag.appendChild(_buildStockCardMobile(id, item));
    }
    listEl.appendChild(frag);
    _renderLoadMoreBtn(listEl);
}

function _buildEmptyStockState(hasActiveFilter) {
    return `
        <div class="empty-state">
            <div class="empty-state-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                    <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
            </div>
            <div class="empty-state-title">Nenhum artigo encontrado</div>
            <div class="empty-state-sub">${hasActiveFilter ? 'Nenhum produto corresponde à pesquisa ou filtro activo.' : 'Sem produtos registados no armazém.'}</div>
            ${hasActiveFilter ? '<button type="button" class="empty-state-btn" onclick="resetStockFilters()">Limpar filtros</button>' : ''}
        </div>`;
}

function resetStockFilters() {
    _stockFilter      = 'all';
    _desktopFilter    = 'all';
    _zeroFilterActive = false;
    const inp = $id('inp-search');
    if (inp) inp.value = '';
    $id('inp-search-clear')?.classList.add('hidden');
    renderList('', false);
}

function _renderLoadMoreBtn(listEl) {
    $id('load-more-btn')?.remove();
    if (_stockDeferredEntries.length === 0) return;
    const PAGE_SIZE = 80;
    const n   = _stockDeferredEntries.length;
    const btn = $el('button', { type: 'button', className: 'btn-load-more' });
    btn.id          = 'load-more-btn';
    btn.textContent = `Mostrar mais ${n} produto${n > 1 ? 's' : ''}`;
    btn.onclick     = () => {
        const batch = _stockDeferredEntries.splice(0, PAGE_SIZE);
        const frag  = document.createDocumentFragment();
        for (const [id, item] of batch) {
            frag.appendChild(_buildStockCardMobile(id, item));
        }
        btn.remove();
        listEl.appendChild(frag);
        _renderLoadMoreBtn(listEl);
    };
    listEl.appendChild(btn);
}

// ── Edição inline de quantidade (mobile double-tap & desktop click) ─────────
function openInlineQtyEdit(id, item, mode = 'mobile') {
    if (currentRole !== 'manager') return;
    const targetId = mode === 'desktop' ? `sdcdisp-${id}` : `qty-${id}`;
    const qtyEl    = $id(targetId);
    if (!qtyEl || qtyEl.parentNode?.querySelector('.qty-inline-edit')) return;

    const currentQty = cache.stock.data?.[id]?.quantidade ?? item.quantidade ?? 0;
    const wrap = $el('div', { className: 'qty-inline-edit' + (mode === 'desktop' ? ' qty-inline-desktop' : '') });
    const inp  = $el('input', { className: 'qty-inline-input' });
    inp.type   = 'number';
    inp.min    = '0';
    inp.step   = 'any';
    inp.value  = currentQty;
    inp.setAttribute('inputmode', 'decimal');

    let finished = false;
    const cancelFn = () => {
        if (finished) return;
        finished = true;
        wrap.replaceWith(qtyEl);
    };
    const confirmFn = async () => {
        if (finished) return;
        const newVal = parseFloat(inp.value);
        if (isNaN(newVal) || newVal < 0) { cancelFn(); return; }
        finished = true;

        const oldVal = cache.stock.data?.[id]?.quantidade ?? 0;
        wrap.replaceWith(qtyEl);
        if (newVal === oldVal) return;

        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newVal;
        if (_stockSort === 'qtd-asc' || _stockSort === 'qtd-desc') _invalidateSortedCache();
        _syncCardQtyUI(id, newVal, true);

        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ quantidade: newVal })
            });
            _syncCardQtyUI(id, newVal, false);
            if (newVal < oldVal) {
                registarMovimento('saida_manual', id, item.codigo, item.nome, oldVal - newVal);
            }
            renderDashboard();
        } catch(_e) {
            if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = oldVal;
            _syncCardQtyUI(id, oldVal, false);
            showToast('Erro ao guardar', 'error');
        }
    };

    inp.addEventListener('click',     e => e.stopPropagation());
    inp.addEventListener('mousedown', e => e.stopPropagation());
    inp.addEventListener('keydown',   e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmFn(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelFn(); }
    });
    inp.addEventListener('blur', () => setTimeout(cancelFn, 150));

    const ok = $el('button', { type: 'button', className: 'qty-inline-ok', textContent: '✓' });
    ok.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); confirmFn(); });

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

// ── Debounce + gravação atómica de quantidade ───────────────────────────────
const _qtyTimers      = {};
const _qtyPendingBase = {};

async function _readServerStockQty(id, fallbackQty = 0) {
    if (!navigator.onLine) return fallbackQty;
    try {
        const url = await authUrl(`${BASE_URL}/stock/${id}/quantidade.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const qty    = await res.json();
        const parsed = typeof qty === 'number' ? qty : parseFloat(qty);
        return Number.isFinite(parsed) ? parsed : fallbackQty;
    } catch (e) {
        console.warn('[Stock] fallback para cache local:', id, e?.message);
        return fallbackQty;
    }
}

// Compara sem espaços e sem diferença de maiúsculas.
// → { status: 'empty' | 'none' | 'one' | 'multi', id?, item?, count? }
function findStockByCodigo(codigo) {
    const key = String(codigo || '').replace(/\s+/g, '').toUpperCase();
    if (!key) return { status: 'empty' };
    const ids = Object.entries(cache.stock.data || {})
        .filter(([id, it]) => !id.startsWith('_tmp_') && String(it?.codigo || '').replace(/\s+/g, '').toUpperCase() === key)
        .map(([id]) => id);
    if (ids.length === 0) return { status: 'none' };
    if (ids.length > 1)   return { status: 'multi', count: ids.length };
    return { status: 'one', id: ids[0], item: cache.stock.data[ids[0]] };
}

const _stRound3  = n => Math.round(n * 1000) / 1000;
const _stIncBody = n => JSON.stringify({ quantidade: { '.sv': { increment: n } } });

async function _stSavedQty(res, id, fallback) {
    try {
        const j = await res.clone().json();
        if (j && typeof j.quantidade === 'number' && Number.isFinite(j.quantidade)) return j.quantidade;
    } catch (_) {}
    return await _readServerStockQty(id, fallback);
}

async function _commitStockDelta(id, baseQty, finalQty) {
    if (finalQty === undefined) return { saved: baseQty, applied: 0 };
    const delta = _stRound3(finalQty - baseQty);
    if (delta === 0) return { saved: baseQty, applied: 0 };
    const url = `${BASE_URL}/stock/${id}.json`;

    if (!navigator.onLine) {
        await apiFetch(url, { method: 'PATCH', body: _stIncBody(delta) });
        return { saved: finalQty, applied: delta, queued: true };
    }

    const res = await apiFetch(url, { method: 'PATCH', body: _stIncBody(delta) });
    if (!res) return { saved: finalQty, applied: delta, queued: true };

    let saved   = await _stSavedQty(res, id, _stRound3(baseQty + delta));
    let applied = delta;
    if (saved < 0) {
        const fix = _stRound3(-saved);
        try { await apiFetch(url, { method: 'PATCH', body: _stIncBody(fix) }); }
        catch (e) { console.warn('[Stock] correcção a 0 falhou:', id, e?.message); }
        applied = _stRound3(delta + fix);
        saved   = 0;
    }
    return { saved, applied };
}

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(30);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = Number(stockData[id].quantidade) || 0;
    if (!Object.prototype.hasOwnProperty.call(_qtyPendingBase, id)) {
        _qtyPendingBase[id] = oldQty;
    }
    const newQty = Math.max(0, _stRound3(oldQty + delta));
    if (newQty === oldQty) return;

    // Actualiza cache + UI (mobile e desktop) imediatamente
    stockData[id].quantidade = newQty;
    if (_stockSort === 'qtd-asc' || _stockSort === 'qtd-desc') _invalidateSortedCache();
    _syncCardQtyUI(id, newQty, true);

    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        const baseQty = _qtyPendingBase[id] ?? oldQty;
        try {
            const commit   = await _commitStockDelta(id, baseQty, finalQty);
            const savedQty = commit.saved;
            stockData[id].quantidade = savedQty;
            _syncCardQtyUI(id, savedQty, false);

            const movido = Math.max(0, -commit.applied);
            if (movido > 0) {
                const _itm = stockData[id];
                registarMovimento('saida_manual', id, _itm?.codigo, _itm?.nome, movido);
            }
        } catch (e) {
            console.warn('changeQtd erro:', e?.message || e);
            stockData[id].quantidade = baseQty;
            _syncCardQtyUI(id, baseQty, false);
            showToast('Erro ao guardar quantidade', 'error');
        }
        delete _qtyTimers[id];
        delete _qtyPendingBase[id];
    }, 600);
}

// ── SWIPE GESTURES & DELEGATION ─────────────────────────────────────────────
const SWIPE_THRESHOLD = 80;
let _swipeCard     = null;
let _swipeWrapper  = null;
let _swipeStartX   = 0;
let _swipeStartY   = 0;
let _swipeCurrentX = 0;
let _swipeDragging = false;
let _swipeMeta     = null; // { id, item }
let _swipeIntent   = null; // 'horizontal' | 'vertical' | null

document.addEventListener('mousemove', e => {
    if (!_swipeDragging) return;
    _onSwipeMove(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => {
    if (!_swipeDragging) return;
    _onSwipeEnd();
});

let _stockDelegationReady = false;
function _ensureStockListDelegation() {
    if (_stockDelegationReady) return;
    const listEl = $id('stock-list');
    if (!listEl) return;
    _stockDelegationReady = true;

    function _resolveCtx(target) {
        const wrapper = target.closest('.swipe-wrapper[data-id]');
        if (!wrapper) return null;
        const id   = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        if (!item) return null;
        const card = wrapper.querySelector('.item-card');
        return { wrapper, card, id, item };
    }

    const _qtyTapState = new Map();
    listEl.addEventListener('click', e => {
        // Miniatura mobile → lightbox directo
        const thumb = e.target.closest('.mc-thumb');
        if (thumb) {
            e.stopPropagation();
            const ctx = _resolveCtx(thumb);
            if (ctx?.item?.imgUrl) openImageViewer(ctx.item.imgUrl, ctx.item.nome, ctx.item.codigo);
            return;
        }
        const btn = e.target.closest('.btn-qty');
        if (btn) {
            const ctx = _resolveCtx(btn);
            if (!ctx) return;
            const isPlus  = btn.id?.startsWith('btn-plus-')  || btn.textContent.trim() === '+';
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
                openInlineQtyEdit(ctx.id, ctx.item, 'mobile');
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

    const _IGNORE_SWIPE = '.btn-qty, .qty-display, .qty-inline-edit, .mc-thumb';

    listEl.addEventListener('touchstart', e => {
        if (currentRole === 'worker') return;
        if (e.target.closest(_IGNORE_SWIPE)) return;
        const ctx = _resolveCtx(e.target);
        if (!ctx || !ctx.card) return;
        _onSwipeStart(ctx.card, ctx.wrapper, ctx.id, ctx.item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchmove', e => {
        if (!_swipeDragging) return;
        if (e.target.closest(_IGNORE_SWIPE)) return;
        _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchend', e => {
        if (!_swipeDragging) return;
        if (e.target.closest(_IGNORE_SWIPE)) return;
        _onSwipeEnd();
    }, { passive: true });

    listEl.addEventListener('mousedown', e => {
        if (currentRole === 'worker') return;
        if (e.target.closest(_IGNORE_SWIPE)) return;
        const ctx = _resolveCtx(e.target);
        if (!ctx || !ctx.card) return;
        _onSwipeStart(ctx.card, ctx.wrapper, ctx.id, ctx.item, e.clientX, e.clientY);
        e.preventDefault();
    });
}

function attachSwipe(_card, _wrapper, _id, _item) { /* noop — tratado por delegation */ }

function _onSwipeStart(card, wrapper, id, item, x, y = 0) {
    _swipeCard     = card;
    _swipeWrapper  = wrapper;
    _swipeMeta     = { id, item };
    _swipeStartX   = x;
    _swipeStartY   = y;
    _swipeCurrentX = 0;
    _swipeDragging = true;
    _swipeIntent   = null;
}

function _onSwipeMove(x, y = 0) {
    if (!_swipeDragging || !_swipeCard) return;
    const dx = x - _swipeStartX;
    const dy = y - _swipeStartY;

    if (_swipeIntent === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        _swipeIntent = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (_swipeIntent === 'horizontal') _swipeCard.classList.add('is-swiping');
    }
    if (_swipeIntent !== 'horizontal') return;

    _swipeCurrentX = dx;
    const clamped  = Math.max(-140, Math.min(140, dx));
    _swipeCard.style.transform = `translateX(${clamped}px)`;
    _swipeWrapper.classList.remove('swiping-left', 'swiping-right');
    if (clamped < -20)     _swipeWrapper.classList.add('swiping-left');
    else if (clamped > 20) _swipeWrapper.classList.add('swiping-right');
}

function _onSwipeEnd() {
    if (!_swipeDragging || !_swipeCard) return;
    _swipeDragging = false;
    _swipeCard.classList.remove('is-swiping');
    _swipeWrapper.classList.remove('swiping-left', 'swiping-right');
    if (_swipeIntent === 'horizontal') {
        snapBack(_swipeCard);
        if      (_swipeCurrentX < -SWIPE_THRESHOLD) openDeleteModal(_swipeMeta.id, _swipeMeta.item);
        else if (_swipeCurrentX >  SWIPE_THRESHOLD) openEditModal(_swipeMeta.id, _swipeMeta.item);
    } else if (_swipeIntent === null) {
        openProductDetail(_swipeMeta.id, _swipeMeta.item);
    }
    _swipeCard = _swipeWrapper = _swipeMeta = null;
    _swipeIntent = null;
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once: true });
}

// ── Popup de detalhe do produto (mobile tap) ────────────────────────────────
let _pdmOpenedAt = 0;

function openProductDetail(id, item) {
    const data   = cache.stock.data?.[id] || item;
    _pdmOpenedAt = performance.now();

    const imgWrap = $id('pdm-img-wrap');
    const img     = $id('pdm-img');
    if (data.imgUrl) {
        img.src = data.imgUrl;
        img.alt = data.nome || '';
        imgWrap.style.display = '';
        imgWrap.title   = 'Ver imagem maior';
        imgWrap.onclick = e => {
            if (performance.now() - _pdmOpenedAt < 600) { e.stopPropagation(); return; }
            openImageViewer(data.imgUrl, data.nome, data.codigo);
        };
    } else {
        imgWrap.style.display = 'none';
    }

    $id('pdm-ref').textContent  = 'REF: ' + (data.codigo || '—').toUpperCase();
    $id('pdm-nome').textContent = (data.nome || '').toUpperCase();

    const locWrap = $id('pdm-loc-wrap');
    if (data.localizacao) {
        $id('pdm-loc').textContent = data.localizacao.toUpperCase();
        locWrap.style.display = '';
    } else {
        locWrap.style.display = 'none';
    }

    const qty   = Number(data.quantidade) || 0;
    const qtyEl = $id('pdm-qty');
    qtyEl.textContent = fmtQty(qty, data.unidade);
    qtyEl.className   = 'pdm-value pdm-qty' + (qty === 0 ? ' pdm-qty-zero' : '');

    const notasWrap = $id('pdm-notas-wrap');
    if (data.notas) {
        $id('pdm-notas').textContent = data.notas;
        notasWrap.style.display = '';
    } else {
        notasWrap.style.display = 'none';
    }

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

// ── EXPORTAR CSV ────────────────────────────────────────────────────────────
async function exportCSV() {
    const btn = $id('export-csv-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    const data = await fetchCollection('stock', false);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para exportar', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
        return;
    }
    const headers   = ['Referência', 'Nome', 'Localização', 'Quantidade', 'Unidade'];
    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_tmp_')));
    const rows = Object.values(cleanData).map(item => [
        `"${(item.codigo || '').toUpperCase()}"`,
        `"${(item.nome || '').replace(/"/g, '""')}"`,
        `"${(item.localizacao || '').toUpperCase()}"`,
        item.quantidade ?? 0,
        item.unidade || 'un'
    ]);
    const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    Object.assign($el('a'), {
        href: url,
        download: `gestao-armazem-stock-${new Date().toISOString().slice(0, 10)}.csv`
    }).click();
    URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
    showToast(`${Object.keys(cleanData).length} produtos exportados!`);
}

// ── DETECÇÃO DE CÓDIGO DUPLICADO ────────────────────────────────────────────
function checkDuplicateCodigo(codigo, onConfirm) {
    if (!codigo || codigo.toUpperCase() === 'SEMREF') {
        onConfirm(); return;
    }
    const stock = cache.stock.data || {};
    const dupes = Object.values(stock).filter(
        item => (item.codigo || '').toUpperCase() === codigo.toUpperCase()
    );
    if (dupes.length === 0) {
        onConfirm(); return;
    }
    const names = dupes.map(d => d.nome || '(sem nome)').join(', ');
    $id('dup-modal-desc').textContent =
        `O código "${codigo.toUpperCase()}" já existe em: ${names}. Queres registar mesmo assim?`;
    $id('dup-confirm-btn').onclick = () => { modalClose('dup-modal'); onConfirm(); };
    modalOpen('dup-modal');
    focusModal('dup-modal');
}
