// ─────────────────────────────────────────────────────────────────────────────
// pats.js — Hiperfrio v6.55
// Pedidos PAT: render, cards, mapa Leaflet, geocoding, clientes, levantar.
// Carrega DEPOIS de stock.js (usa _commitStockDelta) e ANTES de app.js.
//
// Dependências:
//   utils.js   → $id, $el, escapeHtml, showToast, modalOpen, modalClose,
//                focusModal, _calcDias, _debounce, _fetchWithTimeout, loadXlsx
//   auth.js    → currentRole, requireManagerAccess, apiFetch, authUrl
//   reports.js → registarMovimento, _relSalvarPatAntesDeApagar,
//                _autoFecharMesSeNecessario
//   stock.js   → _commitStockDelta
//   app.js     → cache, fetchCollection, invalidateCache, renderDashboard,
//                renderList, openConfirmModal, nav, _encData
// ─────────────────────────────────────────────────────────────────────────────

// ── MAPA DE PEDIDOS PAT — Leaflet + Nominatim (OpenStreetMap)

function _createClusterGroup() {
    return L.markerClusterGroup({
        maxClusterRadius: 40,
        disableClusteringAtZoom: 9,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        iconCreateFunction(cluster) {
            const count = cluster.getChildCount();
            const size  = count < 5 ? 36 : count < 10 ? 42 : 48;
            return L.divIcon({
                html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#334155;border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;cursor:pointer"><span style="font-size:13px;font-weight:800;color:#fff;font-family:DM Sans,sans-serif">${count}</span></div>`,
                className: '',
                iconSize: [size, size],
                iconAnchor: [size/2, size/2],
            });
        },
    });
}

let _patMap            = null;  // instância Leaflet
let _patMapCluster     = null;  // MarkerClusterGroup do mapa principal
let _markerJustClicked = false;
let _patMapMarkers = [];
let _patMapOpen    = false;

// ── Geocoding cache — Firebase /geocode-cache/ ────────────────────────────
// Fonte de verdade principal: /clientes/{id}.lat + .lng
// Cache secundária: /geocode-cache/{key} para nomes sem cliente correspondente
const _geocodeCache = {};         // memória: key → {lat,lng} | null
let   _geocodeCacheLoaded = false;

const GEOCODE_CACHE_URL = `${BASE_URL}/geocode-cache.json`;

function _normEstabKey(nome) {
    return String(nome || '')
        .trim()
        .toLowerCase()
        .replace(/-\s*\d+\s*$/, '')   // remove " - 524" no fim
        .replace(/\s+\d+\s*$/, '')     // remove número solto
        .replace(/[()]/g, '')
        .trim();
}

function _firebaseGeocodeKey(key) {
    return key.replace(/[.#$\/\[\]\s]/g, '_');
}

// Encontrar cliente correspondente a um nome de estabelecimento
function _findClienteByEstab(nome, clienteNumero = '', clienteId = '') {
    const clientes = _clientesCache.data || {};
    const key = _normEstabKey(nome);

    // 0. Por Firebase ID directo — o mais fiável (sem ambiguidade)
    if (clienteId && clientes[clienteId]) {
        return [clienteId, clientes[clienteId]];
    }

    // 1. Por número + nome em conjunto (elimina ambiguidade de nº repetido)
    if (clienteNumero) {
        const byNumNome = Object.entries(clientes).find(([, c]) =>
            String(c.numero || '').trim() === String(clienteNumero).trim() &&
            _normEstabKey(c.nome) === key
        );
        if (byNumNome) return byNumNome;

        // 1b. Só por número (quando há um único com esse nº)
        const byNum = Object.entries(clientes).filter(([, c]) =>
            String(c.numero || '').trim() === String(clienteNumero).trim()
        );
        if (byNum.length === 1) return byNum[0];
    }

    // 2. Por nome normalizado exacto
    const byNome = Object.entries(clientes).find(([, c]) =>
        _normEstabKey(c.nome) === key
    );
    if (byNome) return byNome;

    // 3. Por nome parcial (último recurso)
    const byPartial = Object.entries(clientes).find(([, c]) => {
        const ck = _normEstabKey(c.nome);
        return ck.length > 4 && (key.includes(ck) || ck.includes(key));
    });
    return byPartial || null;
}

// Guardar coords no cliente Firebase + geocode-cache
async function _persistEstabCoords(nome, coords, clienteNumero = '', clienteId = '') {
    const key = _normEstabKey(nome);
    if (!key || coords?.lat == null || coords?.lng == null) return;

    const lat = parseFloat(coords.lat);
    const lng = parseFloat(coords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    // Actualizar memória
    _geocodeCache[key] = { lat, lng };

    // Guardar na geocode-cache Firebase (sempre)
    const fbKey = _firebaseGeocodeKey(key);
    try {
        const url = await authUrl(`${BASE_URL}/geocode-cache/${encodeURIComponent(fbKey)}.json`);
        fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, ts: Date.now() })
        }).catch(() => {});
    } catch(_e) {}

    // Guardar nas coordenadas do cliente (fonte de verdade)
    const clienteMatch = _findClienteByEstab(nome, clienteNumero, clienteId);
    if (!clienteMatch) {
        return;
    }

    const [matchedId, cliente] = clienteMatch;
    const oldLat = parseFloat(cliente.lat);
    const oldLng = parseFloat(cliente.lng);
    const unchanged = Number.isFinite(oldLat) && Number.isFinite(oldLng)
        && Math.abs(oldLat - lat) < 0.000001
        && Math.abs(oldLng - lng) < 0.000001;
    if (unchanged) return;

    if (_clientesCache.data?.[matchedId]) {
        _clientesCache.data[matchedId] = { ..._clientesCache.data[matchedId], lat, lng };
    }
    try {
        await apiFetch(`${BASE_URL}/clientes/${matchedId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng })
        });
    } catch(e) {
        console.warn('[geocache] falha ao guardar no cliente:', matchedId, e?.message);
    }
}

function _getMapPendingPatsForEstab(nome) {
    const key = _normEstabKey(nome);
    return Object.entries(_patCache.data || {})
        .filter(([, p]) =>
            _normEstabKey(p.estabelecimento) === key
            && p.status !== 'levantado'
            && p.status !== 'historico'
        );
}

// Carrega toda a cache do Firebase para memória (1 fetch, feito uma vez)
async function _loadGeocodeCache() {
    // ── Passo 1: Clientes — sempre frescos, nunca em cache ────────────────
    // São a fonte de verdade. Se o utilizador editar coords na administração,
    // a próxima abertura do mapa reflecte sempre as coords actualizadas.
    const clientes = await _fetchClientes(true); // force=true para ir sempre à Firebase
    Object.values(clientes).forEach(c => {
        if (c.lat != null && c.lng != null && c.nome) {
            const key = _normEstabKey(c.nome);
            if (key) _geocodeCache[key] = { lat: parseFloat(c.lat), lng: parseFloat(c.lng) };
        }
    });

    // ── Passo 2: geocode-cache Firebase — só carregada uma vez por sessão ──
    // Só preenche estabelecimentos sem cliente correspondente (ex: novos locais).
    // Nunca sobrescreve as coords dos clientes.
    if (!_geocodeCacheLoaded) {
        try {
            const url = await authUrl(GEOCODE_CACHE_URL);
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object') {
                    const GEOCODE_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // retentar nulos após 7 dias
                    Object.entries(data).forEach(([k, v]) => {
                        const rawKey = _normEstabKey(v?.keyOriginal || k.replace(/_/g, ' '));
                        if (!rawKey || _geocodeCache[rawKey] !== undefined) return; // clientes têm prioridade
                        // Entradas null com mais de 7 dias são ignoradas — serão retentadas pelo Nominatim
                        if (v?.lat == null && v?.ts && (Date.now() - v.ts) > GEOCODE_RETRY_MS) return;
                        _geocodeCache[rawKey] = (v?.lat != null && v?.lng != null)
                            ? { lat: v.lat, lng: v.lng } : null;
                    });
                }
            } else {
                console.warn(`[geocache] HTTP ${res.status}`);
            }
        } catch(e) {
            console.warn('[geocache] erro ao carregar geocode-cache:', e?.message);
        }
        _geocodeCacheLoaded = true;
    }

}

// Atraso entre pedidos Nominatim (1 req/s conforme ToS)
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _geocodeEstab(nome, saveToFirebase = true, clienteNumero = '', clienteId = '') {
    const key = _normEstabKey(nome);

    // 1. SEMPRE verificar coords do cliente primeiro (fonte de verdade)
    const clienteMatch = _findClienteByEstab(nome, clienteNumero, clienteId);
    if (clienteMatch) {
        const [, c] = clienteMatch;
        if (c.lat != null && c.lng != null) {
            const coords = { lat: parseFloat(c.lat), lng: parseFloat(c.lng) };
            _geocodeCache[key] = coords;
            return coords;
        }
        // Cliente existe mas sem coords → vai ao Nominatim e guarda no cliente correcto
    } else {
        // Sem cliente → usar geocode-cache como fallback
        if (_geocodeCache[key] !== undefined) return _geocodeCache[key];
    }

    // 3. Nominatim — estratégia multi-tentativa
    const cleaned = nome
        .replace(/-\s*\d+\s*$/, '')
        .replace(/\s+\d+\s*$/, '')
        .replace(/[()]/g, '')
        .trim();

    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    const stopWords = ['PINGO','DOCE','CONTINENTE','JUMBO','LIDL','ALDI','MERCADONA','BP','GALP','REPSOL','DISCOUNT','ARMAZEM','GERAL','HIPERFRIO','SUPERMERCADO','MINIPRECO','INTERMARCHE','SHOPPING','RECHEIO','LECLERC'];
    const localWords = words.filter(w => !stopWords.includes(w.toUpperCase()));

    const queries = [
        cleaned + ', Portugal',
        localWords.join(' ') + ', Portugal',
        localWords.length ? localWords[localWords.length - 1] + ', Portugal' : '',
    ].filter((q, i, arr) =>
        q && q !== 'undefined, Portugal' && q.trim() !== ', Portugal' && arr.indexOf(q) === i
    );

    for (const q of queries) {
        const encoded = encodeURIComponent(q);
        const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=pt`;
        try {
            const res = await fetch(url, {
                headers: { 'Accept-Language': 'pt-PT,pt;q=0.9', 'User-Agent': 'HiperfrioStock/1.0' }
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (data && data.length > 0) {
                const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
                if (saveToFirebase) {
                    // Guardar no cliente E na geocode-cache — usar clienteId para match exacto
                    const num = clienteNumero || clienteMatch?.[1]?.numero || '';
                    const cid = clienteId     || clienteMatch?.[0]         || '';
                    await _persistEstabCoords(nome, result, num, cid);
                } else {
                    _geocodeCache[key] = result;
                }
                return result;
            }
        } catch(e) { continue; }
        await _sleep(800);
    }

    // Não encontrado — guardar null para não repetir tentativa
    _geocodeCache[key] = null;
    if (saveToFirebase) {
        const fbKey = _firebaseGeocodeKey(key);
        try {
            const url = await authUrl(`${BASE_URL}/geocode-cache/${encodeURIComponent(fbKey)}.json`);
            fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyOriginal: key, lat: null, lng: null, ts: Date.now() }) }).catch(() => {});
        } catch(_e) {}
    }
    return null;
}

// Ícones de estabelecimentos customizados
// Para adicionar novos: { match: /regex/, icon: 'ficheiro.png', size: [w, h] }
const _CHAIN_ICONS = [
    {
        match:    /pingo\s*doce/i,
        icon:     'pingo-doce-pin.png',
        color:    '#e30613',
        initials: 'PD',
    },
    {
        match:    /continente/i,
        icon:     'continente-pin.png',
        color:    '#e30613',
        initials: 'CT',
    },
    {
        match:    /recheio/i,
        icon:     'recheio-pin.png',
        color:    '#cc0000',
        initials: 'RC',
    },
    {
        match:    /leclerc/i,
        icon:     'leclerc-pin.png',
        color:    '#003da5',
        initials: 'LC',
    },
    {
        match:    /intermarc[hé]/i,
        icon:     '',
        color:    '#007a33',
        initials: 'IM',
    },
    {
        match:    /lidl/i,
        icon:     '',
        color:    '#0050aa',
        initials: 'LI',
    },
    {
        match:    /aldi/i,
        icon:     '',
        color:    '#00539f',
        initials: 'AL',
    },
    {
        match:    /modelo\b/i,
        icon:     '',
        color:    '#e30613',
        initials: 'MC',
    },
];

function _getChainIcon(nomeEstab, zoom) {
    const nome = (nomeEstab || '').trim();
    for (const chain of _CHAIN_ICONS) {
        if (chain.match.test(nome)) return chain;
    }
    return null;
}

// Tamanho do pin escala com o zoom
function _pinSizeForZoom(zoom) {
    const w = Math.round(Math.max(31, Math.min(53, 31 * Math.pow(1.15, zoom - 7))));
    return { w, h: Math.round(w * 1.22) };
}

// Label truncada para não ficar demasiado larga no mapa
function _pinLabel(nome) {
    if (!nome) return '';
    const clean = nome.replace(/\s*-\s*\d+$/, '').trim(); // remove "- 335" do fim
    return clean.length > 22 ? clean.substring(0, 20) + '…' : clean;
}

function _makePinIcon(count, urgente, separacao, zoom, nome) {
    const { w } = _pinSizeForZoom(zoom ?? (_patMap ? _patMap.getZoom() : 7));
    const bgColor   = urgente ? '#dc2626' : separacao ? '#d97706' : '#334155';
    const showLabel = (zoom ?? 7) >= 6;
    const label     = showLabel ? _pinLabel(nome) : '';
    const fs        = Math.max(9, Math.round(w * 0.32));
    const countBadge = count > 1
        ? `<div style="position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:99px;font-size:9px;font-weight:800;padding:1px 5px;border:1.5px solid #fff;white-space:nowrap">${count}</div>`
        : '';
    const labelHtml = label
        ? `<div style="position:absolute;top:${w+6}px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(15,23,42,0.82);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:0.01em;pointer-events:none;font-family:DM Sans,sans-serif">${label}</div>`
        : '';
    const totalH = w + (label ? 28 : 0);
    const html = `<div style="position:relative;width:${w}px;height:${totalH}px">
        <div style="width:${w}px;height:${w}px;border-radius:50%;background:${bgColor};border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;cursor:pointer">
            <span style="font-size:${fs}px;font-weight:800;color:#fff;font-family:DM Sans,sans-serif">${count > 1 ? count : ''}</span>
        </div>
        ${countBadge}
        ${labelHtml}
    </div>`;
    return L.divIcon({
        className: '',
        html,
        iconSize:    [w, totalH],
        iconAnchor:  [Math.round(w/2), Math.round(w/2)],
        popupAnchor: [0, -(Math.round(w/2)+4)],
    });
}

function _makeChainIconAtZoom(chain, zoom, urgente, separacao, nome) {
    const { w } = _pinSizeForZoom(zoom ?? (_patMap ? _patMap.getZoom() : 7));
    const showLabel = (zoom ?? 7) >= 6;
    const label     = showLabel ? _pinLabel(nome || '') : '';
    const totalH    = w + (label ? 28 : 0);
    const imgHtml = chain.icon
        ? `<img style="width:70%;height:70%;object-fit:contain;display:block" src="${chain.icon}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt=""><div style="display:none;font-size:${Math.round(w*0.3)}px;font-weight:800;color:#334155;font-family:DM Sans,sans-serif">${chain.initials||'?'}</div>`
        : `<div style="font-size:${Math.round(w*0.3)}px;font-weight:800;color:#334155;font-family:DM Sans,sans-serif">${chain.initials||'?'}</div>`;
    const labelHtml = label
        ? `<div style="position:absolute;top:${w+6}px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(15,23,42,0.82);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:0.01em;pointer-events:none;font-family:DM Sans,sans-serif">${label}</div>`
        : '';
    const html = `<div style="position:relative;width:${w}px;height:${totalH}px">
        <div style="width:${w}px;height:${w}px;border-radius:50%;background:#fff;border:2.5px solid #334155;box-shadow:0 2px 8px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden">
            ${imgHtml}
        </div>
        ${labelHtml}
    </div>`;
    return L.divIcon({
        className: '',
        html,
        iconSize:    [w, totalH],
        iconAnchor:  [Math.round(w/2), Math.round(w/2)],
        popupAnchor: [0, -(Math.round(w/2)+4)],
    });
}

// ── Map Pin Bottom-Sheet ─────────────────────────────────────────────────────
let _mapPinCoords  = null;
let _mapPinExpanded = null; // id da PAT expandida (modo detalhe)

function openMapPinSheet(pats, coords) {
    _mapPinCoords   = coords;
    _mapPinExpanded = pats.length === 1 ? pats[0][0] : null;

    const sheet = $id('map-pin-sheet');
    if (!sheet) return;

    _renderMapPinSheet(pats);
    sheet.classList.remove('closing');
    sheet.classList.add('open');

    // Posicionar junto ao pin após render (precisamos da altura real)
    requestAnimationFrame(() => _positionSheetNearPin(coords, sheet));
}

function _positionSheetNearPin(coords, sheet) {
    // Detectar qual mapa está activo e usar o container correcto
    const isPanelActive = !!_patMapPanel && !_patMapOpen;
    const activeMap     = isPanelActive ? _patMapPanel : _patMap;
    const containerId   = isPanelActive ? 'pat-map-panel-container' : 'pat-map-container';

    if (!activeMap || !coords) return;

    const point = activeMap.latLngToContainerPoint([coords.lat, coords.lng]);
    const mapContainer = $id(containerId);
    if (!mapContainer) return;

    const mapRect = mapContainer.getBoundingClientRect();
    const pinX    = mapRect.left + point.x;
    const pinY    = mapRect.top  + point.y;

    const sheetW  = sheet.offsetWidth  || 320;
    const sheetH  = sheet.offsetHeight || 200;
    const vw      = window.innerWidth;
    const vh      = window.innerHeight;
    const margin  = 12;
    const gap     = 14;

    // Preferência: acima do pin, centrado horizontalmente
    let left = pinX - sheetW / 2;
    let top  = pinY - sheetH - gap;
    let arrowBelow = true;

    // Se sair pelo topo → colocar abaixo do pin
    if (top < mapRect.top + margin) {
        top = pinY + gap;
        arrowBelow = false;
    }

    // Ajustar horizontalmente dentro dos limites do mapa
    if (left < mapRect.left + margin) left = mapRect.left + margin;
    if (left + sheetW > mapRect.right - margin) left = mapRect.right - sheetW - margin;

    // Garantir que não sai pela base
    if (top + sheetH > vh - margin) top = vh - sheetH - margin;

    sheet.style.left   = Math.round(left) + 'px';
    sheet.style.top    = Math.round(top)  + 'px';
    sheet.style.bottom = 'auto';
    sheet.style.right  = 'auto';

    // Posicionar a seta a apontar para o pin
    const arrow = $id('map-pin-arrow');
    if (arrow) {
        const arrowX    = Math.round(pinX - left);
        const clampedX  = Math.max(20, Math.min(arrowX, sheetW - 20));
        arrow.style.left      = clampedX + 'px';
        arrow.style.transform = 'translateX(-50%)';
        if (arrowBelow) {
            arrow.style.bottom   = '-7px';
            arrow.style.top      = 'auto';
            arrow.style.clipPath = 'polygon(0 0, 100% 0, 50% 100%)';
        } else {
            arrow.style.top      = '-7px';
            arrow.style.bottom   = 'auto';
            arrow.style.clipPath = 'polygon(50% 0, 0 100%, 100% 100%)';
        }
    }
}

function _renderMapPinSheet(pats) {
    const estabEl  = $id('map-pin-estab');
    const badgesEl = $id('map-pin-badges');
    const patsEl   = $id('map-pin-pats');

    const nome     = pats[0][1].estabelecimento || '—';
    const urgentes = pats.filter(([, p]) => _calcDias(p.criadoEm) >= 20);
    const comGuia  = pats.filter(([, p]) => !!p.separacao);

    // Header — nome em destaque
    estabEl.textContent = nome;
    badgesEl.innerHTML  = '';
    if (pats.length > 1) {
        const b = $el('span', { className: 'map-pin-badge count' });
        b.textContent = `${pats.length} pedidos`;
        badgesEl.appendChild(b);
    }
    if (urgentes.length > 0) {
        const b = $el('span', { className: 'map-pin-badge urgente' });
        b.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${urgentes.length} urgente${urgentes.length !== 1 ? 's' : ''}`;
        badgesEl.appendChild(b);
    }
    if (comGuia.length > 0) {
        const b = $el('span', { className: 'map-pin-badge guia', textContent: 'Guia Transporte' });
        badgesEl.appendChild(b);
    }

    patsEl.innerHTML = '';

    if (pats.length === 1) {
        // Vista única — mostrar detalhe completo directamente
        patsEl.appendChild(_buildPatDetail(pats[0], pats));
    } else {
        // Múltiplas — resumo + expandir ao clicar
        pats.forEach(([id, pat]) => {
            const dias    = _calcDias(pat.criadoEm);
            const urgente = dias >= 20;
            const diasLbl = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
            const isExpanded = _mapPinExpanded === id;

            const wrapper = $el('div');
            wrapper.className = `map-pin-pat-row${urgente ? ' urgente' : ''}`;
            wrapper.dataset.patId = id;

            // Cabeçalho resumo (sempre visível)
            const summary = $el('div', { className: 'map-pin-pat-summary' });
            summary.innerHTML = `
                <div class="map-pin-pat-top">
                    <span class="map-pin-pat-num">PAT ${pat.numero || '—'}</span>
                    <span class="map-pin-pat-age${urgente ? ' urgente' : ''}">${diasLbl}</span>
                    <span class="map-pin-pat-chevron${isExpanded ? ' open' : ''}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                </div>`;
            summary.onclick = () => {
                _mapPinExpanded = isExpanded ? null : id;
                _renderMapPinSheet(pats);
            };
            wrapper.appendChild(summary);

            // Detalhe (expansível)
            if (isExpanded) {
                wrapper.appendChild(_buildPatDetail([id, pat], pats));
            }

            patsEl.appendChild(wrapper);
        });
    }
}

function _buildPatDetail([id, pat], allPats) {
    const dias    = _calcDias(pat.criadoEm);
    const urgente = dias >= 20;
    const prods   = pat.produtos || [];

    const detail = $el('div', { className: 'map-pin-pat-detail' });

    // Tags
    if (pat.separacao) {
        const tags = $el('div', { className: 'map-pin-pat-tags' });
        tags.innerHTML = '<span class="map-pin-pat-tag guia">Guia Transporte</span>';
        detail.appendChild(tags);
    }

    // Produtos
    if (prods.length > 0) {
        const prodsEl = $el('div', { className: 'map-pin-pat-prods' });
        prods.forEach(p => {
            const chip = $el('span', { className: 'map-pin-pat-prod' });
            chip.textContent = `${p.codigo || '?'} ×${p.quantidade || 1}`;
            prodsEl.appendChild(chip);
        });
        detail.appendChild(prodsEl);
    } else {
        const empty = $el('p', { className: 'map-pin-no-prods', textContent: 'Sem produtos associados' });
        detail.appendChild(empty);
    }

    // Botão levantar com confirmação
    const levBtn = $el('button', { className: 'map-pin-lev-btn' });
    levBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Dar como levantado`;
    levBtn.onclick = () => {
        // Confirmação via modal existente da app
        openConfirmModal({
            title: 'Confirmar levantamento',
            type: 'success', okLabel: 'Levantar',
            desc: `PAT ${pat.numero || id} — ${escapeHtml(pat.estabelecimento || '')}`,
            onConfirm: async () => {
                levBtn.classList.add('loading');
                levBtn.textContent = 'A processar...';
                await marcarPatLevantado(id);
                if (_patMapOpen) await openPatMap();
                const remaining = _getMapPendingPatsForEstab(pat.estabelecimento);
                if (remaining.length === 0) {
                    setTimeout(() => closeMapPinSheet(), 600);
                } else {
                    _mapPinExpanded = null;
                    _renderMapPinSheet(remaining);
                    requestAnimationFrame(() => {
                        const sheet = $id('map-pin-sheet');
                        if (sheet && _mapPinCoords) _positionSheetNearPin(_mapPinCoords, sheet);
                    });
                }
            }
        });
    };
    detail.appendChild(levBtn);
    return detail;
}

function closeMapPinSheet() {
    const sheet = $id('map-pin-sheet');
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.add('closing');
    setTimeout(() => {
        sheet.classList.remove('open', 'closing');
        // Repor posição para próxima abertura
        sheet.style.left   = '';
        sheet.style.top    = '';
        sheet.style.bottom = '';
        sheet.style.right  = '';
    }, 200);
}

function openMapPinGmaps() {
    if (!_mapPinCoords) return;
    const { lat, lng } = _mapPinCoords;
    const nome = $id('map-pin-estab')?.textContent || '';
    const q = encodeURIComponent(nome + ', Portugal');
    window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank');
}

function centerMapOnPin() {
    if (!_patMap || !_mapPinCoords) return;
    _patMap.setView([_mapPinCoords.lat, _mapPinCoords.lng], 15, { animate: true });
}

// expandPatMap — abre SEMPRE o mapa fullscreen com geocodificação completa e pins dinâmicos
async function expandPatMap() {
    _patMapOpen = true;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $id('view-map')?.classList.add('active');
    $id('main-content')?.classList.add('map-view-active');
    window.scrollTo(0, 0);

    const loadingEl  = $id('pat-map-loading');
    const loadingTxt = $id('pat-map-loading-text');
    const errorEl    = $id('pat-map-error');
    const subtitleEl = $id('pat-map-subtitle');
    const container  = $id('pat-map-container');

    if (loadingEl)  loadingEl.style.display  = 'flex';
    if (errorEl)    errorEl.style.display    = 'none';
    if (subtitleEl) subtitleEl.textContent   = '';
    if (loadingTxt) loadingTxt.textContent   = 'A preparar mapa...';
    if (!container) return;

    const headerH     = $id('app-header')?.offsetHeight || 60;
    const mapHeaderEl = document.querySelector('.pat-map-header');
    await _sleep(60);
    const mapHeaderH  = mapHeaderEl ? mapHeaderEl.offsetHeight : 80;
    container.style.height = (window.innerHeight - headerH - mapHeaderH) + 'px';
    container.style.width  = '100%';

    // Destruir painel lateral se existir (container diferente)
    if (_patMapPanel) { try { _patMapPanel.remove(); } catch(_) {} _patMapPanel = null; _patMapPanelCluster = null; }

    // Recriar instância Leaflet para garantir container correcto
    if (_patMap) {
        if (_patMapCluster) { _patMap.removeLayer(_patMapCluster); _patMapCluster = null; }
        _patMapMarkers = [];
        try { _patMap.remove(); } catch(_) {}
        _patMap = null;
    }

    const PT_BOUNDS = L.latLngBounds(L.latLng(30.0, -31.5), L.latLng(42.2, -6.2));
    _patMap = L.map('pat-map-container', {
        center: [39.6, -8.0], zoom: 7, minZoom: 6, maxZoom: 17,
        maxBounds: PT_BOUNDS, maxBoundsViscosity: 1.0, zoomControl: true,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 20, minZoom: 6,
    }).addTo(_patMap);
    _patMapCluster = _createClusterGroup();
    _patMap.addLayer(_patMapCluster);
    _patMap.invalidateSize();
    _patMap.on('click', () => {
        if (_markerJustClicked) { _markerJustClicked = false; return; }
        closeMapPinSheet();
    });
    // Pins dinâmicos: redimensionar e mostrar/esconder labels ao fazer zoom
    _patMap.on('zoomend', () => {
        const z = _patMap.getZoom();
        _patMapMarkers.forEach(m => {
            if (!m._hipMeta) return;
            const { nome, count, urgente, separacao } = m._hipMeta;
            const chain = _CHAIN_ICONS.find(c => c.match.test(nome));
            m.setIcon(chain ? _makeChainIconAtZoom(chain, z, urgente, separacao, nome) : _makePinIcon(count, urgente, separacao, z, nome));
        });
    });

    if (loadingTxt) loadingTxt.textContent = 'A carregar pedidos...';
    const pats = await _fetchPats();
    await _fetchClientes();
    const pendentes = Object.entries(pats || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');

    if (pendentes.length === 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl)   errorEl.style.display   = 'flex';
        const errTxt = $id('pat-map-error-text');
        if (errTxt) errTxt.textContent = 'Sem pedidos pendentes para mostrar.';
        return;
    }

    if (subtitleEl) subtitleEl.textContent = 'A preparar localizações...';

    const groups = {};
    pendentes.forEach(([id, pat]) => {
        const key = _normEstabKey(pat.estabelecimento);
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        groups[key].push([id, pat]);
    });
    const groupEntries = Object.entries(groups);

    if (loadingTxt) loadingTxt.textContent = 'A carregar localizações guardadas...';
    _geocodeCacheLoaded = false;
    await _loadGeocodeCache();

    const cached  = groupEntries.filter(([k]) => _geocodeCache[k] !== undefined);
    const missing = groupEntries.filter(([k]) => _geocodeCache[k] === undefined);

    function _addMk(estabKey, items) {
        const coords = _geocodeCache[estabKey];
        if (!coords) return false;
        const urgente   = items.some(([, p]) => _calcDias(p.criadoEm) >= 20);
        const separacao = items.some(([, p]) => !!p.separacao);
        const nome      = items[0][1].estabelecimento || '';
        const count     = items.length;
        const z         = _patMap.getZoom();
        const chain     = _CHAIN_ICONS.find(c => c.match.test(nome));
        const icon      = chain ? _makeChainIconAtZoom(chain, z, urgente, separacao, nome) : _makePinIcon(count, urgente, separacao, z, nome);
        const marker    = L.marker([coords.lat, coords.lng], { icon }).addTo(_patMapCluster || _patMap);
        marker._hipMeta = { nome, count, urgente, separacao };
        const lat = coords.lat, lng = coords.lng;
        marker.on('click', () => {
            const cur = _getMapPendingPatsForEstab(items[0]?.[1]?.estabelecimento || estabKey);
            if (!cur.length) { if (_patMapCluster) _patMapCluster.removeLayer(marker); _patMapMarkers = _patMapMarkers.filter(m => m !== marker); closeMapPinSheet(); return; }
            _markerJustClicked = true;
            openMapPinSheet(cur, { lat, lng });
        });
        _patMapMarkers.push(marker);
        return true;
    }

    let geocoded = 0;
    const bounds = [];
    cached.forEach(([k, items]) => {
        if (_addMk(k, items) && _geocodeCache[k]) {
            bounds.push([_geocodeCache[k].lat, _geocodeCache[k].lng]);
            geocoded++;
        }
    });

    if (geocoded > 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (bounds.length >= 1) _patMap.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], animate: true });
        if (subtitleEl) subtitleEl.textContent = geocoded + ' estabelecimento' + (geocoded !== 1 ? 's' : '') + ' no mapa';
        setTimeout(() => _patMap && _patMap.invalidateSize(), 200);
    }

    if (missing.length === 0) {
        if (geocoded === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) { errorEl.style.display = 'flex'; const t = $id('pat-map-error-text'); if (t) t.textContent = 'Não foi possível localizar nenhum estabelecimento.'; }
        }
        _renderMapPinSheet(pendentes);
        return;
    }

    for (let i = 0; i < missing.length; i++) {
        if (!_patMapOpen) break;
        const [estabKey, items] = missing[i];
        const nomeOriginal = items[0][1].estabelecimento || estabKey;
        if (subtitleEl) subtitleEl.textContent = 'A localizar "' + nomeOriginal + '"... (' + (i+1) + '/' + missing.length + ')';
        const coords = await _geocodeEstab(nomeOriginal, true, items[0]?.[1]?.clienteNumero || '', items[0]?.[1]?.clienteId || '');
        if (!_patMapOpen || !coords) continue;
        bounds.push([coords.lat, coords.lng]);
        _addMk(estabKey, items);
        if (loadingEl) loadingEl.style.display = 'none';
        geocoded++;
        if (bounds.length >= 1) _patMap.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], animate: true });
    }
    if (subtitleEl) subtitleEl.textContent = geocoded + ' estabelecimento' + (geocoded !== 1 ? 's' : '') + ' no mapa';
    _renderMapPinSheet(pendentes);
}

async function openPatMap() {
    const isDesktop = window.innerWidth >= 768;

    // ── Desktop: inicializa mapa no painel lateral inline ─────────────────
    if (isDesktop) {
        await _openPatMapPanel();
        return;
    }

    // ── Mobile: comportamento original — navega para view-map ─────────────
    _patMapOpen = true;

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $id('view-map')?.classList.add('active');
    $id('main-content')?.classList.add('map-view-active');
    window.scrollTo(0, 0);

    const loadingEl  = $id('pat-map-loading');
    const loadingTxt = $id('pat-map-loading-text');
    const errorEl    = $id('pat-map-error');
    const subtitleEl = $id('pat-map-subtitle');
    const container  = $id('pat-map-container');

    if (loadingEl) loadingEl.style.display = 'flex';
    if (errorEl)   errorEl.style.display   = 'none';
    if (subtitleEl) subtitleEl.textContent  = '';
    if (loadingTxt) loadingTxt.textContent  = 'A preparar mapa...';

    if (!container) { console.error('[map] container não encontrado'); return; }

    // Calcular altura disponível directamente via viewport
    // vh - header (~60px) - topbar da vista (~80px) - padding bottom
    const headerEl = $id('app-header');
    const headerH  = headerEl ? headerEl.offsetHeight : 60;
    const mapHeaderEl = document.querySelector('.pat-map-header');
    await _sleep(50); // um tick para o DOM pintar
    const mapHeaderH = mapHeaderEl ? mapHeaderEl.offsetHeight : 80;
    const availH = window.innerHeight - headerH - mapHeaderH;
    container.style.height = availH + 'px';
    container.style.width  = '100%';

    // Reutilizar instância do mapa se já existir (evita reload desnecessário)
    if (_patMap) {
        if (_patMapCluster) _patMapCluster.clearLayers();
        _patMapMarkers = [];
    }

    // Bounds de Portugal continental + ilhas (Açores e Madeira incluídos)
    const PT_BOUNDS = L.latLngBounds(
        L.latLng(30.0, -31.5),   // SW — inclui Açores
        L.latLng(42.2, -6.2)     // NE — nordeste de Trás-os-Montes
    );

    if (!_patMap) { _patMap = L.map('pat-map-container', {
        center:       [39.6, -8.0],
        zoom:         7,
        minZoom:      6,
        maxZoom:      17,
        maxBounds:    PT_BOUNDS,
        maxBoundsViscosity: 1.0,
        zoomControl:  true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20,
        minZoom: 6,
    }).addTo(_patMap);

    _patMapCluster = _createClusterGroup();
    _patMap.addLayer(_patMapCluster);
    _patMap.fitBounds(PT_BOUNDS, { padding: [20, 20] });
    _patMap.invalidateSize();
    _patMap.on('click', () => {
        if (_markerJustClicked) { _markerJustClicked = false; return; }
        closeMapPinSheet();
    });
    _patMap.on('zoomend', () => {
        const z = _patMap.getZoom();
        _patMapMarkers.forEach(m => {
            if (!m._hipMeta) return;
            const { nome, count, urgente, separacao } = m._hipMeta;
            const chain = _CHAIN_ICONS.find(c => c.match.test(nome));
            m.setIcon(chain ? _makeChainIconAtZoom(chain, z, urgente, separacao, nome) : _makePinIcon(count, urgente, separacao, z, nome));
        });
    }); }

    if (loadingTxt) loadingTxt.textContent = 'A carregar pedidos...';

    // Limpar markers anteriores
    if (_patMapCluster) _patMapCluster.clearLayers();
    _patMapMarkers = [];

    // Buscar PATs pendentes
    const pats = await _fetchPats();
    await _fetchClientes();
    const pendentes = Object.entries(pats || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');

    if (pendentes.length === 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'flex';
        $id('pat-map-error-text').textContent = 'Sem pedidos pendentes para mostrar.';
        return;
    }

    subtitleEl.textContent = `A preparar localizações...`;

    // Agrupar por estabelecimento (mesmo nome → mesmo pin)
    const groups = {};
    pendentes.forEach(([id, pat]) => {
        const key = _normEstabKey(pat.estabelecimento);
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        groups[key].push([id, pat]);
    });
    const groupEntries = Object.entries(groups);

    // ── Passo 1: Carregar cache do Firebase ──────────────────────────────
    if (loadingTxt) loadingTxt.textContent = 'A carregar localizações guardadas...';
    await _loadGeocodeCache();

    const cached  = groupEntries.filter(([k]) => _geocodeCache[k] !== undefined);
    const missing = groupEntries.filter(([k]) => _geocodeCache[k] === undefined);

    // ── Passo 2: Helper para adicionar marker ────────────────────────────
    function _addMarker(estabKey, items) {
        const coords = _geocodeCache[estabKey];
        if (!coords) return false;
        const urgente   = items.some(([, p]) => _calcDias(p.criadoEm) >= 20);
        const separacao = items.some(([, p]) => !!p.separacao);
        const nomeEstab = items[0][1].estabelecimento || '';
        const chain     = _CHAIN_ICONS.find(c => c.match.test(nomeEstab));
        const z = _patMap ? _patMap.getZoom() : 7;
        const icon = chain ? _makeChainIconAtZoom(chain, z, urgente, separacao, nomeEstab) : _makePinIcon(items.length, urgente, separacao, z, nomeEstab);
        const marker = L.marker([coords.lat, coords.lng], { icon })
            .addTo(_patMapCluster || _patMap);
        marker._hipMeta = { nome: nomeEstab, count: items.length, urgente, separacao };
        const _lat   = coords.lat;
        const _lng   = coords.lng;
        marker.on('click', () => {
            const currentItems = _getMapPendingPatsForEstab(items[0]?.[1]?.estabelecimento || estabKey);
            if (currentItems.length === 0) {
                if (_patMapCluster) _patMapCluster.removeLayer(marker);
                _patMapMarkers = _patMapMarkers.filter(m => m !== marker);
                closeMapPinSheet();
                return;
            }
            _markerJustClicked = true;
            try {
                openMapPinSheet(currentItems, { lat: _lat, lng: _lng });
            } catch(e) {
                console.error('[map] ERRO em openMapPinSheet:', e.message, e.stack);
            }
        });
        _patMapMarkers.push(marker);
        return true;
    }

    // ── Passo 3: Mostrar pins da cache imediatamente ─────────────────────
    let geocoded = 0;
    const bounds = [];

    cached.forEach(([k, items]) => {
        if (_addMarker(k, items) && _geocodeCache[k]) {
            bounds.push([_geocodeCache[k].lat, _geocodeCache[k].lng]);
            geocoded++;
        }
    });

    if (geocoded > 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        _patMap.invalidateSize();
        setTimeout(() => {
            if (!_patMap) return;
            if (bounds.length === 1) { _patMap.setView(bounds[0], 11); }
            else { _patMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 }); }
        }, 150);
        subtitleEl.textContent = `${geocoded} estabelecimento${geocoded !== 1 ? 's' : ''} no mapa`;
    }

    // ── Passo 4: Geocodificar os que faltam (background se já há pins) ───
    if (missing.length === 0) {
        if (geocoded === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) { errorEl.style.display = 'flex'; $id('pat-map-error-text').textContent = 'Não foi possível localizar nenhum estabelecimento.'; }
        }
        const naoEncontrados = groupEntries.filter(([k]) => _geocodeCache[k] === null).length;
        if (naoEncontrados > 0) subtitleEl.textContent += ` · ${naoEncontrados} não localizado${naoEncontrados !== 1 ? 's' : ''}`;
        return;
    }

    let newGeocoded = 0;
    let failed = 0;

    for (let i = 0; i < missing.length; i++) {
        if (!_patMapOpen) break;
        const [estabKey, items] = missing[i];
        const nomeOriginal = items[0][1].estabelecimento || estabKey;
        const progressTxt = missing.length > 1 ? ` (${i + 1}/${missing.length})` : '';
        subtitleEl.textContent = `A localizar "${nomeOriginal}"...${progressTxt}`;

        const coords = await _geocodeEstab(
            nomeOriginal, true,
            items[0]?.[1]?.clienteNumero || '',
            items[0]?.[1]?.clienteId     || ''
        );
        if (!_patMapOpen) break;
        if (!coords) { failed++; continue; }

        newGeocoded++;
        bounds.push([coords.lat, coords.lng]);
        _addMarker(estabKey, items);

        if (bounds.length >= 1) { _patMap.fitBounds(bounds.length === 1 ? [bounds[0], bounds[0]] : bounds, { padding: [40, 40], maxZoom: 13 }); }

        if (newGeocoded === 1 && geocoded === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
        if (i < missing.length - 1) await _sleep(1100);
    }

    if (loadingEl) loadingEl.style.display = 'none';

    const totalShown = geocoded + newGeocoded;
    if (totalShown === 0) {
        if (errorEl) { errorEl.style.display = 'flex'; $id('pat-map-error-text').textContent = 'Não foi possível localizar nenhum estabelecimento.'; }
        return;
    }

    const failedTxt = failed > 0 ? ` · ${failed} não localizad${failed !== 1 ? 'os' : 'o'}` : '';
    const newTxt    = ''; // sem mensagem de 'novos guardados'
    subtitleEl.textContent = `${totalShown} estabelecimento${totalShown !== 1 ? 's' : ''} no mapa${newTxt}${failedTxt}`;

    // Forçar Leaflet a recalcular dimensões
    setTimeout(() => _patMap && _patMap.invalidateSize(), 200);
}

// ── Mapa no painel lateral (desktop) ─────────────────────────────────────────
let _patMapPanel     = null;  // instância Leaflet do painel
let _patMapPanelCluster = null; // MarkerClusterGroup do painel
let _patMapPanelMkrs = [];    // markers do painel

async function _openPatMapPanel() {
    const container  = $id('pat-map-panel-container');
    const loadingEl  = $id('pat-map-panel-loading');
    if (!container) return;

    if (loadingEl) loadingEl.style.display = 'flex';

    // Altura controlada pelo CSS flex — apenas garantir largura
    container.style.height = '';
    container.style.width  = '100%';

    // Criar instância se não existe
    const PT_BOUNDS = L.latLngBounds(L.latLng(30.0, -31.5), L.latLng(42.2, -6.2));
    if (!_patMapPanel) {
        _patMapPanel = L.map('pat-map-panel-container', {
            center: [39.6, -8.0], zoom: 7,
            minZoom: 5, maxZoom: 17,
            maxBounds: PT_BOUNDS, maxBoundsViscosity: 1.0,
            zoomControl: true,
            attributionControl: false,
        });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 20, minZoom: 5,
        }).addTo(_patMapPanel);
        _patMapPanelCluster = _createClusterGroup();
        _patMapPanel.addLayer(_patMapPanelCluster);
        _patMapPanel.fitBounds(PT_BOUNDS, { padding: [10, 10] });
        _patMapPanel.on('click', () => { if (_markerJustClicked) { _markerJustClicked = false; return; } closeMapPinSheet(); });
        _patMapPanel.on('zoomend', () => {
            const z = _patMapPanel.getZoom();
            _patMapPanelMkrs.forEach(m => {
                if (!m._hipMeta) return;
                const { nome, count, urgente, separacao } = m._hipMeta;
                const chain = _CHAIN_ICONS.find(c => c.match.test(nome));
                m.setIcon(chain ? _makeChainIconAtZoom(chain, z, urgente, separacao, nome) : _makePinIcon(count, urgente, separacao, z, nome));
            });
        });
    } else {
        if (_patMapPanelCluster) _patMapPanelCluster.clearLayers();
        _patMapPanelMkrs = [];
    }

    _patMapPanel.invalidateSize();

    // Buscar PATs pendentes e colocar markers
    await _loadGeocodeCache();
    const pats     = await _fetchPats();
    await _fetchClientes();
    const pendentes = Object.entries(pats || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');

    if (loadingEl) loadingEl.style.display = 'none';

    const groups = {};
    pendentes.forEach(([id, pat]) => {
        const key = _normEstabKey(pat.estabelecimento);
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        groups[key].push([id, pat]);
    });

    const bounds = [];
    Object.entries(groups).forEach(([k, items]) => {
        const coords = _geocodeCache[k];
        if (!coords) return;
        const urgente   = items.some(([, p]) => _calcDias(p.criadoEm) >= 20);
        const separacao = items.some(([, p]) => !!p.separacao);
        const nomeEstab = items[0][1].estabelecimento || '';
        const chain     = _CHAIN_ICONS.find(c => c.match.test(nomeEstab));
        const icon      = chain ? _makeChainIconAtZoom(chain, 7, urgente, separacao, nomeEstab) : _makePinIcon(items.length, urgente, separacao, 7, nomeEstab);
        const marker    = L.marker([coords.lat, coords.lng], { icon }).addTo(_patMapPanelCluster || _patMapPanel);
        marker._hipMeta = { nome: nomeEstab, count: items.length, urgente, separacao };
        const _lat = coords.lat, _lng = coords.lng;
        marker.on('click', () => {
            const cur = _getMapPendingPatsForEstab(items[0]?.[1]?.estabelecimento || k);
            if (cur.length === 0) { if (_patMapPanelCluster) _patMapPanelCluster.removeLayer(marker); _patMapPanelMkrs = _patMapPanelMkrs.filter(m => m !== marker); closeMapPinSheet(); return; }
            _markerJustClicked = true;
            openMapPinSheet(cur, { lat: _lat, lng: _lng });
        });
        _patMapPanelMkrs.push(marker);
        bounds.push([coords.lat, coords.lng]);
    });

    if (bounds.length >= 1) {
        // Dar tempo ao CSS flex para calcular a altura real do container
        setTimeout(() => {
            _patMapPanel.invalidateSize();
            setTimeout(() => {
                if (bounds.length === 1) {
                    _patMapPanel.setView(bounds[0], 11);
                } else {
                    _patMapPanel.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
                }
            }, 150);
        }, 50);
    } else {
        _patMapPanel.invalidateSize();
    }
}

function closePatMap() {
    _patMapOpen = false;
    $id('main-content')?.classList.remove('map-view-active');
    nav('view-pedidos');
}


// CLIENTES — autocomplete Nº Cliente no modal PAT
const CLIENTES_URL = `${BASE_URL}/clientes.json`;
const _clientesCache = { data: null, lastFetch: 0 };

async function _fetchClientes(force = false) {
    const now = Date.now();
    if (!force && _clientesCache.data && now - _clientesCache.lastFetch < 300000) return _clientesCache.data;
    try {
        const url = await authUrl(CLIENTES_URL);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        _clientesCache.data = await res.json() || {};
        _clientesCache.lastFetch = now;
    } catch(_e) { _clientesCache.data = _clientesCache.data || {}; }
    return _clientesCache.data;
}

let _clienteDropdownIdx = -1;

function patClientSearch(val) {
    _clienteDropdownIdx = -1;
    $id('pat-cliente-id').value = ''; // limpar ao escrever
    const dd = $id('pat-client-dropdown');
    const q  = val.trim();
    if (!q) { dd.innerHTML = ''; _removeClientOutsideListener(); return; }

    const data = _clientesCache.data || {};

    // Injectar _fbId em cada cliente para uso no dropdown
    const dataComId = Object.entries(data).reduce((acc, [fbId, c]) => {
        acc[fbId] = { ...c, _fbId: fbId };
        return acc;
    }, {});

    // Número exacto — verifica quantos clientes partilham esse NR
    if (/^\d{1,3}$/.test(q)) {
        const exactMatches = Object.values(dataComId).filter(c => c.numero === q);
        if (exactMatches.length === 1) {
            $id('pat-estabelecimento').value = exactMatches[0].nome;
            $id('pat-cliente-id').value      = exactMatches[0]._fbId;
            dd.innerHTML = '';
            _removeClientOutsideListener();
            return;
        }
        if (exactMatches.length > 1) {
            _renderClientDropdown(dd, exactMatches, true);
            _addClientOutsideListener();
            return;
        }
    }

    // Sugestões parciais
    const matches = Object.values(dataComId)
        .filter(c => c.numero.startsWith(q) || c.nome.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 10);

    if (matches.length === 0) {
        dd.innerHTML = '<div class="pat-dd-empty">Sem resultados</div>';
        _removeClientOutsideListener();
        return;
    }
    _renderClientDropdown(dd, matches, false);
    _addClientOutsideListener();
}

function _renderClientDropdown(dd, matches, isExact) {
    dd.innerHTML = '';
    if (isExact) {
        const hdr = $el('div', { className: 'pat-dd-header' });
        hdr.textContent = matches.length + ' estabelecimentos com este Nº — escolhe:';
        dd.appendChild(hdr);
    }
    matches.forEach((c, i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        const codeEl = $el('span'); codeEl.className = 'pat-dd-code'; codeEl.textContent = c.numero;
        const nameEl = $el('span'); nameEl.className = 'pat-dd-name';  nameEl.textContent = c.nome;
        opt.appendChild(codeEl); opt.appendChild(nameEl);
        opt.onmousedown = (e) => {
            e.preventDefault();
            $id('pat-cliente-num').value     = c.numero;
            $id('pat-estabelecimento').value  = c.nome;
            $id('pat-cliente-id').value       = c._fbId || '';
            dd.innerHTML = '';
            _removeClientOutsideListener();
        };
        dd.appendChild(opt);
    });
}

function _clientOutsideHandler(e) {
    const wrap = document.querySelector('.pat-client-wrap');
    if (wrap && !wrap.contains(e.target)) {
        $id('pat-client-dropdown').innerHTML = '';
        _removeClientOutsideListener();
    }
}
function _addClientOutsideListener() {
    document.removeEventListener('click', _clientOutsideHandler);
    document.addEventListener('click', _clientOutsideHandler);
}
function _removeClientOutsideListener() {
    document.removeEventListener('click', _clientOutsideHandler);
}

function patClientKeydown(e) {
    const dd   = $id('pat-client-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _clienteDropdownIdx = Math.min(_clienteDropdownIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _clienteDropdownIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _clienteDropdownIdx = Math.max(_clienteDropdownIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _clienteDropdownIdx));
    } else if (e.key === 'Enter' && _clienteDropdownIdx >= 0) {
        e.preventDefault();
        opts[_clienteDropdownIdx]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

// ── Lista de clientes no Admin ─────────────────────────────────────────────
async function renderClientesList() {
    const container = $id('clientes-list');
    if (!container) return;
    container.innerHTML = '<div class="pat-loading">A carregar...</div>';
    const data = await _fetchClientes(true);

    function _cadeia(nome) {
        return (nome || '').trim().split(/\s+/)[0].toUpperCase();
    }

    const entries = Object.entries(data || {})
        .sort(([, a], [, b]) => {
            const cadA = _cadeia(a.nome), cadB = _cadeia(b.nome);
            const cadCmp = cadA.localeCompare(cadB, 'pt');
            if (cadCmp !== 0) return cadCmp;
            const locA = (a.lat != null && a.lng != null) ? 0 : 1;
            const locB = (b.lat != null && b.lng != null) ? 0 : 1;
            if (locA !== locB) return locA - locB;
            return (a.nome || '').localeCompare(b.nome || '', 'pt');
        });

    if (entries.length === 0) {
        container.innerHTML = '<div class="empty-msg">Nenhum cliente. Usa o botão acima para importar.</div>';
        return;
    }

    container.innerHTML = '';
    const totalComLoc = entries.filter(([, c]) => c.lat != null && c.lng != null).length;

    // ── Stats ────────────────────────────────────────────────────────────
    const stats = $el('div', { className: 'clientes-stats' });
    stats.innerHTML = `
        <span class="clientes-stat"><span class="clientes-stat-num">${entries.length}</span> clientes</span>
        <span class="clientes-stat-dot"></span>
        <span class="clientes-stat"><span class="clientes-stat-num" style="color:#16a34a">${totalComLoc}</span> com localização</span>`;
    container.appendChild(stats);

    // ── Pesquisa ─────────────────────────────────────────────────────────
    const searchWrap = $el('div', { className: 'clientes-search-wrap' });
    searchWrap.innerHTML = `
        <svg class="clientes-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="clientes-search-input" placeholder="Pesquisar por número ou nome..." id="clientes-search-inp">`;
    container.appendChild(searchWrap);

    // ── Área de grupos ────────────────────────────────────────────────────
    const groupsArea = $el('div');
    groupsArea.id = 'clientes-groups-area';
    container.appendChild(groupsArea);

    // Agrupar por cadeia
    const groups = {};
    entries.forEach(([id, c]) => {
        const k = _cadeia(c.nome);
        if (!groups[k]) groups[k] = [];
        groups[k].push([id, c]);
    });

    function _buildGroups(filter = '') {
        const q = filter.trim().toLowerCase();
        groupsArea.innerHTML = '';
        let totalVisible = 0;

        Object.entries(groups).forEach(([cadeia, items]) => {
            const filtered = q
                ? items.filter(([, c]) =>
                    c.nome.toLowerCase().includes(q) ||
                    String(c.numero || '').includes(q))
                : items;
            if (filtered.length === 0) return;
            totalVisible += filtered.length;

            const withLoc = filtered.filter(([, c]) => c.lat != null && c.lng != null).length;

            // Wrapper do grupo
            const grp = $el('div', { className: 'clientes-group' });

            // Header do grupo
            const hdr = $el('div', { className: 'clientes-group-header' });
            hdr.innerHTML = `
                <span class="clientes-group-name">${cadeia}</span>
                ${withLoc > 0 ? `<span class="clientes-group-loc visible"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>${withLoc}</span>` : ''}
                <span class="clientes-group-count">${filtered.length}</span>
                <span class="clientes-group-chevron"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;

            hdr.onclick = () => grp.classList.toggle('collapsed');

            // Body com linhas
            const body = $el('div', { className: 'clientes-group-body' });

            filtered.forEach(([id, c]) => {
                const hasCoords = c.lat != null && c.lng != null;
                const row = $el('div', { className: 'cliente-row' });

                const numEl = $el('span', { className: 'cliente-row-num' });
                numEl.textContent = String(c.numero || '').padStart(3, '0');

                const nomeWrap = $el('div');
                nomeWrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;';

                const dot = $el('span');
                dot.className = `cliente-loc-dot ${hasCoords ? 'has-loc' : 'no-loc'}`;
                dot.title = hasCoords ? `${parseFloat(c.lat).toFixed(5)}, ${parseFloat(c.lng).toFixed(5)}` : 'Sem localização';

                const nomeEl = $el('span');
                nomeEl.className = `cliente-row-nome${hasCoords ? '' : ' sem-loc'}`;
                nomeEl.textContent = c.nome || '—';
                nomeEl.title = c.nome || '';

                nomeWrap.appendChild(dot);
                nomeWrap.appendChild(nomeEl);

                const actions = $el('div', { className: 'cliente-row-actions' });

                const editBtn = $el('button', { className: 'cliente-row-edit' });
                editBtn.title = 'Editar';
                editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
                editBtn.onclick = (e) => { e.stopPropagation(); openEditClienteModal(id, c); };

                const delBtn = $el('button', { className: 'cliente-row-del' });
                delBtn.title = 'Apagar';
                delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>`;
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    openConfirmModal({
                        title: 'Apagar cliente?', type: 'danger',
                        desc: `${escapeHtml(c.numero)} — ${escapeHtml(c.nome)}`,
                        onConfirm: async () => {
                            try {
                                await apiFetch(`${BASE_URL}/clientes/${id}.json`, { method: 'DELETE' });
                                delete _clientesCache.data[id];
                                renderClientesList();
                                showToast('Cliente apagado');
                            } catch(_e) { showToast('Erro ao apagar', 'error'); }
                        }
                    });
                };

                actions.appendChild(editBtn);
                actions.appendChild(delBtn);
                row.appendChild(numEl);
                row.appendChild(nomeWrap);
                row.appendChild(actions);
                body.appendChild(row);
            });

            grp.appendChild(hdr);
            grp.appendChild(body);
            groupsArea.appendChild(grp);
        });

        // Sem resultados
        if (totalVisible === 0 && q) {
            groupsArea.innerHTML = `<div class="clientes-empty-search">Nenhum cliente encontrado para "${escapeHtml(q)}"</div>`;
        }
    }

    _buildGroups();

    // Pesquisa em tempo real
    const searchInp = $id('clientes-search-inp');
    if (searchInp) {
        let _st;
        searchInp.addEventListener('input', e => {
            clearTimeout(_st);
            _st = setTimeout(() => _buildGroups(e.target.value), 180);
        });
    }
}

// ── Modal Editar Cliente ───────────────────────────────────────────────────
function _ecInitials(nome) {
    const words = (nome || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function ecUpdatePreview() {
    const nome = $id('edit-cliente-nome')?.value || '';
    const disp = $id('ec-nome-display');
    const avt  = $id('ec-avatar');
    if (disp) disp.textContent = nome || '—';
    if (avt)  avt.textContent  = _ecInitials(nome);
}

function ecUpdateLocStatus() {
    const lat = $id('edit-cliente-lat')?.value?.trim();
    const lng = $id('edit-cliente-lng')?.value?.trim();
    const el  = $id('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status editing-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg> Coordenadas definidas — a guardar ao clicar em Guardar`;
    } else if (!lat && !lng) {
        // Mostrar estado original (repor ao que estava ao abrir)
        _ecSetInitialLocStatus();
    }
}

function _ecSetInitialLocStatus(lat, lng) {
    const el = $id('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status has-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> Localização guardada · ${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`;
    } else {
        el.className = 'ec-loc-status no-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Sem localização — será geocodificada automaticamente`;
    }
}

function openEditClienteModal(id, c) {
    $id('edit-cliente-id').value  = id;
    $id('edit-cliente-numero').value = c.numero || '';
    $id('edit-cliente-nome').value   = c.nome   || '';
    $id('edit-cliente-lat').value    = c.lat    || '';
    $id('edit-cliente-lng').value    = c.lng    || '';

    // Preview no header
    const nomeDisplay = $id('ec-nome-display');
    const numDisplay  = $id('ec-numero-display');
    const avatar      = $id('ec-avatar');
    if (nomeDisplay) nomeDisplay.textContent = c.nome  || '—';
    if (numDisplay)  numDisplay.textContent  = `Nº ${(c.numero || '').padStart(3, '0')}`;
    if (avatar)      avatar.textContent      = _ecInitials(c.nome);

    // Estado da localização
    _ecSetInitialLocStatus(c.lat, c.lng);

    modalOpen('modal-edit-cliente');
    setTimeout(() => $id('edit-cliente-nome').focus(), 120);
}

async function saveEditCliente() {
    const id     = $id('edit-cliente-id').value;
    const numero = $id('edit-cliente-numero').value.trim(); // readonly, só para payload
    const nome   = $id('edit-cliente-nome').value.trim();
    const latVal = $id('edit-cliente-lat').value.trim();
    const lngVal = $id('edit-cliente-lng').value.trim();
    const previousNome = _clientesCache.data?.[id]?.nome || '';

    if (!nome) { showToast('O nome não pode estar vazio', 'error'); return; }

    // Só alterar nome (número fica inalterado)
    const payload = { nome };

    if (latVal !== '' && lngVal !== '') {
        const lat = parseFloat(latVal);
        const lng = parseFloat(lngVal);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            showToast('Coordenadas inválidas', 'error'); return;
        }
        payload.lat = lat;
        payload.lng = lng;
    } else {
        payload.lat = null;
        payload.lng = null;
    }

    try {
        await apiFetch(`${BASE_URL}/clientes/${id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (_clientesCache.data) {
            _clientesCache.data[id] = { ..._clientesCache.data[id], ...payload };
        }
        const cacheKey = _normEstabKey(nome);
        const previousKey = _normEstabKey(previousNome);
        if (previousKey && previousKey !== cacheKey) {
            delete _geocodeCache[previousKey];
        }
        if (payload.lat != null && payload.lng != null && cacheKey) {
            _geocodeCache[cacheKey] = { lat: payload.lat, lng: payload.lng };
        } else if (cacheKey) {
            _geocodeCache[cacheKey] = null;
        }
        modalClose('modal-edit-cliente');
        renderClientesList();
        showToast('Cliente guardado');
    } catch(_e) { showToast('Erro ao guardar', 'error'); }
}

// ── Importar Excel de clientes ─────────────────────────────────────────────
async function importClientesExcel(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const preview = $id('clientes-import-preview');
    preview.innerHTML = '<div class="pat-loading">A processar ficheiro...</div>';

    try {
        await loadXlsx();
        const buf  = await file.arrayBuffer();
        const wb   = XLSX.read(buf, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        const clientes = {};
        let count = 0;
        rows.forEach(row => {
            const num  = String(row[0] || '').trim();
            const nome = String(row[1] || '').trim();
            if (!num || !nome || isNaN(Number(num))) return;
            const id = `c${num.padStart(3, '0')}`;
            clientes[id] = { numero: num, nome };
            count++;
        });

        if (count === 0) {
            preview.innerHTML = '<div class="clientes-preview-error">Nenhum cliente encontrado. Verifica o formato do ficheiro.</div>';
            return;
        }

        preview.innerHTML = `<div class="clientes-preview-info">✓ ${count} clientes encontrados. A importar...</div>`;

        // Guardar no Firebase (merge — preserva coords existentes)
        const existing = await _fetchClientes(true);
        const merged = {};
        for (const [id, c] of Object.entries(clientes)) {
            merged[id] = { ...c };
            // Preservar lat/lng se já existia
            if (existing[id]?.lat) merged[id].lat = existing[id].lat;
            if (existing[id]?.lng) merged[id].lng = existing[id].lng;
        }

        await apiFetch(`${BASE_URL}/clientes.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged)
        });

        _clientesCache.data = merged;
        _clientesCache.lastFetch = Date.now();
        preview.innerHTML = `<div class="clientes-preview-info">✓ ${count} clientes importados com sucesso.</div>`;
        renderClientesList();
        input.value = '';
    } catch(e) {
        console.error('[clientes] importar:', e);
        preview.innerHTML = `<div class="clientes-preview-error">Erro ao processar ficheiro: ${e.message}</div>`;
    }
}

// ── Exportar Excel de clientes ─────────────────────────────────────────────

const _patCache = { data: null, lastFetch: 0 };

async function _fetchPats(force = false) {
    const now = Date.now();
    if (!force && _patCache.data && now - _patCache.lastFetch < 120000) return _patCache.data;
    try {
        const url = await authUrl(`${BASE_URL}/pedidos.json`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        _patCache.data = await res.json() || {};
        _patCache.lastFetch = now;
        // Auto-limpeza: apaga entradas de histórico com mais de 15 dias
        _autoLimparHistorico();
    } catch(_e) { _patCache.data = _patCache.data || {}; }
    return _patCache.data;
}

async function _autoLimparHistorico() {
    const expirados = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === 'historico' && p.saidaEm && _calcDias(p.saidaEm) >= 15);
    if (!expirados.length) return;
    for (const [id, pat] of expirados) {
        // Guardar snapshot ANTES de apagar — PAT ainda está na cache e Firebase
        await _relSalvarPatAntesDeApagar(pat);
        // Só depois apagar da Firebase e da cache local
        await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' })
            .catch(e => console.warn('[Histórico] falha auto-limpeza:', id, e?.message));
        delete _patCache.data[id];
    }
}

function _getPatPendingCount() {
    // _patCache é a variável module-level correcta (cache principal não inclui pedidos)
    const data = (_patCache && _patCache.data) ? _patCache.data : {};
    return Object.values(data).filter(p => p.status !== 'levantado' && p.status !== 'historico').length;
}

async function updatePatCount() {
    // Actualiza a cache de PATs — card do dashboard lê _getPatPendingCount() da cache
    await _fetchPats();
}

let _patSearchQuery  = '';
let _patTab          = 'pendentes'; // 'pendentes' | 'levantadas' | 'historico'
let _patSelMode      = false;       // modo seleção para levantar
let _patSelWorker    = '';          // funcionário escolhido
let _patSelIds       = new Set();   // IDs seleccionados

const _debouncedPatSearch = _debounce(val => {
    _patSearchQuery = (val || '').toLowerCase().trim();
    renderPats();
}, 300);

function patSearchFilter(val) { _debouncedPatSearch(val); }

// ── Popover de pedidos duplicados por estabelecimento ──────────────
let _dupPopoverEl = null;
let _dupPopoverCloseHandler = null;

function showDupPopover(badge, estabNorm) {
    // fecha se já aberto + limpa listener anterior
    if (_dupPopoverCloseHandler) { document.removeEventListener('click', _dupPopoverCloseHandler); _dupPopoverCloseHandler = null; }
    if (_dupPopoverEl) { _dupPopoverEl.remove(); _dupPopoverEl = null; }

    const pats = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status !== 'levantado' &&
                (p.estabelecimento || '').trim().toLowerCase() === estabNorm)
        .sort((a, b) => (a[1].criadoEm || 0) - (b[1].criadoEm || 0));

    const pop = $el('div', { className: 'dup-popover' });
    pop.innerHTML = `
        <div class="dup-pop-title">PATs — ${escapeHtml(pats[0]?.[1]?.estabelecimento || estabNorm)}</div>
        ${pats.map(([, p]) => {
            const dias = _calcDias(p.criadoEm);
            const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
            const urgente = dias >= 20;
            return `<div class="dup-pop-row">
                <span class="dup-pop-pat ${urgente ? 'dup-pop-urgente' : ''}">PAT ${escapeHtml(p.numero || '—')}</span>
                <span class="dup-pop-dias">${diasLabel}</span>
            </div>`;
        }).join('')}
    `;
    _dupPopoverEl = pop;

    document.body.appendChild(pop);

    // posicionar abaixo do badge
    const rect = badge.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    let left = rect.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    pop.style.left = left + 'px';
    pop.style.top  = (rect.bottom + 6) + 'px';

    _dupPopoverCloseHandler = (e) => {
        if (!pop.contains(e.target)) {
            pop.remove(); _dupPopoverEl = null;
            document.removeEventListener('click', _dupPopoverCloseHandler);
            _dupPopoverCloseHandler = null;
        }
    };
    setTimeout(() => document.addEventListener('click', _dupPopoverCloseHandler), 0);
}

async function renderPats() {
    const el = $id('pat-list');
    if (!el) return;
    el.innerHTML = '<div class="pat-loading">A carregar...</div>';

    // Sync tab UI
    ['pendentes','levantadas','historico'].forEach(t => {
        $id(`pat-tab-${t}`)?.classList.toggle('active', _patTab === t);
    });
    const guiaFilter = $id('pat-guia-filter');
    const showGuiaFilter = _patTab === 'levantadas' || _patTab === 'historico';
    if (guiaFilter) guiaFilter.style.display = showGuiaFilter ? 'flex' : 'none';
    const soGuias = showGuiaFilter && $id('pat-guia-only').checked;

    const pats = await _fetchPats();
    let entries = Object.entries(pats || {})
        .filter(([, p]) => {
            if (_patTab === 'pendentes')  return p.status !== 'levantado' && p.status !== 'historico';
            if (_patTab === 'levantadas') return p.status === 'levantado';
            if (_patTab === 'historico')  return p.status === 'historico';
            return false;
        })
        .filter(([, p]) => {
            if (soGuias) return !!p.separacao;
            return true;
        })
        .filter(([, p]) => {
            if (!_patSearchQuery) return true;
            return (p.numero || '').toLowerCase().includes(_patSearchQuery) ||
                   (p.estabelecimento || '').toLowerCase().includes(_patSearchQuery);
        })
        .sort((a, b) => (b[1].criadoEm || 0) - (a[1].criadoEm || 0));

    if (entries.length === 0) {
        const msgs = { pendentes: 'Nenhum pedido pendente.', levantadas: 'Nenhuma PAT levantada.', historico: 'Sem histórico.' };
        el.innerHTML = `<div class="pat-empty">${msgs[_patTab] || ''}</div>`;
        updatePatCount();
        return;
    }

    el.innerHTML = '';

    // ── Pendentes: lista plana com KPI row ─────────────────────────────
    if (_patTab === 'pendentes') {
        const estabCount = {};
        entries.forEach(([, p]) => {
            const n = (p.estabelecimento || '').trim().toLowerCase();
            if (n) estabCount[n] = (estabCount[n] || 0) + 1;
        });

        const urgentes = entries.filter(([, p]) => _calcDias(p.criadoEm) >= 20).length;
        const isMobile = window.innerWidth < 768;

        if (isMobile) {
            // ── KPI row mobile: pills + botão Levantar várias ──────────────
            const kpiRow = $el('div', { className: 'pat-kpi-row' });
            kpiRow.id = 'pat-kpi-row';
            kpiRow.innerHTML = `
                <div class="pat-kpi-pill">
                    <div class="pat-kpi-label">Total Pendentes</div>
                    <div class="pat-kpi-val">${entries.length}</div>
                </div>
                <div class="pat-kpi-pill">
                    <div class="pat-kpi-label">Atrasados</div>
                    <div class="pat-kpi-val${urgentes > 0 ? ' danger' : ''}">${String(urgentes).padStart(2,'0')}</div>
                </div>
                <div class="pat-kpi-lev" id="pat-kpi-lev-btn">
                    <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="13" height="13"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                    Levantar várias
                </div>`;
            // Botão levantar várias abre o modal de selecção de funcionário
            kpiRow.querySelector('#pat-kpi-lev-btn').onclick = (e) => {
                e.stopPropagation();
                openLevantarModal();
            };
            el.appendChild(kpiRow);
        } else {
            // ── Count bar desktop (mantém comportamento original) ──────────
            const countBar = $el('div', { className: 'pat-count-bar' });
            countBar.innerHTML = `<span class="pat-count-lbl">${entries.length} pedido${entries.length !== 1 ? 's' : ''} pendente${entries.length !== 1 ? 's' : ''}</span>`
                + (urgentes > 0 ? `<span class="pat-count-badge">${urgentes} urgente${urgentes !== 1 ? 's' : ''} (+15 dias)</span>` : '');
            el.appendChild(countBar);
        }

        entries.forEach(([id, pat]) => el.appendChild(_buildPatCard(id, pat, 'pendentes', estabCount)));
        updatePatCount();

        // Actualizar contador na tab
        const tabEl = $id('pat-tab-pendentes');
        if (tabEl) {
            let cnt = tabEl.querySelector('.pat-tab-cnt');
            if (!cnt) { cnt = $el('span'); cnt.className = 'pat-tab-cnt'; tabEl.appendChild(cnt); }
            cnt.textContent = entries.length;
        }
        return;
    }

    // ── Levantadas / Histórico: agrupadas por funcionário ────────────────
    const grupos = {};
    entries.forEach(([id, pat]) => {
        const key = pat.funcionario || '—';
        if (!grupos[key]) grupos[key] = [];
        grupos[key].push([id, pat]);
    });
    const sortedGroups = Object.entries(grupos).sort(([a], [b]) => a.localeCompare(b, 'pt'));

    sortedGroups.forEach(([func, items]) => {
        // Cabeçalho do grupo
        const header = $el('div', { className: 'pat-group-header' });
        header.innerHTML = `
            <div class="pat-group-info">
                <span class="pat-group-avatar">${func === '—' ? '?' : func[0].toUpperCase()}</span>
                <span class="pat-group-name">${func === '—' ? 'Sem funcionário' : func}</span>
                <span class="pat-group-count">${items.length}</span>
            </div>`;
        el.appendChild(header);

        items.forEach(([id, pat]) => el.appendChild(_buildPatCard(id, pat, _patTab, {})));
    });
    updatePatCount();
}

function _buildPatCard(id, pat, tab, estabCount) {
    const isDesktop = window.innerWidth >= 768;
    return isDesktop
        ? _buildPatCardDesktop(id, pat, tab, estabCount)
        : _buildPatCardMobile(id, pat, tab, estabCount);
}

// ── SVGs partilhados ──────────────────────────────────────────────────────────
const _PAT_EDIT_SVG  = SVG_EDIT;
const _PAT_DEL_SVG   = SVG_DEL;
const _PAT_CHECK_SVG = SVG_CHECK;
const _PAT_ARR_SVG   = SVG_ARROW;
const _PAT_INFO_SVG  = SVG_INFO;

// ── DESKTOP: layout flex row com accent, info, localização e acção ────────────
function _buildPatCardDesktop(id, pat, tab, estabCount) {
    const separacao  = !!pat.separacao;
    const isLev      = tab === 'levantadas';
    const isHist     = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);
    const dias       = _calcDias(pat.criadoEm);
    const urgente    = tab === 'pendentes' && dias >= 20;
    const nomeNorm   = (pat.estabelecimento || '').trim().toLowerCase();

    // Cor do accent
    let accentColor = 'var(--primary)';
    if (urgente)   accentColor = '#dc2626';
    if (separacao && !urgente) accentColor = '#d97706';
    if (isLev)     accentColor = '#16a34a';
    if (isHist)    accentColor = 'var(--text-muted)';

    // Classes do card
    let cardClass = 'pat-card pat-card-desktop';
    if (isSelected) cardClass += ' pat-card-selected';
    if (isLev)      cardClass += ' pat-card-levantada';
    if (isHist)     cardClass += ' pat-card-historico';
    const card = $el('div');
    card.className = cardClass;

    // ── Accent bar (flex, não absolute) ──────────────────────────────────
    const accent = $el('div', { className: 'pat-card-accent' });
    accent.style.background = accentColor;
    card.appendChild(accent);

    // ── Body principal ────────────────────────────────────────────────────
    const body = $el('div', { className: 'pat-card-body-desktop' });

    // Top: badges + dias
    const topRow = $el('div', { className: 'pat-card-top' });
    const topLeft = $el('div', { className: 'pat-card-top-left' });

    // Checkbox selecção
    if (_patSelMode) {
        const cb = $el('span');
        cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');
        cb.innerHTML = isSelected ? _PAT_CHECK_SVG : '';
        topLeft.appendChild(cb);
    }

    // Badge número PAT
    const patBadge = $el('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || '—');
    topLeft.appendChild(patBadge);

    // Tag separação / guia
    if (separacao) {
        const sepTag = $el('span', { className: 'pat-sep-tag', textContent: 'Guia Transporte' });
        topLeft.appendChild(sepTag);
    }

    // Badge duplicados
    if (tab === 'pendentes') {
        const dupCount = estabCount[nomeNorm] || 0;
        if (dupCount > 1) {
            const dupBadge = $el('span', { className: 'pat-dup-badge' });
            dupBadge.dataset.estab = nomeNorm;
            dupBadge.textContent   = `! ${dupCount} pedidos`;
            topLeft.appendChild(dupBadge);
        }
    }

    // Dias / data
    const diasSpan = $el('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && pat.saidaEm) {
        diasSpan.textContent = new Date(pat.saidaEm).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    } else if (isLev && pat.levantadoEm) {
        diasSpan.textContent = new Date(pat.levantadoEm).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    } else {
        diasSpan.textContent = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
    }
    topRow.appendChild(topLeft);
    topRow.appendChild(diasSpan);

    // Estabelecimento
    const estabDiv = $el('div', { className: 'pat-card-estab' });
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    // Meta: técnico + data criação
    const metaRow = $el('div', { className: 'pat-card-meta' });
    const USER_SVG = SVG_USER;
    const CAL_SVG  = SVG_CAL;
    if (pat.funcionario || pat.criadoEm) {
        if (pat.funcionario) metaRow.innerHTML += `<span>${USER_SVG} ${escapeHtml(pat.funcionario)}</span>`;
        if (pat.criadoEm)   metaRow.innerHTML += `<span>${CAL_SVG} ${new Date(pat.criadoEm).toLocaleDateString('pt-PT')}</span>`;
    }

    // Produtos chips
    const prodsDiv = $el('div', { className: 'pat-card-produtos' });
    (pat.produtos || []).forEach(p => {
        const chip = $el('span', { className: 'pat-prod-chip' });
        chip.textContent = (p.codigo || '?') + ' × ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    body.appendChild(topRow);
    body.appendChild(estabDiv);
    if (metaRow.children.length > 0 || metaRow.innerHTML) body.appendChild(metaRow);

    // Pills de progresso (Pendente → Com Guia → Separação)
    if (tab === 'pendentes' || tab === 'levantadas') {
        const stepsDiv = $el('div', { className: 'pat-steps' });
        const steps = [
            { label: 'Pendente',  done: true },
            { label: 'Com Guia',  done: separacao },
            { label: 'Separação', done: separacao && isLev },
        ];
        steps.forEach(s => {
            const pill = $el('div');
            pill.className = 'pat-step-pill ' + (s.done ? 'done' : 'pending');
            pill.textContent = s.label;
            stepsDiv.appendChild(pill);
        });
        body.appendChild(stepsDiv);
    }

    if ((pat.produtos || []).length > 0) body.appendChild(prodsDiv);

    if (pat.obs) {
        const obsDiv = $el('div', { className: 'pat-card-obs' });
        obsDiv.textContent = pat.obs;
        body.appendChild(obsDiv);
    }

    card.appendChild(body);

    // ── Localização ───────────────────────────────────────────────────────
    if (pat.localidade || pat.morada) {
        const locDiv = $el('div', { className: 'pat-card-loc' });
        locDiv.innerHTML = `<span class="pat-card-loc-label">Localização</span>
                            <span class="pat-card-loc-val">${pat.localidade || pat.morada || ''}</span>`;
        card.appendChild(locDiv);
    }

    // ── Acção ─────────────────────────────────────────────────────────────
    const actionDiv = $el('div', { className: 'pat-card-action' });
    actionDiv.onclick   = e => e.stopPropagation();

    if (_patSelMode) {
        const btnRefs = $el('button', { className: 'pat-btn-refs' });
        btnRefs.innerHTML = _PAT_EDIT_SVG + ' Refs';
        btnRefs.onclick = e => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.innerHTML = _PAT_CHECK_SVG + ' Levantar ' + _PAT_ARR_SVG;
        btnLev.onclick   = () => marcarPatLevantado(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionDiv.appendChild(btnEdit);
        actionDiv.appendChild(btnLev);
        actionDiv.appendChild(btnDel);
    } else if (tab === 'levantadas') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnSaida = $el('button', { className: 'pat-btn-guia' });
        btnSaida.innerHTML = _PAT_INFO_SVG + ' Detalhes';
        btnSaida.onclick   = () => darSaidaPat(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionDiv.appendChild(btnEdit);
        actionDiv.appendChild(btnSaida);
        actionDiv.appendChild(btnDel);
    } else if (tab === 'historico') {
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionDiv.appendChild(btnDel);
    }

    if (actionDiv.children.length > 0) card.appendChild(actionDiv);

    card.onclick = e => {
        if (_patSelMode) {
            if (_patSelIds.has(id)) _patSelIds.delete(id); else _patSelIds.add(id);
            _updateLevantarBtn();
            renderPats();
            return;
        }
        const badge = e.target.closest('.pat-dup-badge');
        if (badge) { showDupPopover(badge, badge.dataset.estab); return; }
        openPatDetail(id, pat);
    };
    return card;
}

// ── MOBILE: layout original com bar absolute e acções em baixo ────────────────
function _buildPatCardMobile(id, pat, tab, estabCount) {
    const card = $el('div');
    const separacao  = !!pat.separacao;
    const isLev      = tab === 'levantadas';
    const isHist     = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);
    const dias       = _calcDias(pat.criadoEm);
    const urgente    = tab === 'pendentes' && dias >= 20;
    const nomeNorm   = (pat.estabelecimento || '').trim().toLowerCase();

    let cardClass = 'pat-card';
    if (separacao && !urgente) cardClass += ' pat-card-separacao';
    if (urgente)               cardClass += ' pat-card-urgente';
    if (isLev)                 cardClass += ' pat-card-levantada';
    if (isHist)                cardClass += ' pat-card-historico';
    if (isSelected)            cardClass += ' pat-card-selected';
    card.className = cardClass;

    const bar = $el('div', { className: 'pat-card-bar' });
    card.appendChild(bar);

    const body = $el('div', { className: 'pat-card-body' });

    const cardTop = $el('div', { className: 'pat-card-top' });
    const cardTopLeft = $el('div', { className: 'pat-card-top-left' });

    // Checkbox selecção (sempre visível no mobile, à direita)
    const cb = $el('div');
    cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');

    const patBadge = $el('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || '—');
    cardTopLeft.appendChild(patBadge);

    if (separacao) {
        const sepTag = $el('span', { className: 'pat-sep-tag', textContent: 'Guia Transporte' });
        cardTopLeft.appendChild(sepTag);
    }

    if (tab === 'pendentes') {
        const dupCount = estabCount[nomeNorm] || 0;
        if (dupCount > 1) {
            const dupBadge = $el('span', { className: 'pat-dup-badge' });
            dupBadge.dataset.estab = nomeNorm;
            dupBadge.textContent   = `! ${dupCount} pedidos`;
            cardTopLeft.appendChild(dupBadge);
        }
    }

    const diasSpan = $el('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && pat.saidaEm) {
        const d = new Date(pat.saidaEm);
        diasSpan.textContent = d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
        const diasRestantes = 15 - _calcDias(pat.saidaEm);
        if (diasRestantes <= 3) diasSpan.style.color = 'var(--text-muted)';
    } else if (isLev && pat.levantadoEm) {
        diasSpan.textContent = new Date(pat.levantadoEm).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    } else {
        diasSpan.textContent = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
    }
    cardTop.appendChild(cardTopLeft);
    // Modo selecção: mostra checkbox; normal: mostra dias
    cardTop.appendChild(_patSelMode ? cb : diasSpan);

    const estabDiv = $el('div', { className: 'pat-card-estab' });
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    // Meta: técnico + data
    const metaMobile = $el('div', { className: 'pat-card-meta-mobile' });
    const _M_USER = SVG_USER;
    const _M_CAL  = SVG_CAL;
    if (pat.funcionario) metaMobile.innerHTML += `<span>${_M_USER} ${escapeHtml(pat.funcionario)}</span>`;
    if (pat.criadoEm)    metaMobile.innerHTML += `<span>${_M_CAL} ${new Date(pat.criadoEm).toLocaleDateString('pt-PT')}</span>`;

    const prodsDiv = $el('div', { className: 'pat-card-produtos' });
    (pat.produtos || []).forEach(p => {
        const chip = $el('span', { className: 'pat-prod-chip' });
        chip.textContent = (p.codigo || '?') + ' × ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    const MAP_SVG = SVG_MAP;

    const actionsDiv = $el('div', { className: 'pat-card-actions' });
    actionsDiv.onclick   = e => e.stopPropagation();

    if (_patSelMode) {
        const btnRefs = $el('button', { className: 'pat-btn-refs' });
        btnRefs.innerHTML = _PAT_EDIT_SVG + ' Refs';
        btnRefs.onclick = e => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionsDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.innerHTML = _PAT_CHECK_SVG + ' Levantar ' + _PAT_ARR_SVG;
        btnLev.onclick   = () => marcarPatLevantado(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        const btnMapa = $el('button', { className: 'pat-btn-mapa' });
        btnMapa.innerHTML = MAP_SVG + (pat.localidade || pat.morada || 'Mapa');
        btnMapa.onclick   = () => openPatMap();
        actionsDiv.appendChild(btnEdit);
        actionsDiv.appendChild(btnLev);
        actionsDiv.appendChild(btnDel);
        actionsDiv.appendChild(btnMapa);
    } else if (tab === 'levantadas') {
        const btnEdit = $el('button', { className: 'pat-btn-edit' });
        btnEdit.innerHTML = _PAT_EDIT_SVG;
        btnEdit.title     = 'Editar PAT';
        btnEdit.onclick   = () => openEditPat(id, pat);
        const btnSaida = $el('button', { className: 'pat-btn-guia' });
        btnSaida.innerHTML = _PAT_INFO_SVG + ' Detalhes';
        btnSaida.onclick   = () => darSaidaPat(id);
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionsDiv.appendChild(btnEdit);
        actionsDiv.appendChild(btnSaida);
        actionsDiv.appendChild(btnDel);
    } else if (tab === 'historico') {
        const btnDel = $el('button', { className: 'pat-btn-apagar' });
        btnDel.innerHTML = _PAT_DEL_SVG;
        btnDel.onclick   = () => apagarPat(id);
        actionsDiv.appendChild(btnDel);
    }

    body.appendChild(cardTop);
    body.appendChild(estabDiv);
    if (metaMobile.innerHTML) body.appendChild(metaMobile);
    if (pat.obs) {
        const obsDiv = $el('div', { className: 'pat-card-obs' });
        obsDiv.textContent = pat.obs;
        body.appendChild(obsDiv);
    }
    if ((pat.produtos || []).length > 0) body.appendChild(prodsDiv);
    if (actionsDiv.children.length > 0) body.appendChild(actionsDiv);
    card.appendChild(body);

    card.onclick = e => {
        if (_patSelMode) {
            if (_patSelIds.has(id)) _patSelIds.delete(id); else _patSelIds.add(id);
            _updateLevantarBtn();
            renderPats();
            return;
        }
        const badge = e.target.closest('.pat-dup-badge');
        if (badge) { showDupPopover(badge, badge.dataset.estab); return; }
        openPatDetail(id, pat);
    };
    return card;
}

function setPatTab(tab) {
    _patTab      = tab;
    _patSelMode  = false;
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    const searchEl = $id('pat-search');
    if (searchEl) searchEl.value = '';
    _patSearchQuery = '';
    if (tab === 'pendentes') {
        const cbEl = $id('pat-guia-only');
        if (cbEl) cbEl.checked = false;
    }
    renderPats();
}

// ── Levantar Encomenda — modal de funcionário ─────────────
async function openLevantarModal() {
    const modal = $id('levantar-modal');
    const list  = $id('levantar-worker-list');
    if (!modal || !list) return;

    list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem">A carregar...</div>';
    modal.classList.add('active');

    const data = await fetchCollection('funcionarios');
    const workers = Object.values(data || {}).sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));

    list.innerHTML = '';
    if (!workers.length) {
        list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem">Sem funcionários registados.</div>';
        return;
    }
    workers.forEach(w => {
        const opt = $el('div', { className: 'worker-option' });
        opt.textContent = w.nome;
        opt.onclick     = () => { closeLevantarModal(); startLevantarMode(w.nome); };
        list.appendChild(opt);
    });
}
function closeLevantarModal() {
    $id('levantar-modal')?.classList.remove('active');
}

// ── Modo de seleção para levantar ─────────────────────────
function startLevantarMode(workerNome) {
    _patTab       = 'pendentes';
    _patSelMode   = true;
    _patSelWorker = workerNome;
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'flex';
    const workerEl = $id('pat-sel-worker');
    if (workerEl) workerEl.textContent = workerNome;
    _updateLevantarBtn();
    renderPats();
}

function cancelLevantarMode() {
    _patSelMode   = false;
    _patSelWorker = '';
    _patSelIds.clear();
    const bar = $id('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    renderPats();
}

function patSelToggleAll() {
    const pats = _patCache.data || {};
    // Só selecciona PATs pendentes (tab activo no modo levantar)
    const pendentes = Object.entries(pats).filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');
    const allSelected = pendentes.length > 0 && pendentes.every(([id]) => _patSelIds.has(id));
    if (allSelected) {
        _patSelIds.clear();
    } else {
        pendentes.forEach(([id]) => _patSelIds.add(id));
    }
    _updateLevantarBtn();
    renderPats();
}

function _updateLevantarBtn() {
    const btn = $id('pat-levantar-btn');
    if (!btn) return;
    btn.textContent = `Levantar ${_patSelIds.size}`;
    btn.disabled    = _patSelIds.size === 0;
}

async function levantarSelectedPats() {
    if (_patSelIds.size === 0) return;
    const ids    = [..._patSelIds];
    const worker = _patSelWorker;

    openConfirmModal({
        title: `Levantar ${ids.length} PAT${ids.length > 1 ? 's' : ''}?`,
        type: 'success', okLabel: 'Levantar',
        desc: `Serão marcadas como levantadas por ${worker}. As que têm guia de transporte descontam stock.`,
        onConfirm: async () => {
            // Mostrar feedback imediato
            const levBtn = $id('pat-levantar-btn');
            if (levBtn) { levBtn.disabled = true; levBtn.textContent = 'A processar...'; }
            try {
                const ts = Date.now();
                // Calcula novas quantidades de stock antes de lançar os pedidos
                // agrupa por id de produto para evitar PATCHes duplicados
                const stockPatches = {}; // { stockId: { baseQty, delta } }
                for (const id of ids) {
                    const pat = _patCache.data?.[id];
                    if (!pat || !pat.separacao) continue;
                    for (const p of (pat.produtos || [])) {
                        if (!p.id) continue;
                        const currentQty = cache.stock.data?.[p.id]?.quantidade ?? 0;
                        if (!stockPatches[p.id]) {
                            stockPatches[p.id] = { baseQty: currentQty, delta: 0 };
                        }
                        stockPatches[p.id].delta -= (p.quantidade || 1);
                    }
                }

                // Aplica ao cache local imediatamente
                Object.entries(stockPatches).forEach(([sid, patch]) => {
                    const nextQty = Math.max(0, patch.baseQty + patch.delta);
                    if (cache.stock.data?.[sid]) cache.stock.data[sid].quantidade = nextQty;
                });

                // Lança todos os PATCHes em paralelo
                const patPromises = ids.map(id => {
                    const pat = _patCache.data?.[id];
                    if (!pat) return Promise.resolve();
                    const payload = { status: 'levantado', levantadoEm: ts, funcionario: worker };
                    Object.assign(_patCache.data[id], payload);
                    return apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                        method: 'PATCH',
                        body: JSON.stringify(payload),
                    });
                });

                const stockPromises = Object.entries(stockPatches).map(([sid, patch]) => {
                    const _itm = cache.stock.data?.[sid];
                    const finalQty = Math.max(0, patch.baseQty + patch.delta);
                    const movedQty = Math.abs(Math.min(0, patch.delta));
                    if (movedQty > 0) registarMovimento('saida_pat', sid, _itm?.codigo, _itm?.nome, movedQty);
                    return _commitStockDelta(sid, patch.baseQty, finalQty)
                        .then(savedQty => {
                            if (cache.stock.data?.[sid]) cache.stock.data[sid].quantidade = savedQty;
                        })
                        .catch(e => console.warn('[Stock] PATCH falhou:', sid, e.message));
                });

                await Promise.allSettled([...patPromises, ...stockPromises]);

                cancelLevantarMode();
                renderList();
                updatePatCount();
                showToast(`${ids.length} PAT${ids.length > 1 ? 's' : ''} levantada${ids.length > 1 ? 's' : ''} por ${worker}!`);
            } catch(_e) {
                showToast('Erro ao levantar pedidos', 'error');
                const levBtn = $id('pat-levantar-btn');
                if (levBtn) { levBtn.disabled = false; levBtn.textContent = `Levantar ${_patSelIds.size}`; }
            }
        }
    });
}

// ── Dar saída — apaga a PAT levantada imediatamente ─────
async function darSaidaPat(id) {
    const pat = _patCache.data?.[id];
    openConfirmModal({
        title: 'Dar saída a esta PAT?',
        type: 'success', okLabel: 'Dar saída',
        desc: pat?.separacao
            ? 'A PAT vai para o histórico (15 dias). Guia de transporte concluída.'
            : 'A PAT vai para o histórico onde ficará 15 dias.',
        onConfirm: async () => {
            try {
                const payload = { status: 'historico', saidaEm: Date.now() };
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                });
                if (_patCache.data?.[id]) Object.assign(_patCache.data[id], payload);
                renderPats();
                updatePatCount();
                showToast('Saída dada — PAT no histórico!');
            } catch(_e) { showToast('Erro ao dar saída', 'error'); }
        }
    });
}

async function limparTabActual() {
    const statusAlvo = _patTab === 'historico' ? 'historico' : 'levantado';
    const alvo = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === statusAlvo);
    if (!alvo.length) { showToast('Nada para limpar.', 'info'); return; }

    const label = statusAlvo === 'historico' ? 'histórico' : 'levantadas';
    openConfirmModal({
        title: `Limpar ${alvo.length} registo${alvo.length > 1 ? 's' : ''}?`,
        type: 'danger',
        desc: `Remove todas as PATs do ${label}. Esta acção é irreversível.`,
        onConfirm: async () => {
            try {
                // Guardar snapshots de todos os meses afectados ANTES de apagar
                const mesesVistos = new Set();
                for (const [, pat] of alvo) {
                    const d = new Date(pat.levantadoEm || pat.saidaEm || pat.criadoEm || Date.now());
                    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
                    if (!mesesVistos.has(mk)) {
                        mesesVistos.add(mk);
                        await _relSalvarPatAntesDeApagar(pat);
                    }
                }
                for (const [id] of alvo) {
                    await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' });
                    delete _patCache.data[id];
                }
                renderPats();
                showToast(`${alvo.length} registo${alvo.length > 1 ? 's' : ''} removido${alvo.length > 1 ? 's' : ''}!`);
            } catch(_e) { showToast('Erro ao limpar', 'error'); }
        }
    });
}

// ── Editar referências de uma PAT (modo levantar) ────────────────────────
let _patRefsId  = null;
let _patRefsList = []; // {id|null, codigo, nome, quantidade}
let _patRefsDDIdx = -1;

function openPatRefsModal(id, pat) {
    _patRefsId   = id;
    _patRefsList = (pat.produtos || []).map(p => ({ ...p }));
    $id('pat-refs-title').textContent  = 'PAT ' + (pat.numero || '');
    $id('pat-refs-estab').textContent  = pat.estabelecimento || '';
    $id('pat-refs-search').value       = '';
    $id('pat-refs-dropdown').innerHTML = '';
    _renderRefsChips();
    modalOpen('pat-refs-modal');
    focusModal('pat-refs-modal');
    setTimeout(() => $id('pat-refs-search').focus(), 80);
}

function closePatRefsModal() {
    modalClose('pat-refs-modal');
    _patRefsId = null;
}

function patRefsSearch(val) {
    _patRefsDDIdx = -1;
    const dd = $id('pat-refs-dropdown');
    const q  = val.trim().toLowerCase();
    if (!q) { dd.innerHTML = ''; return; }

    const stock = cache.stock.data || {};
    const matches = Object.entries(stock)
        .filter(([id, item]) => {
            if (_patRefsList.some(p => p.id === id)) return false;
            const codigo = (item.codigo || '').toLowerCase();
            const nome   = (item.nome   || '').toLowerCase();
            return codigo.startsWith(q) || nome.includes(q);
        })
        .slice(0, 8);

    dd.innerHTML = '';

    // Opção de adicionar manualmente se não há resultado exacto
    const exactMatch = Object.values(stock).some(i => (i.codigo||'').toLowerCase() === q);
    if (!exactMatch) {
        const manual = $el('div', { className: 'pat-dd-option pat-dd-manual' });
        manual.innerHTML = `<span class="pat-dd-code">${escapeHtml(val.trim().toUpperCase())}</span><span class="pat-dd-name" style="color:var(--text-muted)">→ Adicionar manual</span>`;
        manual.onmousedown = (e) => { e.preventDefault(); patRefsAddManual(val.trim()); };
        dd.appendChild(manual);
    }

    matches.forEach(([id, item], i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        opt.innerHTML = `
            <span class="pat-dd-code">${escapeHtml((item.codigo||'SEMREF').toUpperCase())}</span>
            <span class="pat-dd-name">${escapeHtml(item.nome||'')}</span>
            <span class="pat-dd-stock">Stock: ${item.quantidade||0}</span>`;
        opt.onmousedown = (e) => { e.preventDefault(); patRefsAddFromStock(id, item); };
        dd.appendChild(opt);
    });

    if (!matches.length && exactMatch) {
        dd.innerHTML = '<div class="pat-dd-empty">Já adicionado</div>';
    }
}

function patRefsKeydown(e) {
    const dd   = $id('pat-refs-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    const val  = $id('pat-refs-search').value.trim();
    if (e.key === 'Enter') {
        e.preventDefault();
        if (_patRefsDDIdx >= 0 && opts[_patRefsDDIdx]) {
            opts[_patRefsDDIdx].dispatchEvent(new MouseEvent('mousedown'));
        } else if (val) {
            patRefsAddManual(val);
        }
        return;
    }
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _patRefsDDIdx = Math.min(_patRefsDDIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patRefsDDIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _patRefsDDIdx = Math.max(_patRefsDDIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patRefsDDIdx));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

function patRefsAddFromStock(id, item) {
    if (_patRefsList.some(p => p.id === id)) return;
    _patRefsList.push({ id, codigo: (item.codigo||'SEMREF').toUpperCase(), nome: item.nome||'', quantidade: 1 });
    $id('pat-refs-search').value = '';
    $id('pat-refs-dropdown').innerHTML = '';
    $id('pat-refs-search').focus();
    _renderRefsChips();
}

function patRefsAddManual(raw) {
    const codigo = raw.toUpperCase().trim();
    if (!codigo) return;
    if (_patRefsList.some(p => p.codigo === codigo && !p.id)) return;
    _patRefsList.push({ id: null, codigo, nome: '', quantidade: 1 });
    $id('pat-refs-search').value = '';
    $id('pat-refs-dropdown').innerHTML = '';
    $id('pat-refs-search').focus();
    _renderRefsChips();
}

function patRefsRemove(codigo) {
    _patRefsList = _patRefsList.filter(p => p.codigo !== codigo);
    _renderRefsChips();
}

function patRefsSetQty(codigo, val) {
    const p = _patRefsList.find(x => x.codigo === codigo);
    if (p) p.quantidade = Math.max(1, parseInt(val) || 1);
}

function _renderRefsChips() {
    const el = $id('pat-refs-chips');
    el.innerHTML = '';
    _patRefsList.forEach(p => {
        const chip = $el('div', { className: 'pat-chip' });
        chip.innerHTML = `
            <div class="pat-chip-info">
                <span class="pat-chip-code">${escapeHtml(p.codigo)}</span>
                ${p.nome ? `<span class="pat-chip-name">${escapeHtml(p.nome)}</span>` : '<span class="pat-chip-name" style="color:var(--text-muted);font-style:italic">manual</span>'}
            </div>
            <input type="number" class="pat-chip-qty" value="${p.quantidade||1}" min="1"
                onchange="patRefsSetQty('${escapeHtml(p.codigo)}', this.value)"
                oninput="patRefsSetQty('${escapeHtml(p.codigo)}', this.value)">
            <button class="pat-chip-remove" onclick="patRefsRemove('${escapeHtml(p.codigo)}')">✕</button>`;
        el.appendChild(chip);
    });
}

async function savePatRefs() {
    if (!_patRefsId) return;
    const btn = document.querySelector('#pat-refs-modal .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'A guardar...'; }
    const produtos = _patRefsList.map(p => ({
        id:         p.id   || null,
        codigo:     p.codigo,
        nome:       p.nome || '',
        quantidade: p.quantidade || 1
    }));
    try {
        await apiFetch(`${BASE_URL}/pedidos/${_patRefsId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ produtos }),
        });
        if (_patCache.data?.[_patRefsId]) _patCache.data[_patRefsId].produtos = produtos;
        closePatRefsModal();
        renderPats();
        showToast('Referências actualizadas!');
    } catch(_e) {
        showToast('Erro ao guardar', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
}

function openPatModal() {
    _patProducts = [];
    $id('pat-edit-id').value            = '';
    $id('pat-numero').value              = '';
    $id('pat-numero').readOnly           = false;
    $id('pat-cliente-num').value         = '';
    $id('pat-cliente-id').value          = '';
    $id('pat-client-dropdown').innerHTML = '';
    $id('pat-estabelecimento').value     = '';
    $id('pat-product-search').value      = '';
    $id('pat-product-dropdown').innerHTML = '';
    $id('pat-product-chips').innerHTML   = '';
    $id('pat-numero-hint').textContent   = '';
    $id('pat-separacao').checked         = false;
    $id('pat-obs') && ($id('pat-obs').value = '');
    $id('pat-modal-title').textContent   = 'Novo Pedido';
    _fetchClientes();
    modalOpen('pat-modal');
    focusModal('pat-modal');
    setTimeout(() => $id('pat-numero').focus(), 80);
}

async function openEditPat(id, pat) {
    // Preencher o modal com os dados da PAT existente
    _patProducts = (pat.produtos || []).map(p => ({ ...p }));

    $id('pat-edit-id').value            = id;
    $id('pat-modal-title').textContent  = `Editar PAT ${pat.numero || ''}`;
    $id('pat-numero').value             = pat.numero || '';
    $id('pat-numero').readOnly          = true; // nº PAT não pode ser alterado
    $id('pat-numero-hint').textContent  = '';
    $id('pat-separacao').checked        = !!pat.separacao;
    $id('pat-obs') && ($id('pat-obs').value = pat.obs || '');

    // Cliente — tentar preencher clienteId se estiver em falta
    let clienteId = pat.clienteId || '';
    const clienteNum = pat.clienteNumero || '';
    const estab      = pat.estabelecimento || '';

    if (!clienteId && (clienteNum || estab)) {
        // Tentar encontrar o clienteId automaticamente
        await _fetchClientes();
        const match = _findClienteByEstab(estab, clienteNum, '');
        if (match) {
            clienteId = match[0];
            // Guardar na PAT para futuras utilizações
            apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clienteId })
            }).catch(() => {});
            if (_patCache.data?.[id]) _patCache.data[id].clienteId = clienteId;
        }
    }

    $id('pat-cliente-num').value         = clienteNum;
    $id('pat-cliente-id').value          = clienteId;
    $id('pat-client-dropdown').innerHTML = '';
    $id('pat-estabelecimento').value     = estab;

    // Renderizar chips de produtos
    $id('pat-product-chips').innerHTML = '';
    _renderPatChips();
    $id('pat-product-search').value      = '';
    $id('pat-product-dropdown').innerHTML = '';

    _fetchClientes();
    modalOpen('pat-modal');
    focusModal('pat-modal');
    setTimeout(() => $id('pat-estabelecimento').focus(), 80);
}

function closePatModal() {
    modalClose('pat-modal');
    $id('pat-product-dropdown').innerHTML = '';
}

// ANTHROPIC API KEY — gestão local
const ANTHROPIC_KEY_STORAGE  = 'hiperfrio-anthropic-key';

// Chave Anthropic em sessionStorage (não persiste entre sessões nem é acessível
// por outras abas — reduz exposição vs localStorage)
function _getAnthropicKey() {
    return sessionStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
}
// Migração única: mover chave antiga de localStorage para sessionStorage e limpar
(function _migrateAnthropicKey() {
    const old = localStorage.getItem(ANTHROPIC_KEY_STORAGE);
    if (old) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, old);
        localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
    }
})();

function _isProxyUrl(val) {
    return val.startsWith('https://') || val.startsWith('http://');
}

function saveAnthropicKey() {
    const val = $id('inp-anthropic-key').value.trim();
    if (val && !_isProxyUrl(val) && !val.startsWith('sk-ant-')) {
        showToast('Valor inválido — introduz o URL do Worker (https://...) ou uma chave sk-ant-...', 'error');
        return;
    }
    if (val) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, val);
        $id('inp-anthropic-key').value = '';
        const tipo = _isProxyUrl(val) ? 'Proxy configurado' : 'Chave configurada';
        showToast(`${tipo} — OCR por foto usa agora Claude Vision ✓`, 'ok');
    } else {
        sessionStorage.removeItem(ANTHROPIC_KEY_STORAGE);
        showToast('Configuração removida — OCR volta ao modo local', 'ok');
    }
    _updateOcrKeyStatus();
}

function _updateOcrKeyStatus() {
    const val = _getAnthropicKey();
    let text, color;
    if (!val) {
        text  = 'Não configurada — usa OCR local';
        color = '';
    } else if (_isProxyUrl(val)) {
        text  = `✓ Claude Vision activo (${new URL(val).hostname})`;
        color = 'var(--ok, #16a34a)';
    } else {
        text  = `✓ Claude Vision activo (${val.slice(0,10)}…)`;
        color = 'var(--ok, #16a34a)';
    }
    ['ocr-api-status', 'ocr-api-status-modal'].forEach(id => {
        const el = $id(id);
        if (el) { el.textContent = text; el.style.color = color; }
    });
}

function openOcrSettings() {
    _updateOcrKeyStatus();
    _loadOcrKeywordsInput();
    // Pré-preenche o campo da chave
    const key = _getAnthropicKey();
    const inp = $id('inp-anthropic-key');
    if (inp && key) inp.value = key;
    modalOpen('ocr-settings-modal');
    focusModal('ocr-settings-modal');
}

// ── IMAGENS DE PRODUTOS — Google Custom Search + URL manual
// ── SerpApi Image Search ─────────────────────────────────────────────────
// Gratuito: 250 pesquisas/mês, sem cartão de crédito
// Documenta: serpapi.com/google-images-api
const GIMG_KEY_STORAGE = 'hiperfrio-serpapi-key'; // localStorage key

function _getSerpApiKey() {
    return localStorage.getItem(GIMG_KEY_STORAGE) || '';
}

function openGimgSettings() {
    const keyInp = $id('gimg-api-key-input');
    if (keyInp) keyInp.value = _getSerpApiKey();
    $id('gimg-settings-modal')?.classList.add('active');
    focusModal('gimg-settings-modal');
}
function closeGimgSettings() {
    $id('gimg-settings-modal')?.classList.remove('active');
}
function saveGimgKeys() {
    const key = $id('gimg-api-key-input')?.value.trim();
    if (!key) { showToast('Cola a chave SerpApi', 'error'); return; }
    localStorage.setItem(GIMG_KEY_STORAGE, key);
    showToast('Chave SerpApi guardada ✓');
    _updateGimgStatus();
    closeGimgSettings();
}
function clearGimgKeys() {
    localStorage.removeItem(GIMG_KEY_STORAGE);
    showToast('Chave removida');
    _updateGimgStatus();
    closeGimgSettings();
}

// MANUTENÇÃO — Limpar referências duplicadas no stock
// Lógica: agrupa todos os produtos por `codigo` (referência).
// Quando há mais do que um produto com o mesmo codigo, mantém o que tem
// mais informação (maior quantidade ou mais campos preenchidos) e apaga
// os restantes via DELETE na Firebase.
async function runDedup() {
    const btn    = $id('dedup-btn');
    const status = $id('dedup-status');

    if (btn) { btn.disabled = true; btn.textContent = 'A varrer...'; }
    if (status) status.textContent = 'A ler base de dados…';

    try {
        // 1 — Lê o stock completo directamente do servidor (sempre fresco)
        const url  = await authUrl(`${BASE_URL}/stock.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data || typeof data !== 'object') {
            if (status) status.textContent = 'Base de dados vazia.';
            return;
        }

        // 2 — Agrupa por código (normalizado: trim + uppercase)
        const grupos = {}; // { codigo: [ [firebaseKey, itemObj], ... ] }
        for (const [key, item] of Object.entries(data)) {
            if (!item || typeof item !== 'object') continue;
            const cod = (item.codigo || '').toString().trim().toUpperCase();
            if (!cod) continue; // ignora produtos sem referência
            if (!grupos[cod]) grupos[cod] = [];
            grupos[cod].push([key, item]);
        }

        // 3 — Encontra grupos com duplicados
        const duplicados = Object.entries(grupos).filter(([, arr]) => arr.length > 1);

        if (duplicados.length === 0) {
            if (status) status.textContent = 'Sem duplicados encontrados ✓';
            showToast('Sem duplicados encontrados ✓', 'ok');
            return;
        }

        // 4 — Mostra confirmação antes de apagar
        const totalApagar = duplicados.reduce((acc, [, arr]) => acc + arr.length - 1, 0);
        const linhas = duplicados.map(([cod, arr]) => {
            // Escolhe o melhor: maior quantidade; empate → mais campos preenchidos
            arr.sort((a, b) => {
                const qa = a[1].quantidade || 0;
                const qb = b[1].quantidade || 0;
                if (qb !== qa) return qb - qa;
                return Object.keys(b[1]).length - Object.keys(a[1]).length;
            });
            const [manterKey, manterItem] = arr[0];
            const apagar = arr.slice(1);
            return `• REF ${cod}: ${arr.length} entradas → manter "${manterItem.nome || manterKey}" (qty ${manterItem.quantidade ?? 0}), apagar ${apagar.length}`;
        }).join('\n');

        openConfirmModal({
            title: `Apagar ${totalApagar} produto${totalApagar > 1 ? 's' : ''} duplicado${totalApagar > 1 ? 's' : ''}?`,
            type: 'danger',
            desc: `Referências com duplicados (${duplicados.length}):\n\n${linhas}\n\nO produto com maior quantidade (ou mais informação) é mantido. Esta acção não pode ser desfeita.`,
            onConfirm: async () => {
                if (btn) btn.textContent = 'A apagar…';
                if (status) status.textContent = `A apagar ${totalApagar} duplicado(s)…`;

                let apagados = 0;
                let erros    = 0;

                for (const [, arr] of duplicados) {
                    // arr já está ordenado: arr[0] = manter, arr[1..] = apagar
                    for (const [key] of arr.slice(1)) {
                        try {
                            await apiFetch(`${BASE_URL}/stock/${key}.json`, { method: 'DELETE' });
                            // Remove do cache local imediatamente
                            if (cache.stock.data?.[key]) delete cache.stock.data[key];
                            apagados++;
                        } catch (e) {
                            console.error('[dedup] Erro ao apagar', key, e);
                            erros++;
                        }
                    }
                }

                // Invalida cache e re-renderiza
                invalidateCache('stock');
                await renderList('', true);

                const msg = erros > 0
                    ? `${apagados} duplicado(s) removido(s), ${erros} erro(s)`
                    : `${apagados} duplicado(s) removido(s) ✓`;
                if (status) status.textContent = msg;
                showToast(msg, erros > 0 ? 'error' : 'ok');
            }
        });

    } catch (e) {
        console.error('[dedup] Erro:', e);
        if (status) status.textContent = 'Erro: ' + (e?.message || e);
        showToast('Erro ao varrer: ' + (e?.message || e), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Varrer ›'; }
    }
}

function _updateGimgStatus() {
    const key = _getSerpApiKey();
    const el = $id('gimg-api-status');
    if (el) el.textContent = key
        ? 'SerpApi configurada — pesquisa automática activa'
        : 'Não configurada — configura o SerpApi para pesquisa automática';
}

// ── Pré-visualização ao colar URL manual ─────────────────────────────────
function imgUrlPreview(url) {
    const thumb       = $id('img-edit-thumb');
    const placeholder = $id('img-edit-placeholder');
    const clearBtn    = $id('img-clear-btn');
    if (!thumb) return;
    if (url && url.startsWith('http')) {
        thumb.src             = url;
        thumb.style.display   = 'block';
        if (placeholder) placeholder.style.display = 'none';
        if (clearBtn)    clearBtn.style.display     = 'inline-flex';
    } else {
        thumb.style.display   = 'none';
        if (placeholder) placeholder.style.display = 'flex';
        if (clearBtn)    clearBtn.style.display     = 'none';
    }
}

function imgClear() {
    const inp = $id('edit-img-url');
    if (inp) inp.value = '';
    imgUrlPreview('');
    $id('img-search-results').style.display = 'none';
}

// Carrega imgUrl no modal quando se abre editar produto
function _loadImgEdit(imgUrl) {
    const inp = $id('edit-img-url');
    if (inp) inp.value = imgUrl || '';
    imgUrlPreview(imgUrl || '');
    $id('img-search-results').style.display = 'none';
}

// ── Pesquisa automática SerpApi Google Images ────────────────────────────
// Documentação: https://serpapi.com/images-results
const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

async function imgSearchAuto() {
    const btn    = $id('img-search-btn');
    const nome   = $id('edit-nome')?.value.trim();  // só o nome, sem referência

    if (!nome) { showToast('Preenche primeiro o nome do produto', 'error'); return; }

    const key = _getSerpApiKey();

    if (!key) {
        // Sem chave: abre Google Images no browser
        const encoded = encodeURIComponent(nome + ' produto refrigeração HVAC');
        window.open(`https://www.google.com/search?tbm=isch&q=${encoded}`, '_blank');
        showToast('Sem chave SerpApi — a abrir Google Images no browser', 'info');
        return;
    }

    // Detecta se a chave é um URL de proxy (Cloudflare Worker)
    // ou uma chave SerpApi directa (que vai falhar por CORS)
    const isProxy = key.startsWith('http://') || key.startsWith('https://');

    const SPIN_SVG   = SVG_SPIN;
    const SEARCH_SVG = SVG_SEARCH;

    btn.disabled = true;
    btn.innerHTML = SPIN_SVG + ' A pesquisar...';

    try {
        const q = encodeURIComponent(nome + ' HVAC refrigeração');
        let url;

        if (isProxy) {
            // Proxy Cloudflare Worker — passa o query como parâmetro
            url = `${key}?q=${q}`;
        } else {
            // Chamada directa SerpApi (pode falhar por CORS no browser)
            url = `${SERPAPI_ENDPOINT}?engine=google_images&q=${q}&num=6&safe=active&api_key=${key}`;
            console.warn('[imgSearch] AVISO: chamada directa ao SerpApi falha por CORS no browser. Configura um Cloudflare Worker como proxy.');
        }

        const res = await _fetchWithTimeout(url, {}, 12000);

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('[imgSearch] Erro HTTP:', res.status, errText);
            if (res.status === 401) throw new Error('Chave SerpApi inválida — verifica em Definições');
            if (res.status === 429) throw new Error('Quota esgotada (250 pesquisas/mês no plano gratuito)');
            throw new Error(`HTTP ${res.status}: ${errText.slice(0, 100)}`);
        }

        const data  = await res.json();

        if (data.error) throw new Error(data.error);

        const items = (data.images_results || []).slice(0, 6);
        if (items.length === 0) {
            showToast('Sem resultados — tenta outro nome ou cola um URL', 'error');
            return;
        }

        // Grelha de miniaturas clicáveis
        const resultsEl = $id('img-search-results');
        resultsEl.innerHTML = '';
        resultsEl.style.display = 'grid';

        items.forEach((item, i) => {
            const thumbUrl = item.thumbnail;
            const origUrl  = item.original;

            const wrap = $el('div', { className: 'img-result-thumb' });
            wrap.title     = item.title || '';

            const img = $el('img');
            img.src     = thumbUrl;
            img.alt     = item.title || '';
            img.onerror = () => {
                console.warn('[imgSearch] Falhou a carregar miniatura:', thumbUrl?.slice(0, 60));
                wrap.style.display = 'none';
            };
            img.onclick = () => {
                const chosen = origUrl || thumbUrl;
                $id('edit-img-url').value = chosen;
                imgUrlPreview(chosen);
                resultsEl.querySelectorAll('.img-result-thumb').forEach(t => t.classList.remove('selected'));
                wrap.classList.add('selected');
            };
            wrap.appendChild(img);
            resultsEl.appendChild(wrap);
        });

    } catch(e) {
        if (e?.message === 'Failed to fetch' || e?.name === 'TypeError') {
            showToast('Erro CORS — configura um Cloudflare Worker como proxy em Definições.', 'error');
        } else {
            showToast('Erro na pesquisa: ' + (e?.message || e), 'error');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = SEARCH_SVG + ' Pesquisar imagem';
    }
}

// Evita que o utilizador fique com o botão bloqueado para sempre se a API não responder.
function _fetchWithTimeout(url, opts, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

async function testAnthropicProxy() {
    const val = _getAnthropicKey();
    if (!val) { showToast('Configura primeiro o URL do Worker', 'error'); return; }

    const btn = $id('btn-test-ocr');
    if (btn) { btn.disabled = true; btn.textContent = '◷ A testar…'; }

    try {
        const isProxy = _isProxyUrl(val);
        const endpoint = isProxy ? val : 'https://api.anthropic.com/v1/messages';
        const headers = { 'Content-Type': 'application/json' };
        if (!isProxy) {
            headers['x-api-key'] = val;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-allow-browser'] = 'true';
        }

        const resp = await _fetchWithTimeout(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'Hi' }]
            })
        }, 15000); // timeout mais curto para o teste

        const data = await resp.json();
        if (data.content || data.id) {
            showToast('✓ Ligação OK — Claude Vision pronto a usar!', 'ok');
        } else if (data.error) {
            showToast('Erro da API: ' + (data.error.message || JSON.stringify(data.error)), 'error');
        } else {
            showToast('Resposta inesperada: ' + JSON.stringify(data).slice(0, 80), 'error');
        }
    } catch(e) {
        showToast('Falha na ligação: ' + (e.message || e), 'error');
        console.error('[testProxy]', e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Testar ligação'; }
    }
}

// OCR KEYWORDS — palavras-chave de estabelecimento
const OCR_KEYWORDS_KEY = 'hiperfrio-ocr-keywords';

function saveOcrKeywords() {
    const val = $id('inp-ocr-keywords').value.trim();
    if (val) localStorage.setItem(OCR_KEYWORDS_KEY, val);
    else localStorage.removeItem(OCR_KEYWORDS_KEY);
    showToast('Palavras-chave guardadas ✓', 'ok');
}

function _getOcrKeywords() {
    return (localStorage.getItem(OCR_KEYWORDS_KEY) || '')
        .split('\n').map(k => k.trim()).filter(Boolean);
}

function _loadOcrKeywordsInput() {
    const el = $id('inp-ocr-keywords');
    if (el) el.value = _getOcrKeywords().join('\n');
}

function patProductSearch(val) {
    _patDropdownIdx = -1;
    const dd = $id('pat-product-dropdown');
    const q = val.trim().toLowerCase();
    if (!q) { dd.innerHTML = ''; return; }

    const stock = cache.stock.data || {};
    const matches = Object.entries(stock)
        .filter(([id, item]) => {
            if (_patProducts.some(p => p.id === id)) return false;
            const codigo = (item.codigo || '').toLowerCase();
            const nome   = (item.nome   || '').toLowerCase();
            return codigo.startsWith(q) || nome.includes(q);
        })
        .slice(0, 8);

    if (matches.length === 0) {
        dd.innerHTML = '<div class="pat-dd-empty">Sem resultados</div>';
        return;
    }

    dd.innerHTML = '';
    matches.forEach(([id, item], i) => {
        const opt = $el('div', { className: 'pat-dd-option' });
        opt.dataset.idx = i;
        const stockQty = item.quantidade || 0;
        opt.innerHTML = `
            <span class="pat-dd-code">${escapeHtml((item.codigo||'SEMREF').toUpperCase())}</span>
            <span class="pat-dd-name">${escapeHtml(item.nome||'')}</span>
            <span class="pat-dd-stock">Stock: ${stockQty}</span>`;
        opt.onmousedown = (e) => { e.preventDefault(); patAddProduct(id, item); };
        dd.appendChild(opt);
    });
}

function patProductKeydown(e) {
    const dd = $id('pat-product-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _patDropdownIdx = Math.min(_patDropdownIdx + 1, opts.length - 1);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patDropdownIdx));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _patDropdownIdx = Math.max(_patDropdownIdx - 1, 0);
        opts.forEach((o, i) => o.classList.toggle('focused', i === _patDropdownIdx));
    } else if (e.key === 'Enter' && _patDropdownIdx >= 0) {
        e.preventDefault();
        opts[_patDropdownIdx]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
        dd.innerHTML = '';
    }
}

function patAddProduct(id, item) {
    if (_patProducts.some(p => p.id === id)) return;
    _patProducts.push({
        id,
        codigo: (item.codigo || 'SEMREF').toUpperCase(),
        nome: item.nome || '',
        quantidade: 1,
        stockDisponivel: item.quantidade || 0
    });
    _renderPatChips();
    $id('pat-product-search').value = '';
    $id('pat-product-dropdown').innerHTML = '';
    $id('pat-product-search').focus();
}

function patRemoveProduct(id) {
    _patProducts = _patProducts.filter(p => p.id !== id);
    _renderPatChips();
}

function patSetQty(id, val) {
    const prod = _patProducts.find(p => p.id === id);
    if (!prod) return;
    const n = Math.max(1, parseInt(val) || 1);
    prod.quantidade = n;
    // Actualiza visualmente o input sem re-renderizar tudo
    const inp = document.querySelector(`.pat-chip[data-id="${id}"] .pat-chip-qty`);
    if (inp && inp !== document.activeElement) inp.value = n;
}

function _renderPatChips() {
    const el = $id('pat-product-chips');
    el.innerHTML = '';
    _patProducts.forEach(p => {
        const chip = $el('div', { className: 'pat-chip' });
        chip.dataset.id = p.id;
        chip.innerHTML = `
            <div class="pat-chip-info">
                <span class="pat-chip-code">${escapeHtml(p.codigo)}</span>
                <span class="pat-chip-name">${escapeHtml(p.nome)}</span>
            </div>
            <div class="pat-chip-controls">
                <span class="pat-chip-stock-label">Stock: ${p.stockDisponivel}</span>
                <div class="pat-chip-qty-wrap">
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',-1)">−</button>
                    <input class="pat-chip-qty" type="number" min="1" value="${p.quantidade}"
                        onchange="patSetQty('${p.id}',this.value)"
                        onblur="patSetQty('${p.id}',this.value)">
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',1)">+</button>
                </div>
                <button class="pat-chip-remove" onclick="patRemoveProduct('${p.id}')" aria-label="Remover">×</button>
            </div>`;
        el.appendChild(chip);
    });
}

function patQtyStep(id, delta) {
    const prod = _patProducts.find(p => p.id === id);
    if (!prod) return;
    prod.quantidade = Math.max(1, (prod.quantidade || 1) + delta);
    const inp = document.querySelector(`.pat-chip[data-id="${id}"] .pat-chip-qty`);
    if (inp) inp.value = prod.quantidade;
}

async function savePat() {
    const editId     = $id('pat-edit-id').value.trim();
    const isEdit     = !!editId;
    const numero     = $id('pat-numero').value.trim();
    const clienteNum = $id('pat-cliente-num').value.trim();
    const clienteId  = $id('pat-cliente-id').value.trim() || null;
    const estab      = $id('pat-estabelecimento').value.trim().toUpperCase();
    const separacao  = $id('pat-separacao').checked;
    const obs        = ($id('pat-obs')?.value || '').trim();
    const hint       = $id('pat-numero-hint');

    if (!/^\d{6}$/.test(numero)) {
        hint.textContent = 'O Nº PAT deve ter exactamente 6 dígitos.';
        hint.style.color = 'var(--danger)';
        $id('pat-numero').focus();
        return;
    }
    hint.textContent = '';

    // Verificar duplicado — só na criação
    // Verifica primeiro no cache local (rápido), depois confirma na Firebase
    // para proteger contra dois utilizadores a criar a mesma PAT em simultâneo.
    if (!isEdit) {
        const patsExistentes = Object.values(_patCache.data || {});
        const duplicadoLocal = patsExistentes.find(p => p.numero === numero && p.status !== 'levantado');
        if (duplicadoLocal) {
            hint.textContent = `PAT ${numero} já está registada (${duplicadoLocal.estabelecimento || 'sem estabelecimento'}).`;
            hint.style.color = 'var(--danger)';
            $id('pat-numero').focus();
            return;
        }
        // Confirmação remota — protege contra race condition multi-utilizador
        if (navigator.onLine) {
            try {
                const checkUrl = await authUrl(`${BASE_URL}/pedidos.json?orderBy="numero"&equalTo="${numero}"`);
                const checkRes = await fetch(checkUrl);
                if (checkRes.ok) {
                    const remote = await checkRes.json();
                    if (remote && typeof remote === 'object') {
                        const remoteActive = Object.values(remote).find(p => p.status !== 'levantado');
                        if (remoteActive) {
                            hint.textContent = `PAT ${numero} já está registada por outro utilizador.`;
                            hint.style.color = 'var(--danger)';
                            $id('pat-numero').focus();
                            // Actualiza cache local com o que o servidor tem
                            _patCache.lastFetch = 0;
                            return;
                        }
                    }
                }
            } catch(e) {
                console.warn('[savePat] verificação remota de duplicado falhou:', e?.message);
                // Não bloquear — continua com a verificação local
            }
        }
    }

    if (isEdit) {
        // ── Modo edição — PATCH só os campos editáveis ────────────────────
        const patchPayload = {
            clienteNumero:   clienteNum || null,
            clienteId:       clienteId  || null,
            estabelecimento: estab,
            separacao,
            obs:             obs || null,
            produtos: _patProducts.map(p => ({
                id: p.id, codigo: p.codigo, nome: p.nome, quantidade: p.quantidade || 1
            })),
        };
        try {
            await apiFetch(`${BASE_URL}/pedidos/${editId}.json`, {
                method: 'PATCH',
                body: JSON.stringify(patchPayload),
            });
            if (_patCache.data?.[editId]) {
                _patCache.data[editId] = { ..._patCache.data[editId], ...patchPayload };
            }
            closePatModal();
            renderPats();
            showToast(`PAT ${numero} actualizada`);
        } catch(_e) { showToast('Erro ao guardar edição', 'error'); }
    } else {
        // ── Modo criação — POST novo ───────────────────────────────────────
        const payload = {
            numero,
            clienteNumero: clienteNum || null,
            clienteId:     clienteId  || null,
            estabelecimento: estab,
            separacao,
            obs:           obs || null,
            produtos: _patProducts.map(p => ({
                id: p.id, codigo: p.codigo, nome: p.nome, quantidade: p.quantidade || 1
            })),
            status: 'pendente',
            criadoEm: Date.now(),
        };
        try {
            const res = await apiFetch(`${BASE_URL}/pedidos.json`, {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            if (!_patCache.data) _patCache.data = {};
            if (res) {
                const r = await res.json();
                if (r?.name) _patCache.data[r.name] = payload;
            } else {
                _patCache.data[`_tmp_pat_${Date.now()}`] = payload;
            }
            closePatModal();
            renderPats();
            showToast(res ? `PAT ${numero} registada!` : `PAT ${numero} guardada offline`);
        } catch(_e) { showToast('Erro ao guardar pedido', 'error'); }
    }
}

async function marcarPatLevantado(id) {
    const pat = _patCache.data?.[id];
    if (!pat) return;
    // Protecção contra duplo-clique: verificar se já está levantado no cache local
    if (pat.status === 'levantado') {
        showToast('PAT já foi levantada', 'error'); return;
    }
    const separacao = !!pat?.separacao;

    const desc = separacao
        ? 'Pedido com Separação de Material — o stock dos produtos será descontado automaticamente.'
        : 'O pedido será removido dos pendentes. O stock não será alterado.';

    openConfirmModal({
        title: 'Marcar como levantado?',
        type: 'success', okLabel: 'Levantar',
        desc,
        onConfirm: async () => {
            try {
                // Marca no cache local IMEDIATAMENTE — protege contra duplo clique
                // Um segundo marcarPatLevantado verá status='levantado' e sairá
                if (_patCache.data?.[id]) _patCache.data[id].status = 'levantado';

                // 1 — Marca como levantado na Firebase (com suporte offline)
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'levantado', levantadoEm: Date.now() }),
                });

                // 2 — Se separação: desconta stock com delta seguro (multi-utilizador)
                // Usa _commitStockDelta que lê o valor ACTUAL do servidor antes de escrever,
                // evitando sobreposição quando outro utilizador alterou o stock entretanto.
                if (separacao && pat.produtos?.length) {
                    const patches = pat.produtos
                        .filter(p => p.id)
                        .map(p => {
                            const qtdPat = p.quantidade || 1;
                            // Optimistic update no cache local para feedback imediato
                            const cacheAtual = cache.stock.data?.[p.id]?.quantidade ?? 0;
                            const cacheNova  = Math.max(0, cacheAtual - qtdPat);
                            if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = cacheNova;
                            registarMovimento('saida_pat', p.id, p.codigo, p.nome, qtdPat);
                            // _commitStockDelta lê o valor real do servidor e aplica o delta
                            // baseQty = cacheAtual, finalQty = cacheNova → delta = -qtdPat
                            return _commitStockDelta(p.id, cacheAtual, cacheNova)
                                .then(savedQty => {
                                    if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = savedQty;
                                })
                                .catch(e => console.warn('[Stock] PATCH falhou:', p.id, e.message));
                        });
                    await Promise.allSettled(patches);
                    renderList();
                }

                // updatePatCount já faz fetch — evitar chamada dupla após renderPats
                renderPats();
                showToast(separacao ? 'Levantado — stock descontado!' : 'Pedido marcado como levantado!');
            } catch(_e) { showToast('Erro ao actualizar pedido', 'error'); }
        }
    });
}

async function apagarPat(id) {
    openConfirmModal({
        title: 'Apagar pedido?',
        type: 'danger',
        desc: 'O pedido será eliminado permanentemente. O stock não é alterado.',
        onConfirm: async () => {
            try {
                const pat = _patCache.data?.[id];
                // Guardar snapshot antes de apagar — garante que a PAT é contada no relatório
                if (pat) await _relSalvarPatAntesDeApagar(pat);
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' });
                if (_patCache.data) delete _patCache.data[id];
                renderPats();
                updatePatCount();
                showToast('Pedido apagado');
            } catch(_e) { showToast('Erro ao apagar pedido', 'error'); }
        }
    });
}

function openPatDetail(id, pat) {
    const dias      = _calcDias(pat.criadoEm);
    const dataStr   = pat.criadoEm ? new Date(pat.criadoEm).toLocaleDateString('pt-PT') : '—';
    const urgente   = dias >= 20;
    const separacao = !!pat.separacao;
    const body      = $id('pat-detail-body');
    body.innerHTML  = '';

    // ── Helper: criar linha de detalhe ──────────────────────────────────
    function _row(lbl, val) {
        const d = $el('div', { className: 'pat-detail-row' });
        const l = $el('span', { className: 'pat-detail-lbl' });
        l.textContent = lbl;
        const v = $el('span');
        v.textContent = val;
        d.appendChild(l); d.appendChild(v);
        return d;
    }

    // ── Header colorido ──────────────────────────────────────────────────
    const hdr = $el('div', { className: 'pat-detail-header' });
    hdr.style.cssText = [
        'text-align:left',
        'margin:-16px -16px 16px',
        'padding:16px',
        urgente
            ? 'background:#fef2f2;border-bottom:1px solid #fecaca'
            : 'background:var(--bg);border-bottom:1px solid var(--border)',
    ].join(';');

    // Linha 1: número PAT + badge estado
    const hdrTop = $el('div');
    hdrTop.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';

    const numEl = $el('span');
    numEl.style.cssText = `font-size:1.1rem;font-weight:600;color:${urgente ? '#7f1d1d' : 'var(--text-main)'}`;
    numEl.textContent = 'PAT ' + (pat.numero || '—');
    hdrTop.appendChild(numEl);

    const estadoBadge = $el('span');
    estadoBadge.style.cssText = urgente
        ? 'font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5'
        : 'font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:rgba(202,138,4,0.12);color:#92400e;border:1px solid rgba(202,138,4,0.25)';
    estadoBadge.textContent = (urgente ? '🔴 Urgente' : '🟡 Pendente') + ' · ' + (dias === 0 ? 'hoje' : `${dias}d`);
    hdrTop.appendChild(estadoBadge);

    if (separacao) {
        const st = $el('span', { className: 'pat-sep-tag' });
        st.textContent = 'Guia Transporte';
        hdrTop.appendChild(st);
    }
    hdr.appendChild(hdrTop);

    // Linha 2: nome do estabelecimento em destaque
    const estabEl = $el('p');
    estabEl.style.cssText = `margin:0 0 2px;font-size:15px;font-weight:500;color:${urgente ? '#7f1d1d' : 'var(--text-main)'}`;
    estabEl.textContent = pat.estabelecimento || 'Não especificado';
    hdr.appendChild(estabEl);

    // Linha 3: data
    const dateEl = $el('p');
    dateEl.style.cssText = `margin:0;font-size:12px;color:${urgente ? '#b91c1c' : 'var(--text-muted)'}`;
    dateEl.textContent = 'Criado em ' + dataStr;
    hdr.appendChild(dateEl);

    body.appendChild(hdr);

    // ── Linhas de informação ─────────────────────────────────────────────
    if (pat.funcionario) body.appendChild(_row('Levantado por', pat.funcionario));

    // ── Observações ──────────────────────────────────────────────────────
    if (pat.obs) {
        const obsLbl = $el('div', { className: 'pat-detail-lbl' });
        obsLbl.style.cssText = 'margin-top:14px;margin-bottom:6px';
        obsLbl.textContent = 'Observações';
        body.appendChild(obsLbl);
        const obsBox = $el('div');
        obsBox.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:0.875rem;color:var(--text-main);line-height:1.5;white-space:pre-wrap';
        obsBox.textContent = pat.obs;
        body.appendChild(obsBox);
    }

    // ── Produtos ─────────────────────────────────────────────────────────
    if (pat.produtos?.length) {
        const lbl = $el('div', { className: 'pat-detail-lbl' });
        lbl.style.cssText = 'margin-top:14px;margin-bottom:8px';
        lbl.textContent = 'Produtos reservados';
        body.appendChild(lbl);
        const prodsDiv = $el('div', { className: 'pat-detail-produtos' });
        pat.produtos.forEach(p => {
            const row = $el('div', { className: 'pat-detail-prod' });
            const code = $el('span', { className: 'pat-dd-code' });
            code.textContent = p.codigo || '?';
            const name = $el('span', { className: 'pat-dd-name' });
            name.textContent = p.nome || '';
            const qty = $el('span', { className: 'pat-detail-qty' });
            qty.textContent = '× ' + (p.quantidade || 1);
            row.appendChild(code); row.appendChild(name); row.appendChild(qty);
            prodsDiv.appendChild(row);
        });
        body.appendChild(prodsDiv);
    } else {
        const empty = $el('div', { className: 'pat-empty' });
        empty.style.marginTop = '12px';
        empty.textContent = 'Sem produtos associados.';
        body.appendChild(empty);
    }

    // ── Acções ───────────────────────────────────────────────────────────
    const actions = $el('div', { className: 'pat-detail-actions' });

    if (pat.status !== 'levantado' && pat.status !== 'historico') {
        const btnLev = $el('button', { className: 'pat-btn-levantado' });
        btnLev.style.flex  = '1';
        btnLev.innerHTML   = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btnLev.appendChild(document.createTextNode('Dar como levantado'));
        btnLev.onclick     = () => { modalClose('pat-detail-modal'); marcarPatLevantado(id); };
        actions.appendChild(btnLev);
    }

    const btnDel = $el('button', { className: 'pat-btn-apagar' });
    btnDel.setAttribute('aria-label', 'Apagar PAT');
    btnDel.innerHTML = SVG_DEL;
    btnDel.onclick   = () => { modalClose('pat-detail-modal'); apagarPat(id); };
    actions.appendChild(btnDel);

    body.appendChild(actions);

    modalOpen('pat-detail-modal');
    focusModal('pat-detail-modal');
}

