// ─────────────────────────────────────────────────────────────────────────────
// reports.js — Hiperfrio v6.61
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
// tipo: 'saida_pat' | 'saida_manual' | 'saida_guia' | 'remocao' | 'estorno_guia'
//   saida_*      — saída normal, soma ao total e ao ranking da ref.
//   remocao      — produto apagado; conta como saída.
//   estorno_*    — reversão de saída (ex: undo de recolha em guia). SUBTRAI
//                  ao total e ao ranking. Usa-se quando o movimento original
//                  foi gravado mas a operação foi revertida.
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

    // Fetch guias separadas no mês — para métrica "Guias técnicas" no KPI
    let guiasCount = 0;
    try {
        const guiasUrl = await authUrl(
            `${BASE_URL}/guias.json?orderBy="separadoEm"&startAt=${ini}&endAt=${fim}`
        );
        const guiasRes  = await fetch(guiasUrl);
        const guiasData = guiasRes.ok ? (await guiasRes.json() || {}) : {};
        if (guiasData && typeof guiasData === 'object' && !Array.isArray(guiasData)) {
            guiasCount = Object.keys(guiasData).length;
        }
    } catch(_e) { /* requer .indexOn: ["separadoEm"] em /guias */ }

    // Map código → unidade (para gás mostrar kg em vez de unidades).
    // Movimentos não guardam unidade, mas stock sim. Fazemos lookup por código.
    // Também conta quantos produtos têm stock = 0 (input para alerta).
    const unidadePorCodigo = {};
    let stockZero = 0;
    const stockByCodigo = {}; // para cross-check de consumo por ref
    try {
        const stockRaw = await fetchCollection('stock', false);
        Object.values(stockRaw || {}).forEach(item => {
            if (!item.codigo) return;
            const codU = item.codigo.toUpperCase();
            unidadePorCodigo[codU] = item.unidade || 'un';
            stockByCodigo[codU] = item;
            if ((item.quantidade || 0) === 0) stockZero++;
        });
    } catch(_e) {}

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
    // Decomposição por tipo + agregação SÓ para guias (base para planear encomendas)
    const saidasPorTipo = { saida_pat: 0, saida_manual: 0, saida_guia: 0, remocao: 0 };
    const refCountGuias = {};
    // Estornos (reversões explícitas) descontam no ranking e no total.
    // Se um movimento tem `estorno_*`, subtraímos a quantidade da ref correspondente
    // e também do tipo original (ex: estorno_guia subtrai em saidasPorTipo.saida_guia).
    // Tipos suportados: estorno_guia (reversão de recolha em guias técnicas).
    Object.values(movData).forEach(m => {
        if (!m.codigo) return;
        const qtd = m.quantidade || 1;
        const codU = m.codigo.toUpperCase();
        const unidade = unidadePorCodigo[codU] || 'un';
        const isEstorno = typeof m.tipo === 'string' && m.tipo.startsWith('estorno_');
        const sign = isEstorno ? -1 : 1;
        // Mapear estorno_X → saida_X para subtrair no bucket correspondente
        const tipoBucket = isEstorno ? m.tipo.replace(/^estorno_/, 'saida_') : m.tipo;

        totalSaidasReal += qtd * sign;
        if (saidasPorTipo[tipoBucket] !== undefined) saidasPorTipo[tipoBucket] += qtd * sign;

        if (!refCount[codU]) refCount[codU] = { codigo: m.codigo, nome: m.nome, qty: 0, unidade };
        refCount[codU].qty += qtd * sign;

        // Materiais saídos VIA GUIAS — ranking separado para planeamento.
        // Estorno de guia subtrai. Tipo saida_guia adiciona.
        if (m.tipo === 'saida_guia' || m.tipo === 'estorno_guia') {
            if (!refCountGuias[codU]) refCountGuias[codU] = { codigo: m.codigo, nome: m.nome, qty: 0, unidade };
            refCountGuias[codU].qty += qtd * sign;
        }
    });
    // Guard numérico: buckets não podem ficar negativos se a ordem de estornos
    // foi lida antes das saídas originais (raro mas possível com clock skew).
    Object.keys(saidasPorTipo).forEach(k => { if (saidasPorTipo[k] < 0) saidasPorTipo[k] = 0; });
    // Filtrar refs com qty <= 0 (totalmente estornadas) — não aparecem em rankings
    const top5 = Object.values(refCount)
        .filter(r => r.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
    const topGuias = Object.values(refCountGuias)
        .filter(r => r.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
    // Total não pode ficar negativo (teórico, mas guard)
    if (totalSaidasReal < 0) totalSaidasReal = 0;

    // Top refs do período que estão a zero no stock actualmente — alerta crítico
    const topEsgotados = Object.values(refCount)
        .filter(r => {
            const item = stockByCodigo[r.codigo.toUpperCase()];
            return item && (item.quantidade || 0) === 0;
        })
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 3);

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
        topGuias,
        saidasPorTipo,
        guiasCount,
        stockZero,         // novo: nº produtos a 0 no stock
        topEsgotados,      // novo: top refs do período que estão esgotadas agora
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
// ── Renderizar relatório ──────────────────────────────────────────────────
// Layout: painel operacional denso com 4 linhas + mini-tabs em blocos densos.
// Data actual: snapshot do mês (ou semana/janela móvel via filtro).
// resetToCurrent: se true, repõe offset a 0 e range a 'mes' antes de renderizar.
async function renderRelatorio(resetToCurrent = false) {
    if (resetToCurrent) {
        _relMesOffset = 0;
        _relRange     = 'mes';
        // Actualizar UI dos botões de range imediatamente
        document.querySelectorAll('.relx-range-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.range === 'mes');
        });
    }
    try { await loadChart(); } catch(_e) { console.warn('[Relatório] Chart.js não carregou:', _e?.message); }

    const mesKey  = _mesKey(_relMesOffset);
    const lblEl   = $id('rel-month-label');
    const content = $id('rel-content');
    const strip   = $id('rel-summary-strip');
    if (lblEl) {
        lblEl.textContent = _relRange === 'mes'
            ? _mesLabel(mesKey)
            : `últimos ${_relRange} dias`;
    }
    if (!content) return;

    // Botão fechar mês — só no mês actual e range 'mes'
    const btnFechar = $id('rel-fechar-btn');
    if (btnFechar) btnFechar.style.display = (_relMesOffset === 0 && _relRange === 'mes') ? 'inline-flex' : 'none';

    // Setas de mês desactivadas em janela móvel
    document.querySelectorAll('.rel-month-arr').forEach(a => {
        a.style.opacity = _relRange === 'mes' ? '' : '0.35';
        a.style.pointerEvents = _relRange === 'mes' ? '' : 'none';
    });

    content.innerHTML = '<div class="relx-loading"><div class="relx-spinner"></div>A preparar dados…</div>';
    if (strip) { ['rel-sum-pats','rel-sum-dur','rel-sum-saidas'].forEach(id => { const el = $id(id); if (el) el.textContent = '—'; }); }

    // Snapshot do período actual
    let snap = null;
    try { snap = await _relFetchPeriod(mesKey, _relRange); } catch(_e) {}
    if (!snap && _relMesOffset === 0) snap = await _buildSnapshot(mesKey);

    if (!snap) {
        if (!navigator.onLine) {
            content.innerHTML = `<div class="relx-empty"><span class="relx-empty-icon">⚡</span><div>Sem ligação</div><small>Não foi possível carregar ${_mesLabel(mesKey)}. Volta quando estiveres online.</small></div>`;
        } else {
            content.innerHTML = `<div class="relx-empty"><span class="relx-empty-icon">○</span><div>Sem dados para ${_mesLabel(mesKey)}</div><small>O snapshot será gerado no dia 1 do mês seguinte.</small></div>`;
        }
        return;
    }

    // Histórico de 6 meses para sparklines
    const sparkData = await _relFetchHistorico(6, mesKey);

    // Snapshot mês anterior + dois meses antes (para detectar mudanças de padrão).
    // Fetch em paralelo para não penalizar o load.
    const [snapAnt, snapAnt2, snapAnt3] = await Promise.all([
        _lerSnapshot(_mesKey(_relMesOffset - 1)).catch(() => null),
        _lerSnapshot(_mesKey(_relMesOffset - 2)).catch(() => null),
        _lerSnapshot(_mesKey(_relMesOffset - 3)).catch(() => null),
    ]);

    // Summary strip (topo fixo)
    const hasTotal = snap.totalSaidas != null;
    const totalSaidas = hasTotal ? snap.totalSaidas : (snap.top5 || []).reduce((a, b) => a + (b.qty || 0), 0);
    _relAnimCount('rel-sum-pats',   snap.totalPats ?? 0);
    _relAnimCount('rel-sum-saidas', totalSaidas, 800, hasTotal ? '' : '~');
    const saidasEl = $id('rel-sum-saidas');
    if (saidasEl) saidasEl.title = hasTotal ? '' : 'Valor aproximado — snapshot antigo';
    const durEl = $id('rel-sum-dur');
    if (durEl) durEl.textContent = snap.duracaoMedia != null ? snap.duracaoMedia + 'd' : '—';

    // ── Builder HTML — um único template string para toda a grid ──────────
    content.innerHTML = _relBuildLayout(snap, snapAnt, sparkData, totalSaidas, hasTotal, snapAnt2, snapAnt3);

    // ── Hooks pós-render: event listeners para mini-tabs + animações ──────
    _relAttachMiniTabs(snap);
    _relDrawSparklines(sparkData, snap);
    _relDrawDonut(snap);
    _relAnimateBars();
    _relAnimateKPIs();
}

// ── Layout builder — monta toda a grid numa string ────────────────────────
function _relBuildLayout(snap, snapAnt, sparkData, totalSaidas, hasTotal, snapAnt2, snapAnt3) {
    const mesKey = snap.mes || _mesKey(_relMesOffset);

    // KPIs
    const kpis = [
        { id: 'pats',    label: 'PATs do período',      value: snap.totalPats || 0,   sub: `${snap.levantadas || 0} levant. · ${snap.pendentes || 0} pend.`, delta: _relDelta(snap.totalPats, snapAnt?.totalPats),       invert: false },
        { id: 'saidas',  label: 'Saídas totais',        value: totalSaidas,            sub: 'unidades', suffix: hasTotal ? '' : '~',                                           delta: _relDelta(totalSaidas, snapAnt ? (snapAnt.totalSaidas ?? (snapAnt.top5||[]).reduce((a,b)=>a+(b.qty||0),0)) : null),  invert: false },
        { id: 'duracao', label: 'Duração média',        value: snap.duracaoMedia || 0, sub: 'dias · criação → levant.',                                                          suffix: 'd',   delta: _relDelta(snap.duracaoMedia, snapAnt?.duracaoMedia),   invert: true  },
        { id: 'guias',   label: 'Guias Técnicos',       value: snap.guiasCount || 0,   sub: 'separações',                                                                         delta: _relDelta(snap.guiasCount, snapAnt?.guiasCount),       invert: false },
    ];

    const kpisHtml = kpis.map((k, i) => `
        <div class="relx-kpi" style="animation-delay:${i * 80}ms">
            <div class="relx-kpi-label">${k.label}</div>
            <div class="relx-kpi-value">
                <span class="relx-kpi-num" data-target="${k.value}" data-prefix="${k.suffix || ''}">0${k.suffix || ''}</span>
            </div>
            <div class="relx-kpi-sub">${escapeHtml(k.sub)}</div>
            ${k.delta.html}
            <div class="relx-kpi-spark"><svg class="relx-spark-svg" data-metric="${k.id}" viewBox="0 0 120 32" preserveAspectRatio="none"></svg></div>
        </div>
    `).join('');

    // Distribuição (donut)
    const totalPats = snap.totalPats || 0;
    const taxa = snap.levantadas && totalPats ? Math.round((snap.levantadas / totalPats) * 100) : 0;
    const distribuicaoHtml = `
        <div class="relx-block relx-block-distrib" style="animation-delay:340ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title">Distribuição de PATs</h3>
                <span class="relx-block-pill">${_mesLabel(mesKey)}</span>
            </div>
            <div class="relx-donut-wrap">
                <canvas id="relx-donut" width="160" height="160" class="relx-donut-canvas"></canvas>
                <div class="relx-donut-center">
                    <div class="relx-donut-big" id="relx-donut-num">0</div>
                    <div class="relx-donut-small">total</div>
                </div>
            </div>
            <div class="relx-legend">
                <div class="relx-legend-row"><span class="relx-dot" style="background:#0f172a"></span><span class="relx-legend-txt">Levant. s/guia</span><span class="relx-legend-val">${snap.levantadasSemGuia || 0}</span></div>
                <div class="relx-legend-row"><span class="relx-dot" style="background:#f97316"></span><span class="relx-legend-txt">Levant. c/guia</span><span class="relx-legend-val">${snap.levantadasComGuia || 0}</span></div>
                <div class="relx-legend-row"><span class="relx-dot" style="background:#f59e0b"></span><span class="relx-legend-txt">Pendentes</span><span class="relx-legend-val">${snap.pendentes || 0}</span></div>
                <div class="relx-legend-row"><span class="relx-dot" style="background:#cbd5e1"></span><span class="relx-legend-txt">Histórico</span><span class="relx-legend-val">${snap.historico || 0}</span></div>
            </div>
            <div class="relx-conclusao">
                <div class="relx-conclusao-lbl">Taxa de conclusão</div>
                <div class="relx-conclusao-val" data-target="${taxa}" data-suffix="%">0%</div>
                <div class="relx-conclusao-bar"><div class="relx-conclusao-fill" style="--pct:${taxa}%"></div></div>
            </div>
        </div>
    `;

    // Top saídas (com mini-tabs)
    const tabsSaidas = [
        { id: 'all',    label: 'Todas',    data: snap.top5 || [] },
        { id: 'pat',    label: 'PATs',     data: [] }, // vazio por enquanto — preenchido via movimentos filtrados client-side se precisar
        { id: 'guia',   label: 'Guias',    data: snap.topGuias || [] },
        { id: 'manual', label: 'Manuais',  data: [] },
    ];
    // Por agora mostramos Todas + Guias (os mais relevantes); os outros ficam como placeholder
    const saidasHtml = `
        <div class="relx-block relx-block-saidas" style="animation-delay:420ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title">Top referências — saídas</h3>
                <div class="relx-minitabs" data-tabs-group="saidas">
                    <button class="relx-minitab active" data-tab="all">Todas</button>
                    <button class="relx-minitab" data-tab="guia">Só Guias</button>
                </div>
            </div>
            <div class="relx-barlist" data-panel="saidas-all">
                ${_relBarListHtml(snap.top5, 'saidas-all')}
            </div>
            <div class="relx-barlist is-hidden" data-panel="saidas-guia">
                ${_relBarListHtml(snap.topGuias, 'saidas-guia')}
            </div>
        </div>
    `;

    // Bloco separado: materiais em guias (destaque para planeamento de encomendas)
    const guiasHtml = `
        <div class="relx-block relx-block-guias" style="animation-delay:500ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title"><span class="relx-star">⚑</span> Materiais em guias</h3>
                <span class="relx-block-pill relx-pill-orange">planear encomendas</span>
            </div>
            ${snap.topGuias && snap.topGuias.length
                ? `<div class="relx-barlist">${_relBarListHtml(snap.topGuias, 'guias', '#f97316')}</div>`
                : '<div class="relx-empty-inline">Sem guias separadas no período</div>'
            }
        </div>
    `;

    // Ferramentas (com mini-tabs dias/requisições)
    const ferramentasHtml = `
        <div class="relx-block relx-block-ferr" style="animation-delay:580ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title">Ferramentas</h3>
                <div class="relx-minitabs" data-tabs-group="ferr">
                    <button class="relx-minitab active" data-tab="dias">Dias fora</button>
                    <button class="relx-minitab" data-tab="req">Requisições</button>
                </div>
            </div>
            <div class="relx-barlist" data-panel="ferr-dias">
                ${_relFerrDiasHtml(snap.topFerrDias, mesKey)}
            </div>
            <div class="relx-barlist is-hidden" data-panel="ferr-req">
                ${_relFerrReqHtml(snap.topFerr)}
            </div>
        </div>
    `;

    // Top clientes
    const clientesHtml = `
        <div class="relx-block relx-block-clientes" style="animation-delay:660ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title">Top clientes</h3>
                <span class="relx-block-pill">${(snap.topClientes || []).length} estab.</span>
            </div>
            ${snap.topClientes && snap.topClientes.length
                ? `<ol class="relx-ranking">${
                    snap.topClientes.map((c, i) => `
                        <li class="relx-rank-row" style="animation-delay:${700 + i * 50}ms">
                            <span class="relx-rank-pos relx-rank-${Math.min(i+1,5)}">${i + 1}</span>
                            <div class="relx-rank-info">
                                <div class="relx-rank-name">${escapeHtml(c.nome)}</div>
                                <div class="relx-rank-sub">${c.comGuia > 0 ? c.comGuia + ' com guia transporte' : 'sem guia'}</div>
                            </div>
                            <div class="relx-rank-val">
                                <div class="relx-rank-num">${c.total}</div>
                                <div class="relx-rank-unit">PATs</div>
                            </div>
                        </li>
                    `).join('')
                }</ol>`
                : '<div class="relx-empty-inline">Sem PATs no período</div>'
            }
        </div>
    `;

    // Insights avançados
    const insights = _relBuildInsightsAvancados(snap, snapAnt, sparkData, snapAnt2, snapAnt3);
    const insightsHtml = insights.length ? `
        <div class="relx-block relx-block-insights" style="animation-delay:740ms">
            <div class="relx-block-hdr">
                <h3 class="relx-block-title">Observações automáticas</h3>
                <span class="relx-block-pill relx-pill-live">${insights.length} alerta${insights.length > 1 ? 's' : ''}</span>
            </div>
            <div class="relx-insights-list">
                ${insights.map((it, i) => `
                    <div class="relx-insight relx-insight-${it.level}" style="animation-delay:${760 + i * 60}ms">
                        <span class="relx-insight-icon">${it.icon}</span>
                        <span class="relx-insight-text">${it.text}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    ` : '';

    return `
        <div class="relx-grid">
            <div class="relx-row-kpis">${kpisHtml}</div>
            <div class="relx-row-main">
                <div class="relx-col-left">
                    ${saidasHtml}
                    ${guiasHtml}
                </div>
                <div class="relx-col-right">
                    ${distribuicaoHtml}
                </div>
            </div>
            <div class="relx-row-secondary">
                ${ferramentasHtml}
                ${clientesHtml}
            </div>
            ${insightsHtml}
        </div>
    `;
}

// ── Helpers de construção ─────────────────────────────────────────────────
function _relBarListHtml(items, prefix, color) {
    if (!items || !items.length) return '<div class="relx-empty-inline">Sem dados no período</div>';
    const maxQ = items[0]?.qty || 1;
    const defaultColor = '#0f172a';
    return items.map((it, i) => {
        const pct = Math.round((it.qty / maxQ) * 100);
        const c = color || defaultColor;
        // Usa a unidade do stock (ex: kg para gás) em vez de "un." fixo.
        // Se não houver unidade resolvida, assume 'un'.
        const unidade = it.unidade && it.unidade !== 'un' ? it.unidade : 'un.';
        const qtyFmt  = `${it.qty} ${unidade}`;
        return `
            <div class="relx-bar-row" style="animation-delay:${i * 60}ms">
                <div class="relx-bar-meta">
                    <span class="relx-bar-code">${escapeHtml(it.codigo || '')}</span>
                    <span class="relx-bar-name">${escapeHtml(it.nome || '')}</span>
                    <span class="relx-bar-val" style="color:${c}">${qtyFmt}</span>
                </div>
                <div class="relx-bar-track">
                    <div class="relx-bar-fill" data-w="${pct}" style="background:${c}"></div>
                </div>
            </div>
        `;
    }).join('');
}

function _relFerrDiasHtml(items, mesKey) {
    if (!items || !items.length) return '<div class="relx-empty-inline">Sem dados de alocação</div>';
    const [y, m] = mesKey.split('-').map(Number);
    const diasMes = new Date(y, m, 0).getDate();
    return items.map((t, i) => {
        const pct = Math.round((t.dias / diasMes) * 100);
        const color = pct >= 80 ? '#dc2626' : pct >= 50 ? '#f59e0b' : '#0f172a';
        return `
            <div class="relx-bar-row" style="animation-delay:${i * 60}ms">
                <div class="relx-bar-meta">
                    <span class="relx-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="relx-bar-val" style="color:${color}">${t.dias}d · ${pct}%</span>
                </div>
                <div class="relx-bar-track">
                    <div class="relx-bar-fill" data-w="${pct}" style="background:${color}"></div>
                </div>
            </div>
        `;
    }).join('');
}

function _relFerrReqHtml(items) {
    if (!items || !items.length) return '<div class="relx-empty-inline">Sem requisições no período</div>';
    const max = items[0]?.count || 1;
    return items.map((t, i) => {
        const pct = Math.round((t.count / max) * 100);
        return `
            <div class="relx-bar-row" style="animation-delay:${i * 60}ms">
                <div class="relx-bar-meta">
                    <span class="relx-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="relx-bar-val">${t.count}× requisit.</span>
                </div>
                <div class="relx-bar-track">
                    <div class="relx-bar-fill" data-w="${pct}" style="background:#0f172a"></div>
                </div>
            </div>
        `;
    }).join('');
}

// ── Delta helper (chips de tendência) ─────────────────────────────────────
function _relDelta(val, ant, suffix = '') {
    if (ant == null || val == null) return { html: '<div class="relx-chip relx-chip-neu">—</div>', diff: 0 };
    const diff = val - ant;
    if (Math.abs(diff) < 0.5) return { html: '<div class="relx-chip relx-chip-neu">= igual</div>', diff: 0 };
    const up = diff > 0;
    const cls = up ? 'relx-chip-up' : 'relx-chip-dn';
    const ico = up ? '▲' : '▼';
    return {
        html: `<div class="relx-chip ${cls}">${ico} ${Math.abs(diff).toFixed(diff % 1 ? 1 : 0)}${suffix} vs ant.</div>`,
        diff,
    };
}

// ── Fetch período / histórico ─────────────────────────────────────────────
// _relRange: 'mes' | '30' | '14' | '7'
// 'mes': usa snapshot do mês
// '7'/'14'/'30': janela móvel a partir de hoje — constrói snapshot em memória
async function _relFetchPeriod(mesKey, range) {
    if (range === 'mes') {
        return await _lerSnapshot(mesKey);
    }
    // Janela móvel
    const ndays = parseInt(range, 10);
    if (!ndays || ndays < 1) return await _lerSnapshot(mesKey);
    return await _relBuildWindow(ndays);
}

// Constrói snapshot-like para últimos N dias
async function _relBuildWindow(ndays) {
    const now = Date.now();
    const ini = now - ndays * 86400000;
    const fim = now;

    // Fetch pats (usa cache actual — não ideal mas adequado)
    let pats = [];
    try {
        const patData = await _fetchPats(false);
        pats = Object.values(patData || {});
    } catch(_e) {}

    // Ferramentas actuais
    let ferrData = {};
    try {
        ferrData = (await fetchCollection('ferramentas', false)) || {};
    } catch(_e) {}

    // Map código → unidade (stock lookup)
    const unidadePorCodigo = {};
    let stockZero = 0;
    const stockByCodigo = {};
    try {
        const stockRaw = await fetchCollection('stock', false);
        Object.values(stockRaw || {}).forEach(item => {
            if (!item.codigo) return;
            const codU = item.codigo.toUpperCase();
            unidadePorCodigo[codU] = item.unidade || 'un';
            stockByCodigo[codU] = item;
            if ((item.quantidade || 0) === 0) stockZero++;
        });
    } catch(_e) {}

    // Movimentos no range — como não podemos query por ts (precisaria de índice),
    // lemos os movimentos do mês actual E anterior para cobrir 30 dias
    const mesActual = _mesKey(0);
    const mesAnt    = _mesKey(-1);
    const movData = {};
    for (const mk of [mesAnt, mesActual]) {
        try {
            const movUrl = await authUrl(`${MOV_URL}.json?orderBy="mes"&equalTo="${mk}"`);
            const res = await fetch(movUrl);
            if (res.ok) {
                const d = await res.json();
                if (d && typeof d === 'object' && !Array.isArray(d)) Object.assign(movData, d);
            }
        } catch(_e) {}
    }

    // Filtrar por ts dentro do range
    const movsRange = Object.values(movData).filter(m => m.ts && m.ts >= ini && m.ts <= fim);

    // PATs criadas no range
    const patsMes = pats.filter(p => p.criadoEm >= ini && p.criadoEm <= fim);
    const patsLevantadas = pats.filter(p => {
        const levTs = p.levantadoEm || p.saidaEm;
        return levTs && levTs >= ini && levTs <= fim;
    });

    const pendentes = patsMes.filter(p => p.status !== 'levantado' && p.status !== 'historico');
    const comDuracao = patsLevantadas.filter(p => p.criadoEm && (p.levantadoEm || p.saidaEm));
    const totalN = comDuracao.length + pendentes.length;
    const duracaoMedia = totalN > 0
        ? Math.round((comDuracao.reduce((a,p) => a + _calcDias(p.criadoEm, p.levantadoEm || p.saidaEm), 0)
            + pendentes.reduce((a,p) => a + _calcDias(p.criadoEm), 0)) / totalN)
        : null;

    // Saídas
    const refCount = {};
    const refCountGuias = {};
    let totalSaidasReal = 0;
    const saidasPorTipo = { saida_pat: 0, saida_manual: 0, saida_guia: 0, remocao: 0 };
    movsRange.forEach(m => {
        if (!m.codigo) return;
        const qtd = m.quantidade || 1;
        const codU = m.codigo.toUpperCase();
        const unidade = unidadePorCodigo[codU] || 'un';
        const isEstorno = typeof m.tipo === 'string' && m.tipo.startsWith('estorno_');
        const sign = isEstorno ? -1 : 1;
        const tipoBucket = isEstorno ? m.tipo.replace(/^estorno_/, 'saida_') : m.tipo;

        totalSaidasReal += qtd * sign;
        if (saidasPorTipo[tipoBucket] !== undefined) saidasPorTipo[tipoBucket] += qtd * sign;

        if (!refCount[codU]) refCount[codU] = { codigo: m.codigo, nome: m.nome, qty: 0, unidade };
        refCount[codU].qty += qtd * sign;
        if (m.tipo === 'saida_guia' || m.tipo === 'estorno_guia') {
            if (!refCountGuias[codU]) refCountGuias[codU] = { codigo: m.codigo, nome: m.nome, qty: 0, unidade };
            refCountGuias[codU].qty += qtd * sign;
        }
    });
    Object.keys(saidasPorTipo).forEach(k => { if (saidasPorTipo[k] < 0) saidasPorTipo[k] = 0; });
    const top5     = Object.values(refCount).filter(r => r.qty > 0).sort((a,b) => b.qty - a.qty).slice(0, 5);
    const topGuias = Object.values(refCountGuias).filter(r => r.qty > 0).sort((a,b) => b.qty - a.qty).slice(0, 5);
    if (totalSaidasReal < 0) totalSaidasReal = 0;

    // Clientes
    const clienteCount = {};
    patsMes.forEach(p => {
        const nome = (p.estabelecimento || 'Sem estabelecimento').trim();
        if (!clienteCount[nome]) clienteCount[nome] = { nome, total: 0, comGuia: 0 };
        clienteCount[nome].total++;
        if (p.separacao) clienteCount[nome].comGuia++;
    });
    const topClientes = Object.values(clienteCount).sort((a,b) => b.total - a.total).slice(0, 5);

    // Ferramentas — dias fora no range
    const ferrDias = [];
    const ferrCount = {};
    Object.values(ferrData).forEach(t => {
        if (!t.nome) return;
        const hist = t.historico ? Object.values(t.historico)
            .sort((a,b) => _relParseEvTs(a.data) - _relParseEvTs(b.data)) : [];
        let dias = 0, lastAtrib = null;
        hist.forEach(ev => {
            const evTs = _relParseEvTs(ev.data);
            if (ev.acao === 'atribuida') {
                if (evTs > fim) return;
                lastAtrib = Math.max(evTs, ini);
                ferrCount[t.nome] = (ferrCount[t.nome] || 0) + (evTs >= ini ? 1 : 0);
            } else if (ev.acao === 'devolvida' && lastAtrib) {
                const devTs = Math.min(evTs, fim);
                if (devTs > lastAtrib) dias += Math.round((devTs - lastAtrib) / 86400000);
                lastAtrib = null;
            }
        });
        if (lastAtrib && t.status === 'alocada') {
            const extra = Math.round((fim - lastAtrib) / 86400000);
            if (extra > 0) dias += extra;
        }
        if (dias > 0) ferrDias.push({ nome: t.nome, dias });
    });
    const topFerrDias = ferrDias.sort((a,b) => b.dias - a.dias).slice(0, 5);
    const topFerr = Object.entries(ferrCount).filter(([,c]) => c > 0)
        .sort((a,b) => b[1] - a[1]).slice(0, 6)
        .map(([nome, count]) => ({ nome, count }));

    // Guias — não re-fetch aqui (estimamos via movs saida_guia > 0 ...)
    const guiasCount = 0; // não fiável na janela móvel sem query adicional

    const levantadasComGuia = patsLevantadas.filter(p => !!p.separacao).length;
    const levantadasSemGuia = patsLevantadas.length - levantadasComGuia;
    const historicoN        = patsMes.filter(p => p.status === 'historico').length;
    const porFunc = {};
    patsLevantadas.forEach(p => {
        const f = p.funcionario || 'Sem funcionário';
        porFunc[f] = (porFunc[f] || 0) + 1;
    });

    return {
        mes: `${ndays}d`,
        totalPats: patsMes.length,
        levantadas: patsLevantadas.length,
        levantadasComGuia, levantadasSemGuia,
        comGuia: levantadasComGuia,
        pendentes: pendentes.length,
        historico: historicoN,
        duracaoMedia,
        totalSaidas: totalSaidasReal,
        saidasPorTipo,
        guiasCount,
        stockZero,
        porFunc,
        top5, topGuias,
        topFerr, topClientes, topFerrDias,
        ts: Date.now(),
    };
}

// Lê últimos N snapshots para sparklines
async function _relFetchHistorico(n, mesKeyActual) {
    const result = { pats: [], saidas: [], duracao: [], guias: [] };
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() + _relMesOffset - i);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        let s = null;
        try { s = await _lerSnapshot(mk); } catch(_e) {}
        result.pats.push(s?.totalPats || 0);
        const sai = s?.totalSaidas ?? (s?.top5 || []).reduce((a, b) => a + (b.qty || 0), 0);
        result.saidas.push(sai || 0);
        result.duracao.push(s?.duracaoMedia || 0);
        result.guias.push(s?.guiasCount || 0);
    }
    return result;
}

// ── Desenhar sparkline SVG com animação de path ───────────────────────────
function _relDrawSparklines(sparkData, snap) {
    const metricMap = {
        pats:    sparkData.pats,
        saidas:  sparkData.saidas,
        duracao: sparkData.duracao,
        guias:   sparkData.guias,
    };
    document.querySelectorAll('.relx-spark-svg').forEach(svg => {
        const metric = svg.dataset.metric;
        const data   = metricMap[metric] || [];
        if (!data.length) return;

        const W = 120, H = 32, P = 2;
        const max = Math.max(...data, 1);
        const min = Math.min(...data, 0);
        const range = max - min || 1;
        const step = (W - P * 2) / Math.max(data.length - 1, 1);

        const pts = data.map((v, i) => {
            const x = P + i * step;
            const y = H - P - ((v - min) / range) * (H - P * 2);
            return [x, y];
        });

        const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
        const dFill = d + ` L ${W - P} ${H - P} L ${P} ${H - P} Z`;

        // Ultimate point highlight
        const last = pts[pts.length - 1];

        svg.innerHTML = `
            <defs>
                <linearGradient id="sg-${metric}" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="#f97316" stop-opacity="0.32"/>
                    <stop offset="100%" stop-color="#f97316" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${dFill}" fill="url(#sg-${metric})" class="relx-spark-area" />
            <path d="${d}" fill="none" stroke="#f97316" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="relx-spark-line" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
            <circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="#f97316" class="relx-spark-dot"/>
        `;
    });
}

// ── Donut (Chart.js) + número animado central ─────────────────────────────
function _relDrawDonut(snap) {
    const canvas = $id('relx-donut');
    if (!canvas || !window.Chart) return;
    if (_relDonutChart) { try { _relDonutChart.destroy(); } catch(_e) {} _relDonutChart = null; }
    const data = [
        Math.max(snap.levantadasSemGuia || 0, 0),
        Math.max(snap.levantadasComGuia || 0, 0),
        Math.max(snap.pendentes         || 0, 0),
        Math.max(snap.historico         || 0, 0),
    ];
    _relDonutChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
            datasets: [{
                data,
                backgroundColor: ['#0f172a', '#f97316', '#f59e0b', '#cbd5e1'],
                borderWidth: 0,
                hoverOffset: 5,
            }]
        },
        options: {
            responsive: false, cutout: '72%',
            animation: { animateRotate: true, duration: 1200, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
        }
    });
    _relAnimCount('relx-donut-num', snap.totalPats || 0, 1100);

    // Taxa de conclusão animação
    const taxaEl = document.querySelector('.relx-conclusao-val[data-target]');
    if (taxaEl) {
        const target = parseInt(taxaEl.dataset.target) || 0;
        _relAnimCountTo(taxaEl, target, 1000, '%');
    }
}

// ── Animar barras ─────────────────────────────────────────────────────────
function _relAnimateBars() {
    // Usa requestAnimationFrame para garantir que o style.width aplica depois do reveal.
    requestAnimationFrame(() => {
        document.querySelectorAll('.relx-bar-fill[data-w]').forEach((bar, i) => {
            setTimeout(() => { bar.style.width = bar.dataset.w + '%'; }, 200 + i * 40);
        });
    });
}

// ── Count up dos KPIs (pega os .relx-kpi-num com data-target) ─────────────
function _relAnimateKPIs() {
    document.querySelectorAll('.relx-kpi-num[data-target]').forEach((el, i) => {
        const target = parseFloat(el.dataset.target) || 0;
        const prefix = el.dataset.prefix || '';
        setTimeout(() => _relAnimCountTo(el, target, 1100, prefix, true), 150 + i * 100);
    });
}

// Variante do _relAnimCount que aceita elemento em vez de id + prefix/suffix
function _relAnimCountTo(el, target, dur = 800, suffix = '', prefixed = false) {
    if (!el) return;
    // prefixed: se true, 'suffix' é na verdade prefixo (para "~")
    const apply = (v) => {
        const n = Math.round(v);
        el.textContent = prefixed ? (suffix + n) : (n + suffix);
    };
    if (target === 0) { apply(0); return; }
    const start = performance.now();
    const step = ts => {
        const p    = Math.min((ts - start) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 4);
        apply(target * ease);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ── Mini-tabs handler ─────────────────────────────────────────────────────
function _relAttachMiniTabs(snap) {
    document.querySelectorAll('.relx-minitabs').forEach(group => {
        const groupId = group.dataset.tabsGroup;
        group.querySelectorAll('.relx-minitab').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.relx-minitab').forEach(b => b.classList.toggle('active', b === btn));
                const block = group.closest('.relx-block');
                const tabId = btn.dataset.tab;
                block.querySelectorAll('[data-panel]').forEach(p => {
                    const match = p.dataset.panel === `${groupId}-${tabId}`;
                    p.classList.toggle('is-hidden', !match);
                    if (match) {
                        // Re-animar barras quando troca tab
                        p.querySelectorAll('.relx-bar-fill[data-w]').forEach(bar => {
                            bar.style.width = '0';
                            requestAnimationFrame(() => {
                                setTimeout(() => bar.style.width = bar.dataset.w + '%', 40);
                            });
                        });
                    }
                });
            });
        });
    });
}

// ── Insights avançados ───────────────────────────────────────────────────
// Gera uma lista de observações automáticas com base no snapshot actual e
// nos 3 snapshots anteriores. Cada item: { level, icon, text }.
// Níveis: 'alert' (laranja) · 'warn' (amarelo) · 'info' (azul) · 'good' (verde)
function _relBuildInsightsAvancados(snap, snapAnt, sparkData, snapAnt2, snapAnt3) {
    const out = [];

    // 1. Ferramenta com muitos dias fora → considerar 2ª unidade
    if (snap.topFerrDias?.length) {
        const top = snap.topFerrDias[0];
        const [y, m] = (snap.mes || _mesKey(0)).split('-').map(Number);
        const diasMes = new Date(y, m, 0).getDate() || 30;
        const pct = Math.round((top.dias / diasMes) * 100);
        if (pct >= 80) {
            out.push({ level: 'warn', icon: '⚠', text: `<b>${escapeHtml(top.nome)}</b> esteve <b>${pct}%</b> do período fora do armazém (${top.dias} dias). Considera adquirir uma segunda unidade.` });
        }
    }

    // 2. Saídas totais disparadas vs média 3 meses
    if (sparkData && sparkData.saidas?.length >= 4) {
        const recentes = sparkData.saidas.slice(-4, -1);
        const avg = recentes.reduce((a, b) => a + b, 0) / Math.max(recentes.length, 1);
        const atual = sparkData.saidas[sparkData.saidas.length - 1];
        if (avg > 0 && atual > avg * 1.5) {
            const pct = Math.round(((atual - avg) / avg) * 100);
            const topRef = snap.top5?.[0];
            const lider = topRef ? ` Líder: <b>${escapeHtml(topRef.codigo)} — ${escapeHtml(topRef.nome || '')}</b>.` : '';
            out.push({ level: 'alert', icon: '▲', text: `Saídas subiram <b>+${pct}%</b> vs média 3 meses.${lider} Vigiar stock.` });
        }
    }

    // 3. PATs pendentes acumuladas
    if (snap.pendentes > 5) {
        out.push({ level: 'info', icon: 'ℹ', text: `<b>${snap.pendentes}</b> PATs ainda pendentes no fim do período. Garante que todas estão atribuídas a um técnico.` });
    }

    // 4. Duração média alta
    if (snap.duracaoMedia != null && snap.duracaoMedia > 10) {
        out.push({ level: 'warn', icon: '⏱', text: `Duração média em <b>${snap.duracaoMedia} dias</b> — acima do recomendado. Verifica pendências em aberto.` });
    }

    // 5. Crescimento guias técnicas vs mês anterior.
    //    5b tem precedência sobre 5 — se cresceu >50% já é alert, e mostrar ambos
    //    seria redundante. Antes eram if/else if com 5 a ganhar sempre (diff>=5
    //    entrava no info e 5b nunca disparava mesmo em casos de crescimento forte).
    if (snapAnt && snap.guiasCount && snapAnt.guiasCount) {
        const diff = snap.guiasCount - snapAnt.guiasCount;
        const cresceuMuito = snapAnt.guiasCount > 0 && snap.guiasCount > snapAnt.guiasCount * 1.5;
        if (cresceuMuito) {
            // 5b — alert de crescimento forte (precedente)
            const pct = Math.round(((snap.guiasCount - snapAnt.guiasCount) / snapAnt.guiasCount) * 100);
            out.push({ level: 'alert', icon: '⚑', text: `Separações para técnicos cresceram <b>+${pct}%</b> vs mês anterior. Sinal de intensificação da actividade no terreno.` });
        } else if (Math.abs(diff) >= 5) {
            // 5 — delta absoluto relevante
            const sinal = diff > 0 ? '+' : '';
            out.push({ level: 'info', icon: '⚑', text: `Guias Técnicos: <b>${sinal}${diff}</b> separações vs mês anterior (${snapAnt.guiasCount} → ${snap.guiasCount}).` });
        }
    }

    // 6. NOVO: Cliente novo no top 3 (não estava no top 3 do mês anterior)
    if (snap.topClientes?.length && snapAnt?.topClientes?.length) {
        const top3Ant = new Set(snapAnt.topClientes.slice(0, 3).map(c => (c.nome || '').trim().toUpperCase()));
        const top3Atual = snap.topClientes.slice(0, 3);
        const novos = top3Atual.filter(c => !top3Ant.has((c.nome || '').trim().toUpperCase()));
        if (novos.length > 0) {
            const nomes = novos.map(c => `<b>${escapeHtml(c.nome)}</b> (${c.total} PATs)`).join(', ');
            out.push({ level: 'good', icon: '★', text: `Cliente${novos.length > 1 ? 's' : ''} novo${novos.length > 1 ? 's' : ''} no top 3: ${nomes}. Potencial para expandir relação.` });
        }
    }

    // 7. NOVO: Ferramenta inactiva — esteve nos últimos 3 meses mas este não
    if (snapAnt && snapAnt2 && snapAnt3) {
        const recentes = [snapAnt, snapAnt2, snapAnt3];
        const aparecia = new Map(); // nome → quantos meses apareceu
        recentes.forEach(s => {
            (s.topFerr || []).forEach(t => {
                aparecia.set(t.nome, (aparecia.get(t.nome) || 0) + 1);
            });
        });
        const atuais = new Set((snap.topFerr || []).map(t => t.nome));
        // Ferramentas que apareceram em ≥2 dos 3 meses anteriores mas NÃO este mês
        const inactivas = [...aparecia.entries()]
            .filter(([nome, count]) => count >= 2 && !atuais.has(nome))
            .map(([nome]) => nome);
        if (inactivas.length > 0) {
            const nomes = inactivas.slice(0, 2).map(n => `<b>${escapeHtml(n)}</b>`).join(', ');
            const extra = inactivas.length > 2 ? ` e mais ${inactivas.length - 2}` : '';
            out.push({ level: 'info', icon: '○', text: `Ferramenta${inactivas.length > 1 ? 's' : ''} sem requisições este período: ${nomes}${extra}. Verifica se está acessível ou se pode ser libertada.` });
        }
    }

    // 8. NOVO: Pico de uma referência específica — top 1 deste período não estava no top 5 há 2 meses
    if (snap.top5?.length && snapAnt?.top5?.length && snapAnt2?.top5?.length) {
        const top1Atual = snap.top5[0];
        const codsAnteriores = new Set([
            ...snapAnt.top5.map(r => (r.codigo || '').toUpperCase()),
            ...snapAnt2.top5.map(r => (r.codigo || '').toUpperCase()),
        ]);
        if (!codsAnteriores.has((top1Atual.codigo || '').toUpperCase())) {
            const unidade = top1Atual.unidade && top1Atual.unidade !== 'un' ? top1Atual.unidade : 'un';
            out.push({ level: 'alert', icon: '✦', text: `Nova referência em 1º lugar: <b>${escapeHtml(top1Atual.codigo)} — ${escapeHtml(top1Atual.nome || '')}</b> (${top1Atual.qty} ${unidade}). Não aparecia no top 5 dos 2 meses anteriores.` });
        }
    }

    // 9. NOVO: Saldo negativo — stock zero a crescer vs mês anterior
    if (snapAnt && typeof snapAnt.stockZero === 'number' && typeof snap.stockZero === 'number') {
        const diff = snap.stockZero - snapAnt.stockZero;
        if (diff >= 3) {
            out.push({ level: 'warn', icon: '◎', text: `Produtos a zero aumentaram em <b>+${diff}</b> (${snapAnt.stockZero} → ${snap.stockZero}). Pode valer a pena uma ronda de encomendas.` });
        }
    }

    // 10. NOVO: Padrão saudável — feedback positivo quando tudo corre bem
    if (out.length === 0 && snap.totalPats > 0) {
        out.push({ level: 'good', icon: '✓', text: `Período estável: sem alertas automáticos. <b>${snap.totalPats}</b> PATs processadas, duração média de <b>${snap.duracaoMedia ?? '—'} dias</b>.` });
    }

    return out;
}

// ── Filtro de range (mes / 30 / 14 / 7) ───────────────────────────────────
let _relRange = 'mes';
function relSetRange(range) {
    _relRange = range;
    document.querySelectorAll('.relx-range-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.range === range);
    });
    renderRelatorio();
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



