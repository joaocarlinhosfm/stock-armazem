// ─────────────────────────────────────────────────────────────────────────────
// dashboard.js — Gestão Armazém v6.84
// Dashboard v4: snapshots diários (/dash-snapshots), KPIs, alertas, gráfico de
// evolução a 14 dias, garrafas de gases refrigerantes e listas clicáveis.
//
// DEPENDÊNCIAS:
//   utils.js      — BASE_URL, $id, escapeHtml, _calcDias
//   auth.js       — authUrl
//   pats.js       — _patCache, _fetchPats, openPatDetail
//   encomendas.js — _encData, _encEstado, _encNextFilter, loadEncomendas, openEncDetail
//   stock.js      — _pendingZeroFilter
//   app.js        — cache, fetchCollection, apiFetch, nav
// ─────────────────────────────────────────────────────────────────────────────

// DASHBOARD — snapshot diário na Firebase
// Path: /dash-snapshots/{YYYY-MM-DD}
// Guardado 1x por dia, partilhado entre todos os dispositivos.
// Cleanup automático: mantém só os últimos 30 dias.

const DASH_SNAP_URL     = `${BASE_URL}/dash-snapshots`;
const _DASH_SNAP_WROTE_KEY = 'hiperfrio-dashsnap-wrote'; // localStorage: data do último write

function _dashToday() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function _dashYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

// Guarda snapshot do dia na Firebase — só 1x por dia por dispositivo,
// mas qualquer dispositivo pode escrever se ainda não foi escrito hoje.
async function _saveDashSnapshot(total, semStock, alocadas, patPendentes, encActivas) {
    const today = _dashToday();
    const lastWrote = localStorage.getItem(_DASH_SNAP_WROTE_KEY);
    if (lastWrote === today) return; // já escrito hoje neste dispositivo
    try {
        const snap = { date: today, total, semStock, alocadas, patPendentes, encActivas, ts: Date.now() };
        await apiFetch(`${DASH_SNAP_URL}/${today}.json`, {
            method: 'PUT',
            body:   JSON.stringify(snap),
        });
        localStorage.setItem(_DASH_SNAP_WROTE_KEY, today);
        // Cleanup em background: apagar snapshots com mais de 30 dias
        _pruneDashSnapshots().catch(() => {});
    } catch(e) {
        console.warn('[dashSnap] falha ao guardar:', e?.message);
    }
}

// Calcula a diferença entre valor actual e o snapshot de ontem.
// Retorna null se não houver dados de comparação.
function _getDashTrend(field, currentVal, snapYesterday) {
    if (!snapYesterday || snapYesterday[field] == null || currentVal == null) return null;
    const diff = currentVal - snapYesterday[field];
    return diff === 0 ? null : diff;
}

// Apaga snapshots com mais de 30 dias — corre 1x por semana no máximo
const _DASH_PRUNE_KEY = 'hiperfrio-dashsnap-pruned';
async function _pruneDashSnapshots() {
    const lastPrune = localStorage.getItem(_DASH_PRUNE_KEY) || '';
    const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    if (lastPrune >= weekAgo) return;
    try {
        const url  = await authUrl(`${DASH_SNAP_URL}.json`);
        const res  = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data) return;
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const old    = Object.keys(data).filter(k => k < cutoff);
        await Promise.allSettled(
            old.map(k => apiFetch(`${DASH_SNAP_URL}/${k}.json`, { method: 'DELETE' }))
        );
        localStorage.setItem(_DASH_PRUNE_KEY, _dashToday());
    } catch(e) {
        console.warn('[dashSnap] prune error:', e?.message);
    }
}

// ── Dashboard v4 (makeover) ──────────────────────────────────────────────────
// Três ideias: (1) AÇÃO — bloco "Precisa de atenção" no topo, tudo clicável;
// (2) NÚMEROS — KPIs com mini-gráfico e evolução a 14 dias (dos snapshots diários);
// (3) CALMA — cartões limpos, uma só fonte de verdade por número, claro/escuro.
// Fluxo: renderDashboard() → _dvCompute() (números) → _dvDraw() (HTML).
// Cliques: um único listener delegado em #view-dashboard (data-dv-act / data-dv-id).

const _DV_ALERTA_DIAS      = 7;    // ferramenta "em atraso" ao fim de N dias fora (≥)
const _DV_PAT_URGENTE_DIAS = 20;   // PAT "urgente" ao fim de N dias por levantar (≥)
const _DV_HISTORY_DAYS     = 14;   // janela dos mini-gráficos e da evolução

let _dashHistory   = null;         // { fetchedOn, rows } — snapshots diários (cache por dia)
let _dvLast        = null;         // último estado desenhado (para o gráfico de evolução)
let _dvChartMetric = 'patPendentes';
let _dvAlertsOpen  = false;        // lista de alertas expandida (telemóvel)
let _dvSeq         = 0;            // só a chamada mais recente de renderDashboard desenha

const _DV_METRICS = [
    { key: 'patPendentes', tab: 'PATs',        title: 'PATs pendentes',      tone: 'info', upBad: true  },
    { key: 'semStock',     tab: 'Sem stock',   title: 'Artigos sem stock',   tone: 'warn', upBad: true  },
    { key: 'encActivas',   tab: 'Encomendas',  title: 'Encomendas em curso', tone: 'info', upBad: false },
    { key: 'alocadas',     tab: 'Ferramentas', title: 'Ferramentas fora',    tone: 'info', upBad: false },
];

// Ícones (24×24, traço) — Lucide
const _DV_ICO = {
    pat:     '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    tool:    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    gas:     '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
    box:     '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    truck:   '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
    check:   '<path d="M20 6 9 17l-5-5"/>',
    chev:    '<path d="m9 18 6-6-6-6"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
};
function _dvIco(name, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_DV_ICO[name] || ''}</svg>`;
}

// ── Histórico (snapshots) ────────────────────────────────────────────────────

// Todos os snapshots (≤30 dias, ~1 KB) — 1 pedido por dia por sessão.
async function _loadDashHistory() {
    const today = _dashToday();
    if (_dashHistory && _dashHistory.fetchedOn === today) return _dashHistory.rows;
    try {
        const res  = await fetch(await authUrl(`${DASH_SNAP_URL}.json`));
        const data = res.ok ? await res.json() : null;
        const rows = Object.values(data || {}).filter(s => s && s.date).sort((a, b) => a.date < b.date ? -1 : 1);
        _dashHistory = { fetchedOn: today, rows };
        return rows;
    } catch (e) {
        return _dashHistory?.rows || [];
    }
}

// Pontos {d, v} dos últimos N dias + o valor de hoje (ao vivo) no fim.
function _dvSeries(rows, field, liveValue) {
    const today = _dashToday();
    const from  = new Date(Date.now() - (_DV_HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const pts = rows.filter(r => r.date >= from && r.date < today && r[field] != null).map(r => ({ d: r.date, v: r[field] }));
    if (liveValue != null) pts.push({ d: today, v: liveValue });
    return pts;
}

// ── Desenho: peças pequenas ──────────────────────────────────────────────────

const _dvPl = (n, s, p) => n === 1 ? s : p;

function _dvSpark(pts) {
    if (pts.length < 2) return '<span class="dv4-spark dv4-spark-empty"></span>';
    const W = 100, H = 30, pad = 3;
    const vals = pts.map(p => p.v), lo = Math.min(...vals), hi = Math.max(...vals);
    const t0 = Date.parse(pts[0].d), t1 = Date.parse(pts[pts.length - 1].d), ts = (t1 - t0) || 1;
    const xy = pts.map(p => [
        ((Date.parse(p.d) - t0) / ts) * W,
        hi === lo ? H / 2 : H - pad - ((p.v - lo) / (hi - lo)) * (H - 2 * pad),
    ]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<svg class="dv4-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="dv4-spark-area" d="${line} L${W} ${H} L0 ${H} Z"/>
        <path class="dv4-spark-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
}

function _dvRing(pct, tone) {
    return `<svg class="dv4-ring dv4-tone-${tone}" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="dv4-ring-bg" cx="18" cy="18" r="15.9155"/>
        <circle class="dv4-ring-fg" cx="18" cy="18" r="15.9155" stroke-dasharray="${pct} ${100 - pct}" transform="rotate(-90 18 18)"/>
        <text x="18" y="18.6" text-anchor="middle" dominant-baseline="middle" class="dv4-ring-txt">${pct}%</text></svg>`;
}

// diff vs ontem; upBad = subir é mau (vermelho), descer é bom (verde)
function _dvDelta(diff, upBad) {
    if (diff == null) return '<span class="dv4-delta dv4-delta-none">sem comparação</span>';
    const up  = diff > 0;
    const cls = upBad ? (up ? 'bad' : 'ok') : 'none';
    return `<span class="dv4-delta dv4-delta-${cls}">${up ? '▲' : '▼'} ${Math.abs(diff)} vs ontem</span>`;
}

function _dvKpi({ act, id, label, value, sub, delta, spark, tone, ring }) {
    return `<button type="button" class="dv4-card dv4-kpi dv4-tone-${tone || 'none'}" data-dv-act="${act}"${id ? ` data-dv-id="${id}"` : ''}>
        <span class="dv4-kpi-top">
            <span class="dv4-label">${label}</span>
            ${ring || ''}
        </span>
        <span class="dv4-kpi-val">${value}</span>
        <span class="dv4-kpi-sub">${sub || ''}</span>
        ${delta ? `<span class="dv4-kpi-delta">${delta}</span>` : ''}
        ${spark ? `<span class="dv4-spark-wrap">${spark}</span>` : ''}
    </button>`;
}

function _dvCard(title, linkText, linkAct, linkId, bodyHtml, extraCls = '') {
    return `<section class="dv4-card ${extraCls}">
        <div class="dv4-card-hd">
            <h3 class="dv4-card-title">${title}</h3>
            ${linkText ? `<button type="button" class="dv4-link" data-dv-act="${linkAct}"${linkId ? ` data-dv-id="${linkId}"` : ''}>${linkText}</button>` : ''}
        </div>
        ${bodyHtml}
    </section>`;
}

function _dvEmpty(text) {
    return `<div class="dv4-empty">${_dvIco('check', 16)}<span>${escapeHtml(text)}</span></div>`;
}

// ── Cálculo (sem tocar no DOM) ───────────────────────────────────────────────

function _dvCompute(stockData, ferrData) {
    const stockEntries = Object.entries(stockData || {});
    const ferra        = Object.values(ferrData  || {});

    const total    = stockEntries.length;
    const zero     = stockEntries.filter(([, i]) => (i.quantidade || 0) === 0).map(([, i]) => i);
    const semStock = zero.length;
    const comStock = total - semStock;

    const alocList = ferra.filter(t => t.status === 'alocada');
    const atraso   = alocList.filter(t => t.dataEntrega && _calcDias(t.dataEntrega) >= _DV_ALERTA_DIAS);

    const patsPend = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico')
        .sort((a, b) => _calcDias(b[1].criadoEm || Date.now()) - _calcDias(a[1].criadoEm || Date.now()));
    const patUrgentes = patsPend.filter(([, p]) => p.criadoEm && _calcDias(p.criadoEm) >= _DV_PAT_URGENTE_DIAS);

    const encAll       = Object.entries(_encData || {});
    const encPendentes = encAll.filter(([, e]) => _encEstado(e) === 'pendente').length;
    const encParciais  = encAll.filter(([, e]) => _encEstado(e) === 'parcial').length;
    const encAtivas    = encAll.filter(([, e]) => _encEstado(e) !== 'recebida')
                               .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    // unidades que faltam receber nas encomendas parciais
    let faltam = 0;
    encAll.filter(([, e]) => _encEstado(e) === 'parcial').forEach(([, e]) => {
        Object.values(e.linhas || {}).forEach(l => {
            faltam += Math.max(0, (parseFloat(l.qtd) || 0) - (parseFloat(l.recebido) || 0));
        });
    });

    return {
        total, comStock, semStock, zero,
        alocadas: alocList.length, totalFerr: ferra.length, alocList, atraso,
        patPendentes: patsPend.length, patsPend, patUrgentes,
        patHoje:    patsPend.filter(([, p]) => p.criadoEm && _calcDias(p.criadoEm) === 0).length,
        encPendentes, encParciais, encActivas: encPendentes + encParciais, encAtivas, encFaltam: Math.round(faltam * 100) / 100,
        gases: _getGasItems(stockData),
    };
}

// ── Alertas ──────────────────────────────────────────────────────────────────

function _dvAlerts(c) {
    const out = [];
    const esc = escapeHtml;

    if (c.patUrgentes.length) {
        const [, p0] = c.patUrgentes[0];
        const n = c.patUrgentes.length;
        out.push({ sev: 'bad', ico: 'pat', act: 'pats',
            title: `${n} ${_dvPl(n, 'PAT', 'PATs')} com ${_DV_PAT_URGENTE_DIAS}+ dias por levantar`,
            sub: `A mais antiga: PAT ${esc(p0.numero || '—')} · ${esc(p0.estabelecimento || 'Sem estabelecimento')} (${_calcDias(p0.criadoEm)}d)` });
    }

    c.gases.filter(g => g.qty <= g.alertAt).forEach(g => {
        const pct = Math.round(Math.max(0, Math.min(1, g.qty / g.max)) * 100);
        out.push({ sev: 'bad', ico: 'gas', act: 'stock',
            title: `${esc(g.name)} baixo: ${(Math.round(g.qty * 10) / 10).toFixed(1)} kg`,
            sub: `${pct}% da garrafa · alerta aos ${g.alertAt} kg` });
    });

    if (c.atraso.length) {
        const n = c.atraso.length;
        const nomes = [...new Set(c.atraso.map(t => t.colaborador).filter(Boolean))];
        const mais  = c.atraso.slice().sort((a, b) => _calcDias(b.dataEntrega) - _calcDias(a.dataEntrega))[0];
        out.push({ sev: 'warn', ico: 'tool', act: 'tools',
            title: `${n} ${_dvPl(n, 'ferramenta', 'ferramentas')} fora há ${_DV_ALERTA_DIAS}+ dias`,
            sub: `${esc(nomes.slice(0, 2).join(', ') || 'Sem colaborador')}${nomes.length > 2 ? ` e mais ${nomes.length - 2}` : ''} · a mais antiga: ${esc(typeof _toolDisplayLabel === 'function' ? _toolDisplayLabel(mais) : (mais.nome || '—'))} (${_calcDias(mais.dataEntrega)}d)` });
    }

    if (c.semStock > 0) {
        const cods = c.zero.slice(0, 3).map(i => esc(i.codigo || i.nome || '?')).join(', ');
        out.push({ sev: 'warn', ico: 'box', act: 'zero',
            title: `${c.semStock} ${_dvPl(c.semStock, 'artigo sem stock', 'artigos sem stock')}`,
            sub: `${cods}${c.semStock > 3 ? ` e mais ${c.semStock - 3}` : ''}` });
    }

    if (c.encParciais > 0) {
        out.push({ sev: 'warn', ico: 'truck', act: 'enc', id: 'parcial',
            title: `${c.encParciais} ${_dvPl(c.encParciais, 'encomenda parcial', 'encomendas parciais')}`,
            sub: `Faltam receber ${c.encFaltam} un` });
    }
    if (c.encPendentes > 0) {
        out.push({ sev: 'info', ico: 'truck', act: 'enc', id: 'pendente',
            title: `${c.encPendentes} ${_dvPl(c.encPendentes, 'encomenda por receber', 'encomendas por receber')}`,
            sub: 'Ainda sem entradas registadas' });
    }
    const ord = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => ord[a.sev] - ord[b.sev]);
}

function _dvAlertsCard(alerts) {
    const nAtt = alerts.filter(a => a.sev !== 'info').length;
    const hasBad = alerts.some(a => a.sev === 'bad');
    const pill = nAtt
        ? `<span class="dv4-pill dv4-pill-${hasBad ? 'bad' : 'warn'}">${nAtt}</span>`
        : `<span class="dv4-pill dv4-pill-ok">Tudo em dia</span>`;
    const SHOW = 4;   // telemóvel: 4 alertas visíveis, o resto atrás de "Mostrar todos"
    const body = alerts.length
        ? `<div class="dv4-alerts${_dvAlertsOpen ? ' expanded' : ''}">${alerts.map((a, i) => `
            <button type="button" class="dv4-alert dv4-sev-${a.sev}${i >= SHOW ? ' dv4-alert-extra' : ''}" data-dv-act="${a.act}"${a.id ? ` data-dv-id="${a.id}"` : ''}>
                <span class="dv4-alert-ico">${_dvIco(a.ico, 18)}</span>
                <span class="dv4-alert-txt"><b>${a.title}</b><small>${a.sub}</small></span>
                <span class="dv4-alert-go">${_dvIco('chev', 16)}</span>
            </button>`).join('')}</div>`
          + (alerts.length > SHOW ? `<button type="button" class="dv4-more dv4-alerts-toggle" data-dv-act="alerts-toggle">${_dvAlertsOpen ? 'Mostrar menos' : `Mostrar todos (${alerts.length})`}</button>` : '')
        : _dvEmpty('Sem alertas. Tudo em ordem.');
    return `<section class="dv4-card dv4-attn${hasBad ? ' has-bad' : ''}">
        <div class="dv4-card-hd"><h3 class="dv4-card-title">Precisa de atenção</h3>${pill}</div>${body}</section>`;
}

// ── Evolução (gráfico) ───────────────────────────────────────────────────────

function _dvChartBody(key) {
    const m   = _DV_METRICS.find(x => x.key === key) || _DV_METRICS[0];
    const pts = _dvLast?.series?.[m.key] || [];
    if (pts.length < 2) {
        return `<div class="dv4-empty dv4-empty-chart"><span>A recolher histórico — o gráfico aparece quando houver pelo menos 2 dias de dados (um registo por dia, ao abrir o Dashboard).</span></div>`;
    }
    const vals = pts.map(p => p.v), lo = Math.min(...vals), hi = Math.max(...vals);
    const first = vals[0], last = vals[vals.length - 1], diff = last - first;
    const t0 = Date.parse(pts[0].d), t1 = Date.parse(pts[pts.length - 1].d), ts = (t1 - t0) || 1;
    const dias = Math.max(1, Math.round(ts / 86400000));

    const W = 320, H = 130, L = 30, R = 10, T = 12, B = 24;
    const pad  = Math.ceil((hi - lo) * 0.2);
    let yMin = Math.max(0, lo - pad), yMax = hi + pad;
    if (yMax === yMin) yMax = yMin + 1;
    const X = t => L + ((t - t0) / ts) * (W - L - R);
    const Y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
    const xy = pts.map(p => [X(Date.parse(p.d)), Y(p.v)]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const mid = Math.round((yMin + yMax) / 2);
    const fmtD = s => s.slice(8, 10) + '/' + s.slice(5, 7);
    const grid = [yMax, mid, yMin].map(v => `<line class="dv4-ch-grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
        <text class="dv4-ch-ylab" x="${L - 6}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`).join('');
    const dots = xy.map((p, i) => `<circle class="dv4-ch-dot${i === xy.length - 1 ? ' last' : ''}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === xy.length - 1 ? 3.6 : 2.2}"/>`).join('');

    const sgn = diff > 0 ? '+' : '';
    const dCls = diff === 0 ? 'none' : (m.upBad ? (diff > 0 ? 'bad' : 'ok') : 'none');
    const dTxt = diff === 0 ? 'Sem alteração' : `${sgn}${diff} em ${dias} ${_dvPl(dias, 'dia', 'dias')}`;

    return `<div class="dv4-ch-sum"><span class="dv4-ch-now">${last}</span><span class="dv4-delta dv4-delta-${dCls}">${dTxt}</span></div>
        <svg class="dv4-chart dv4-tone-${m.tone}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(m.title)} nos últimos ${dias} dias">
            ${grid}
            <path class="dv4-ch-area" d="${line} L${xy[xy.length - 1][0].toFixed(1)} ${H - B} L${xy[0][0].toFixed(1)} ${H - B} Z"/>
            <path class="dv4-ch-line" d="${line}"/>
            ${dots}
            <text class="dv4-ch-xlab" x="${L}" y="${H - 6}" text-anchor="start">${fmtD(pts[0].d)}</text>
            <text class="dv4-ch-xlab" x="${W - R}" y="${H - 6}" text-anchor="end">hoje</text>
        </svg>`;
}

function _dvChartCard() {
    const tabs = _DV_METRICS.map(m => `<button type="button" class="dv4-tab${m.key === _dvChartMetric ? ' active' : ''}" data-dv-act="chart" data-dv-id="${m.key}">${m.tab}</button>`).join('');
    return `<section class="dv4-card" id="dv4-chart-card">
        <div class="dv4-card-hd"><h3 class="dv4-card-title">Evolução · ${_DV_HISTORY_DAYS} dias</h3></div>
        <div class="dv4-tabs" role="tablist">${tabs}</div>
        <div id="dv4-chart-body">${_dvChartBody(_dvChartMetric)}</div>
    </section>`;
}

function _dvChartSet(key) {
    _dvChartMetric = key;
    document.querySelectorAll('#dv4-chart-card .dv4-tab').forEach(b => b.classList.toggle('active', b.dataset.dvId === key));
    const body = $id('dv4-chart-body');
    if (body) body.innerHTML = _dvChartBody(key);
}

// ── Gases ────────────────────────────────────────────────────────────────────
// Lê MAX e ALERTA dos campos gasMax / gasAlerta do produto (kg). Sem gasMax usa o
// máximo visto NESTE dispositivo (localStorage) — por isso a % pode variar entre aparelhos.

// Detecta automaticamente todos os produtos com unidade 'kg'
function _getGasItems(stockData) {
    return Object.entries(stockData || {})
        .filter(([, item]) => item.unidade === 'kg')
        .map(([id, item]) => {
            const qty  = item.quantidade || 0;
            // gasMax: usa campo dedicado, senão máximo histórico local, senão qty*1.5
            const maxKey  = 'hiperfrio-gasmax-' + id;
            let   maxHist = parseFloat(localStorage.getItem(maxKey) || '0');
            if (qty > maxHist) { maxHist = qty; localStorage.setItem(maxKey, qty); }
            const maxVal  = (item.gasMax != null && item.gasMax > 0)
                ? item.gasMax
                : (maxHist > 0 ? maxHist : Math.max(qty, 1));
            // gasAlerta: usa campo dedicado, senão 20% do máximo
            const alertVal = (item.gasAlerta != null && item.gasAlerta > 0)
                ? item.gasAlerta
                : Math.round(maxVal * 0.20 * 10) / 10;
            return {
                id,
                name:    (item.codigo || item.nome || id).toUpperCase(),
                qty,
                max:     maxVal,
                alertAt: alertVal,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

function _drawGasCylSvg(g) {
    const W=44, H=96, capH=10, neckW=16, neckH=10;
    const bodyY = capH + neckH, bodyH = H - bodyY - 2, rx = 7;
    const p       = Math.max(0, Math.min(1, g.qty / g.max));
    const fillH   = Math.round((bodyH - 6) * p);
    const fillY   = bodyY + (bodyH - 6) - fillH + 3;
    const low     = g.qty <= g.alertAt;
    const fill    = low ? '#E24B4A' : '#185FA5';
    const pctText = Math.round(p * 100);
    const cid     = 'gc' + g.id.replace(/[^a-z0-9]/gi,'') + pctText;

    // Cores fixas para garantir visibilidade em tema claro e escuro
    const bodyFill   = '#DDE4F0';
    const bodyStroke = '#9BAAC4';
    const capFill    = '#B8C5DA';
    const topFill    = '#9BAAC4';
    const textFill   = p > 0.18 ? '#ffffff' : '#4A5A72';

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <defs><clipPath id="${cid}"><rect x="3" y="${bodyY}" width="${W-6}" height="${bodyH}" rx="${rx}"/></clipPath></defs>
        <rect x="${(W-neckW)/2}" y="${capH}" width="${neckW}" height="${neckH}" rx="4" fill="${capFill}" stroke="${bodyStroke}" stroke-width="0.5"/>
        <rect x="${(W-neckW+4)/2}" y="2" width="${neckW-4}" height="${capH}" rx="3" fill="${topFill}"/>
        <rect x="3" y="${bodyY}" width="${W-6}" height="${bodyH}" rx="${rx}" fill="${bodyFill}" stroke="${bodyStroke}" stroke-width="1"/>
        ${p > 0 ? `<rect x="3" y="${fillY}" width="${W-6}" height="${fillH+6}" rx="${rx}" fill="${fill}" opacity="0.92" clip-path="url(#${cid})"/>` : ''}
        <text x="${W/2}" y="${bodyY + bodyH/2 + 1}" text-anchor="middle" dominant-baseline="middle"
            font-size="11" font-weight="500" font-family="'DM Mono','Courier New',monospace" fill="${textFill}">${pctText}%</text></svg>`;
}

function _dvGasCard(gases) {
    if (!gases.length) return '';
    const low  = gases.filter(g => g.qty <= g.alertAt).length;
    const tot  = gases.reduce((s, g) => s + g.qty, 0);
    const fmt  = v => (Math.round(v * 10) / 10).toFixed(1);
    const items = gases.map(g => {
        const isLow = g.qty <= g.alertAt;
        return `<button type="button" class="dv4-gas${isLow ? ' low' : ''}" data-dv-act="stock">
            ${_drawGasCylSvg(g)}
            <span class="dv4-gas-name">${escapeHtml(g.name)}</span>
            <span class="dv4-gas-kg">${fmt(g.qty)} kg</span>
            ${isLow ? '<span class="dv4-chip dv4-chip-bad">Baixo</span>' : ''}
        </button>`;
    }).join('');
    const chip = low ? `<span class="dv4-pill dv4-pill-bad">${low} ${_dvPl(low, 'baixo', 'baixos')}</span>` : '';
    return `<section class="dv4-card">
        <div class="dv4-card-hd"><h3 class="dv4-card-title">Gases refrigerantes</h3>${chip}<button type="button" class="dv4-link" data-dv-act="stock">Ver stock</button></div>
        <div class="dv4-sub">${gases.length} ${_dvPl(gases.length, 'tipo', 'tipos')} · ${fmt(tot)} kg no total</div>
        <div class="dv4-gases">${items}</div></section>`;
}

// ── Listas ───────────────────────────────────────────────────────────────────

function _dvMore(n, act, id) {
    return n > 0 ? `<button type="button" class="dv4-more" data-dv-act="${act}"${id ? ` data-dv-id="${id}"` : ''}>+ ${n} ${_dvPl(n, 'outro', 'outros')}</button>` : '';
}

function _dvPatsCard(c) {
    const esc = escapeHtml, MAX = 5;
    const rows = c.patsPend.slice(0, MAX).map(([id, p]) => {
        const dias = p.criadoEm ? _calcDias(p.criadoEm) : 0;
        const urg  = dias >= _DV_PAT_URGENTE_DIAS;
        return `<button type="button" class="dv4-row" data-dv-act="pat" data-dv-id="${esc(id)}">
            <span class="dv4-dot ${urg ? 'bad' : 'info'}"></span>
            <span class="dv4-row-main"><b>PAT ${esc(p.numero || '—')}</b><small>${esc(p.estabelecimento || 'Sem estabelecimento')}</small></span>
            <span class="dv4-age${urg ? ' urg' : ''}">${dias === 0 ? 'Hoje' : dias + 'd'}</span>
        </button>`;
    }).join('');
    const body = c.patsPend.length ? `<div class="dv4-list">${rows}</div>${_dvMore(c.patsPend.length - MAX, 'pats')}` : _dvEmpty('Sem PATs pendentes');
    return _dvCard('PATs pendentes', 'Ver todas', 'pats', null, body);
}

function _dvToolsCard(c) {
    const esc = escapeHtml;
    const porColab = {};
    c.alocList.filter(t => t.colaborador).forEach(t => { (porColab[t.colaborador] = porColab[t.colaborador] || []).push(t); });
    const grupos = Object.entries(porColab).map(([colab, tools]) => ({
        colab, tools, dias: Math.max(...tools.map(t => t.dataEntrega ? _calcDias(t.dataEntrega) : 0)),
    })).sort((a, b) => b.dias - a.dias);
    const MAX = 5;
    const rows = grupos.slice(0, MAX).map(g => {
        const ini = g.colab.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
        const late = g.dias >= _DV_ALERTA_DIAS;
        return `<button type="button" class="dv4-row" data-dv-act="tools">
            <span class="dv4-avatar">${esc(ini)}</span>
            <span class="dv4-row-main"><b>${esc(g.colab)}</b><small>${esc(g.tools.map(t => typeof _toolDisplayLabel === 'function' ? _toolDisplayLabel(t) : t.nome).join(' · '))}</small></span>
            <span class="dv4-badge ${late ? 'warn' : 'ok'}">${g.dias}d fora</span>
        </button>`;
    }).join('');
    const body = grupos.length ? `<div class="dv4-list">${rows}</div>${_dvMore(grupos.length - MAX, 'tools')}` : _dvEmpty('Todas as ferramentas em armazém');
    return _dvCard('Ferramentas em campo', 'Painel', 'tools', null, body);
}

function _dvEncCard(c) {
    const esc = escapeHtml, MAX = 4;
    const rows = c.encAtivas.slice(0, MAX).map(([id, enc]) => {
        const linhas = Object.values(enc.linhas || {});
        const tot = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const rec = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct = tot > 0 ? Math.round(rec / tot * 100) : 0;
        const parcial = _encEstado(enc) === 'parcial';
        return `<button type="button" class="dv4-row dv4-row-col" data-dv-act="encdetail" data-dv-id="${esc(id)}">
            <span class="dv4-row-line"><span class="dv4-row-main"><b>Enc. ${esc(enc.num || '—')}</b><small>${esc(enc.fornecedor || '—')}</small></span>
                <span class="dv4-badge ${parcial ? 'warn' : 'info'}">${parcial ? 'Parcial' : 'Pendente'}</span></span>
            <span class="dv4-prog"><span class="dv4-bar"><span class="dv4-bar-fill" style="width:${pct}%"></span></span><span class="dv4-pct">${pct}%</span></span>
        </button>`;
    }).join('');
    const body = c.encAtivas.length ? `<div class="dv4-list">${rows}</div>${_dvMore(c.encAtivas.length - MAX, 'enc', 'pendente')}` : _dvEmpty('Sem encomendas em curso');
    return _dvCard('Encomendas em curso', 'Ver todas', 'enc', 'pendente', body);
}

// ── Montagem ─────────────────────────────────────────────────────────────────

function _dvHeader() {
    const now  = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 19 ? 'Boa tarde' : 'Boa noite';
    const name = localStorage.getItem('hiperfrio-displayname') || localStorage.getItem('hiperfrio-username') || '';
    const hh = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const wd = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const mo = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return `<div class="dv4-head">
        <div>
            <h2 class="dv4-hello">${escapeHtml(greeting)}${name ? ', ' + escapeHtml(name.split(' ')[0]) : ''}</h2>
            <p class="dv4-date">${wd[now.getDay()]}, ${now.getDate()} ${mo[now.getMonth()]} · atualizado às ${hh}</p>
        </div>
        <button type="button" class="dv4-refresh" id="dv4-refresh-btn" data-dv-act="refresh" title="Atualizar" aria-label="Atualizar dashboard">${_dvIco('refresh', 16)}</button>
    </div>`;
}

function _dvDraw(el, c, rows) {
    const yest = rows.find(r => r.date === _dashYesterday()) || null;
    const S = (f, live) => _dvSpark(_dvSeries(rows, f, live));
    _dvLast = { series: {
        patPendentes: _dvSeries(rows, 'patPendentes', c.patPendentes),
        semStock:     _dvSeries(rows, 'semStock',     c.semStock),
        encActivas:   _dvSeries(rows, 'encActivas',   c.encActivas),
        alocadas:     _dvSeries(rows, 'alocadas',     c.alocadas),
    } };

    const pctOk = c.total > 0 ? Math.round(c.comStock / c.total * 100) : 0;
    const chips = [
        c.patUrgentes.length ? `<span class="dv4-chip dv4-chip-bad">${c.patUrgentes.length} ${_dvPl(c.patUrgentes.length, 'urgente', 'urgentes')}</span>` : '',
        c.patHoje ? `<span class="dv4-chip dv4-chip-info">${c.patHoje} hoje</span>` : '',
    ].join('');

    const kpis = [
        _dvKpi({ act: 'stock', label: 'Stock', value: c.total.toLocaleString('pt-PT'), tone: pctOk >= 90 ? 'ok' : pctOk >= 75 ? 'warn' : 'bad',
                 sub: `${c.comStock} com stock`, ring: _dvRing(pctOk, pctOk >= 90 ? 'ok' : pctOk >= 75 ? 'warn' : 'bad'),
                 delta: _dvDelta(_getDashTrend('total', c.total, yest), false), spark: S('total', c.total) }),
        _dvKpi({ act: 'zero', label: 'Sem stock', value: c.semStock, tone: c.semStock ? 'warn' : 'ok',
                 sub: c.total ? `${Math.round(c.semStock / c.total * 100)}% do inventário` : '',
                 delta: _dvDelta(_getDashTrend('semStock', c.semStock, yest), true), spark: S('semStock', c.semStock) }),
        _dvKpi({ act: 'pats', label: 'PATs pendentes', value: c.patPendentes, tone: c.patUrgentes.length ? 'bad' : 'info',
                 sub: chips || 'Em dia', delta: _dvDelta(_getDashTrend('patPendentes', c.patPendentes, yest), true), spark: S('patPendentes', c.patPendentes) }),
        _dvKpi({ act: 'enc', id: 'pendente', label: 'Encomendas', value: c.encActivas, tone: 'info',
                 sub: `${c.encPendentes} ${_dvPl(c.encPendentes, 'pendente', 'pendentes')} · ${c.encParciais} ${_dvPl(c.encParciais, 'parcial', 'parciais')}`,
                 delta: _dvDelta(_getDashTrend('encActivas', c.encActivas, yest), false), spark: S('encActivas', c.encActivas) }),
        _dvKpi({ act: 'tools', label: 'Ferramentas fora', value: `${c.alocadas}<span class="dv4-of">/${c.totalFerr}</span>`, tone: c.atraso.length ? 'warn' : 'ok',
                 sub: c.atraso.length ? `${c.atraso.length} em atraso` : (c.alocadas ? 'Nenhuma em atraso' : 'Todas em armazém'),
                 spark: S('alocadas', c.alocadas) }),
    ].join('');

    el.innerHTML = _dvHeader()
        + _dvAlertsCard(_dvAlerts(c))
        + `<div class="dv4-kpis">${kpis}</div>`
        + `<div class="dv4-grid">${typeof _dvNotasCard === 'function' ? _dvNotasCard() : ''}${_dvChartCard()}${_dvGasCard(c.gases)}${_dvPatsCard(c)}${_dvToolsCard(c)}${_dvEncCard(c)}</div>`;
}

function _dvSkeleton() {
    return '<div class="dv4-sk" style="height:56px"></div><div class="dv4-sk" style="height:150px"></div>'
         + '<div class="dv4-kpis"><div class="dv4-sk" style="height:120px"></div><div class="dv4-sk" style="height:120px"></div><div class="dv4-sk" style="height:120px"></div><div class="dv4-sk" style="height:120px"></div></div>';
}

// ── Cliques (listener único) ─────────────────────────────────────────────────

function _dvAction(act, id) {
    switch (act) {
        case 'refresh':   renderDashboard(true, true); break;
        case 'chart':     _dvChartSet(id); break;
        case 'alerts-toggle': {
            _dvAlertsOpen = !_dvAlertsOpen;
            document.querySelector('.dv4-alerts')?.classList.toggle('expanded', _dvAlertsOpen);
            const tg = document.querySelector('.dv4-alerts-toggle');
            if (tg) tg.textContent = _dvAlertsOpen ? 'Mostrar menos' : `Mostrar todos (${document.querySelectorAll('.dv4-alert').length})`;
            break;
        }
        case 'pats':      nav('view-pedidos'); break;
        case 'pat':       { const p = _patCache.data?.[id]; if (p) openPatDetail(id, p); break; }
        case 'stock':     _pendingZeroFilter = false; nav('view-search'); break;
        case 'zero':      _pendingZeroFilter = true;  nav('view-search'); break;
        case 'tools':     nav('view-tools'); break;
        case 'enc':       _encNextFilter = id || null; nav('view-encomendas'); break;
        case 'encdetail': if (_encData?.[id]) openEncDetail(id); break;
        default:          if (typeof notasHandleAction === 'function') notasHandleAction(act, id); break;
    }
}

function _dvBindOnce(el) {
    if (el._dvBound) return;
    el._dvBound = true;
    el.addEventListener('click', e => {
        const t = e.target.closest('[data-dv-act]');
        if (t && el.contains(t)) _dvAction(t.dataset.dvAct, t.dataset.dvId);
    });
}

// ── Entrada ──────────────────────────────────────────────────────────────────

async function renderDashboard(force = false, fromBtn = false) {
    const el = $id('view-dashboard');
    if (!el) return;
    _dvBindOnce(el);
    const seq = ++_dvSeq;
    el.classList.add('dv4');

    // 1) Primeira vez: desenha já com o que existe em cache (ou um esqueleto)
    if (!el.dataset.dvDrawn) {
        if (cache.stock.data && cache.ferramentas.data) {
            _dvDraw(el, _dvCompute(cache.stock.data, cache.ferramentas.data), _dashHistory?.rows || []);
            el.dataset.dvDrawn = '1';
        } else {
            el.innerHTML = _dvSkeleton();
        }
    }
    el.classList.add('dv4-loading');
    $id('dv4-refresh-btn')?.classList.add('spinning');

    // 2) Dados frescos
    try {
        const ts = Date.now();
        const [stockData, ferrData, , , rows] = await Promise.all([
            fetchCollection('stock', force || ts > cache.stock.lastFetch + 60000),
            fetchCollection('ferramentas', force || ts > cache.ferramentas.lastFetch + 60000),
            _fetchPats(force || !_patCache.data),
            loadEncomendas(),
            _loadDashHistory(),
        ]);
        if (seq !== _dvSeq) return;        // entretanto houve outra chamada — essa é que desenha

        const c = _dvCompute(stockData, ferrData);
        _saveDashSnapshot(c.total, c.semStock, c.alocadas, c.patPendentes, c.encActivas);
        _dvDraw(el, c, rows);
        el.dataset.dvDrawn = '1';
    } catch (e) {
        console.warn('[dashboard] falha ao atualizar:', e?.message);
        if (!el.dataset.dvDrawn) el.innerHTML = '<div class="dv4-card"><div class="dv4-empty"><span>Não foi possível carregar o dashboard. Verifica a ligação.</span></div><button type="button" class="dv4-more" data-dv-act="refresh">Tentar de novo</button></div>';
    } finally {
        if (seq === _dvSeq) {
            el.classList.remove('dv4-loading');
            $id('dv4-refresh-btn')?.classList.remove('spinning');
        }
    }
}
