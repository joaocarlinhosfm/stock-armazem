// ─────────────────────────────────────────────────────────────────────────────
// inventory.js — Gestão Armazém v6.80
// Inventário Guiado v2: seleção de zonas, navegação passo a passo, pesquisa
// inline, gravação parcial/retoma (/inv-resume, 72h), revisão e exportação
// para Excel / Email.
//
// DEPENDÊNCIAS:
//   utils.js     — BASE_URL, $id, $el, escapeHtml, showToast, fmtQty,
//                  modalOpen, modalClose, focusModal, loadXlsx, openImageViewer
//   auth.js      — USER_KEY, authUrl
//   tools.js     — openConfirmModal, closeConfirmModal
//   stock.js     — renderList
//   dashboard.js — renderDashboard
//   app.js       — cache, fetchCollection, invalidateCache, apiFetch
// ─────────────────────────────────────────────────────────────────────────────

// INVENTÁRIO GUIADO — v2
// Pontos: filtro por zona, revisão, retoma, stats, Excel, email
// INV_RESUME_KEY removida — resume migrado para Firebase /inv-resume/{user}
const INV_EMAIL_KEY = 'hiperfrio-inv-email';

function _invGetEmail() {
    return localStorage.getItem(INV_EMAIL_KEY) || '';
}

function saveInvEmail() {
    const val = ($id('inv-email-input')?.value || '').trim();
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        showToast('Email inválido', 'error');
        return;
    }
    if (val) {
        localStorage.setItem(INV_EMAIL_KEY, val);
        showToast('Email guardado ✓');
    } else {
        localStorage.removeItem(INV_EMAIL_KEY);
        showToast('Email removido');
    }
}

function _loadInvEmailInput() {
    const el = $id('inv-email-input');
    if (el) el.value = _invGetEmail();
}

// Estado da sessão de inventário
let _invItems     = [];        // produtos a percorrer
let _invIdx       = 0;         // índice actual
let _invChanges   = {};        // { id: newQty } — confirmados
let _invSkipped   = new Set(); // ids saltados
let _invOptions   = { zones: null, skipZeros: false }; // null = todas as zonas
let _invLastData  = null;      // snapshot dos dados no início (para o Excel)

async function startInventory() {
    const data = await fetchCollection('stock', true);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para inventariar', 'error'); return;
    }

    // Carrega sessão guardada ANTES de abrir o modal — banner já está pronto ao aparecer
    const saved = await _invLoadResume();

    _openInvSetup(data);

    const banner = $id('inv-resume-banner');
    if (banner) {
        if (!saved) {
            banner.style.display = 'none';
        } else {
            const hoursAgo = Math.round((Date.now() - (saved.ts || 0)) / 3600000);
            const timeLabel = hoursAgo < 1 ? 'há menos de 1h' : `há ${hoursAgo}h`;
            $id('inv-resume-banner-text').textContent =
                `Inventário em curso · ${saved.idx + 1}/${saved.items.length} · guardado ${timeLabel}`;
            banner.style.display = 'flex';
            $id('inv-resume-btn-retomar').onclick = () => {
                closeInvSetup();
                _resumeInventory(saved);
            };
            $id('inv-resume-btn-novo').onclick = () => {
                banner.style.display = 'none';
                _invClearResume();
            };
        }
    }
}

function _openInvSetup(data) {
    // Extrai zonas únicas ordenadas
    const zones = [...new Set(
        Object.values(data)
            .filter(p => !String(p.codigo||'').startsWith('_tmp_'))
            .map(p => (p.localizacao||'').trim().toUpperCase())
            .filter(Boolean)
    )].sort((a,b) => a.localeCompare(b,'pt'));

    const container = $id('inv-setup-zones');
    container.innerHTML = '';

    if (zones.length === 0) {
        container.innerHTML = '<p class="modal-desc" style="margin:0">Todos os produtos serão inventariados (sem zonas definidas).</p>';
    } else {
        zones.forEach(zone => {
            const chip = $el('button');
            chip.type      = 'button';
            chip.className = 'inv-zone-chip active';
            chip.dataset.zone = zone;
            chip.textContent  = zone;
            chip.onclick = () => {
                chip.classList.toggle('active');
                _updateInvSetupBtn();
            };
            container.appendChild(chip);
        });
    }

    $id('inv-skip-zeros').checked = false;
    _updateInvSetupBtn();
    modalOpen('inv-setup-modal');
    focusModal('inv-setup-modal');
}

function invSetupToggleAll() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const allActive = [...chips].every(c => c.classList.contains('active'));
    chips.forEach(c => c.classList.toggle('active', !allActive));
    _updateInvSetupBtn();
}

function _updateInvSetupBtn() {
    const chips   = document.querySelectorAll('.inv-zone-chip');
    const active  = [...chips].filter(c => c.classList.contains('active'));
    const btn     = document.querySelector('#inv-setup-modal .btn-primary');
    const toggleBtn = document.querySelector('.inv-setup-toggle-all');
    if (!btn) return;
    if (chips.length === 0) {
        btn.textContent = 'Iniciar Inventário →';
    } else if (active.length === 0) {
        btn.textContent = 'Selecciona pelo menos uma zona';
        btn.disabled = true;
        if (toggleBtn) toggleBtn.textContent = 'Seleccionar todas';
        return;
    } else {
        const allActive = active.length === chips.length;
        btn.textContent = allActive
            ? `Iniciar — todos os produtos →`
            : `Iniciar — ${active.length} zona${active.length > 1 ? 's' : ''} →`;
        if (toggleBtn) toggleBtn.textContent = allActive ? 'Limpar selecção' : 'Seleccionar todas';
    }
    btn.disabled = false;
}

function closeInvSetup() {
    modalClose('inv-setup-modal');
}

async function invSetupStart() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const totalChips = chips.length;
    const activeZones = totalChips === 0
        ? null
        : [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.zone);

    if (activeZones && activeZones.length === 0) return;

    const skipZeros = $id('inv-skip-zeros').checked;
    const allZones  = totalChips === 0 || activeZones === null || activeZones.length === totalChips;
    closeInvSetup();
    await _startInvWithOptions(activeZones, skipZeros, allZones);
}

async function _startInvWithOptions(zones, skipZeros, allZones = true) {
    const data = cache.stock.data;
    if (!data) return;
    _invLastData = { ...data };

    const allChips  = document.querySelectorAll('.inv-zone-chip');

    _invOptions = { zones, skipZeros, allZones };

    _invItems = Object.entries(data)
        .filter(([k, p]) => {
            if (k.startsWith('_tmp_')) return false;
            if (skipZeros && (p.quantidade || 0) === 0) return false;
            if (zones !== null) {
                const z = (p.localizacao||'').trim().toUpperCase();
                return zones.includes(z);
            }
            return true;
        })
        .sort(([,a],[,b]) => {
            const la = (a.localizacao||'ZZZ').toUpperCase();
            const lb = (b.localizacao||'ZZZ').toUpperCase();
            return la !== lb ? la.localeCompare(lb,'pt') : (a.nome||'').localeCompare(b.nome||'','pt');
        });

    if (_invItems.length === 0) {
        showToast('Nenhum produto corresponde aos filtros seleccionados', 'error'); return;
    }

    _invIdx     = 0;
    _invChanges = {};
    _invSkipped = new Set();

    modalOpen('inv-modal');
    focusModal('inv-modal');
    _renderInvStep();
}

function _resumeInventory(saved) {
    closeConfirmModal();
    _invItems    = saved.items;
    _invIdx      = saved.idx;
    _invChanges  = saved.changes;
    _invSkipped  = new Set(saved.skipped || []);
    _invOptions  = saved.options || { zones: null, skipZeros: false };
    // Bug 5: garantir que _invLastData não é null ao exportar depois de retomar
    _invLastData = cache.stock.data ? { ...cache.stock.data } : null;
    if (!_invLastData) {
        fetchCollection('stock', false).then(d => { if (d) _invLastData = { ...d }; });
    }
    modalOpen('inv-modal');
    focusModal('inv-modal');
    _renderInvStep();
    showToast(`A retomar — produto ${_invIdx + 1} de ${_invItems.length}`);
}

let _invStepAt = 0;

function _renderInvStep() {
    _invStepAt = performance.now();
    const total      = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    $id('inv-progress-text').textContent = `${_invIdx + 1} / ${total}`;
    $id('inv-progress-bar').style.width  = `${Math.round((_invIdx / total) * 100)}%`;

    // Zone progress: "Zona 201-001A — 4 de 12"
    const zonaEl = $id('inv-zone-progress');
    if (zonaEl) {
        const zona = (item.localizacao||'').trim().toUpperCase() || 'SEM LOCAL';
        const zonaItems = _invItems.filter(([,p]) => (p.localizacao||'').trim().toUpperCase() === zona || (zona === 'SEM LOCAL' && !(p.localizacao||'').trim()));
        const zonaIdx   = zonaItems.findIndex(([i]) => i === id);
        // zona vem de Firebase (localização) — escapar para evitar injection.
        zonaEl.innerHTML = `<strong>${escapeHtml(zona)}</strong> — ${zonaIdx + 1} de ${zonaItems.length}`;
    }

    const zona = (item.localizacao||'').trim().toUpperCase();
    $id('inv-local').textContent = zona ? zona : 'SEM LOCAL';
    $id('inv-ref').textContent   = item.codigo  || '';
    $id('inv-nome').textContent  = item.nome    || '';
    $id('inv-unidade').textContent =
        item.unidade && item.unidade !== 'un' ? item.unidade : '';

    // Foto do produto
    const photoImg = $id('inv-photo-img');
    const photoPlaceholder = $id('inv-photo-placeholder');
    if (photoImg && photoPlaceholder) {
        if (item.imgUrl) {
            photoImg.src = item.imgUrl;
            photoImg.style.display = 'block';
            photoImg.style.cursor  = 'zoom-in';
            // ignora o "clique fantasma" do toque que acabou de mudar de passo
            photoImg.onclick = () => { if (performance.now() - _invStepAt < 600) return; openImageViewer(item.imgUrl, item.nome, item.codigo); };
            photoPlaceholder.style.display = 'none';
        } else {
            photoImg.style.display = 'none';
            photoPlaceholder.style.display = 'flex';
        }
    }

    // Limpar search ao navegar
    invSearchClear();

    // Badge de zona filtrada
    const badge = $id('inv-zone-badge');
    if (badge) {
        if (_invOptions.zones !== null && !_invOptions.allZones) {
            badge.textContent = `${_invOptions.zones.length} zona${_invOptions.zones.length > 1 ? 's' : ''}`;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    }

    // Quantidade: usa valor já confirmado se existir, senão o original
    const currentVal = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
    const qtyInput   = $id('inv-qtd');
    qtyInput.value   = currentVal;
    qtyInput.focus();
    qtyInput.select();

    // Enter = Confirmar (fix bug UX mobile — substitui listener anterior para evitar duplicados)
    const newInput = qtyInput.cloneNode(true);
    qtyInput.parentNode.replaceChild(newInput, qtyInput);
    newInput.value = currentVal;
    newInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); invConfirm(); }
    });
    newInput.focus();
    newInput.select();

    // Mostra a quantidade original do sistema como referência
    const origEl = $id('inv-orig-qty');
    if (origEl) {
        const orig = item.quantidade || 0;
        origEl.textContent = `Sistema: ${fmtQty(orig, item.unidade)}`;
        origEl.className   = 'inv-orig-qty' + (_invChanges[id] !== undefined && _invChanges[id] !== orig ? ' inv-orig-changed' : '');
    }

    $id('inv-prev-btn').disabled = _invIdx === 0;
    _invSaveResume();
}

function invQtyDelta(delta) {
    const el = $id('inv-qtd');
    if (!el) return;
    el.value = Math.max(0, (parseFloat(el.value) || 0) + delta);
    el.focus();
}

function invConfirm() {
    const [id] = _invItems[_invIdx] || [];
    if (!id) return;
    const val = parseFloat($id('inv-qtd').value);
    if (!isNaN(val) && val >= 0) {
        _invChanges[id] = val;
        _invSkipped.delete(id);
    }
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invSkip() {
    const [id] = _invItems[_invIdx] || [];
    if (id) _invSkipped.add(id);
    if (_invIdx < _invItems.length - 1) { _invIdx++; _renderInvStep(); }
    else _finishInventory();
}

function invPrev() {
    if (_invIdx > 0) { _invIdx--; _renderInvStep(); }
}

function closeInventory() {
    modalClose('inv-modal');
    invSearchClear();
    // Progresso guardado — não apaga para possível retoma
}

// ── Pesquisa inline no inventário ────────────────────────────────────────────
function invSearchInput(q) {
    const clearBtn = $id('inv-search-clear');
    const results  = $id('inv-search-results');
    if (!q.trim()) { invSearchClear(); return; }
    if (clearBtn) clearBtn.style.display = 'flex';
    results.style.display = 'flex';
    results.innerHTML = '';

    const term = q.trim().toLowerCase();
    // Produto actual para referência de zona
    const [curId, curItem] = _invItems[_invIdx] || [];
    const curZona = (curItem?.localizacao||'').trim().toUpperCase();

    // Encontrar matches (ref ou nome)
    const matches = _invItems
        .map(([id, item], idx) => ({ id, item, idx }))
        .filter(({ item }) =>
            (item.codigo||'').toLowerCase().includes(term) ||
            (item.nome||'').toLowerCase().includes(term)
        )
        .slice(0, 6);

    if (matches.length === 0) {
        results.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);padding:8px 0;text-align:center">Sem resultados</div>';
        return;
    }

    matches.forEach(({ id, item, idx }) => {
        const zona      = (item.localizacao||'').trim().toUpperCase() || 'SEM LOCAL';
        const isCurrent = idx === _invIdx;
        const isConfirmed = _invChanges[id] !== undefined;

        const card = $el('div');
        card.className = 'inv-search-result' + (isCurrent ? ' inv-search-current' : '');

        // Header: ref + zona
        const hdr = $el('div', { className: 'inv-search-result-header' });
        const ref = $el('span', { className: 'inv-search-result-ref' });
        ref.textContent = item.codigo || '—';
        const zonaBadge = $el('span', { className: 'inv-search-result-zona' });
        zonaBadge.textContent = zona;
        hdr.appendChild(ref); hdr.appendChild(zonaBadge);

        // Nome
        const nome = $el('div', { className: 'inv-search-result-nome' });
        nome.textContent = item.nome || id;

        // Acções
        const acts = $el('div', { className: 'inv-search-result-actions' });

        if (!isCurrent) {
            const btnGoto = $el('button', { className: 'inv-search-btn-goto', textContent: 'Ir para →' });
            btnGoto.onclick = () => _invSearchJumpTo(idx);

            const btnOnly = $el('button', { className: 'inv-search-btn-only', textContent: 'Confirmar só este' });
            btnOnly.onclick = () => _invSearchConfirmOnly(id, item);

            acts.appendChild(btnGoto); acts.appendChild(btnOnly);
        } else {
            const lbl = $el('span');
            lbl.style.cssText = 'font-size:0.75rem;color:var(--primary);font-weight:700;padding:4px 0';
            lbl.textContent = '← Produto actual';
            acts.appendChild(lbl);
        }

        // Contexto: outros produtos da mesma zona (até 3)
        const zonaNeighbours = _invItems
            .map(([i, p], ni) => ({ i, p, ni }))
            .filter(({ i, p }) => i !== id && (p.localizacao||'').trim().toUpperCase() === zona)
            .slice(0, 3);

        if (zonaNeighbours.length > 0) {
            const ctx = $el('div', { className: 'inv-search-result-ctx' });
            zonaNeighbours.forEach(({ i, p, ni }) => {
                const row = $el('div');
                row.className = 'inv-search-ctx-row' + (ni === _invIdx ? ' ctx-current' : '');
                const confirmed = _invChanges[i] !== undefined;
                row.innerHTML = `<span>${escapeHtml(p.codigo || '—')} · ${escapeHtml((p.nome||'').slice(0,22))}</span>`
                    + `<span style="color:${confirmed?'var(--success)':'var(--text-muted)'}">${confirmed ? '✓' : '–'}</span>`;
                ctx.appendChild(row);
            });
            card.appendChild(hdr); card.appendChild(nome); card.appendChild(acts); card.appendChild(ctx);
        } else {
            card.appendChild(hdr); card.appendChild(nome); card.appendChild(acts);
        }

        results.appendChild(card);
    });
}

function invSearchClear() {
    const inp      = $id('inv-search-input');
    const clearBtn = $id('inv-search-clear');
    const results  = $id('inv-search-results');
    if (inp)      inp.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (results)  { results.style.display = 'none'; results.innerHTML = ''; }
}

function _invSearchJumpTo(idx) {
    _invIdx = idx;
    invSearchClear();
    _renderInvStep();
}

function _invSearchConfirmOnly(id, item) {
    const inp = $id('inv-search-input');
    // Abre modal rápido de confirmação para este produto
    openConfirmModal({
        title: `Confirmar ${item.codigo || id}`,
        desc: `Quantidade actual de "${item.nome || id}"? (Sistema: ${item.quantidade || 0})`,
        type: 'confirm', okLabel: 'Confirmar',
        onConfirm: () => {
            const val = parseFloat($id('inv-qtd')?.value);
            if (!isNaN(val) && val >= 0) {
                _invChanges[id] = val;
                _invSkipped.delete(id);
                _invSaveResume();
                showToast(`${item.codigo || id} confirmado`);
                invSearchClear();
            }
        },
    });
    // Injecta input no slot dedicado do modal
    const slot = $id('confirm-modal-slot');
    if (slot) {
        const qInput = $el('input');
        qInput.type = 'number'; qInput.min = '0'; qInput.step = 'any';
        qInput.value = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
        qInput.className = 'inv-qty-input';
        qInput.id = 'inv-qtd';
        qInput.style.cssText = 'width:100%;text-align:center';
        qInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $id('confirm-modal-ok').click(); }});
        slot.appendChild(qInput);
        setTimeout(() => { qInput.focus(); qInput.select(); }, 50);
    }
}

// ── Guardar progresso parcial ─────────────────────────────────────────────────
function _openInvSavePartial() {
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;
    const remaining = _invItems.length - confirmed - skipped;

    const statsEl = $id('inv-partial-stats');
    if (statsEl) {
        statsEl.innerHTML = `
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--success)">${confirmed}</span>
                <span class="inv-partial-stat-lbl">Confirmados</span>
            </div>
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--danger)">${skipped}</span>
                <span class="inv-partial-stat-lbl">Saltados</span>
            </div>
            <div class="inv-partial-stat">
                <span class="inv-partial-stat-num" style="color:var(--text-muted)">${remaining}</span>
                <span class="inv-partial-stat-lbl">Por fazer</span>
            </div>`;
    }
    modalOpen('inv-partial-modal');
    focusModal('inv-partial-modal');
}

// Guarda progresso no Firebase (já está guardado incrementalmente) e sai para o menu
async function invSaveAndExit() {
    // Força um último save para garantir que está actualizado
    await _invSaveResume();
    // Fecha todos os modais do inventário
    modalClose('inv-partial-modal');
    modalClose('inv-modal');
    invSearchClear();
    showToast('Progresso guardado — podes retomar em qualquer dispositivo', 'success');
}

async function exportInventoryPartialEmail() {
    // Guarda no Firebase antes de exportar
    await _invSaveResume();
    modalClose('inv-partial-modal');
    // Fecha o inventário
    modalClose('inv-modal');
    invSearchClear();
    await exportInventoryEmail(true); // true = parcial
}

function _finishInventory() {
    modalClose('inv-modal');
    _invClearResume(); // limpa a sessão guardada

    const data = cache.stock.data || {};
    const changed = Object.entries(_invChanges).filter(([id, newQty]) => {
        const oldQty = data[id]?.quantidade;
        return oldQty !== undefined && newQty !== oldQty;
    });

    // Abre modal de revisão
    _openInvReview(changed, data);
}

function _openInvReview(changed, data) {
    const total     = _invItems.length;
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;

    const descEl = $id('inv-review-desc');
    descEl.textContent = changed.length === 0
        ? `${confirmed} produto${confirmed !== 1?'s':''} confirmado${confirmed !== 1?'s':''} — sem diferenças de quantidade.`
        : `${changed.length} diferença${changed.length !== 1?'s':''} encontrada${changed.length !== 1?'s':''}. Revê e confirma antes de guardar.`;

    const listEl = $id('inv-review-list');
    listEl.innerHTML = '';

    if (changed.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Tudo conforme ✓</div>';
    } else {
        changed.forEach(([id, newQty]) => {
            const item   = data[id] || {};
            const oldQty = item.quantidade || 0;
            const diff   = newQty - oldQty;
            const row = $el('label', { className: 'inv-review-row' });

            const cb  = $el('input');
            cb.type   = 'checkbox';
            cb.checked = true;
            cb.dataset.id = id;
            cb.className  = 'inv-review-cb';

            const info = $el('div', { className: 'inv-review-info' });

            const nome = $el('span', { className: 'inv-review-nome' });
            nome.textContent = item.nome || id;

            const qty = $el('span', { className: 'inv-review-qty' });
            const sign = diff > 0 ? '+' : '';
            const oldSpan = $el('span', { className: 'inv-rev-old' });
            oldSpan.textContent = fmtQty(oldQty, item.unidade);
            const arr  = document.createTextNode(' → ');
            const newSpan = $el('span', { className: 'inv-rev-new' });
            newSpan.textContent = fmtQty(newQty, item.unidade);
            const sp = document.createTextNode(' ');
            const diffSpan = $el('span');
            diffSpan.className   = 'inv-rev-diff ' + (diff > 0 ? 'inv-rev-plus' : 'inv-rev-minus');
            diffSpan.textContent = '(' + sign + fmtQty(diff, item.unidade) + ')';
            qty.appendChild(oldSpan); qty.appendChild(arr);
            qty.appendChild(newSpan); qty.appendChild(sp); qty.appendChild(diffSpan);

            info.appendChild(nome);
            info.appendChild(qty);
            row.appendChild(cb);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    }

    modalOpen('inv-review-modal');
    focusModal('inv-review-modal');
}

function invReviewBack() {
    modalClose('inv-review-modal');
    // Reabre o inventário no último produto
    modalOpen('inv-modal');
    _invSaveResume();
}

async function invReviewConfirm() {
    modalClose('inv-review-modal');

    const data    = cache.stock.data || {};
    const checked = [...document.querySelectorAll('.inv-review-cb:checked')].map(cb => cb.dataset.id);

    // Estatísticas para o ecrã de resultado
    let totalAdded   = 0;
    let totalRemoved = 0;
    let savedCount   = 0;

    // Calcula estatísticas e actualiza cache local primeiro
    const patches = [];
    for (const id of checked) {
        const newQty = _invChanges[id];
        const oldQty = data[id]?.quantidade || 0;
        if (newQty === undefined) continue;
        const diff = newQty - oldQty;
        if (diff > 0) totalAdded   += diff;
        if (diff < 0) totalRemoved += Math.abs(diff);
        savedCount++;
        if (data[id]) data[id].quantidade = newQty;
        patches.push({ id, newQty });
    }
    // Envia todos os PATCHes em paralelo — muito mais rápido que em série
    const results = await Promise.allSettled(
        patches.map(({ id, newQty }) =>
            apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: newQty })
            })
        )
    );
    if (results.some(r => r.status === 'rejected')) {
        console.warn('invSave: alguns PATCHes falharam');
        invalidateCache('stock');
    }

    renderList(window._searchInputEl?.value || '', true);
    renderDashboard();

    // Guardar snapshot final para exportação
    _invLastData = { ...cache.stock.data };

    // Mostrar resultado com stats
    _openInvResult({
        total:      _invItems.length,
        confirmed:  Object.keys(_invChanges).length,
        skipped:    _invSkipped.size,
        saved:      savedCount,
        added:      totalAdded,
        removed:    totalRemoved,
    });
}

function _openInvResult(stats) {
    const statsEl = $id('inv-result-stats');
    statsEl.innerHTML = `
        <div class="inv-stat-grid">
            <div class="inv-stat-card inv-stat-ok">
                <span class="inv-stat-num">${stats.confirmed}</span>
                <span class="inv-stat-label">Confirmados</span>
            </div>
            <div class="inv-stat-card inv-stat-skip">
                <span class="inv-stat-num">${stats.skipped}</span>
                <span class="inv-stat-label">Saltados</span>
            </div>
            <div class="inv-stat-card inv-stat-plus">
                <span class="inv-stat-num">+${stats.added}</span>
                <span class="inv-stat-label">Unid. adicionadas</span>
            </div>
            <div class="inv-stat-card inv-stat-minus">
                <span class="inv-stat-num">−${stats.removed}</span>
                <span class="inv-stat-label">Unid. removidas</span>
            </div>
        </div>
        ${stats.saved > 0
            ? `<p class="inv-result-saved">${stats.saved} alteração${stats.saved !== 1?'s':''} guardada${stats.saved !== 1?'s':''} no sistema.</p>`
            : '<p class="inv-result-saved">Nenhuma diferença encontrada — stock conforme!</p>'}
    `;
    modalOpen('inv-result-modal');
    focusModal('inv-result-modal');
}

async function exportInventoryExcel() {
    await loadXlsx();
    const wb       = _buildInventoryWorkbook();
    const filename = `inventario-gestao-armazem-${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel exportado com sucesso!');
}

async function exportInventoryEmail(parcial = false) {
    await loadXlsx();
    const now     = new Date();
    const dateStr = now.toLocaleDateString('pt-PT');
    const data    = _invLastData || cache.stock.data || {};
    const diffRows = _invItems
        .filter(([id]) => {
            const nq = _invChanges[id];
            return nq !== undefined && nq !== (data[id]?.quantidade || 0);
        })
        .map(([id, item]) => {
            const nq = _invChanges[id];
            const oq = item.quantidade || 0;
            return `• ${item.nome||id} (${item.localizacao||'sem zona'}): ${fmtQty(oq, item.unidade)} → ${fmtQty(nq, item.unidade)}`;
        });

    const parcialLabel = parcial ? ' [PARCIAL]' : '';
    const subject = encodeURIComponent(`Inventário Gestão Armazém${parcialLabel} — ${dateStr}`);
    const body = encodeURIComponent(
        `Inventário Gestão Armazém${parcialLabel} — ${dateStr}\n\n`
        + `Produtos verificados: ${Object.keys(_invChanges).length}/${_invItems.length}\n`
        + (parcial ? `Por verificar: ${_invItems.length - Object.keys(_invChanges).length - _invSkipped.size}\n` : '')
        + `Diferenças encontradas: ${diffRows.length}\n\n`
        + (diffRows.length > 0 ? 'ALTERAÇÕES:\n' + diffRows.join('\n') + '\n\n' : 'Sem diferenças de stock.\n\n')
        + '(Ficheiro Excel em anexo)'
    );

    const destEmail = _invGetEmail();

    // Tenta Web Share API com ficheiro (Android)
    if (navigator.canShare) {
        try {
            const wb   = _buildInventoryWorkbook();
            const blob = new Blob(
                [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            );
            const filename = `inventario-gestao-armazem${parcial ? '-parcial' : ''}-${now.toISOString().slice(0,10)}.xlsx`;
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: `Inventário Gestão Armazém${parcialLabel} — ${dateStr}`,
                    text:  `Relatório de inventário de ${dateStr}`,
                    files: [file],
                });
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('share:', e);
        }
    }

    // Fallback: download do Excel + mailto com destinatário pré-preenchido
    exportInventoryExcel();
    setTimeout(() => {
        const mailto = destEmail
            ? `mailto:${encodeURIComponent(destEmail)}?subject=${subject}&body=${body}`
            : `mailto:?subject=${subject}&body=${body}`;
        window.open(mailto, '_blank');
    }, 800);
}

// Helper partilhado por exportInventoryEmail e exportInventoryExcel
function _buildInventoryWorkbook() {
    const data = _invLastData || cache.stock.data || {};
    const now  = new Date();
    const rows = _invItems.map(([id, item]) => {
        const newQty  = _invChanges[id];
        const origQty = item.quantidade || 0;
        const status  = _invSkipped.has(id) ? 'Saltado'
            : newQty === undefined ? 'Não verificado'
            : newQty === origQty   ? 'Conforme'
            : newQty > origQty     ? 'Corrigido ↑' : 'Corrigido ↓';
        return {
            'Referência': item.codigo||'', 'Nome': item.nome||'',
            'Zona': item.localizacao||'SEM LOCAL',
            'Qtd Sistema': origQty,
            'Qtd Inventário': newQty !== undefined ? newQty : origQty,
            'Diferença': newQty !== undefined ? newQty - origQty : 0,
            'Unidade': item.unidade === 'un' || !item.unidade ? '' : item.unidade,
            'Estado': status, 'Notas': item.notas||'',
        };
    });
    const wb  = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(rows);
    ws1['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, 'Inventário Completo');
    const diffRows = rows.filter(r => r['Diferença'] !== 0);
    if (diffRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(diffRows);
        ws2['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws2, 'Diferenças');
    }
    const ws3 = XLSX.utils.aoa_to_sheet([
        ['Gestão Armazém — Relatório de Inventário',''],
        ['Data', now.toLocaleDateString('pt-PT')],
        ['Hora', now.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})],
        ['Produtos verificados', Object.keys(_invChanges).length],
        ['Produtos saltados', _invSkipped.size],
        ['Total de produtos', _invItems.length],
        ['Diferenças encontradas', diffRows.length],
    ]);
    ws3['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Resumo');
    return wb;
}

// ── Inventário Resume — Firebase /inv-resume/shared (72h TTL) ──────────────
// Caminho único partilhado — não depende do dispositivo nem do username em localStorage
const INV_RESUME_FIREBASE_TTL = 72 * 60 * 60 * 1000; // 72 horas em ms

function _invResumeUserKey() {
    const username = (localStorage.getItem(USER_KEY) || '').trim().toLowerCase();
    return username && /^[a-z0-9._-]+$/.test(username) ? username : 'anon-device';
}

function _invResumeUrl() {
    return `${BASE_URL}/inv-resume/${encodeURIComponent(_invResumeUserKey())}.json`;
}

async function _invSaveResume() {
    try {
        const payload = JSON.stringify({
            idx:     _invIdx,
            items:   _invItems,
            changes: _invChanges,
            skipped: [..._invSkipped],
            options: _invOptions,
            ts:      Date.now(),
        });
        const url = await authUrl(_invResumeUrl());
        // await o fetch — garante que os dados chegaram ao Firebase antes de continuar
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload });
    } catch (e) { console.warn('invSaveResume:', e); }
}

async function _invLoadResume() {
    try {
        const url = await authUrl(_invResumeUrl());
        const res = await fetch(url);
        if (!res.ok) {
            console.warn('invLoadResume: resposta', res.status, res.statusText);
            return null;
        }
        const saved = await res.json();
        if (!saved || !saved.items || saved.items.length === 0) {
            return null;
        }
        if (Date.now() - (saved.ts || 0) > INV_RESUME_FIREBASE_TTL) {
            _invClearResume();
            return null;
        }
        return saved;
    } catch (e) {
        console.warn('invLoadResume erro:', e);
        return null;
    }
}

async function _invClearResume() {
    try {
        const url = await authUrl(_invResumeUrl());
        fetch(url, { method: 'DELETE' }).catch(() => {});
    } catch (_e) {}
}
