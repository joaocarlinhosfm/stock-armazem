// ─────────────────────────────────────────────────────────────────────────────
// stock.js — Gestão Armazém v6.87
// Gestão de stock: cards limpos (mobile + desktop) sem botões +/-,
// abertura do produto para consulta/edição, filtros rápidos, pesquisa sem
// acentos e multi-palavra, ordenação, gravação atómica (para PATs/Encomendas)
// e exportação CSV.
// Carrega DEPOIS de reports.js e ANTES de tools.js, pats.js.
//
// Dependências:
//   utils.js   → BASE_URL, $id, $el, fmtQty, UNIT_SHORT, escapeHtml, showToast,
//                modalOpen, modalClose, focusModal, openImageViewer,
//                setRefreshSpinning
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

const _STK_PIN_SVG        = '<svg width="11" height="11" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/></svg>';
const _STK_CHEV_SVG       = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
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

// Formata quantidade separando número principal e unidade discreta
function _fmtQtyPartsHtml(quantidade, unidade) {
    const qty  = quantidade ?? 0;
    const unit = (unidade && unidade !== 'un') ? (UNIT_SHORT[unidade] || unidade) : 'un';
    return `<span class="stk-qty-num">${escapeHtml(String(qty))}</span><span class="stk-qty-unit">${escapeHtml(unit)}</span>`;
}

// Oculta na grelha notas automáticas de importação (continuam visíveis ao abrir o produto)
function _isAutoImportNote(notas) {
    return /^importado\s+do\s+excel\b/i.test(String(notas || '').trim());
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

    const noLocBtn = $id('sf-btn-nolocal');
    if (noLocBtn) noLocBtn.style.display = (noLocal > 0 || _stockFilter === 'nolocal') ? '' : 'none';

    const zeroBtn = $id('sf-btn-zero');
    if (zeroBtn) zeroBtn.classList.toggle('has-zero', zero > 0);

    document.querySelectorAll('.stock-filter-btn[data-filter]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === _stockFilter);
    });

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

// ── Card Desktop (limpo, clicável para abrir/editar, sem botões +/-) ───────
function _buildDesktopCard(id, item) {
    const qty    = Number(item.quantidade) || 0;
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= _STOCK_LOW_THRESHOLD;

    const wrapper = $el('div', { className: 'sdc-wrapper' });
    wrapper.dataset.id = id;

    const card = $el('div', {
        className: 'sdc' + (isZero ? ' sdc-zero' : isLow ? ' sdc-low' : '')
    });
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.onclick  = () => openProductDetail(id, cache.stock.data?.[id] || item);
    card.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openProductDetail(id, cache.stock.data?.[id] || item);
        }
    };

    // ── Cabeçalho: ref chip + badge + nome + nota manual | miniatura ──────
    const hdr  = $el('div', { className: 'sdc-hdr' });
    const meta = $el('div', { className: 'sdc-meta' });

    const refRow = $el('div', { className: 'sdc-ref-row' });
    const ref    = $el('span', { className: 'sdc-ref', textContent: (item.codigo || 'SEM REF').toUpperCase() });
    refRow.appendChild(ref);

    if (isZero) {
        refRow.appendChild($el('span', { className: 'sdc-badge sdc-badge-out', textContent: 'SEM STOCK' }));
    } else if (isLow) {
        refRow.appendChild($el('span', { className: 'sdc-badge sdc-badge-low', textContent: 'BAIXO' }));
    }
    meta.appendChild(refRow);

    const nome = $el('div', { className: 'sdc-nome', textContent: (item.nome || '').toUpperCase() });
    meta.appendChild(nome);

    // Só mostra na grelha observações manuais (notas automáticas de importação ficam no detalhe)
    if (item.notas && !_isAutoImportNote(item.notas)) {
        const notas = $el('div', { className: 'sdc-notas', textContent: item.notas });
        notas.title = item.notas;
        meta.appendChild(notas);
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

    // ── Rodapé: stock actual | localização + indicador abrir ─────────────
    const foot = $el('div', { className: 'sdc-foot' });

    const stockInfo = $el('div', { className: 'sdc-stock-info' });
    stockInfo.appendChild($el('div', { className: 'sdc-stock-label', textContent: 'STOCK' }));
    const stockVal = $el('div', { className: 'sdc-qty' + (isZero ? ' is-zero' : '') });
    stockVal.innerHTML = _fmtQtyPartsHtml(qty, item.unidade);
    stockInfo.appendChild(stockVal);

    const footRight = $el('div', { className: 'sdc-foot-right' });
    if ((item.localizacao || '').trim()) {
        const loc = $el('span', { className: 'sdc-loc' });
        loc.innerHTML = _STK_PIN_SVG;
        loc.appendChild(document.createTextNode(item.localizacao.toUpperCase()));
        footRight.appendChild(loc);
    }
    const openHint = $el('span', { className: 'sdc-open-hint' });
    openHint.innerHTML = _STK_CHEV_SVG;
    footRight.appendChild(openHint);

    foot.appendChild(stockInfo);
    foot.appendChild(footRight);
    card.appendChild(foot);

    wrapper.appendChild(card);
    return wrapper;
}

// ── Card Mobile (limpo, toque abre produto para editar, sem botões +/-) ─────
function _buildStockCardMobile(id, item) {
    const qty    = Number(item.quantidade) || 0;
    const isZero = qty === 0;
    const isLow  = !isZero && qty <= _STOCK_LOW_THRESHOLD;

    const wrapper = $el('div', { className: 'swipe-wrapper' });
    wrapper.dataset.id = id;

    // Swipe backgrounds (atalho rápido para gestores)
    const bgL = $el('div', { className: 'swipe-bg swipe-bg-left' });
    bgL.innerHTML = `<span class="swipe-bg-content"><span>Apagar</span>${_STK_SWIPE_DEL_SVG}</span>`;
    const bgR = $el('div', { className: 'swipe-bg swipe-bg-right' });
    bgR.innerHTML = `<span class="swipe-bg-content">${_STK_SWIPE_EDIT_SVG}<span>Editar</span></span>`;
    wrapper.appendChild(bgL);
    wrapper.appendChild(bgR);

    const card = $el('div', {
        className: 'item-card' + (isZero ? ' item-zero' : isLow ? ' item-low' : '')
    });

    // Topo: ref chip + badge + nome + nota manual | miniatura opcional
    const top  = $el('div', { className: 'mc-top' });
    const main = $el('div', { className: 'mc-main' });

    const refRow = $el('div', { className: 'mc-ref-row' });
    refRow.appendChild($el('span', { className: 'mc-ref', textContent: String(item.codigo || 'SEM REF').toUpperCase() }));

    if (isZero) {
        refRow.appendChild($el('span', { className: 'sdc-badge sdc-badge-out', textContent: 'SEM STOCK' }));
    } else if (isLow) {
        refRow.appendChild($el('span', { className: 'sdc-badge sdc-badge-low', textContent: 'BAIXO' }));
    }
    main.appendChild(refRow);

    main.appendChild($el('div', { className: 'mc-nome', textContent: (item.nome || '').toUpperCase() }));

    if (item.notas && !_isAutoImportNote(item.notas)) {
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

    // Rodapé: localização à esquerda | stock + chevron à direita
    const foot = $el('div', { className: 'mc-foot' });

    const hasLoc = !!(item.localizacao || '').trim();
    const pill   = $el('div', { className: 'loc-pill' + (hasLoc ? '' : ' loc-pill-empty') });
    pill.innerHTML = _STK_PIN_SVG;
    pill.appendChild(document.createTextNode(hasLoc ? item.localizacao.toUpperCase() : 'SEM LOCAL'));

    const qtyWrap = $el('div', { className: 'mc-qty-wrap' });
    const qtyEl   = $el('div', { className: 'mc-qty' + (isZero ? ' is-zero' : '') });
    qtyEl.innerHTML = _fmtQtyPartsHtml(qty, item.unidade);
    const chev = $el('span', { className: 'mc-chev' });
    chev.innerHTML = _STK_CHEV_SVG;
    qtyWrap.appendChild(qtyEl);
    qtyWrap.appendChild(chev);

    foot.appendChild(pill);
    foot.appendChild(qtyWrap);
    card.appendChild(foot);

    wrapper.appendChild(card);
    return wrapper;
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

    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!qNorm && _stockFilter === 'all' && !localStorage.getItem(hintKey)) {
        const hint = $el('div', { className: 'swipe-hint' });
        if (currentRole === 'worker') {
            hint.innerHTML = '<span>Modo consulta — toca num artigo para ver detalhes</span>';
        } else {
            hint.innerHTML = '<span>Toca num artigo para abrir · desliza para editar ou apagar</span>';
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

async function forceRefresh() {
    setRefreshSpinning(true);
    await Promise.all([
        renderList($id('inp-search')?.value || '', true),
        renderDashboard()
    ]);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

// ── Helpers partilhados de stock (usados por PATs e Encomendas) ─────────────
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

// ── SWIPE GESTURES & DELEGATION (mobile) ────────────────────────────────────
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

    listEl.addEventListener('click', e => {
        // Miniatura mobile → lightbox directo
        const thumb = e.target.closest('.mc-thumb');
        if (thumb) {
            e.stopPropagation();
            const ctx = _resolveCtx(thumb);
            if (ctx?.item?.imgUrl) openImageViewer(ctx.item.imgUrl, ctx.item.nome, ctx.item.codigo);
            return;
        }
        // Worker: click no card abre detalhe
        if (currentRole === 'worker') {
            const ctx = _resolveCtx(e.target);
            if (ctx) openProductDetail(ctx.id, ctx.item);
        }
    });

    listEl.addEventListener('touchstart', e => {
        if (currentRole === 'worker') return;
        if (e.target.closest('.mc-thumb')) return;
        const ctx = _resolveCtx(e.target);
        if (!ctx || !ctx.card) return;
        _onSwipeStart(ctx.card, ctx.wrapper, ctx.id, ctx.item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchmove', e => {
        if (!_swipeDragging) return;
        if (e.target.closest('.mc-thumb')) return;
        _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    listEl.addEventListener('touchend', e => {
        if (!_swipeDragging) return;
        if (e.target.closest('.mc-thumb')) return;
        _onSwipeEnd();
    }, { passive: true });

    listEl.addEventListener('mousedown', e => {
        if (currentRole === 'worker') return;
        if (e.target.closest('.mc-thumb')) return;
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

// ── Popup de detalhe do produto (mobile & desktop) ──────────────────────────
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

    $id('pdm-ref').textContent  = (data.codigo || 'SEM REF').toUpperCase();
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
    qtyEl.innerHTML = _fmtQtyPartsHtml(qty, data.unidade);
    qtyEl.className = 'pdm-value pdm-qty' + (qty === 0 ? ' pdm-qty-zero' : '');

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
