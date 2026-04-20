// ─────────────────────────────────────────────────────────────────────────────
// reports.js — Hiperfrio v6.59
// Relatório mensal, snapshots, movimentos de stock, Chart.js.
// Carrega DEPOIS de auth.js e ANTES de stock.js, tools.js, pats.js.
//
// Dependências:
//   utils.js  → BASE_URL, _calcDias, escapeHtml, $id, $el, loadXlsx, showToast
//   auth.js   → apiFetch, authUrl
//   app.js    → _patCache (lido em runtime, não no arranque)
// ─────────────────────────────────────────────────────────────────────────────

// RELATÓRIO MENSAL
// Firebase: /relatorios/{YYYY-MM} — snapshot mensal guardado automaticamente
//           /movimentos/{id}      — log de movimentos de stock

const REL_URL = `${BASE_URL}/relatorios`;
const MOV_URL = `${BASE_URL}/movimentos`;

let _relMesOffset = 0; // 0 = mês actual, -1 = anterior, etc.
let _relDonutChart = null; // instância Chart.js — destruída antes de recriar

// ── Limpeza automática de movimentos antigos ──────────────────────────────
// Corre em background no arranque. Apaga movimentos com >90 dias.
// NOTA Firebase: requer índice em /movimentos por campo "ts".
// Adicionar em Firebase Console → Realtime Database → Regras:
//   "movimentos": { ".indexOn": ["ts", "mes"] }
const _PRUNE_MOV_KEY     = 'hiperfrio-prune-mov-ts';
const _PRUNE_MOV_FREQ_MS = 7 * 24 * 60 * 60 * 1000;  // só limpa 1x por semana
const _PRUNE_MOV_TTL_MS  = 90 * 24 * 60 * 60 * 1000; // apaga movimentos >90 dias

async function _pruneMovimentos() {
    if (!navigator.onLine) return;
    const lastRun = parseInt(localStorage.getItem(_PRUNE_MOV_KEY) || '0');
    if (Date.now() - lastRun < _PRUNE_MOV_FREQ_MS) return;

    try {
        // Filtrar directamente por timestamp no Firebase em vez de descarregar tudo
        const cutoff = Date.now() - _PRUNE_MOV_TTL_MS;
        const url  = await authUrl(`${MOV_URL}.json?orderBy="ts"&endAt=${cutoff}`);
        const res  = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            localStorage.setItem(_PRUNE_MOV_KEY, Date.now().toString());
            return;
        }

        const expirados = Object.keys(data);
        if (expirados.length === 0) {
            localStorage.setItem(_PRUNE_MOV_KEY, Date.now().toString());
            return;
        }

        const BATCH = 20;
        for (let i = 0; i < expirados.length; i += BATCH) {
            const lote = expirados.slice(i, i + BATCH);
            await Promise.allSettled(
                lote.map(id => apiFetch(`${MOV_URL}/${id}.json`, { method: 'DELETE' }))
            );
            if (i + BATCH < expirados.length) await new Promise(r => setTimeout(r, 300));
        }

        localStorage.setItem(_PRUNE_MOV_KEY, Date.now().toString());
    } catch(e) {
        console.warn('[pruneMovimentos] erro:', e?.message);
    }
}

// ── Utilitários de data ────────────────────────────────────────────────────
function _mesKey(offset = 0) {
    const d = new Date();
    d.setDate(1); // evita rollover: 31 Jan + 1 mês = 3 Mar sem este fix
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function _mesLabel(key) {
    const [y, m] = key.split('-');
    const nomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    return `${nomes[parseInt(m)-1]} ${y}`;
}
function _mesRange(key) {
    const [y, m] = key.split('-').map(Number);
    // Local time — consistente com _calcDias (que usa Date.getFullYear/Month/Date)
    // e com a expectativa do utilizador que um evento criado "no dia 1" pertence ao
    // mês em que o calendário dele diz que é. Usar UTC criava um bug nas fronteiras
    // do mês em Portugal (eventos entre 00h-01h WEST caíam no mês anterior).
    const ini = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
    const fim = new Date(y, m,     1, 0, 0, 0, 0).getTime() - 1;
    return { ini, fim };
}

// ── Registar movimento de stock ───────────────────────────────────────────
// tipo: 'saida_pat' | 'saida_manual' | 'saida_guia' | 'remocao'
// Helper: parse de ev.data (string ISO) tratando date-only como local.
// "2026-04-15" em new Date() vira UTC midnight; em Portugal WEST (UTC+1) isto
// cai às 01:00 local do dia 15. Para consistência com ranges locais, tratamos
// date-only como local midnight.
function _relParseEvTs(s) {
    if (!s) return 0;
    // Se for estritamente YYYY-MM-DD (10 chars, 2 hífens), interpretar como local
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }
    // Datetime completo (com T ou espaço) — delegar ao Date parser
    return new Date(s).getTime();
}
async function registarMovimento(tipo, itemId, codigo, nome, quantidade) {
    // Exigir só o codigo — itemId pode ser temporário (_tmp_) em modo offline
    // para produtos criados antes de sincronizar. O relatório agrega por codigo.
    if (!codigo) return;
    const mov = {
        tipo,
        itemId:    itemId || null,
        codigo:    (codigo || '').toUpperCase(),
        nome:      nome   || '',
        quantidade: Math.abs(quantidade || 1),
        ts:        Date.now(),
        mes:       _mesKey(0),
    };
    // Usar apiFetch com queue offline — garante que movimentos offline são sincronizados
    try {
        await apiFetch(`${MOV_URL}.json`, { method: 'POST', body: JSON.stringify(mov) });
    } catch(e) {
        // Se falhou e está offline, guardar na queue manual para tentar depois
        if (!navigator.onLine) {
            queueAdd({ url: `${MOV_URL}.json`, method: 'POST', body: JSON.stringify(mov) });
        }
    }
}

// ── Snapshot mensal ────────────────────────────────────────────────────────
async function _buildSnapshot(mesKey) {
    const { ini, fim } = _mesRange(mesKey);
    const mesCorrente = _mesKey(0);
    const isMesCorrente = mesKey === mesCorrente;

    // Para o mês corrente: forçar fetch fresco (dados ainda podem mudar)
    // Para meses passados: usar cache — PATs apagadas não estão mais no Firebase,
    // por isso fetch fresco OMITE-as. O snapshot deve ter sido gerado antes da deleção.
    let pats, ferrData;
    if (isMesCorrente) {
        const [patData, ferrDataRaw] = await Promise.all([
            _fetchPats(true),
            fetchCollection('ferramentas', true),
        ]);
        pats     = Object.values(patData    || {});
        ferrData = ferrDataRaw || {};
    } else {
        pats     = Object.values(_patCache.data    || {});
        ferrData = cache.ferramentas.data || {};
    }

    // Fetch movimentos do mês (ponto 8: query com índice firebase)
    let movData = {};
    try {
        const movUrl = await authUrl(`${MOV_URL}.json?orderBy="mes"&equalTo="${mesKey}"`);
        const movRes = await fetch(movUrl);
        movData = movRes.ok ? (await movRes.json() || {}) : {};
        // Firebase retorna array se não há índice — converter para objeto
        if (Array.isArray(movData)) movData = {};
    } catch(e) {}

    // PATs criadas neste mês
    const patsMes = pats.filter(p => p.criadoEm >= ini && p.criadoEm <= fim);

    // PATs levantadas neste mês (ponto 6: incluir historico com saidaEm)
    const patsLevantadas = pats.filter(p => {
        const levTs = p.levantadoEm || p.saidaEm;
        return levTs && levTs >= ini && levTs <= fim;
    });

    // Duração média (criação → levantamento)
    let duracaoMedia = null;
    const comDuracao = patsLevantadas.filter(p => p.criadoEm && (p.levantadoEm || p.saidaEm));
    if (comDuracao.length) {
        const totalDias = comDuracao.reduce((acc, p) =>
            acc + _calcDias(p.criadoEm, p.levantadoEm || p.saidaEm), 0);
        duracaoMedia = Math.round(totalDias / comDuracao.length);
    }

    // Ponto 2: pendentes = PATs criadas NESTE mês que NÃO foram levantadas NESTE mês
    // (não misturar com PATs de outros meses ainda em aberto)
    const pendentes = patsMes.filter(p =>
        p.status !== 'levantado' && p.status !== 'historico'
    );
    // Duração média dos pendentes do mês (só dias desde criação até hoje)
    const totalN = comDuracao.length + pendentes.length;
    const mediaGlobal = totalN > 0
        ? Math.round((comDuracao.reduce((a,p) => a + _calcDias(p.criadoEm, p.levantadoEm || p.saidaEm), 0)
            + pendentes.reduce((a,p) => a + _calcDias(p.criadoEm), 0)) / totalN)
        : null;

    // Por funcionário
    const porFunc = {};
    patsLevantadas.forEach(p => {
        const f = p.funcionario || 'Sem funcionário';
        porFunc[f] = (porFunc[f] || 0) + 1;
    });

    // Ponto 7: total real de saídas (todos os movimentos, não só top 5)
    const refCount = {};
    let totalSaidasReal = 0;
    Object.values(movData).forEach(m => {
        if (!m.codigo) return;
        totalSaidasReal += m.quantidade || 1;
        if (!refCount[m.codigo]) refCount[m.codigo] = { codigo: m.codigo, nome: m.nome, qty: 0 };
        refCount[m.codigo].qty += m.quantidade || 1;
    });
    const top5 = Object.values(refCount)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);

    // Ferramentas mais requisitadas
    const ferrCount = {};
    Object.values(ferrData).forEach(t => {
        const hist = t.historico ? Object.values(t.historico) : [];
        hist.forEach(ev => {
            if (ev.acao !== 'atribuida') return;
            const evTs = _relParseEvTs(ev.data);
            if (evTs < ini || evTs > fim) return;
            const nome = t.nome || '?';
            ferrCount[nome] = (ferrCount[nome] || 0) + 1;
        });
    });
    const topFerr = Object.entries(ferrCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([nome, count]) => ({ nome, count }));

    // Top clientes
    const clienteCount = {};
    patsMes.forEach(p => {
        const nome = (p.estabelecimento || 'Sem estabelecimento').trim();
        if (!clienteCount[nome]) clienteCount[nome] = { nome, total: 0, comGuia: 0 };
        clienteCount[nome].total++;
        if (p.separacao) clienteCount[nome].comGuia++;
    });
    const topClientes = Object.values(clienteCount)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

    // Ferramentas com mais dias fora do armazém
    const ferrDias = [];
    Object.values(ferrData).forEach(t => {
        if (!t.nome) return;
        const hist = t.historico ? Object.values(t.historico)
            .sort((a, b) => _relParseEvTs(a.data) - _relParseEvTs(b.data)) : [];

        let diasFora = 0;
        let lastAtrib = null;
        hist.forEach(ev => {
            const evTs = _relParseEvTs(ev.data);
            if (ev.acao === 'atribuida') {
                // M6 fix: ignorar atribuições cuja data é posterior ao fim do mês —
                // senão o "status alocada actual" no fim do loop apanha eventos que
                // só aconteceram após o fim do range e subestima/enviesa os dias.
                if (evTs > fim) return;
                lastAtrib = Math.max(evTs, ini);
            } else if (ev.acao === 'devolvida' && lastAtrib) {
                const devTs = Math.min(evTs, fim);
                if (devTs > lastAtrib) diasFora += Math.round((devTs - lastAtrib) / 86400000);
                lastAtrib = null;
            }
        });
        // Só se a última atribuição efectiva (≤ fim) continua sem devolução
        if (lastAtrib && t.status === 'alocada') {
            const extra = Math.round((fim - lastAtrib) / 86400000);
            if (extra > 0) diasFora += extra;
        }
        if (diasFora > 0) ferrDias.push({ nome: t.nome, dias: diasFora });
    });
    const topFerrDias = ferrDias.sort((a, b) => b.dias - a.dias).slice(0, 5);

    // Ponto 4: comGuia = PATs levantadas COM guia (sem sobreposição no donut)
    // donut será: levantadas_sem_guia | levantadas_com_guia | pendentes | historico
    const levantadasComGuia    = patsLevantadas.filter(p => !!p.separacao).length;
    const levantadasSemGuia    = patsLevantadas.length - levantadasComGuia;
    const historicoMes         = patsMes.filter(p => p.status === 'historico').length;

    return {
        mes:               mesKey,
        totalPats:         patsMes.length,
        levantadas:        patsLevantadas.length,
        levantadasComGuia,
        levantadasSemGuia,
        comGuia:           levantadasComGuia,
        pendentes:         pendentes.length,
        historico:         historicoMes,
        duracaoMedia:      mediaGlobal,
        totalSaidas:       totalSaidasReal,
        porFunc,
        top5,
        topFerr,
        topClientes,
        topFerrDias,
        ts:                Date.now(),
    };
}

// _calcDias unificada — ver definição global no topo do ficheiro

// ── Guardar snapshot (S5: com versioning) ────────────────────────────────
// Estrutura do Firebase:
//   /relatorios/{mesKey}/current    → 'v3' (ponteiro para versão activa)
//   /relatorios/{mesKey}/v1         → snapshot antigo
//   /relatorios/{mesKey}/v2         → snapshot intermédio
//   /relatorios/{mesKey}/v3         → snapshot actual
// Retenção: máximo de SNAPSHOT_VERSIONS_KEEP versões, mais antigas são apagadas.
// Compat: leitura antiga tolera formato legacy (sem 'current'), ver _lerSnapshot.
const SNAPSHOT_VERSIONS_KEEP = 5;

async function _guardarSnapshot(mesKey) {
    try {
        const snap = await _buildSnapshot(mesKey);

        // Ler estrutura actual para descobrir próxima versão
        const url = await authUrl(`${REL_URL}/${mesKey}.json`);
        let nextN = 1;
        let existingVersions = []; // lista ordenada de 'v1','v2',...
        try {
            const res  = await fetch(url);
            const data = res.ok ? await res.json() : null;
            if (data && typeof data === 'object') {
                // Se tem 'current' já é formato novo
                if (data.current) {
                    existingVersions = Object.keys(data)
                        .filter(k => /^v\d+$/.test(k))
                        .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
                    const lastN = existingVersions.length > 0
                        ? parseInt(existingVersions[existingVersions.length - 1].slice(1))
                        : 0;
                    nextN = lastN + 1;
                } else if (data.ts || data.mes) {
                    // Formato legacy — migrar: a versão antiga vira v1, nova vira v2
                    existingVersions = ['v1'];
                    nextN = 2;
                }
            }
        } catch(_e) { /* sem histórico — começa em v1 */ }

        const newVersion = `v${nextN}`;
        const isMigracaoLegacy = (existingVersions.length === 1 && existingVersions[0] === 'v1' && nextN === 2);

        // Caminho da migração: fazer PUT completo para apagar campos legacy
        // no root (totalPats, top5, etc. que estão "soltos" no formato antigo).
        if (isMigracaoLegacy) {
            let dataOld = null;
            try {
                const resOld = await fetch(url);
                dataOld = resOld.ok ? await resOld.json() : null;
            } catch(_e) {}
            const fullPayload = {
                current: newVersion,
                [newVersion]: snap,
            };
            if (dataOld && !dataOld.current && (dataOld.ts || dataOld.mes)) {
                fullPayload.v1 = dataOld;
            }
            await apiFetch(`${REL_URL}/${mesKey}.json`, {
                method: 'PUT',
                body:   JSON.stringify(fullPayload),
            });
        } else {
            // Updates normais: PATCH preserva versões anteriores + adiciona nova
            const payload = {
                [newVersion]: snap,
                current:      newVersion,
            };
            await apiFetch(`${REL_URL}/${mesKey}.json`, {
                method: 'PATCH',
                body:   JSON.stringify(payload),
            });
        }

        // Retenção: apagar versões mais antigas se exceder limite
        const allVersions = [...existingVersions, newVersion];
        if (allVersions.length > SNAPSHOT_VERSIONS_KEEP) {
            const paraApagar = allVersions.slice(0, allVersions.length - SNAPSHOT_VERSIONS_KEEP);
            for (const v of paraApagar) {
                try {
                    await apiFetch(`${REL_URL}/${mesKey}/${v}.json`, { method: 'DELETE' });
                } catch(_e) { /* ignorar — não bloqueia */ }
            }
        }

        console.warn(`[Relatório] snapshot guardado: ${mesKey}/${newVersion}`);
        return snap;
    } catch(e) {
        console.warn('[Relatório] falha ao guardar snapshot:', e?.message);
        return null;
    }
}

// Lê snapshot actual — tolera formato legacy e novo.
async function _lerSnapshot(mesKey) {
    try {
        const url = await authUrl(`${REL_URL}/${mesKey}.json`);
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data) return null;
        // Formato novo: tem 'current' → devolve a versão apontada
        if (data.current && data[data.current]) return data[data.current];
        // Formato legacy: tem campos do snapshot directamente
        if (data.ts || data.mes || data.totalPats != null) return data;
        return null;
    } catch(_e) {
        return null;
    }
}

// ── Auto-fechar mês no dia 1 ──────────────────────────────────────────────
// NOTA sobre race multi-dispositivo: dois dispositivos a arrancar simultaneamente
// no dia 1 podem ler "sem snapshot", ambos gerar e fazer PUT — last-write-wins.
// Normalmente benigno porque _buildSnapshot é determinístico (lê os mesmos dados
// do Firebase), mas se um dispositivo tem _patCache desactualizado pode sobrescrever
// com snapshot incompleto. O lock _autoFecharRunning é local, não distribuído.
// Mitigação aceitável: o próximo arranque em qualquer dispositivo detecta o
// snapshot já existe e não regenera. Para snapshots manuais usa relFecharMes.
const _REL_LAST_CLOSE_KEY = 'hiperfrio-rel-last-close';
let _autoFecharRunning = false; // lock para evitar race condition multi-utilizador
async function _autoFecharMesSeNecessario() {
    if (_autoFecharRunning) return;
    _autoFecharRunning = true;
    try {
        const today = new Date();
        const mesAnterior = _mesKey(-1);
        const lastClose   = localStorage.getItem(_REL_LAST_CLOSE_KEY);
        if (lastClose === mesAnterior) return;

        const deveVerificar = today.getDate() === 1 || !lastClose;
        if (!deveVerificar) return;

        const existing = await _lerSnapshot(mesAnterior);
        if (!existing) await _guardarSnapshot(mesAnterior);
        localStorage.setItem(_REL_LAST_CLOSE_KEY, mesAnterior);
    } catch(e) {
        console.warn('[Relatório] auto-fechar falhou:', e?.message);
    } finally {
        _autoFecharRunning = false;
    }
}

// ── Guardar snapshot de um mês específico se ainda não existe / formato antigo ──
// Usada pelo auto-cleanup para deduplicar rebuilds: chamada uma vez por mês afectado.
async function _relSalvarSnapshotSePreciso(mesKey) {
    const mesCorrente = _mesKey(0);
    if (mesKey === mesCorrente) {
        // Mês corrente: regenerar sempre (dados ainda podem mudar e a PAT ainda
        // está na cache antes de ser apagada)
        await _guardarSnapshot(mesKey);
        return;
    }
    // Meses anteriores: só regenerar se não existe ou está em formato antigo
    try {
        const existing = await _lerSnapshot(mesKey);
        if (!existing || existing.totalSaidas === undefined) {
            await _guardarSnapshot(mesKey);
        }
    } catch(e) {
        // silencioso — não bloquear cleanup
    }
}

// ── Guardar antes de apagar PATs expiradas ────────────────────────────────
// Mantida para compatibilidade (pode ser chamada em contexto individual).
// Para batch use _relSalvarSnapshotSePreciso diretamente.
async function _relSalvarPatAntesDeApagar(pat) {
    if (!pat?.criadoEm) return;
    // Determinar mês usando local time — consistente com _mesRange/_calcDias.
    const refTs = pat.levantadoEm || pat.saidaEm || pat.criadoEm;
    const d = new Date(refTs);
    const mesKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    await _relSalvarSnapshotSePreciso(mesKey);
}

// ── Fechar mês manualmente ────────────────────────────────────────────────
async function relFecharMes() {
    const mesKey = _mesKey(_relMesOffset);
    // Só permite fechar o mês actual ou regenerar meses sem snapshot
    // Meses passados com snapshot existente não devem ser sobrescritos via botão
    if (_relMesOffset < 0) {
        const existing = await _lerSnapshot(mesKey);
        if (existing) {
            showToast(`Relatório de ${_mesLabel(mesKey)} já existe. Navega para o mês actual para fechar.`, 'error');
            return;
        }
    }
    const btn = $id('rel-fechar-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A guardar...'; }
    const snap = await _guardarSnapshot(mesKey);
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Fechar mês'; }
    if (snap) { showToast(`Relatório de ${_mesLabel(mesKey)} guardado!`); renderRelatorio(); }
    else       { showToast('Erro ao guardar relatório', 'error'); }
}

// ── Navegação de mês ──────────────────────────────────────────────────────
function relMoveMonth(delta) {
    _relMesOffset += delta;
    if (_relMesOffset > 0)   _relMesOffset = 0;   // não ir para o futuro
    if (_relMesOffset < -24) _relMesOffset = -24;  // máximo 2 anos para trás
    renderRelatorio();
}

// ── Renderizar relatório ──────────────────────────────────────────────────
async function renderRelatorio() {
    // Lazy load do Chart.js — só entra em cache após 1ª visita a Relatórios
    try { await loadChart(); } catch(_e) { console.warn('[Relatório] Chart.js não carregou:', _e?.message); }

    const mesKey  = _mesKey(_relMesOffset);
    const lblEl   = $id('rel-month-label');
    const content = $id('rel-content');
    const strip   = $id('rel-summary-strip');
    if (lblEl) lblEl.textContent = _mesLabel(mesKey);
    if (!content) return;

    // Botão fechar mês — só no mês actual
    const btnFechar = $id('rel-fechar-btn');
    if (btnFechar) btnFechar.style.display = _relMesOffset === 0 ? 'inline-flex' : 'none';

    content.innerHTML = '<div class="rel-loading">A carregar relatório...</div>';
    if (strip) { ['rel-sum-pats','rel-sum-dur','rel-sum-saidas'].forEach(id => { const el = $id(id); if (el) el.textContent = '—'; }); }

    // Fetch snapshot — _lerSnapshot tolera formato legacy e versionado (S5).
    let snap = null;
    let fetchFailed = false;
    try {
        snap = await _lerSnapshot(mesKey);
    } catch(e) {
        fetchFailed = true;
    }
    // Se não há snapshot mas estamos no mês actual, construir em memória
    if (!snap && _relMesOffset === 0) snap = await _buildSnapshot(mesKey);

    if (!snap) {
        // S3 audit: distinguir offline de "sem dados"
        if (!navigator.onLine) {
            content.innerHTML = `<div class="rel-empty">Sem ligação — não foi possível carregar ${_mesLabel(mesKey)}.<br><small>Volta a tentar quando estiveres online.</small></div>`;
        } else {
            content.innerHTML = `<div class="rel-empty">Sem dados para ${_mesLabel(mesKey)}.<br><small>Gerado automaticamente no dia 1 do mês seguinte.</small></div>`;
        }
        return;
    }

    // Fetch snap anterior — igualmente tolerante a formatos
    let snapAnt = null;
    try {
        snapAnt = await _lerSnapshot(_mesKey(_relMesOffset - 1));
    } catch(_e) {}

    // ── Actualizar summary strip com animação ───────────────────────────
    // totalSaidas é campo novo — snapshots antigos (pre-v6.56) só tinham top5.
    // Se falta, somamos top5 mas marcamos como aproximado porque subestima
    // (ignora saídas fora do top 5).
    const hasTotal = snap.totalSaidas != null;
    const totalSaidas = hasTotal ? snap.totalSaidas : (snap.top5 || []).reduce((a, b) => a + (b.qty || 0), 0);
    _relAnimCount('rel-sum-pats',   snap.totalPats ?? 0);
    _relAnimCount('rel-sum-saidas', totalSaidas, 800, hasTotal ? '' : '~');
    // Tooltip explicativo só quando o valor é estimado
    const saidasEl = $id('rel-sum-saidas');
    if (saidasEl) {
        saidasEl.title = hasTotal
            ? ''
            : 'Valor aproximado — snapshot antigo só regista top 5 referências';
    }
    const durEl = $id('rel-sum-dur');
    if (durEl) durEl.textContent = snap.duracaoMedia != null ? snap.duracaoMedia + 'd' : '—';

    content.innerHTML = '';

    // ── helpers ──────────────────────────────────────────────────────────
    function _trend(val, ant, invertido = false, unidade = '') {
        if (ant == null || val == null) return '';
        const diff = val - ant;
        if (Math.abs(diff) < 0.05) return `<div class="rel-kpi-chip chip-neu">= igual ao mês ant.</div>`;
        const up = diff > 0, bom = up !== invertido;
        const cls = bom ? 'chip-up' : 'chip-dn';
        const ico = up ? '▲' : '▼';
        return `<div class="rel-kpi-chip ${cls}">${ico} ${Math.abs(diff)}${unidade} vs mês ant.</div>`;
    }

    function _card(content_html, delay_class = '') {
        const d = $el('div');
        d.className = 'rel-card' + (delay_class ? ' ' + delay_class : '');
        d.innerHTML = content_html;
        return d;
    }

    function _cardHdr(title, pillText, pillClass = 'rel-pill-blue') {
        return `<div class="rel-card-hdr"><span class="rel-card-title">${title}</span><span class="rel-pill ${pillClass}">${pillText}</span></div>`;
    }

    function _emptyInline(msg) {
        return `<div class="rel-empty-inline">${msg}</div>`;
    }

    // ── 1: KPI Cards ────────────────────────────────────────────────────
    const kpiCard = $el('div', { className: 'rel-card' });
    kpiCard.style.padding = '10px';
    const durColor = (snap.duracaoMedia > 7) ? '#dc2626' : (snap.duracaoMedia > 3) ? '#f59e0b' : '#4ade80';
    kpiCard.innerHTML = `
        <div class="rel-kpi-grid">
            <div class="rel-kpi-dark rel-kpi-navy">
                <div class="rel-kpi-bg-icon"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                <div class="rel-kpi-lbl">PATs registadas</div>
                <div class="rel-kpi-num" id="kpi-pats">0</div>
                <div class="rel-kpi-sub">${snap.levantadas ?? 0} levant. · ${snap.pendentes ?? 0} pend.</div>
                ${_trend(snap.totalPats, snapAnt?.totalPats)}
            </div>
            <div class="rel-kpi-dark rel-kpi-forest">
                <div class="rel-kpi-bg-icon"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
                <div class="rel-kpi-lbl">Duração média</div>
                <div class="rel-kpi-num">${snap.duracaoMedia != null ? snap.duracaoMedia + 'd' : '—'}</div>
                <div class="rel-kpi-sub">criação → levantamento</div>
                ${_trend(snap.duracaoMedia, snapAnt?.duracaoMedia, true, 'd')}
            </div>
        </div>`;
    content.appendChild(kpiCard);
    setTimeout(() => _relAnimCount('kpi-pats', snap.totalPats ?? 0, 900), 100);

    // ── 2: Insight automático ────────────────────────────────────────────
    const insightMsg = _relBuildInsight(snap);
    if (insightMsg) {
        const ins = $el('div', { className: 'rel-insight' });
        ins.innerHTML = `
            <div class="rel-insight-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="rel-insight-body">
                <div class="rel-insight-lbl">Alerta automático</div>
                <div class="rel-insight-msg">${escapeHtml(insightMsg)}</div>
            </div>`;
        content.appendChild(ins);
    }

    // ── 3: Donut — distribuição PATs ─────────────────────────────────────
    const donutCard = $el('div', { className: 'rel-card' });
    const totalPats        = snap.totalPats         || 0;
    const levantadas       = snap.levantadas        || 0;
    const levantadasComGuia = snap.levantadasComGuia ?? snap.comGuia ?? 0;
    const levantadasSemGuia = snap.levantadasSemGuia ?? Math.max(0, levantadas - levantadasComGuia);
    const pendentes        = snap.pendentes         || 0;
    // historico = PATs do mês que não são levantadas nem pendentes
    const historico        = snap.historico ?? Math.max(0, totalPats - levantadas - pendentes);
    donutCard.innerHTML = `
        ${_cardHdr('Distribuição de PATs', _mesLabel(mesKey))}
        <div class="rel-donut-wrap">
            <div class="rel-donut-canvas">
                <canvas id="rel-donut" width="110" height="110" class="rel-gauge-canvas"></canvas>
                <div class="rel-donut-center">
                    <span class="rel-donut-center-val">${totalPats}</span>
                    <span class="rel-donut-center-lbl">total</span>
                </div>
            </div>
            <div class="rel-donut-legend">
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#1e3a5f"></div>Levantadas</div><span class="rel-leg-val">${levantadasSemGuia}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#2563eb"></div>C/ guia transp.</div><span class="rel-leg-val">${levantadasComGuia}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#f59e0b"></div>Pendentes</div><span class="rel-leg-val">${pendentes}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#e2e8f0"></div>Histórico</div><span class="rel-leg-val">${historico}</span></div>
            </div>
        </div>`;
    content.appendChild(donutCard);

    // ── 4: Top Clientes ──────────────────────────────────────────────────
    const cliCard = $el('div', { className: 'rel-card' });
    const cliLen = snap.topClientes?.length || 0;
    cliCard.innerHTML = _cardHdr('Top clientes', cliLen + ' estabelec.', 'rel-pill-blue');
    if (cliLen) {
        const list = $el('div', { className: 'rel-rank-list' });
        snap.topClientes.forEach((cli, i) => {
            const badges = ['rb1','rb2','rb3'];
            const bc = i < 3 ? badges[i] : 'rbn';
            const row = $el('div', { className: 'rel-rank-row' });
            row.innerHTML = `
                <div class="rel-rank-badge ${bc}">${i+1}</div>
                <div class="rel-rank-info">
                    <div class="rel-rank-name">${escapeHtml(cli.nome)}</div>
                    <div class="rel-rank-sub">${cli.comGuia > 0 ? cli.comGuia + ' com guia transporte' : 'sem guia'}</div>
                </div>
                <div class="rel-rank-end">
                    <div class="rel-rank-big">${cli.total}</div>
                    <div class="rel-rank-unit">PATs</div>
                </div>`;
            list.appendChild(row);
        });
        cliCard.appendChild(list);
    } else { cliCard.innerHTML += _emptyInline('Sem PATs registadas este mês'); }
    content.appendChild(cliCard);

    // ── 5: Top referências ───────────────────────────────────────────────
    const refsCard = $el('div', { className: 'rel-card' });
    refsCard.innerHTML = _cardHdr('Top referências saídas', 'unidades', 'rel-pill-blue');
    if (snap.top5?.length) {
        const blist = $el('div', { className: 'rel-bar-list' });
        const maxQ = snap.top5[0]?.qty || 1;
        const colors = ['#1e3a5f','#2563eb','#2563eb','#60a5fa','#93c5fd'];
        snap.top5.forEach((item, i) => {
            const pct = Math.round((item.qty / maxQ) * 100);
            const el = $el('div', { className: 'rel-bar-row' });
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(item.codigo)}${item.nome ? ' — ' + escapeHtml(item.nome) : ''}</span>
                    <span class="rel-bar-val" style="color:${colors[i]}">${item.qty} un.</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:${colors[i]}"></div>
                </div>`;
            blist.appendChild(el);
        });
        refsCard.appendChild(blist);
    } else { refsCard.innerHTML += _emptyInline('Sem movimentos registados este mês'); }
    content.appendChild(refsCard);

    // ── 6: Ferramentas dias fora ─────────────────────────────────────────
    const ferrCard = $el('div', { className: 'rel-card' });
    // Dias do mês calculados a partir do mesKey para evitar ambiguidade de timezone.
    // new Date(y, m, 0) dá o último dia do mês anterior = último dia do mês pedido.
    const [_y, _m] = mesKey.split('-').map(Number);
    const diasMes = new Date(_y, _m, 0).getDate();
    ferrCard.innerHTML = _cardHdr('Dias fora do armazém', diasMes + ' dias no mês', 'rel-pill-amber');
    if (snap.topFerrDias?.length) {
        const blist2 = $el('div', { className: 'rel-bar-list' });
        snap.topFerrDias.forEach(t => {
            const pct  = Math.round((t.dias / diasMes) * 100);
            const alerta = pct >= 80;
            const warn   = pct >= 50 && pct < 80;
            const color  = alerta ? '#dc2626' : warn ? '#f59e0b' : '#2563eb';
            const valColor = alerta ? '#dc2626' : warn ? '#f59e0b' : '#2563eb';
            const el = $el('div', { className: 'rel-bar-row' });
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="rel-bar-val" style="color:${valColor}">${t.dias}d · ${pct}%</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:${color}"></div>
                </div>`;
            blist2.appendChild(el);
        });
        ferrCard.appendChild(blist2);
    } else { ferrCard.innerHTML += _emptyInline('Sem dados de alocação registados'); }
    content.appendChild(ferrCard);

    // ── 7: Ferramentas mais requisitadas ─────────────────────────────────
    if (snap.topFerr?.length) {
        const ferrReqCard = $el('div', { className: 'rel-card' });
        ferrReqCard.innerHTML = _cardHdr('Ferramentas mais requisitadas', snap.topFerr.length + ' ferramentas', 'rel-pill-blue');
        const blist3 = $el('div', { className: 'rel-bar-list' });
        const maxF = snap.topFerr[0]?.count || 1;
        snap.topFerr.forEach(t => {
            const pct = Math.round((t.count / maxF) * 100);
            const el = $el('div', { className: 'rel-bar-row' });
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="rel-bar-val" style="color:#1e3a5f">${t.count}× requisitada${t.count > 1 ? 's' : ''}</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:#1e3a5f"></div>
                </div>`;
            blist3.appendChild(el);
        });
        ferrReqCard.appendChild(blist3);
        content.appendChild(ferrReqCard);
    }

    // ── 8: PATs por funcionário (gauges) ─────────────────────────────────
    if (snap.porFunc && Object.keys(snap.porFunc).length) {
        const funcCard = $el('div', { className: 'rel-card' });
        const totalLev = Object.values(snap.porFunc).reduce((a, b) => a + b, 0) || 1;
        const funcEntries = Object.entries(snap.porFunc).sort((a, b) => b[1] - a[1]).slice(0, 4);
        funcCard.innerHTML = _cardHdr('PATs por funcionário', totalLev + ' levantadas', 'rel-pill-green');
        const gaugeRow = $el('div', { className: 'rel-gauge-row' });
        const gColors = ['#1e3a5f','#2563eb','#f59e0b','#16a34a'];
        funcEntries.forEach(([nome, val], i) => {
            const pct = Math.round((val / totalLev) * 100);
            const col = gColors[i] || '#64748b';
            const col_div = $el('div', { className: 'rel-gauge-col' });
            col_div.innerHTML = `
                <canvas id="rel-gauge-${i}" width="72" height="72" class="rel-gauge-canvas"></canvas>
                <span class="rel-gauge-name">${escapeHtml(nome)}</span>
                <span class="rel-gauge-pct" style="color:${col}">${val} PAT${val > 1 ? 's' : ''}</span>`;
            gaugeRow.appendChild(col_div);
        });
        funcCard.appendChild(gaugeRow);
        content.appendChild(funcCard);

        // Desenhar gauges após DOM insert
        setTimeout(() => {
            funcEntries.forEach(([nome, val], i) => {
                const pct = Math.round((val / totalLev) * 100);
                _relDrawGauge('rel-gauge-' + i, pct, gColors[i] || '#64748b', i * 120);
            });
        }, 200);
    }

    // ── Animar barras + donut ────────────────────────────────────────────
    setTimeout(() => {
        content.querySelectorAll('.rel-bar-fill[data-w]').forEach((bar, i) => {
            setTimeout(() => { bar.style.width = bar.dataset.w + '%'; }, i * 70);
        });
        // Donut Chart.js — destruir instância anterior para evitar flickering
        const donutCanvas = $id('rel-donut');
        if (donutCanvas && window.Chart) {
            if (_relDonutChart) { _relDonutChart.destroy(); _relDonutChart = null; }
            _relDonutChart = new Chart(donutCanvas, {
                type: 'doughnut',
                data: {
                    datasets: [{
                        data: [levantadasSemGuia, levantadasComGuia, pendentes, historico].map(v => Math.max(v, 0)),
                        backgroundColor: ['#1e3a5f','#2563eb','#f59e0b','#e2e8f0'],
                        borderWidth: 0,
                        hoverOffset: 4,
                    }]
                },
                options: {
                    responsive: false, cutout: '68%',
                    animation: { animateRotate: true, duration: 1100, easing: 'easeOutQuart' },
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                }
            });
        }
    }, 150);
}

// ── Limpeza de instâncias Chart.js ────────────────────────────────────────
// Chamada quando o utilizador sai do tab Relatório. Evita leak de memória
// e garante estado limpo ao voltar (especialmente se o zoom do browser mudou).
function _relDestroyCharts() {
    if (_relDonutChart) {
        try { _relDonutChart.destroy(); } catch(_e) {}
        _relDonutChart = null;
    }
}

// ── Contador animado ──────────────────────────────────────────────────────
// prefix: opcional, prepended ao número (e.g. "~" quando o valor é aproximado)
function _relAnimCount(elId, target, dur = 800, prefix = '') {
    const el = $id(elId);
    if (!el || target == null) return;
    if (target === 0) { el.textContent = prefix + '0'; return; }
    const start = performance.now();
    const step  = ts => {
        const p    = Math.min((ts - start) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 4);
        el.textContent = prefix + Math.round(target * ease);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ── Gauge canvas ──────────────────────────────────────────────────────────
function _relDrawGauge(canvasId, pct, color, delayMs = 0) {
    setTimeout(() => {
        const c = $id(canvasId);
        if (!c) return;
        const ctx = c.getContext('2d');
        const cx = 36, cy = 36, r = 26, lw = 7;
        const isDark = document.body.classList.contains('dark-mode');
        const trackCol = isDark ? 'rgba(255,255,255,.08)' : '#f1f5f9';
        let cur = 0;
        const target = pct / 100;
        const start  = performance.now();
        const step   = ts => {
            const p    = Math.min((ts - start) / 900, 1);
            const ease = 1 - Math.pow(1 - p, 4);
            cur = target * ease;
            ctx.clearRect(0, 0, 72, 72);
            ctx.beginPath();
            ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI * 2 - Math.PI / 2);
            ctx.strokeStyle = trackCol;
            ctx.lineWidth = lw;
            ctx.lineCap = 'round';
            ctx.stroke();
            if (cur > 0) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cur);
                ctx.strokeStyle = color;
                ctx.lineWidth = lw;
                ctx.lineCap = 'round';
                ctx.stroke();
            }
            const textColor = isDark ? '#e2e8f0' : '#0f172a';
            ctx.fillStyle = textColor;
            ctx.font = 'bold 11px Inter,-apple-system,sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(Math.round(pct * ease) + '%', cx, cy);
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }, delayMs);
}

// ── Insight automático ────────────────────────────────────────────────────
function _relBuildInsight(snap) {
    if (snap.topFerrDias?.length) {
        const top = snap.topFerrDias[0];
        // Dias reais do mês a partir do mesKey — não hardcoded a 30
        const [y, m] = (snap.mes || _mesKey(0)).split('-').map(Number);
        const diasMes = new Date(y, m, 0).getDate(); // dia 0 do mês seguinte = último dia do mês
        const pct = Math.round((top.dias / diasMes) * 100);
        if (pct >= 80) return `"${top.nome}" esteve fora do armazém ${pct}% do mês (${top.dias} dias). Considera adquirir uma segunda unidade.`;
    }
    if (snap.duracaoMedia != null && snap.duracaoMedia > 10) {
        return `Duração média das PATs está em ${snap.duracaoMedia} dias — acima do recomendado. Verifica pendências em aberto.`;
    }
    if (snap.pendentes > 5) {
        return `${snap.pendentes} PATs ainda pendentes no final do mês. Garante que estão atribuídas a um técnico.`;
    }
    return null;
}

