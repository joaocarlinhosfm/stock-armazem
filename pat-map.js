// ─────────────────────────────────────────────────────────────────────────────
// pat-map.js — Gestão Armazém v6.81
// Mapa interativo de Pedidos PAT (Leaflet + CARTO + MarkerCluster), pins de
// insígnias, pin bottom-sheet, painel lateral desktop e geocoding em 3 camadas
// (/clientes → /geocode-cache → Nominatim).
//
// DEPENDÊNCIAS:
//   utils.js    — BASE_URL, $id, $el, _calcDias, loadLeaflet
//   auth.js     — authUrl
//   clientes.js — _clientesCache, _fetchClientes
//   pats.js     — _patCache, _fetchPats, marcarPatLevantado
//   app.js      — apiFetch, nav
// ─────────────────────────────────────────────────────────────────────────────

// ── BASEMAP CARTO ────────────────────────────────────────────────────────────
// A CARTO exige API key nos basemaps raster (sem ela os tiles saem com a marca
// de água "API KEY REQUIRED"). Cola aqui a tua chave. Restringe-a por domínio
// no painel da CARTO, porque fica visível no browser.
const CARTO_BASEMAP_KEY = 'cb1_4ooc_1_9964b3715d785797629e480a';

function _createBaseLayer(minZoom) {
    return L.tileLayer(
        'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=' + encodeURIComponent(CARTO_BASEMAP_KEY),
        {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 20,
            minZoom: minZoom,
        }
    );
}

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
    const bgColor   = urgente ? '#dc2626' : '#334155';   // (o parâmetro 'separacao' já não tem efeito)
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
    // marcarPatLevantado já tem a sua confirmação (com o stock a descontar) —
    // antes havia duas confirmações seguidas e o mapa actualizava antes da 2ª.
    levBtn.onclick = () => marcarPatLevantado(id, {
        onDone: async () => {
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
    // Lazy load de Leaflet — só no primeiro uso do mapa
    try { await loadLeaflet(); } catch(e) { console.error('[Mapa] Leaflet não carregou:', e?.message); return; }

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
    _createBaseLayer(6).addTo(_patMap);
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
    // Lazy load de Leaflet — só no primeiro uso do mapa
    try { await loadLeaflet(); } catch(e) { console.error('[Mapa] Leaflet não carregou:', e?.message); return; }

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

    _createBaseLayer(6).addTo(_patMap);

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
    // Lazy load de Leaflet — só no primeiro uso do mapa
    try { await loadLeaflet(); } catch(e) { console.error('[Mapa] Leaflet não carregou:', e?.message); return; }

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
        _createBaseLayer(5).addTo(_patMapPanel);
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
