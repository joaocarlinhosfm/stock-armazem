// ───────────────────────────────────────
// backup.js — Hiperfrio v6.77
// Cópia de segurança completa (JSON): Administração → Definições → Dados.
// Descarrega TODAS as coleções para um único ficheiro no dispositivo.
// Carrega DEPOIS de stockimport.js.
//
// • Só gestores.
// • As palavras-passe (hashes) NÃO vão para o ficheiro — fica sem dados sensíveis.
// • Se uma coleção falhar, as outras são guardadas na mesma e o aviso fica no ficheiro.
// • Restaurar é manual (o ficheiro tem os dados tal como estão na base de dados).
//
// Dependências: utils.js ($id, showToast, BASE_URL), auth.js (requireManagerAccess, authUrl)
// ───────────────────────────────────────

const _BK_COLLECTIONS = [
    'stock', 'pedidos', 'ferramentas', 'clientes', 'funcionarios', 'guias',
    'encomendas', 'relatorios', 'movimentos', 'dash-snapshots', 'inv-resume',
    'geocode-cache', 'config',
];
const _BK_LAST_KEY = 'hiperfrio-last-backup';   // chave interna (não renomear)

let _bkBusy = false;

function _bkFmtDate(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Mostra a data da última cópia no painel de Definições.
function bkUpdateStatus() {
    const el = $id('backup-status');
    if (!el) return;
    let last = 0;
    try { last = parseInt(localStorage.getItem(_BK_LAST_KEY) || '0', 10) || 0; } catch (_) {}
    if (!last) { el.textContent = 'Ainda não fizeste nenhuma cópia neste dispositivo'; el.style.color = ''; return; }
    const dias = Math.floor((Date.now() - last) / 86400000);
    el.textContent = `Última cópia: ${_bkFmtDate(last)}${dias >= 30 ? ` — há ${dias} dias` : ''}`;
    el.style.color = dias >= 30 ? 'var(--dv-warn, #d97706)' : '';
}

// Conta registos de uma coleção (objeto → nº de chaves; lista → comprimento).
function _bkCount(v) {
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
    return 1;
}

async function _bkFetch(nome) {
    const res = await fetch(await authUrl(`${BASE_URL}/${nome}.json`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

// Retira os hashes das palavras-passe de config/users (devolve nº de hashes retirados).
function _bkStripSecrets(config) {
    let n = 0;
    const users = config && config.users;
    if (users && typeof users === 'object') {
        Object.values(users).forEach(u => {
            if (u && typeof u === 'object' && 'passwordHash' in u) { delete u.passwordHash; n++; }
        });
    }
    return n;
}

async function exportBackupJSON() {
    if (_bkBusy) return;
    if (!requireManagerAccess()) return;
    if (!navigator.onLine) { showToast('Sem ligação — a cópia precisa de internet', 'error'); return; }

    const btn = $id('backup-btn');
    _bkBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'A copiar...'; }

    try {
        const resultados = await Promise.allSettled(_BK_COLLECTIONS.map(_bkFetch));
        const dados = {}, falhas = [], contagem = {};
        let registos = 0;
        _BK_COLLECTIONS.forEach((nome, i) => {
            const r = resultados[i];
            if (r.status === 'fulfilled') {
                dados[nome] = r.value;
                contagem[nome] = _bkCount(r.value);
                registos += contagem[nome];
            } else {
                falhas.push(`${nome}: ${r.reason?.message || 'erro'}`);
            }
        });
        if (!Object.keys(dados).length) throw new Error('nenhuma coleção pôde ser lida');

        const hashes = _bkStripSecrets(dados.config);
        const agora = new Date();
        const ficheiro = {
            app: 'Gestão Armazém',
            tipo: 'copia-de-seguranca',
            criadoEm: agora.toISOString(),
            contagem,
            avisos: [
                ...(hashes ? [`${hashes} hash(es) de palavras-passe omitidos de config/users`] : []),
                ...falhas.map(f => `Coleção não copiada — ${f}`),
            ],
            dados,
        };

        const blob = new Blob([JSON.stringify(ficheiro)], { type: 'application/json;charset=utf-8' });
        const p = n => String(n).padStart(2, '0');
        const nome = `gestao-armazem-backup-${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}.json`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nome;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);

        // Só conta como "última cópia" se estiver completa
        if (!falhas.length) { try { localStorage.setItem(_BK_LAST_KEY, String(Date.now())); } catch (_) {} }
        bkUpdateStatus();
        const kb = blob.size / 1024;
        const tam = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
        showToast(falhas.length
            ? `Cópia INCOMPLETA (${falhas.length} coleção(ões) falharam) — ${tam}`
            : `Cópia guardada: ${registos.toLocaleString('pt-PT')} registos · ${tam}`,
            falhas.length ? 'error' : undefined);
    } catch (e) {
        console.error('[backup]', e);
        showToast('Erro ao fazer a cópia: ' + (e?.message || 'desconhecido'), 'error');
    } finally {
        _bkBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Descarregar'; }
    }
}
