'use strict';

/* ═══════════════════════════════════════════════════════════
   StreamLine Sports — app.js
   API confirmada: api.sportsrc.org (sem login, sem chave)
   /?data=sports       → { success:true, data:[{id,name}] }
   /?data=matches&category=football → { success:true, data:[...] }
   /?data=detail&category=X&id=Y   → { success:true, data:{...} }
════════════════════════════════════════════════════════════ */

const API_BASE = 'https://api.sportsrc.org/';

const SPORT_ICONS = {
    football:       'fa-futbol',
    basketball:     'fa-basketball-ball',
    tennis:         'fa-table-tennis',
    baseball:       'fa-baseball-ball',
    hockey:         'fa-hockey-puck',
    fight:          'fa-fist-raised',
    rugby:          'fa-football-ball',
    cricket:        'fa-cricket',
    golf:           'fa-golf-ball',
    'motor-sports': 'fa-flag-checkered',
    olympics:       'fa-medal',
    afl:            'fa-football-ball',
    darts:          'fa-bullseye',
    billiards:      'fa-circle',
    other:          'fa-trophy',
};

const BG_IMAGES = {
    football:   'https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=1200',
    basketball: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=1200',
    tennis:     'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=1200',
    fight:      'https://images.unsplash.com/photo-1555597673-b21d5c935865?q=80&w=1200',
    default:    'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?q=80&w=1200',
};

// Estado global mínimo
let activeCat = 'football';
let allMatches = [];

/* ─── Utilitários ─────────────────────────────────────────── */
function esc(s) {
    const d = document.createElement('div');
    d.textContent = (s == null ? '' : String(s));
    return d.innerHTML;
}

function teamName(teamObj) {
    return (teamObj && teamObj.name) ? teamObj.name : '?';
}

function fmtDate(ms) {
    if (!ms) return 'Em breve';
    return new Date(ms).toLocaleString('pt-PT', {
        weekday:'short', day:'2-digit', month:'short',
        hour:'2-digit', minute:'2-digit'
    });
}

function isLive(ms) {
    if (!ms) return false;
    const now = Date.now();
    return ms <= now && ms >= now - 3 * 60 * 60 * 1000;
}

/* ─── API ─────────────────────────────────────────────────── */
async function apiGet(params) {
    const url = new URL(API_BASE);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v).trim());
    }
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('JSON inválido'); }
    // A API pode devolver {success, data} ou directamente array/objeto
    if (json && typeof json === 'object' && 'data' in json) return json.data;
    return json;
}

/* ─── Arranque ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);

function init() {
    document.getElementById('search-field').addEventListener('input', onSearch);
    loadCategories();
}

/* ─── Carregar categorias / tabs ──────────────────────────── */
async function loadCategories() {
    document.getElementById('sport-tabs').innerHTML =
        '<div class="tabs-loading"><div class="tab-ghost"></div><div class="tab-ghost"></div><div class="tab-ghost"></div></div>';

    let cats;
    try {
        cats = await apiGet({ data: 'sports' });
        // cats = [{id:"football", name:"Football"}, ...]
        if (!Array.isArray(cats) || !cats.length) throw new Error('lista vazia');
    } catch (e) {
        console.warn('Fallback categorias:', e.message);
        cats = [
            { id: 'football',   name: 'Football'   },
            { id: 'basketball', name: 'Basketball' },
            { id: 'tennis',     name: 'Tennis'     },
            { id: 'fight',      name: 'Fight / UFC'},
            { id: 'hockey',     name: 'Hockey'     },
        ];
    }

    renderTabs(cats);
    loadMatches('football');   // abre futebol por defeito
}

function renderTabs(cats) {
    const nav = document.getElementById('sport-tabs');
    nav.innerHTML = '';
    cats.forEach((cat, i) => {
        const btn = document.createElement('button');
        btn.className = 'sport-tab' + (cat.id === 'football' ? ' active' : '');
        btn.dataset.cat = cat.id;
        btn.innerHTML = `<i class="fas ${SPORT_ICONS[cat.id] || 'fa-trophy'}"></i>${esc(cat.name)}`;
        btn.style.animationDelay = `${i * 0.04}s`;
        btn.addEventListener('click', () => onTabClick(cat.id));
        nav.appendChild(btn);
    });
}

function onTabClick(cat) {
    activeCat = cat;
    document.querySelectorAll('.sport-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.cat === cat)
    );
    loadMatches(cat);
}

/* ─── Carregar jogos ──────────────────────────────────────── */
async function loadMatches(cat) {
    activeCat = cat;

    // Limpa ecrã
    document.getElementById('hero-featured').style.display = 'none';
    document.getElementById('live-bar').style.display = 'none';
    document.getElementById('empty-state').style.display = 'none';
    showSkeletons();

    let matches;
    try {
        const data = await apiGet({ data: 'matches', category: cat });
        // data = array de jogos
        matches = Array.isArray(data) ? data.filter(m => m && m.id) : [];
    } catch (e) {
        console.error('loadMatches erro:', e);
        clearSkeletons();
        showError('Erro: ' + e.message);
        return;
    }

    allMatches = matches;
    clearSkeletons();
    renderMatches(matches);
}

/* ─── Render jogos ────────────────────────────────────────── */
function renderMatches(matches) {
    document.getElementById('hero-featured').style.display = 'none';
    document.getElementById('live-bar').style.display = 'none';
    document.getElementById('main-content').innerHTML = '';
    document.getElementById('empty-state').style.display = 'none';

    if (!matches.length) {
        document.getElementById('empty-title').textContent = 'Sem jogos disponíveis';
        document.getElementById('empty-desc').textContent = 'Não há jogos agendados neste momento.';
        document.getElementById('empty-state').style.display = 'flex';
        return;
    }

    // Hero
    const hero = matches.find(m => m.popular) || matches[0];
    setupHero(hero);

    // Live ticker
    const liveMatches = matches.filter(m => isLive(m.date));
    if (liveMatches.length) renderLiveBar(liveMatches);

    // Grid de jogos
    const section = document.createElement('div');
    section.className = 'row';

    const label = document.createElement('div');
    label.className = 'row-header';
    label.innerHTML = `<div class="row-title">Jogos</div><span class="row-count">${matches.length}</span>`;
    section.appendChild(label);

    const carousel = document.createElement('div');
    carousel.className = 'carousel';
    matches.forEach(m => carousel.appendChild(buildCard(m)));
    section.appendChild(carousel);

    document.getElementById('main-content').appendChild(section);
}

function buildCard(match) {
    const home   = teamName(match.teams?.home);
    const away   = teamName(match.teams?.away);
    const hBadge = match.teams?.home?.badge;
    const aBadge = match.teams?.away?.badge;
    const live   = isLive(match.date);
    const time   = live ? 'AO VIVO' : fmtDate(match.date);
    const poster = match.poster;

    const card = document.createElement('div');
    card.className = 'match-card' + (live ? ' is-live' : '');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    // Visual topo: poster ou badges
    let top = '';
    if (poster) {
        top = `<img class="card-poster" src="${esc(poster)}" alt="" loading="lazy"
               onerror="this.style.display='none'">`;
    } else {
        const hImg = hBadge
            ? `<img src="${esc(hBadge)}" alt="" loading="lazy" style="width:34px;height:34px;object-fit:contain" onerror="this.outerHTML='<span class=badge-init>${esc(home.slice(0,2).toUpperCase())}</span>'">`
            : `<span class="badge-init">${esc(home.slice(0,2).toUpperCase())}</span>`;
        const aImg = aBadge
            ? `<img src="${esc(aBadge)}" alt="" loading="lazy" style="width:34px;height:34px;object-fit:contain" onerror="this.outerHTML='<span class=badge-init>${esc(away.slice(0,2).toUpperCase())}</span>'">`
            : `<span class="badge-init">${esc(away.slice(0,2).toUpperCase())}</span>`;
        top = `<div class="card-poster-placeholder">${hImg}<span class="card-vs">VS</span>${aImg}</div>`;
    }

    card.innerHTML = `
        ${top}
        <div class="card-body">
            <div class="card-teams">${esc(home)} vs ${esc(away)}</div>
            <div class="card-time ${live ? 'live' : ''}">
                <i class="fas ${live ? 'fa-circle' : 'fa-clock'}"></i> ${esc(time)}
            </div>
        </div>
        <div class="card-play-overlay"><i class="fas fa-play"></i></div>
    `;

    card.addEventListener('click', () => openMatch(match));
    card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMatch(match); }
    });
    return card;
}

/* ─── Hero ────────────────────────────────────────────────── */
function setupHero(match) {
    const home = teamName(match.teams?.home);
    const away = teamName(match.teams?.away);
    const live = isLive(match.date);

    document.getElementById('hero-teams').innerHTML =
        `${esc(home)}<span class="hero-vs">VS</span>${esc(away)}`;
    document.getElementById('hero-league').textContent = '';
    document.getElementById('hero-time').textContent =
        live ? '🔴 Ao vivo agora' : fmtDate(match.date);

    const bg = document.getElementById('hero-bg');
    const img = match.poster || BG_IMAGES[activeCat] || BG_IMAGES.default;
    bg.style.backgroundImage = `url('${img}')`;
    bg.style.opacity = '0';
    requestAnimationFrame(() => {
        bg.style.transition = 'opacity .8s';
        bg.style.opacity = '1';
    });

    document.getElementById('hero-play').onclick = () => openMatch(match);
    document.getElementById('hero-featured').style.display = 'flex';
}

/* ─── Live bar ────────────────────────────────────────────── */
function renderLiveBar(liveList) {
    const bar   = document.getElementById('live-bar');
    const track = document.getElementById('live-bar-track');
    track.innerHTML = '';
    liveList.forEach(m => {
        const pill = document.createElement('div');
        pill.className = 'live-pill';
        const h = teamName(m.teams?.home);
        const a = teamName(m.teams?.away);
        pill.innerHTML = `<span class="live-pill-dot"></span>${esc(h)} vs ${esc(a)}`;
        pill.addEventListener('click', () => openMatch(m));
        track.appendChild(pill);
    });
    bar.style.display = 'flex';
}

/* ─── Abrir jogo → streams ────────────────────────────────── */
async function openMatch(match) {
    const home = teamName(match.teams?.home);
    const away = teamName(match.teams?.away);

    document.getElementById('player-title').textContent = `${home} vs ${away}`;
    document.getElementById('player-subtitle').textContent = match.category || activeCat;
    document.getElementById('stream-sources').innerHTML = '';

    document.getElementById('video-player-container').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    showSpinner();

    try {
        // Fetch RAW — não usar apiGet para não perder nenhum campo
        const url = new URL(API_BASE);
        url.searchParams.set('data', 'detail');
        url.searchParams.set('category', activeCat.trim());
        url.searchParams.set('id', match.id.trim());

        const res = await fetch(url.toString());
        const text = await res.text();
        console.log('[SportSRC] detail RAW:', text.slice(0, 2000));

        let json;
        try { json = JSON.parse(text); } catch { throw new Error('Resposta inválida: ' + text.slice(0, 100)); }

        // Tenta extrair sources de QUALQUER nível da resposta
        const sources = extractSources(json);
        console.log('[SportSRC] streams encontrados:', sources.length, sources);

        if (!sources.length) {
            hideSpinner();
            showNoStream('Sem stream neste momento. Tenta noutra fonte ou aguarda o início do jogo.');
            return;
        }

        buildSourceButtons(sources);
        loadStream(sources[0]);

    } catch (e) {
        console.error('[SportSRC] openMatch erro:', e);
        hideSpinner();
        showNoStream(e.message);
    }
}

// Formato confirmado da API SportSRC:
// { success, data: { sources: [ { streamNo, hd, language, embedUrl, source, viewers } ] } }

function extractSources(json) {
    if (!json) return [];

    // Desce para data se existir
    const root = (json.data !== undefined) ? json.data : json;
    if (!root) return [];

    // Formato real: root.sources[]  com campo embedUrl
    if (Array.isArray(root.sources) && root.sources.length) {
        return root.sources
            .filter(s => s && s.embedUrl)
            .map((s, i) => ({
                name: buildSourceName(s, i),
                url: s.embedUrl
            }));
    }

    // Fallbacks para outros formatos possíveis
    if (Array.isArray(root.streams) && root.streams.length) {
        return root.streams
            .filter(s => s && (s.embedUrl || s.url || s.embed || s.src))
            .map((s, i) => ({
                name: buildSourceName(s, i),
                url: s.embedUrl || s.url || s.embed || s.src
            }));
    }

    // Array directo na raiz
    if (Array.isArray(root) && root.length && root[0]?.embedUrl) {
        return root
            .filter(s => s && s.embedUrl)
            .map((s, i) => ({ name: buildSourceName(s, i), url: s.embedUrl }));
    }

    // URL única directa
    const single = root.embedUrl || root.embed || root.url || root.iframe || root.src;
    if (single && typeof single === 'string' && single.startsWith('http')) {
        return [{ name: 'Stream 1', url: single }];
    }

    return [];
}

function buildSourceName(s, i) {
    const num = s.streamNo || (i + 1);
    const hd  = s.hd ? ' HD' : '';
    const lang = s.language ? ` · ${s.language.toUpperCase()}` : '';
    return `Fonte ${num}${hd}${lang}`;
}

function buildSourceButtons(sources) {
    const bar = document.getElementById('stream-sources');
    bar.innerHTML = '';

    sources.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.className = 'src-btn' + (i === 0 ? ' active' : '');
        btn.textContent = s.name || `Fonte ${i + 1}`;
        btn.dataset.idx = i;
        btn.addEventListener('click', () => {
            document.querySelectorAll('.src-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadStream(s);
        });
        bar.appendChild(btn);
    });

    // Botão de reload sempre presente
    const reload = document.createElement('button');
    reload.className = 'src-btn src-reload';
    reload.innerHTML = '<i class="fas fa-redo"></i>';
    reload.title = 'Recarregar stream';
    reload.addEventListener('click', () => {
        const active = bar.querySelector('.src-btn.active:not(.src-reload)');
        const idx = active ? parseInt(active.dataset.idx) : 0;
        loadStream(sources[idx]);
    });
    bar.appendChild(reload);
}

function loadStream(source) {
    const iframe = document.getElementById('main-iframe');
    const url = typeof source === 'string' ? source : source.url;
    showSpinner();
    iframe.src = 'about:blank';
    setTimeout(() => {
        iframe.src = url;
        iframe.onload = () => setTimeout(hideSpinner, 500);
        setTimeout(hideSpinner, 15000);
    }, 300);
}

function showNoStream(detail) {
    hideSpinner();
    const container = document.getElementById('video-player-container');
    container.querySelectorAll('.no-stream-msg').forEach(e => e.remove());
    const msg = document.createElement('div');
    msg.className = 'no-stream-msg';
    msg.innerHTML = `
        <i class="fas fa-satellite-dish"></i>
        <p>Stream ainda não disponível</p>
        <small>${esc(detail || 'O jogo pode ainda não ter começado.')}</small>
        <button onclick="closePlayer()"><i class="fas fa-arrow-left"></i> Voltar</button>
    `;
    container.appendChild(msg);
}


function closePlayer() {
    document.getElementById('main-iframe').src = '';
    document.getElementById('video-player-container').style.display = 'none';
    document.body.style.overflow = '';
    hideSpinner();
}

function showSpinner() { document.getElementById('player-spinner').style.display = 'flex'; }
function hideSpinner() { document.getElementById('player-spinner').style.display = 'none'; }

/* ─── Skeletons ───────────────────────────────────────────── */
function showSkeletons() {
    document.getElementById('main-content').innerHTML = `
        <div class="row" style="padding:0 4%">
            <div class="row-header">
                <div style="width:100px;height:13px;border-radius:4px;background:rgba(255,255,255,.07);animation:shimmer 1.4s infinite"></div>
            </div>
            <div class="carousel">
                ${Array(6).fill(`<div style="flex:0 0 200px;height:170px;border-radius:10px;background:rgba(255,255,255,.05);animation:shimmer 1.4s infinite"></div>`).join('')}
            </div>
        </div>
    `;
}

function clearSkeletons() {
    document.getElementById('main-content').innerHTML = '';
}

/* ─── Erro ────────────────────────────────────────────────── */
function showError(msg) {
    document.getElementById('empty-title').textContent = 'Erro';
    document.getElementById('empty-desc').textContent  = msg;
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('empty-state').querySelector('button').onclick = () => loadMatches(activeCat);
}

/* ─── Pesquisa ────────────────────────────────────────────── */
function onSearch() {
    const q = document.getElementById('search-field').value.trim().toLowerCase();
    if (!q) { renderMatches(allMatches); return; }
    const filtered = allMatches.filter(m => {
        const h = (m.teams?.home?.name || '').toLowerCase();
        const a = (m.teams?.away?.name || '').toLowerCase();
        const t = (m.title || '').toLowerCase();
        return h.includes(q) || a.includes(q) || t.includes(q);
    });
    renderMatches(filtered);
}

/* ─── Expor funções usadas no HTML ───────────────────────── */
window.closePlayer   = closePlayer;
window.toggleModal   = (open) => { /* modal removido */ };
window.toggleSearch  = () => {
    const box = document.getElementById('search-box');
    const field = document.getElementById('search-field');
    box.classList.toggle('expanded') ? field.focus() : (field.value = '', onSearch());
};
window.refreshData   = () => loadMatches(activeCat);
