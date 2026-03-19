// NOTA DE SEGURANÇA (#24): a apiKey do Firebase é pública por design.
// A protecção real é feita pelas Firebase Security Rules (exigem Anonymous Auth).
// Confirmar que as rules não permitem leitura/escrita sem token válido.
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";

// ─────────────────────────────────────────────────────────────────────────────
// _calcDias(ts) — dias de calendário decorridos desde um timestamp ou string de data
// Conta 1 dia a partir das 00:00, independentemente de terem passado 24h
// ─────────────────────────────────────────────────────────────────────────────
function _calcDias(tsOrStr) {
    if (!tsOrStr) return 0;
    // Normaliza para meia-noite local do dia de origem
    let origem;
    if (typeof tsOrStr === 'string') {
        // String de data "YYYY-MM-DD" — interpreta em hora local
        const [y, m, d] = tsOrStr.split('-').map(Number);
        origem = new Date(y, m - 1, d);
    } else {
        // Timestamp numérico (ms) — obtém meia-noite local desse dia
        const dt = new Date(tsOrStr);
        origem = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    }
    // Meia-noite local de hoje
    const hoje = new Date();
    const hojeZero = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    return Math.round((hojeZero - origem) / 86400000);
}

// ── Lazy loading de bibliotecas pesadas ──────────────────────────────────────
// Tesseract (~2.5 MB) e XLSX (~1 MB) só são carregados quando realmente usados,
// evitando atrasar o arranque da app em Android com rede lenta.
function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}
let _tesseractLoading = null;
async function loadTesseract() {
    if (typeof Tesseract !== 'undefined') return;
    if (!_tesseractLoading) _tesseractLoading = _loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js');
    await _tesseractLoading;
}
let _xlsxLoading = null;
async function loadXlsx() {
    if (typeof XLSX !== 'undefined') return;
    if (!_xlsxLoading) _xlsxLoading = _loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    await _xlsxLoading;
}

// =============================================
// XSS — escapar sempre dados do utilizador
// =============================================
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================
// FIREBASE AUTH — token anónimo para REST API
// =============================================
let _authToken     = null;
let _authTokenExp  = 0;     // timestamp de expiração (tokens duram 1h)

// Obtém token válido — aguarda Promise do SDK Firebase ou renova se expirado
async function getAuthToken() {
    const now = Date.now();
    // Token em cache ainda válido (margem de 5 min)
    if (_authToken && now < _authTokenExp - 300_000) return _authToken;

    // Aguarda a Promise criada pelo SDK (com timeout de 10s)
    const tokenPromise = window._firebaseTokenPromise
        ? window._firebaseTokenPromise
        : Promise.reject(new Error('Firebase SDK não carregou'));

    _authToken = await Promise.race([
        tokenPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Auth timeout — verifica Anonymous Auth na consola Firebase')), 10_000))
    ]);

    // Se o user está disponível, renova o token (force=true garante token fresco)
    if (window._firebaseUser) {
        try {
            const forceRefreshToken = (_authToken !== null); // força renovação se já tivemos token antes
            _authToken = await window._firebaseUser.getIdToken(forceRefreshToken);
        } catch(_e) { /* usa o token da Promise */ }
    }

    _authTokenExp = now + 3_500_000; // ~58 min
    return _authToken;
}

// Renovação proactiva do token a cada 45 min — protege sessões longas (ponto 1)
let _tokenRenewalTimer = null;
function _scheduleTokenRenewal() {
    clearTimeout(_tokenRenewalTimer);
    _tokenRenewalTimer = setTimeout(async () => {
        if (window._firebaseUser) {
            try {
                _authToken = await window._firebaseUser.getIdToken(true);
                _authTokenExp = Date.now() + 3_500_000;
            } catch(e) { console.warn('[Auth] falha na renovação:', e.message); }
        }
        _scheduleTokenRenewal(); // agenda próxima renovação
    }, 45 * 60 * 1000); // 45 minutos
}

// Adiciona ?auth=TOKEN a um URL da Firebase REST API
async function authUrl(url) {
    try {
        const token = await getAuthToken();
        const sep   = url.includes('?') ? '&' : '?';
        return `${url}${sep}auth=${token}`;
    } catch (e) {
        console.warn('Auth token indisponível:', e.message);
        return url; // offline — a fila offline trata do reenvio quando voltar online
    }
}

// =============================================
// PERFIL — Funcionário vs Gestor
// =============================================
const ROLE_KEY    = 'hiperfrio-role';   // 'worker' | 'manager'
let   currentRole = null;               // definido no arranque

// Aplica o perfil à UI — chamado uma vez no boot
function applyRole(role) {
    currentRole = role;
    document.body.classList.toggle('worker-mode', role === 'worker');

    // Badge no header — inserido dentro de .header-titles para não quebrar o flex layout
    let badge = document.getElementById('role-badge');
    if (!badge) {
        badge = document.createElement('button');
        badge.id      = 'role-badge';
        badge.onclick = () => openSwitchRoleModal();
        document.querySelector('.header-titles')?.appendChild(badge);
    }
    const savedUser = localStorage.getItem('hiperfrio-username') || '';
    const displayName = savedUser || (role === 'worker' ? 'Funcionário' : 'Gestor');
    if (role === 'worker') {
        badge.textContent = `${displayName} ▾`;
        badge.className   = 'role-badge-worker';
    } else {
        badge.textContent = `${displayName} ▾`;
        badge.className   = 'role-badge-manager';
    }

    // Esconde o ecrã de seleção
    document.getElementById('role-screen')?.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────
// SISTEMA DE LOGIN POR USERNAME + PASSWORD
// ──────────────────────────────────────────────────────────
const USERS_URL = `${BASE_URL}/config/users.json`;
const USER_KEY  = 'hiperfrio-username';

// Hash SHA-256 da password (com salt diferente do PIN)
// hashPassword — salt inclui o username para que o mesmo password gere hashes
// diferentes por utilizador, dificultando rainbow table attacks em massa.
// O salt fixo mantém-se por retrocompatibilidade com hashes já criados.
async function hashPassword(password, username = '') {
    const saltedInput = password + 'hiperfrio-pw-salt' + username.toLowerCase();
    const data    = new TextEncoder().encode(saltedInput);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Carrega lista de utilizadores da Firebase
// Gera um verificador offline derivado da password — nunca guarda dados Firebase localmente.
// salt diferente do Firebase para que compromisso local não dê acesso ao servidor.
const _OFFLINE_SALT = 'hiperfrio-offline-v2';
async function _offlineVerifier(username, password) {
    const raw = new TextEncoder().encode(username + ':' + password + ':' + _OFFLINE_SALT);
    const buf = await crypto.subtle.digest('SHA-256', raw);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadUsers() {
    // 1) Garante token Firebase
    try {
        await getAuthToken();
    } catch(e) {
        console.warn('[Login] sem token Firebase:', e.message);
    }

    // 2) Pedido à Firebase
    try {
        const url = await authUrl(USERS_URL);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && !data.error) {
            // Não guardar dados Firebase localmente — apenas marca timestamp de sucesso
            localStorage.setItem('hiperfrio-last-online', Date.now().toString());
            return data;
        }
        throw new Error(data?.error || 'resposta inválida');
    } catch (e) {
        console.warn('[Login] servidor inacessível — tenta sessão offline');
        return null; // null = offline, {} = sem utilizadores
    }
}

// Floating label — adiciona/remove classe has-value consoante o input tem conteúdo
function lsFieldUpdate(input, fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    if (input.value.length > 0) {
        field.classList.add('has-value');
    } else {
        field.classList.remove('has-value');
    }
}

// Toggle mostrar/esconder password
function toggleLoginPassword() {
    const inp  = document.getElementById('ls-password');
    const icon = document.getElementById('ls-eye-icon');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
        ? '<path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd"/><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z"/>'
        : '<path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/>';
}

// Handler do formulário de login
async function handleLogin(e) {
    if (e) e.preventDefault();

    const errEl  = document.getElementById('ls-error');
    const btn    = document.getElementById('ls-submit-btn');
    const btnText= document.getElementById('ls-btn-text');
    const spinner= document.getElementById('ls-spinner');

    const showError = (msg) => {
        if (!errEl) return;
        errEl.textContent = msg;
        if (msg) errEl.classList.add('visible');
        else     errEl.classList.remove('visible');
    };

    const username = (document.getElementById('ls-username')?.value || '').trim().toLowerCase();
    const password =  document.getElementById('ls-password')?.value || '';

    if (!username || !password) { showError('Preenche o utilizador e a password.'); return; }

    showError('');
    if (btn)     btn.disabled = true;
    if (btnText) btnText.textContent = 'A verificar...';
    if (spinner) spinner.classList.remove('hidden');

    try {
        const users = await loadUsers();

        if (users === null) {
            // Offline — tentar autenticação com sessão local guardada de forma segura
            const sessionRaw = localStorage.getItem('hiperfrio-session');
            if (!sessionRaw) {
                showError('Sem ligação ao servidor. Liga-te à internet para autenticares pela primeira vez.');
                return;
            }
            try {
                const session  = JSON.parse(sessionRaw);
                const TTL_24H  = 24 * 60 * 60 * 1000;
                const verifier = await _offlineVerifier(username, password);
                if (session.username === username && session.verifier === verifier
                    && Date.now() - session.ts < TTL_24H) {
                    // Sessão offline válida
                    const role = session.role || 'worker';
                    localStorage.setItem(ROLE_KEY, role);
                    localStorage.setItem(USER_KEY, username);
                    applyRole(role);
                    bootApp();
                    return;
                }
            } catch (_e) { /* sessão corrompida */ }
            showError('Sem ligação. Só o último utilizador autenticado pode entrar offline.');
            return;
        }

        if (!users || !Object.keys(users).length) {
            showError('Não foi possível contactar o servidor. Verifica a ligação.');
            return;
        }

        const userObj = users[username];
        if (!userObj) {
            showError('Utilizador não encontrado.');
            return;
        }

        const pwHash = await hashPassword(password, username);
        // Retrocompatibilidade: testa também o hash antigo (sem username no salt)
        const pwHashLegacy = await hashPassword(password);
        if (pwHash !== userObj.passwordHash && pwHashLegacy !== userObj.passwordHash) {
            showError('Password incorrecta.');
            return;
        }
        // Se autenticou com hash legacy, migrar silenciosamente para o novo hash
        if (pwHashLegacy === userObj.passwordHash && pwHash !== userObj.passwordHash) {
            const migrUrl = await authUrl(`${USERS_BASE_URL}/${username}.json`);
            fetch(migrUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passwordHash: pwHash }) }).catch(() => {});
        }

        // Login bem sucedido — guardar sessão offline segura (só verifier, nunca dados Firebase)
        const role = userObj.role || 'worker';
        const verifier = await _offlineVerifier(username, password);
        localStorage.setItem('hiperfrio-session', JSON.stringify({ username, role, verifier, ts: Date.now() }));
        // Limpar qualquer cache antiga com dados sensíveis
        localStorage.removeItem('hiperfrio-users-cache');
        localStorage.setItem(ROLE_KEY, role);
        localStorage.setItem(USER_KEY, username);

        showError('');
        const card = document.querySelector('.ls-card');
        if (card) {
            card.style.transition = 'opacity 0.3s, transform 0.3s';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.96) translateY(-10px)';
        }
        await new Promise(r => setTimeout(r, 280));

        applyRole(role);
        bootApp();

    } catch (err) {
        showError('Erro de ligação. Tenta novamente.');
        console.error('[Login] erro:', err);
    } finally {
        if (btn)     btn.disabled = false;
        if (btnText) btnText.textContent = 'Entrar';
        if (spinner) spinner.classList.add('hidden');
    }
}

// ──────────────────────────────────────────────────────────
// GESTÃO DE UTILIZADORES (Admin → tab Utilizadores)
// ──────────────────────────────────────────────────────────
const USERS_BASE_URL = `${BASE_URL}/config/users`;

async function createUser() {
    const nameRaw  = document.getElementById('new-user-name')?.value.trim().toLowerCase();
    const role     = document.getElementById('new-user-role')?.value;
    const password = document.getElementById('new-user-pass')?.value;

    if (!nameRaw)    { showToast('Indica o nome de utilizador', 'error'); return; }
    if (!password || password.length < 4) { showToast('Password deve ter pelo menos 4 caracteres', 'error'); return; }
    // Só letras, números, ponto e underscore
    if (!/^[a-z0-9._]+$/.test(nameRaw)) { showToast('Nome só pode ter letras, números, ponto e _', 'error'); return; }

    const pwHash = await hashPassword(password, nameRaw);
    const url    = await authUrl(`${USERS_BASE_URL}/${nameRaw}.json`);

    try {
        // Verifica se já existe — só considera existente se HTTP 200 e valor não-null
        const checkRes = await fetch(url);
        if (checkRes.ok) {
            const existing = await checkRes.json();
            if (existing !== null && !existing.error) {
                showToast('Utilizador já existe', 'error'); return;
            }
        }

        const saveRes = await fetch(url, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ role, passwordHash: pwHash, createdAt: Date.now() })
        });
        if (!saveRes.ok) {
            const err = await saveRes.json().catch(() => ({}));
            showToast('Erro ao guardar: ' + (err.error || saveRes.status), 'error');
            return;
        }

        // Invalida cache
        localStorage.removeItem('hiperfrio-users-cache');
    localStorage.removeItem('hiperfrio-session');
        document.getElementById('new-user-name').value = '';
        document.getElementById('new-user-pass').value = '';
        showToast(`Utilizador "${nameRaw}" criado`);
        renderUsersList();
    } catch (e) {
        showToast('Erro de ligação: ' + (e.message || e), 'error');
    }
}

async function renderUsersList() {
    const el = document.getElementById('users-list');
    if (!el) return;
    el.innerHTML = '<div class="empty-msg">A carregar...</div>';

    try {
        const res   = await fetch(await authUrl(USERS_URL));
        const users = await res.json() || {};

        if (!Object.keys(users).length) {
            el.innerHTML = '<div class="empty-msg">Nenhum utilizador criado ainda.</div>';
            return;
        }

        el.innerHTML = Object.entries(users).map(([name, u]) => {
            const safeName = escapeHtml(name);
            return `
            <div class="admin-list-row" style="gap:10px;">
                <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
                    <span style="font-size:1.3rem">${u.role === 'manager' ? 'G' : 'F'}</span>
                    <div style="min-width:0;">
                        <div style="font-weight:700;font-size:0.9rem;color:var(--text-main)">${safeName}</div>
                        <div style="font-size:0.72rem;color:var(--text-muted)">${u.role === 'manager' ? 'Gestor' : 'Funcionário'}</div>
                    </div>
                </div>
                <button class="btn-danger-sm" onclick="deleteUser('${safeName}')">🗑</button>
            </div>
        `}).join('');
    } catch (e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar utilizadores.</div>';
    }
}

async function deleteUser(username) {
    const currentUser = localStorage.getItem('hiperfrio-username') || '';
    if (username === currentUser) {
        showToast('Não podes eliminar a tua própria conta', 'error');
        return;
    }
    if (!confirm(`Eliminar utilizador "${username}"?`)) return;
    const url = await authUrl(`${USERS_BASE_URL}/${username}.json`);
    await fetch(url, { method: 'DELETE' });
    localStorage.removeItem('hiperfrio-users-cache');
    localStorage.removeItem('hiperfrio-session');
    showToast(`Utilizador "${username}" eliminado`);
    renderUsersList();
}

// Trocar de perfil — sem reload para ser mais rápido
function switchRole() {
    closeSwitchRoleModal();
    localStorage.removeItem(ROLE_KEY);
    currentRole = null;
    // Remove badge
    document.getElementById('role-badge')?.remove();
    // Repõe body classes
    document.body.classList.remove('worker-mode');
    // Invalida cache em memória
    Object.keys(cache).forEach(k => { cache[k].data = null; cache[k].lastFetch = 0; });
    // Para renovação de token
    clearTimeout(_tokenRenewalTimer);
    // Limpa username
    localStorage.removeItem('hiperfrio-username');
    localStorage.removeItem('hiperfrio-users-cache');
    localStorage.removeItem('hiperfrio-session');
    // Limpa campos do login
    const u = document.getElementById('ls-username'); if (u) u.value = '';
    const p = document.getElementById('ls-password'); if (p) p.value = '';
    const e = document.getElementById('ls-error'); if (e) e.classList.remove('visible');
    // Mostra ecrã de login
    const rs = document.getElementById('role-screen');
    if (rs) { rs.style.opacity='0'; rs.style.transition='opacity 0s'; rs.classList.remove('hidden'); requestAnimationFrame(() => { rs.style.transition='opacity 0.3s'; rs.style.opacity='1'; }); }
    // Esconde todas as vistas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // Reset nav activo
    document.querySelectorAll('.menu-items li, .bottom-nav-item').forEach(b => b.classList.remove('active'));
    // Volta ao dashboard ao próximo login
    document.getElementById('view-dashboard')?.classList.add('active');
    document.getElementById('nav-dashboard')?.classList.add('active');
}

function openSwitchRoleModal() {
    document.getElementById('switch-role-modal')?.classList.add('active');
    focusModal('switch-role-modal');
}
function closeSwitchRoleModal() {
    document.getElementById('switch-role-modal')?.classList.remove('active');
}

function checkAdminAccess() {
    if (currentRole === 'manager') return true;
    showToast('Acesso reservado a gestores', 'error');
    return false;
}

// Inicializa a app após o perfil estar definido
async function bootApp() {
    // Garante token válido antes de qualquer fetch — crítico após login
    try {
        await getAuthToken();
    } catch(_e) {
        console.warn('bootApp: sem token, continua offline');
    }
    _scheduleTokenRenewal();
    // Lança fetches em paralelo após ter token
    await Promise.all([
        renderList(),
        fetchCollection('ferramentas'),
        fetchCollection('funcionarios'),
        _fetchClientes(),
    ]).catch(e => console.warn('bootApp fetch error:', e));
    updateOfflineBanner();
    // Navega para o dashboard como vista inicial
    nav('view-dashboard');
}

// =============================================
// =============================================
// CACHE EM MEMÓRIA — TTL 60s
// =============================================
const CACHE_TTL = 300_000; // 5 min — stock de armazém não muda por segundo
const cache = {
    stock:        { data: null, lastFetch: 0 },
    ferramentas:  { data: null, lastFetch: 0 },
    funcionarios: { data: null, lastFetch: 0 },
};

const _fetchPending = {};

async function fetchCollection(name, force = false) {
    const entry   = cache[name];
    const isStale = (Date.now() - entry.lastFetch) > CACHE_TTL;
    if (!force && !isStale && entry.data !== null) return entry.data;
    if (_fetchPending[name]) return _fetchPending[name];
    _fetchPending[name] = (async () => {
        try {
            const url = await authUrl(`${BASE_URL}/${name}.json`);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data    = await res.json();
            entry.data      = data || {};
            entry.lastFetch = Date.now();
            return entry.data;
        } catch (e) {
            console.error(`Erro ao buscar ${name}:`, e);
            showToast('Erro ao carregar dados', 'error');
            return entry.data || {};
        } finally {
            delete _fetchPending[name];
        }
    })();
    return _fetchPending[name];
}

function invalidateCache(name) { cache[name].lastFetch = 0; }

// =============================================
// FILA OFFLINE — localStorage persistente
// =============================================
const QUEUE_KEY = 'hiperfrio-offline-queue';
let isSyncing   = false; // FIX: evita execuções paralelas de syncQueue

function queueLoad() {
    try {
        const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return _pruneQueue(raw); // PONTO 10: remove entradas expiradas
    }
    catch { return []; }
}
function queueSave(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

// PONTO 10: remove operações com mais de 7 dias da fila
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function _pruneQueue(q) {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    return q.filter(op => !op.ts || op.ts > cutoff);
}

function queueAdd(op) {
    // Regista Background Sync ao adicionar à fila
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => sw.sync.register('hiperfrio-sync')).catch(() => {});
    }
    // FIX: só aceita mutações na fila, nunca GETs
    if (!op.method || op.method === 'GET') return;
    op.ts = Date.now(); // timestamp para TTL
    const q = _pruneQueue(queueLoad());
    // Colapsar PATCHes repetidos ao mesmo URL
    if (op.method === 'PATCH') {
        const idx = q.findIndex(o => o.method === 'PATCH' && o.url === op.url);
        if (idx !== -1) { q[idx] = op; } else { q.push(op); }
    } else {
        // FIX: ignorar operações em IDs temporários (_tmp_) para não enviar URLs inválidos
        if (op.url && op.url.includes('/_tmp_')) return;
        q.push(op);
    }
    queueSave(q);
    updateOfflineBanner();
}

async function syncQueue() {
    if (isSyncing) return; // FIX: protecção contra execuções paralelas
    const q = queueLoad();
    if (q.length === 0) return;
    isSyncing = true;
    const failed = [];
    for (const op of q) {
        try {
            const opts = { method: op.method, headers: { 'Content-Type': 'application/json' } };
            if (op.body) opts.body = op.body;
            const signedUrl = await authUrl(op.url);
            const res = await fetch(signedUrl, opts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch(_e) { failed.push(op); }
    }
    queueSave(failed);
    isSyncing = false;
    updateOfflineBanner();
    if (failed.length < q.length) {
        const synced = q.length - failed.length;
        showToast(`${synced} alteração(ões) sincronizada(s)`);
        // Invalida cache e refresca para limpar _tmp_ IDs
        invalidateCache('stock');
        invalidateCache('ferramentas');
        invalidateCache('funcionarios');
        renderList(window._searchInputEl?.value || '', true);
    }
}

// Wrapper fetch — se offline, coloca na fila
async function apiFetch(url, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (!navigator.onLine) {
        queueAdd({ method: opts.method || 'GET', url, body: opts.body || null });
        return null;
    }
    const signedUrl = await authUrl(url);
    const res = await fetch(signedUrl, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
}

function updateOfflineBanner() {
    const isOffline = !navigator.onLine;
    document.body.classList.toggle('is-offline', isOffline);
    const q       = queueLoad();
    const countEl = document.getElementById('offline-pending-count');
    if (countEl) {
        countEl.textContent   = q.length > 0 ? `${q.length} alteração(ões) pendente(s)` : '';
        countEl.style.display = q.length > 0 ? 'inline' : 'none';
    }
}

// =============================================
// UI HELPERS
// =============================================
function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t    = document.createElement('div');
    t.className = 'toast';
    if (type === 'error') t.style.borderLeftColor = 'var(--danger)';
    const icon = document.createElement('span');
    icon.textContent = type === 'success' ? '✅' : '✗';
    const text = document.createElement('span');
    text.textContent = msg;
    t.appendChild(icon);
    t.appendChild(text);
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function setRefreshSpinning(s) { document.getElementById('btn-refresh')?.classList.toggle('spinning', s); }

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay')?.classList.toggle('active');
}

// ── Avatar dropdown (header) ──────────────────────────────
function toggleAvatarMenu() {
    const dd = document.getElementById('avatar-dropdown');
    if (!dd) return;
    const isOpen = dd.classList.contains('open');
    isOpen ? closeAvatarMenu() : dd.classList.add('open');
}
function closeAvatarMenu() {
    document.getElementById('avatar-dropdown')?.classList.remove('open');
}
// Fecha ao clicar fora
document.addEventListener('click', function(e) {
    const wrap = document.getElementById('header-avatar-wrap');
    if (wrap && !wrap.contains(e.target)) closeAvatarMenu();
});

// =============================================
// NAVEGAÇÃO
// FIX: active state só actualizado após acesso confirmado
// =============================================
// ARQUITECTURA (#18): esta função gere routing + side-effects.
// Para refactor futuro: separar em _activateView(id) e callbacks por vista.
function nav(viewId) {
    if (viewId === 'view-admin' && !checkAdminAccess()) return;

    // Actualiza título do header
    const pageTitles = {
        'view-dashboard': 'Dashboard',
        'view-search':    'Stock',
        'view-pedidos':   'Pedidos PAT',
        'view-admin':     'Administração',
        'view-tools':     'Ferramentas',
        'view-register':  'Novo Artigo',
        'view-bulk':      'Entrada de Lote',
        'view-encomendas':'Encomendas',
    };
    const titleEl = document.getElementById('header-page-title');
    if (titleEl && pageTitles[viewId]) titleEl.textContent = pageTitles[viewId];

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');

    if (viewId === 'view-search') {
        renderList().then(() => {
            if (_zeroFilterActive) filterZeroStock();
            if (_pendingZeroFilter) { _pendingZeroFilter = false; filterZeroStock(); }
        });
        // Reset barra de pesquisa ao navegar para o stock
        document.querySelector('.search-container')?.classList.remove('search-scrolled-away');
        document.getElementById('search-peek-btn')?.classList.remove('visible');
    }
    if (viewId === 'view-register') { // PONTO 19: limpa form ao navegar
        const fa = document.getElementById('form-add');
        if (fa) { fa.reset(); setUnitSelector('inp','un'); document.getElementById('inp-notas').value = ''; }
    }
    if (viewId === 'view-bulk') {
        _bulkCount = 0; _updateBulkCounter();
        _refreshZoneDatalist(); // PONTO 16
        // PONTO 4: limpa zona se vazia para evitar confusão com lote anterior persistido pelo browser
        const bulkLoc = document.getElementById('bulk-loc');
        if (bulkLoc && !bulkLoc.value.trim()) bulkLoc.value = '';
    }
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-dashboard') { renderDashboard(true); }
    if (viewId === 'view-encomendas') { loadEncomendas(); }

    // Botão refresh — só visível no dashboard
    const refreshBtn = document.getElementById('btn-dash-refresh');
    if (refreshBtn) refreshBtn.style.display = viewId === 'view-dashboard' ? 'flex' : 'none';
    if (viewId === 'view-admin') {
        if (window.innerWidth < 768) {
            _buildAdminMobileMenu();
            document.querySelector('.admin-tabs')?.style && (document.querySelector('.admin-tabs').style.display = 'none');
            document.getElementById('admin-slider-wrap') && (document.getElementById('admin-slider-wrap').style.display = 'none');
        } else {
            document.getElementById('admin-mobile-menu')?.remove();
            document.getElementById('admin-mobile-detail')?.remove();
            renderWorkers(); renderAdminTools();
        }
    }
    if (viewId === 'view-pedidos') {
        // Limpa pesquisa ao entrar na vista para não confundir ao voltar
        _patSearchQuery = '';
        const searchEl = document.getElementById('pat-search');
        if (searchEl) searchEl.value = '';
        renderPats();
    }
    if (viewId === 'view-admin') { switchAdminTab(ADMIN_TABS[_adminIdx], false); }

    document.querySelectorAll('.menu-items li').forEach(li => li.classList.remove('active'));
    const sideMap = {
        'view-dashboard':'nav-dashboard',
        'view-pedidos':'nav-pedidos',
        'view-search':'nav-search','view-tools':'nav-tools','view-register':'nav-register',
        'view-bulk':'nav-bulk','view-admin':'nav-admin','view-encomendas':'nav-encomendas'
    };
    document.getElementById(sideMap[viewId])?.classList.add('active');

    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    const bnavMap = {
        'view-dashboard':'bnav-dashboard',
        'view-search':'bnav-search',
        'view-pedidos':'bnav-pedidos',
        'view-encomendas':'bnav-encomendas'
    };
    document.getElementById(bnavMap[viewId])?.classList.add('active');

    if (document.getElementById('side-menu')?.classList.contains('open')) toggleMenu();
    window.scrollTo(0, 0);
    bnavAddClose(); // fecha o mini-menu ao navegar
    // Re-setup swipe ao entrar na admin (slider pode ter sido re-renderizado)
    if (viewId === 'view-admin') { switchAdminTab(ADMIN_TABS[_adminIdx], false); }
    // Garante que o bottom nav pill está visível ao mudar de vista
    document.getElementById('bottom-nav')?.classList.remove('bnav-hidden');
    if (window.innerWidth < 768) {
        const fab = document.getElementById('fab-add');
        if (fab) fab.style.display = viewId === 'view-search' ? '' : 'none';
    }
}

// =============================================
// DASHBOARD — resumo no topo do stock
// =============================================
// PONTO 17: snapshot diário para tendência no dashboard
const DASH_SNAPSHOT_KEY = 'hiperfrio-dash-snap';
function _saveDashSnapshot(total, semStock, alocadas) {
    const today = new Date().toISOString().slice(0,10);
    const snap  = JSON.parse(localStorage.getItem(DASH_SNAPSHOT_KEY) || '{}');
    if (snap.date !== today) {
        snap.prev = snap.curr || null;
        snap.curr = { date: today, total, semStock, alocadas };
        snap.date = today;
        localStorage.setItem(DASH_SNAPSHOT_KEY, JSON.stringify(snap));
    }
}
function _getDashTrend(field, currentVal) {
    try {
        const snap = JSON.parse(localStorage.getItem(DASH_SNAPSHOT_KEY) || '{}');
        if (!snap.prev) return null;
        const diff = currentVal - snap.prev[field];
        if (diff === 0) return null;
        return diff;
    } catch(_e) { return null; }
}

async function renderDashboard(force = false) {
    const el = document.getElementById('dashboard');
    if (!el) return;

    const refreshBtn = document.getElementById('btn-dash-refresh');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    el.innerHTML = '';
    el.className = 'dashboard-v2';

    const ts = Date.now();
    const [stockData, ferrData] = await Promise.all([
        fetchCollection('stock', force || ts > cache.stock.lastFetch + 60000),
        fetchCollection('ferramentas', force || ts > cache.ferramentas.lastFetch + 60000),
        _fetchPats(force || !_patCache.data),
    ]);

    const stockEntries    = Object.values(stockData || {});
    const ferraEntries    = Object.values(ferrData  || {});
    const total           = stockEntries.length;
    const semStock        = stockEntries.filter(i => (i.quantidade || 0) === 0).length;
    const comStock        = total - semStock;
    const alocadas        = ferraEntries.filter(t => t.status === 'alocada').length;
    const totalFerr       = ferraEntries.length;
    const patPendentes    = _getPatPendingCount();
    const ALERTA_DIAS     = 7;
    const alocadasHaMuito = ferraEntries.filter(t =>
        t.status === 'alocada' && t.dataEntrega &&
        _calcDias(t.dataEntrega) > ALERTA_DIAS
    );
    _saveDashSnapshot(total, semStock, alocadas);

    // ── helper: cria um metric card ──────────────────────────────────────────
    function _metricCard({ label, value, sub, accent, icon, warn, alert, onClick, progress, stats }) {
        const card = document.createElement('div');
        card.className = 'dv2-card' + (warn ? ' dv2-card--warn' : '') + (alert ? ' dv2-card--alert' : '');
        card.style.setProperty('--card-accent', accent || 'var(--primary)');
        if (onClick) { card.style.cursor = 'pointer'; card.onclick = onClick; }

        const top = document.createElement('div');
        top.className = 'dv2-card-top';

        const labelEl = document.createElement('span');
        labelEl.className   = 'dv2-card-label';
        labelEl.textContent = label;

        const iconEl = document.createElement('span');
        iconEl.className = 'dv2-card-icon';
        const _dashIcons = {
            box:   '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4z"/><path fill-rule="evenodd" d="M3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>',
            list:  '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/></svg>',
            check: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
            clock: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>',
            doc:   '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>',
        };
        iconEl.innerHTML = _dashIcons[icon] || icon;

        top.appendChild(labelEl);
        top.appendChild(iconEl);

        const valEl = document.createElement('div');
        valEl.className   = 'dv2-card-value';
        valEl.textContent = value;

        // trend dia anterior
        const trend = _getDashTrend(label === 'Produtos' ? 'total' : label === 'Sem stock' ? 'semStock' : label === 'Ferramentas' ? 'alocadas' : null, typeof value === 'number' ? value : null);
        if (trend !== null && trend !== undefined) {
            const tr = document.createElement('span');
            // Para stock: mais produtos = bom (verde); para sem-stock: mais = mau (vermelho)
            const isGood = label === 'Sem stock' ? trend < 0 : trend > 0;
            tr.className   = 'dv2-trend ' + (isGood ? 'dv2-trend--good' : 'dv2-trend--bad');
            tr.textContent = (trend > 0 ? '+' : '') + trend;
            valEl.appendChild(tr);
        }

        card.appendChild(top);
        card.appendChild(valEl);

        // barra de progresso opcional
        if (progress !== undefined && progress !== null) {
            const barWrap = document.createElement('div');
            barWrap.className = 'dv2-progress';
            const barFill = document.createElement('div');
            barFill.className = 'dv2-progress-fill';
            barFill.style.width = Math.min(100, Math.round(progress * 100)) + '%';
            barWrap.appendChild(barFill);
            card.appendChild(barWrap);
        }

        // stats individuais
        if (stats && stats.length > 0) {
            const statsEl = document.createElement('div');
            statsEl.className = 'dv2-stats';
            stats.forEach(s => {
                const pill = document.createElement('span');
                pill.className = 'dv2-stat-pill';
                pill.innerHTML = `<span class="dv2-stat-val" style="color:${s.color}">${escapeHtml(String(s.value))}</span><span class="dv2-stat-lbl">${escapeHtml(s.label)}</span>`;
                statsEl.appendChild(pill);
            });
            card.appendChild(statsEl);
        }

        return card;
    }

    // ── GRID 2×2 ─────────────────────────────────────────────────────────────
    const grid = document.createElement('div');
    grid.className = 'dv2-grid';

    grid.appendChild(_metricCard({
        label: 'Produtos', value: total, icon: 'box',
        sub: `${comStock} com stock · ${semStock} esgotados`,
        accent: '#2563eb',
        progress: total > 0 ? comStock / total : 1,
        onClick: () => nav('view-search'),
        stats: [
            { label: 'Com stock', value: comStock, color: '#16a34a' },
            { label: 'Esgotados', value: semStock, color: semStock > 0 ? '#dc2626' : '#16a34a' },
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'Sem stock', value: semStock, icon: semStock > 0 ? '' : '✅',
        sub: semStock > 0 ? `${Math.round(semStock/total*100)}% do inventário` : 'Tudo com stock',
        accent: semStock > 0 ? '#dc2626' : '#16a34a',
        warn: semStock > 0,
        progress: total > 0 ? semStock / total : 0,
        onClick: semStock > 0 ? () => { _pendingZeroFilter = true; nav('view-search'); } : null,
        stats: semStock > 0 ? [
            { label: '% inventário', value: Math.round(semStock/total*100) + '%', color: '#dc2626' },
        ] : [
            { label: 'Total produtos', value: total, color: '#16a34a' },
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'Ferramentas', value: `${alocadas}/${totalFerr}`, icon: '',
        sub: alocadasHaMuito.length > 0
            ? `! ${alocadasHaMuito.length} há +${ALERTA_DIAS}d`
            : alocadas === 0 ? 'Todas em armazém' : `${totalFerr - alocadas} em armazém`,
        accent: alocadasHaMuito.length > 0 ? '#f59e0b' : '#2563eb',
        warn: alocadasHaMuito.length > 0,
        progress: totalFerr > 0 ? alocadas / totalFerr : 0,
        onClick: () => nav('view-tools'),
        stats: [
            { label: 'Em armazém', value: totalFerr - alocadas, color: '#16a34a' },
            { label: 'Alocadas', value: alocadas, color: alocadas > 0 ? '#f59e0b' : '#64748b' },
            ...(alocadasHaMuito.length > 0 ? [{ label: `+${ALERTA_DIAS}d fora`, value: alocadasHaMuito.length, color: '#dc2626' }] : []),
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'PATs', value: patPendentes, icon: '≡',
        sub: patPendentes === 0 ? 'Sem pendentes' : patPendentes === 1 ? '1 pedido pendente' : `${patPendentes} pedidos pendentes`,
        accent: patPendentes > 0 ? '#7c3aed' : '#16a34a',
        onClick: () => nav('view-pedidos'),
        stats: (() => {
            try {
                const pats     = Object.values(_patCache.data || {});
                const urgentes = pats.filter(p => p.status !== 'levantado' && p.criadoEm && _calcDias(p.criadoEm) > 15).length;
                const hoje     = pats.filter(p => p.status !== 'levantado' && p.criadoEm && _calcDias(p.criadoEm) === 0).length;
                const result   = [{ label: 'Pendentes', value: patPendentes, color: patPendentes > 0 ? '#7c3aed' : '#64748b' }];
                if (urgentes > 0) result.push({ label: '+15 dias', value: urgentes, color: '#dc2626' });
                if (hoje > 0)     result.push({ label: 'Hoje', value: hoje, color: '#16a34a' });
                return result;
            } catch(_e) {
                return [{ label: 'Pendentes', value: patPendentes, color: patPendentes > 0 ? '#7c3aed' : '#64748b' }];
            }
        })(),
    }));

    el.appendChild(grid);

    // ── SECÇÃO: Últimas PATs ─────────────────────────────────────────────────
    const patEntries = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status !== 'levantado')
        .sort((a, b) => (b[1].criadoEm || 0) - (a[1].criadoEm || 0))
        .slice(0, 4);

    if (patEntries.length > 0) {
        const sec = document.createElement('div');
        sec.className = 'dv2-section';

        const hdr = document.createElement('div');
        hdr.className = 'dv2-section-hdr';
        const hdrTitle = document.createElement('span');
        hdrTitle.textContent = 'Últimas PATs';
        const hdrLink = document.createElement('button');
        hdrLink.className   = 'dv2-section-link';
        hdrLink.textContent = 'Ver todas →';
        hdrLink.onclick     = () => nav('view-pedidos');
        hdr.appendChild(hdrTitle);
        hdr.appendChild(hdrLink);
        sec.appendChild(hdr);

        const list = document.createElement('div');
        list.className = 'dv2-pat-list';

        patEntries.forEach(([id, pat]) => {
            const dias = _calcDias(pat.criadoEm);
            const urgente = dias >= 15;
            const row = document.createElement('div');
            row.className = 'dv2-pat-row' + (urgente ? ' dv2-pat-row--urgente' : '');
            row.onclick = () => openPatDetail(id, pat);

            const left = document.createElement('div');
            left.className = 'dv2-pat-left';

            const num = document.createElement('span');
            num.className   = 'dv2-pat-num';
            num.textContent = `PAT ${escapeHtml(pat.numero || '—')}`;

            const estab = document.createElement('span');
            estab.className   = 'dv2-pat-estab';
            estab.textContent = pat.estabelecimento || 'Sem estabelecimento';

            left.appendChild(num);
            left.appendChild(estab);

            const right = document.createElement('span');
            right.className   = 'dv2-pat-age' + (urgente ? ' dv2-pat-age--urgente' : '');
            right.textContent = dias === 0 ? 'Hoje' : dias === 1 ? '1d' : `${dias}d`;

            row.appendChild(left);
            row.appendChild(right);
            list.appendChild(row);
        });

        sec.appendChild(list);
        el.appendChild(sec);
    }

    // ── SECÇÃO: Ferramentas por colaborador ──────────────────────────────────
    const alocadasList = ferraEntries
        .filter(t => t.status === 'alocada' && t.colaborador)
        .sort((a, b) => (a.colaborador || '').localeCompare(b.colaborador || '', 'pt'));

    if (alocadasList.length > 0) {
        const sec2 = document.createElement('div');
        sec2.className = 'dv2-section';

        const hdr2 = document.createElement('div');
        hdr2.className = 'dv2-section-hdr';
        const hdr2Title = document.createElement('span');
        hdr2Title.textContent = 'Ferramentas em uso';
        const hdr2Link = document.createElement('button');
        hdr2Link.className   = 'dv2-section-link';
        hdr2Link.textContent = 'Painel →';
        hdr2Link.onclick     = () => nav('view-tools');
        hdr2.appendChild(hdr2Title);
        hdr2.appendChild(hdr2Link);
        sec2.appendChild(hdr2);

        const list2 = document.createElement('div');
        list2.className = 'dv2-ferr-list';

        // Agrupa por colaborador
        const porColab = {};
        alocadasList.forEach(t => {
            const c = t.colaborador;
            if (!porColab[c]) porColab[c] = [];
            porColab[c].push(t);
        });

        Object.entries(porColab).forEach(([colab, tools]) => {
            const dias_max = Math.max(...tools.map(t =>
                t.dataEntrega ? _calcDias(t.dataEntrega) : 0
            ));
            const overdue = dias_max >= ALERTA_DIAS;

            const row = document.createElement('div');
            row.className = 'dv2-ferr-row' + (overdue ? ' dv2-ferr-row--overdue' : '');
            row.onclick   = () => nav('view-tools');

            const left2 = document.createElement('div');
            left2.className = 'dv2-ferr-left';

            const name = document.createElement('span');
            name.className   = 'dv2-ferr-name';
            name.textContent = colab;

            const toolNames = document.createElement('span');
            toolNames.className   = 'dv2-ferr-tools';
            toolNames.textContent = tools.map(t => t.nome).join(' · ');

            left2.appendChild(name);
            left2.appendChild(toolNames);

            const badge = document.createElement('span');
            badge.className   = 'dv2-ferr-badge' + (overdue ? ' dv2-ferr-badge--overdue' : '');
            badge.textContent = tools.length === 1 ? '1 ferr.' : `${tools.length} ferr.`;

            row.appendChild(left2);
            row.appendChild(badge);
            list2.appendChild(row);
        });

        sec2.appendChild(list2);
        el.appendChild(sec2);
    }

    if (refreshBtn) refreshBtn.classList.remove('spinning');
}

// =============================================
// ORDENAÇÃO DO STOCK
// =============================================
let _stockSort = 'recente'; // 'recente' | 'nome' | 'qtd-asc' | 'qtd-desc' | 'local'
let _pendingZeroFilter  = false;
let _bulkCount = 0; // contador de produtos adicionados no lote actual
let _toolsFilter = 'all';
function toolsFilterSet(btn, filter) {
    _toolsFilter = filter;
    document.querySelectorAll('.tools-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    const search = document.getElementById('inp-tools-search');
    if (search) search.value = '';
    renderTools();
}
let _zeroFilterActive  = false; // zero-stock filter está activo (persiste entre navegações)

// Menu de ordenação — criado no body para evitar clipping por stacking contexts
function _getSortMenu() {
    let menu = document.getElementById('sort-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id        = 'sort-menu';
        menu.className = 'sort-menu';
        const options  = [
            { val: 'recente',  label: 'Mais recente' },
            { val: 'nome',     label: 'Nome A→Z'     },
            { val: 'qtd-asc',  label: 'Quantidade ↑' },
            { val: 'qtd-desc', label: 'Quantidade ↓' },
            { val: 'local',    label: 'Localização'  },
        ];
        options.forEach(o => {
            const btn = document.createElement('button');
            btn.className   = 'sort-option' + (o.val === _stockSort ? ' active' : '');
            btn.id          = `sort-${o.val}`;
            btn.textContent = o.label;
            btn.onclick     = () => setStockSort(o.val);
            menu.appendChild(btn);
        });
        document.body.appendChild(menu);
    }
    return menu;
}

function toggleSortMenu() {
    const btn  = document.getElementById('sort-dropdown-btn');
    const menu = _getSortMenu();
    const isOpen = menu.classList.contains('open');

    if (isOpen) {
        _closeSortMenu();
        return;
    }

    // Posiciona o menu sob o botão usando coordenadas absolutas
    const rect = btn.getBoundingClientRect();
    menu.style.top   = `${rect.bottom + window.scrollY + 6}px`;
    menu.style.right = `${window.innerWidth - rect.right - window.scrollX}px`;
    menu.style.left  = 'auto';
    menu.classList.add('open');
    btn.classList.add('active');

    // Fecha ao clicar fora (próximo tick para não capturar o click actual)
    setTimeout(() => {
        document.addEventListener('click', _onOutsideSortClick);
    }, 0);
}

function _onOutsideSortClick(e) {
    const wrap = document.getElementById('sort-dropdown-wrap');
    const menu = document.getElementById('sort-menu');
    if (!wrap?.contains(e.target) && !menu?.contains(e.target)) {
        _closeSortMenu();
    }
}

function _closeSortMenu() {
    document.getElementById('sort-menu')?.classList.remove('open');
    document.getElementById('sort-dropdown-btn')?.classList.remove('active');
    document.removeEventListener('click', _onOutsideSortClick);
}

// Fecha sort menu em scroll ou resize (posição desactualizada)
window.addEventListener('scroll', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
}, { passive: true });
window.addEventListener('resize', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
});

function setStockSort(val) {
    _stockSort = val;
    // Actualiza estado visual das opções
    document.querySelectorAll('.sort-option').forEach(btn => {
        btn.classList.toggle('active', btn.id === `sort-${val}`);
    });
    // Fecha o menu
    _closeSortMenu();
    renderList(window._searchInputEl?.value || '', true);
}

function getSortedEntries(entries) {
    const copy = [...entries];
    switch (_stockSort) {
        case 'nome':     return copy.sort((a,b) => (a[1].nome||'').localeCompare(b[1].nome||'', 'pt'));
        case 'qtd-asc':  return copy.sort((a,b) => (a[1].quantidade||0) - (b[1].quantidade||0));
        case 'qtd-desc': return copy.sort((a,b) => (b[1].quantidade||0) - (a[1].quantidade||0));
        case 'local':    return copy.sort((a,b) => (a[1].localizacao||'').localeCompare(b[1].localizacao||'', 'pt'));
        default:         return copy.reverse(); // mais recente primeiro
    }
}

// =============================================
// STOCK — RENDER
// FIX: usa [...entries].reverse() para não mutar o cache
// FIX: qty-display.is-zero para stock a 0
// FIX: filtragem por show/hide nos cards existentes sem recriar DOM
// =============================================

// Filtra stock para mostrar apenas produtos com quantidade 0
function filterZeroStock() {
    _zeroFilterActive = true;
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;
    const wrappers = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    wrappers.forEach(wrapper => {
        const id   = wrapper.dataset.id;
        const item = cache.stock.data?.[id];
        const isZero = item && (item.quantidade || 0) === 0;
        wrapper.style.display = isZero ? '' : 'none';
    });
    let badge = document.getElementById('zero-filter-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id        = 'zero-filter-badge';
        badge.className = 'zero-filter-badge';
        const _badgeTxt = document.createElement('span');
        _badgeTxt.textContent = '! A mostrar apenas produtos sem stock';
        const _badgeBtn = document.createElement('button');
        _badgeBtn.textContent = '✕ Limpar';
        _badgeBtn.onclick = clearZeroFilter;
        badge.appendChild(_badgeTxt);
        badge.appendChild(_badgeBtn);
        listEl.parentNode.insertBefore(badge, listEl);
        // Scroll para o topo e foca o badge
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => badge.classList.add('badge-pulse'), 100);
    }
}

// PONTO 16: histórico de zonas
const ZONE_HISTORY_KEY = 'hiperfrio-zone-history';
function _saveZoneToHistory(zona) {
    if (!zona) return;
    const hist = JSON.parse(localStorage.getItem(ZONE_HISTORY_KEY) || '[]');
    const updated = [zona, ...hist.filter(z => z !== zona)].slice(0, 8);
    localStorage.setItem(ZONE_HISTORY_KEY, JSON.stringify(updated));
    _refreshZoneDatalist();
}
function _refreshZoneDatalist() {
    const dl = document.getElementById('zone-datalist');
    if (!dl) return;
    const hist = JSON.parse(localStorage.getItem(ZONE_HISTORY_KEY) || '[]');
    dl.innerHTML = hist.map(z => `<option value="${escapeHtml(z)}">`).join('');
}

// PONTO 20: fechar lote com resumo
function closeBatch() {
    if (_bulkCount === 0) { nav('view-search'); return; }
    const zona = document.getElementById('bulk-loc')?.value?.trim() || '?';
    openConfirmModal({
        icon: '📦',
        title: 'Fechar lote?',
        desc: `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''} na zona "${zona}". Fechar e ir para o stock?`,
        onConfirm: () => {
            // Limpa o formulário completo
            document.getElementById('form-bulk')?.reset();
            setUnitSelector('bulk', 'un');
            document.getElementById('bulk-notas').value = '';
            _bulkCount = 0; _updateBulkCounter();
            nav('view-search');
        }
    });
}

function _updateBulkCounter() {
    const el = document.getElementById('bulk-counter');
    if (!el) return;
    el.textContent = _bulkCount === 0 ? '' : `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''}`;
    el.style.display = _bulkCount > 0 ? 'block' : 'none';
}

function clearSearch() {
    const inp = document.getElementById('inp-search');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); }
}

function clearZeroFilter() {
    _zeroFilterActive = false;
    const badge = document.getElementById('zero-filter-badge');
    if (badge) badge.remove();
    renderList('', false);
}

// PONTO 8: lógica de filtragem centralizada — usada por renderList em ambos os caminhos
function _itemMatchesFilter(item, filterLower, filterUpper) {
    if (!filterLower) return true;
    return (item.nome || '').toLowerCase().includes(filterLower)
        || String(item.codigo || '').toUpperCase().includes(filterUpper)
        || (item.localizacao || '').toLowerCase().includes(filterLower)
        || (item.notas || '').toLowerCase().includes(filterLower);
}

async function renderList(filter = '', force = false) {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    if (!cache.stock.data) listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';

    const data    = await fetchCollection('stock', force);
    const entries = Object.entries(data);

    // Se DOM já tem cards (re-render por filtro), apenas faz show/hide
    const existingCards = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    if (existingCards.length > 0 && !force) {
        // Remove "Mostrar mais" antes de filtrar — contagem pode mudar
        document.getElementById('load-more-btn')?.remove();
        const filterLower = filter.toLowerCase();
        let visible = 0;
        existingCards.forEach(wrapper => {
            const id   = wrapper.dataset.id;
            const item = data[id];
            if (!item) { wrapper.style.display = 'none'; return; }
            const matches = _itemMatchesFilter(item, filterLower, filter.toUpperCase());
            wrapper.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });
        let noResult = listEl.querySelector('.empty-msg');
        if (filter && visible === 0) {
            if (!noResult) {
                noResult = document.createElement('div');
                noResult.className = 'empty-msg';
                listEl.appendChild(noResult);
            }
            noResult.textContent = 'Nenhum resultado encontrado.';
        } else if (noResult) {
            noResult.remove();
        }
        return;
    }

    // Full render
    listEl.innerHTML = '';

    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Nenhum produto registado.</div>';
        return;
    }

    // Hint contextual — swipe para gestores, leitura para funcionários
    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!filter && !localStorage.getItem(hintKey)) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        if (currentRole === 'worker') {
            const msg = document.createElement('span');
            msg.textContent = '👁️ Modo consulta — apenas visualização';
            hint.appendChild(msg);
        } else {
            const l = document.createElement('span'); l.textContent = '✏️ Swipe direita para editar';
            const r = document.createElement('span'); r.textContent = '🗑️ Swipe esquerda para apagar';
            hint.appendChild(l); hint.appendChild(r);
        }
        listEl.appendChild(hint);
        localStorage.setItem(hintKey, '1');
    }

    const filterLower = filter.toLowerCase();
    let found = 0;
    const PAGE_SIZE = 80; // PONTO 9: paginação
    let _shownCount = 0;

    // Ordenação configurável
    getSortedEntries(entries).forEach(([id, item]) => {
        const matches = _itemMatchesFilter(item, filterLower, filter.toUpperCase());

        const wrapper = document.createElement('div');
        wrapper.className    = 'swipe-wrapper';
        wrapper.dataset.id   = id;
        wrapper.style.display = matches ? '' : 'none';
        if (matches) found++;

        // Swipe backgrounds
        const bgL = document.createElement('div'); bgL.className = 'swipe-bg swipe-bg-left';
        const iL  = document.createElement('span'); iL.className = 'swipe-bg-icon'; iL.textContent = '';
        bgL.appendChild(iL);
        const bgR = document.createElement('div'); bgR.className = 'swipe-bg swipe-bg-right';
        const iR  = document.createElement('span'); iR.className = 'swipe-bg-icon'; iR.textContent = '';
        bgR.appendChild(iR);
        wrapper.appendChild(bgL); wrapper.appendChild(bgR);

        // Card content — tudo via textContent (sem XSS)
        const el = document.createElement('div');
        el.className = 'item-card';

        const refLabel = document.createElement('div');
        refLabel.className   = 'ref-label';
        refLabel.textContent = 'REFERÊNCIA';

        const refVal = document.createElement('div');
        refVal.className   = 'ref-value';
        refVal.textContent = String(item.codigo || '').toUpperCase();

        const nomEl = document.createElement('div');
        nomEl.className   = 'card-nome';
        nomEl.textContent = item.nome || '';

        const hr = document.createElement('hr');
        hr.className = 'card-divider';

        const row = document.createElement('div');
        row.className = 'card-bottom-row';

        const pill = document.createElement('div');
        pill.className = 'loc-pill';
        const pinIcon = document.createElement('span');
        pinIcon.style.fontSize = '0.85rem';
        pinIcon.textContent    = '';
        pill.appendChild(pinIcon);
        pill.appendChild(document.createTextNode(' ' + (item.localizacao ? item.localizacao.toUpperCase() : 'SEM LOCAL')));

        const qtyBox = document.createElement('div');
        qtyBox.className = 'qty-pill-box';

        const qty = item.quantidade || 0;

        const btnM = document.createElement('button');
        btnM.className   = 'btn-qty';
        btnM.textContent = '−';
        btnM.disabled    = qty === 0;
        btnM.id          = `btn-minus-${id}`;
        btnM.onclick     = () => changeQtd(id, -1);

        const qtySpan = document.createElement('span');
        qtySpan.className   = 'qty-display' + (qty === 0 ? ' is-zero' : '');
        qtySpan.id          = `qty-${id}`;
        qtySpan.textContent = fmtQty(qty, item.unidade);
        // Duplo-toque/duplo-clique abre edição inline de quantidade
        let _tapTimer = null;
        qtySpan.addEventListener('click', () => {
            if (_tapTimer) {
                clearTimeout(_tapTimer);
                _tapTimer = null;
                openInlineQtyEdit(id, item);
            } else {
                _tapTimer = setTimeout(() => { _tapTimer = null; }, 350);
            }
        });

        const btnP = document.createElement('button');
        btnP.className   = 'btn-qty';
        btnP.textContent = '+';
        btnP.onclick     = () => changeQtd(id, 1);

        qtyBox.appendChild(btnM); qtyBox.appendChild(qtySpan); qtyBox.appendChild(btnP);
        row.appendChild(pill); row.appendChild(qtyBox);
        // PONTO 13: indicador de notas
        if (item.notas) {
            const notasRow = document.createElement('div');
            notasRow.className   = 'card-notas';
            notasRow.title       = item.notas;
            notasRow.textContent = `📝 ${item.notas}`;
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
            el.appendChild(notasRow);
        } else {
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
        }
        el.appendChild(hr); el.appendChild(row);

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        if (!matches) { listEl.appendChild(wrapper); return; }
        // PONTO 9: só renderiza os primeiros PAGE_SIZE visíveis
        if (_shownCount < PAGE_SIZE) {
            listEl.appendChild(wrapper);
        } else {
            wrapper.style.display = 'none';
            wrapper.dataset.deferred = '1';
            listEl.appendChild(wrapper);
        }
        _shownCount++;
    });

    // Botão "Mostrar mais" se há cards diferidos
    const deferred = listEl.querySelectorAll('.swipe-wrapper[data-deferred="1"]').length;
    const existingBtn = document.getElementById('load-more-btn');
    if (existingBtn) existingBtn.remove();
    if (deferred > 0) {
        const btn = document.createElement('button');
        btn.id = 'load-more-btn';
        btn.className = 'btn-load-more';
        btn.textContent = `Mostrar mais ${deferred} produto${deferred > 1 ? 's' : ''}`;
        btn.onclick = () => {
            listEl.querySelectorAll('.swipe-wrapper[data-deferred="1"]').forEach(w => {
                w.style.display = '';
                delete w.dataset.deferred;
            });
            btn.remove();
        };
        listEl.appendChild(btn);
    }

    if (filter && found === 0) {
        const em = document.createElement('div');
        em.className   = 'empty-msg';
        em.textContent = 'Nenhum resultado encontrado.';
        listEl.appendChild(em);
    }

    // Aplica filtro zero-stock se estava pendente (vindo do dashboard)
    if (_pendingZeroFilter) {
        _pendingZeroFilter = false;
        filterZeroStock();
    }
}

// Edição inline de quantidade — abre mini-form no lugar do span
function openInlineQtyEdit(id, item) {
    const qtyEl = document.getElementById(`qty-${id}`);
    if (!qtyEl || qtyEl.querySelector('input')) return; // já em edição
    const currentQty = cache.stock.data?.[id]?.quantidade ?? item.quantidade ?? 0; // PONTO 5: lê do cache actualizado
    const wrap = document.createElement('div');
    wrap.className = 'qty-inline-edit';
    const inp = document.createElement('input');
    inp.type  = 'number';
    inp.min   = '0';
    inp.step  = 'any';
    inp.value = currentQty;
    inp.className = 'qty-inline-input';
    inp.setAttribute('inputmode', 'decimal');
    const confirmFn = async () => {
        const newVal = parseFloat(inp.value);
        if (isNaN(newVal) || newVal < 0) { cancelFn(); return; }
        wrap.replaceWith(qtyEl);
        qtyEl.textContent = fmtQty(newVal, item.unidade);
        qtyEl.classList.toggle('is-zero', newVal === 0);
        document.getElementById(`btn-minus-${id}`)?.toggleAttribute('disabled', newVal === 0);
        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newVal;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method: 'PATCH', body: JSON.stringify({ quantidade: newVal }) });
            renderDashboard();
        } catch(_e) { showToast('Erro ao guardar','error'); }
    };
    const cancelFn = () => { wrap.replaceWith(qtyEl); };
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmFn(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelFn(); }
    });
    inp.addEventListener('blur', () => setTimeout(cancelFn, 150));
    const ok = document.createElement('button');
    ok.className = 'qty-inline-ok';
    ok.textContent = '✓';
    ok.addEventListener('mousedown', e => { e.preventDefault(); confirmFn(); });
    wrap.appendChild(inp);
    wrap.appendChild(ok);
    qtyEl.replaceWith(wrap);
    inp.focus();
    inp.select();
}

async function forceRefresh() {
    setRefreshSpinning(true);
    await Promise.all([
        renderList(document.getElementById('inp-search')?.value || '', true),
        renderDashboard()
    ]);
    setRefreshSpinning(false);
    showToast('Stock atualizado!');
}

// Debounce de escrita para changeQtd — agrupa toques rápidos numa só chamada à Firebase
const _qtyTimers = {};

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(30);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return;

    // Actualiza cache + DOM imediatamente (optimistic)
    stockData[id].quantidade = newQty;
    const qtyEl   = document.getElementById(`qty-${id}`);
    const minusEl = document.getElementById(`btn-minus-${id}`);
    const itemUnidade = stockData[id]?.unidade;
    if (qtyEl) {
        qtyEl.textContent = fmtQty(newQty, itemUnidade);
        qtyEl.classList.toggle('is-zero', newQty === 0);
    }
    if (minusEl) minusEl.disabled = newQty === 0;

    // Mostra indicador de "a guardar" após 300ms sem actividade
    if (qtyEl) qtyEl.classList.add('qty-saving');
    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, {
                method: 'PATCH', body: JSON.stringify({ quantidade: finalQty })
            });
            if (qtyEl) qtyEl.classList.remove('qty-saving');
        } catch (e) {
            console.warn('changeQtd erro:', e?.message || e);
            if (qtyEl) qtyEl.classList.remove('qty-saving');
            stockData[id].quantidade = oldQty;
            if (qtyEl)   { qtyEl.textContent = fmtQty(oldQty, stockData[id]?.unidade); qtyEl.classList.toggle('is-zero', oldQty === 0); }
            if (minusEl)   minusEl.disabled = oldQty === 0;
            showToast('Erro ao guardar quantidade', 'error');
        }
        delete _qtyTimers[id];
    }, 600);
}

// =============================================
// FERRAMENTAS
// =============================================
function formatDate(iso) {
    if (!iso) return 'Data desconhecida';
    const d = new Date(iso), pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let _toolLongPressTimer = null; // módulo-level para evitar memory leak ao re-render

async function renderTools() {
    const list = document.getElementById('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');

    // Actualizar subtítulo do header
    const sub = document.getElementById('tools-header-sub');
    if (sub && data) {
        const entries = Object.values(data);
        const total   = entries.length;
        const aloc    = entries.filter(t => t.status === 'alocada').length;
        sub.textContent = `${total} ferramenta${total !== 1 ? 's' : ''} · ${aloc} alocada${aloc !== 1 ? 's' : ''}`;
    }

    // Actualizar botões de filtro
    document.querySelectorAll('.tools-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === (_toolsFilter || 'all'));
    });

    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div><div class="empty-state-title">Sem ferramentas</div><div class="empty-state-sub">Adiciona ferramentas em Administração.</div></div>`;
        return;
    }

    const filterLower = typeof _toolsFilter === 'string' && _toolsFilter !== 'all' && !['disponivel','alocada'].includes(_toolsFilter)
        ? _toolsFilter.toLowerCase() : '';
    const statusFilter = ['disponivel','alocada'].includes(_toolsFilter) ? _toolsFilter : null;

    let found = 0;
    ;[...Object.entries(data)].reverse().forEach(([id, t]) => {
        if (filterLower && !t.nome?.toLowerCase().includes(filterLower)) return;
        if (statusFilter && t.status !== statusFilter) return;
        found++;

        const isAv = t.status === 'disponivel';
        const TOOL_ALERT_DAYS = 7;
        const isOverdue = !isAv && t.dataEntrega &&
            _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS;

        const div = document.createElement('div');
        div.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}${isOverdue ? ' tool-overdue' : ''}`;
        div.onclick = () => isAv ? openModal(id) : openConfirmModal({
            icon: '↩', title: 'Confirmar devolução?',
            desc: `"${escapeHtml(t.nome)}" será marcada como disponível.`,
            onConfirm: () => returnTool(id)
        });
        div.addEventListener('contextmenu', e => { e.preventDefault(); openHistoryModal(id, t.nome); });
        div.addEventListener('touchstart', () => {
            _toolLongPressTimer = setTimeout(() => openHistoryModal(id, t.nome), 600);
        }, { passive: true });
        div.addEventListener('touchend',  () => clearTimeout(_toolLongPressTimer), { passive: true });
        div.addEventListener('touchmove', () => clearTimeout(_toolLongPressTimer), { passive: true });

        // Info
        const info = document.createElement('div');
        info.className = 'tool-info';

        const nome = document.createElement('div');
        nome.className   = 'tool-nome';
        nome.textContent = t.nome;

        const sub = document.createElement('div');
        sub.className = 'tool-sub';

        if (isAv) {
            const dot = document.createElement('span');
            dot.className = 'tool-status-dot';
            dot.style.background = '#16a34a';
            const lbl = document.createElement('span');
            lbl.className   = 'tool-status-label';
            lbl.textContent = 'Em armazém';
            sub.appendChild(dot);
            sub.appendChild(lbl);
        } else {
            const _days = t.dataEntrega
                ? _calcDias(t.dataEntrega)
                : null;

            const colabBadge = document.createElement('span');
            colabBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-colab'}`;
            colabBadge.textContent = (t.colaborador || '').toUpperCase();
            sub.appendChild(colabBadge);

            if (_days !== null) {
                const daysBadge = document.createElement('span');
                daysBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-days'}`;
                daysBadge.textContent = _days === 0 ? 'hoje' : _days === 1 ? '1d fora' : `${_days}d fora`;
                sub.appendChild(daysBadge);
            }

            if (isOverdue) {
                const ovd = document.createElement('span');
                ovd.className   = 'tool-badge tool-badge-overdue';
                ovd.textContent = '⚠ verificar';
                sub.appendChild(ovd);
            }
        }

        info.appendChild(nome);
        info.appendChild(sub);

        // Seta
        const arrow = document.createElement('span');
        arrow.className = 'tool-arrow';
        arrow.innerHTML = isAv
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>`;

        div.appendChild(info);
        div.appendChild(arrow);
        list.appendChild(div);
    });

    if (found === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta encontrada.</div>';
    }
}

async function renderAdminTools() {
    const data = await fetchCollection('ferramentas');
    const list = document.getElementById('admin-tools-list');
    if (!list) return;
    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta registada.</div>'; return;
    }
    Object.entries(data).forEach(([id, t]) => {
        const row = document.createElement('div');
        row.className = 'admin-list-row admin-tool-row';

        // Nome da ferramenta
        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label';
        lbl.textContent = t.nome;

        // Barra de acções alinhada à esquerda
        const actions = document.createElement('div');
        actions.className = 'admin-tool-actions';

        const editBtn = document.createElement('button');
        editBtn.className   = 'admin-tool-btn admin-tool-btn-edit';
        editBtn.innerHTML   = '✏️ <span>Editar</span>';
        editBtn.onclick     = () => openEditToolModal(id, t);

        const histBtn = document.createElement('button');
        histBtn.className   = 'admin-tool-btn admin-tool-btn-hist';
        histBtn.innerHTML   = '≡ <span>Histórico</span>';
        histBtn.onclick     = () => openHistoryModal(id, t.nome);

        const delBtn = document.createElement('button');
        delBtn.className   = 'admin-tool-btn admin-tool-btn-del';
        delBtn.innerHTML   = '🗑️ <span>Eliminar</span>';
        delBtn.onclick     = () => openConfirmModal({
            icon:'', title:'Apagar ferramenta?',
            desc:`"${escapeHtml(t.nome)}" será removida permanentemente.`,
            onConfirm: () => deleteTool(id)
        });

        actions.appendChild(editBtn);
        actions.appendChild(histBtn);
        actions.appendChild(delBtn);
        row.appendChild(lbl);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

// =============================================
// HISTÓRICO DAS FERRAMENTAS
// =============================================
const HISTORY_MAX = 50; // máximo de registos por ferramenta

async function addToolHistoryEvent(toolId, acao, colaborador) {
    const event = { acao, colaborador: colaborador || '', data: new Date().toISOString() };
    try {
        // Adiciona novo evento
        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico.json`, {
            method: 'POST', body: JSON.stringify(event)
        });
        // Verifica se excede o limite usando o cache de ferramentas (evita fetch extra)
        const histCache = cache.ferramentas.data?.[toolId]?.historico;
        const histCount = histCache ? Object.keys(histCache).length : 0;
        if (histCount >= HISTORY_MAX) {
            // Faz fetch apenas quando necessário para obter os IDs ordenados
            try {
                const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
                const res  = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (data && Object.keys(data).length > HISTORY_MAX) {
                        const sorted = Object.entries(data).sort((a, b) => new Date(a[1].data) - new Date(b[1].data));
                        await apiFetch(`${BASE_URL}/ferramentas/${toolId}/historico/${sorted[0][0]}.json`, { method: 'DELETE' });
                    }
                }
            } catch (e) { console.warn('Limpeza histórico:', e?.message || e); }
        }
    } catch (e) { console.warn('addToolHistoryEvent:', e?.message || e); /* best-effort */ }
}

async function openHistoryModal(toolId, toolName) {
    document.getElementById('history-modal-tool-name').textContent = `🪛 ${toolName}`;
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';
    document.getElementById('history-modal').classList.add('active');
    focusModal('history-modal');

    try {
        if (!navigator.onLine) {
            listEl.innerHTML = '<div class="empty-msg">Sem ligação — histórico indisponível offline.</div>';
            return;
        }
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        listEl.innerHTML = '';

        if (!data) {
            listEl.innerHTML = '<div class="empty-msg">Sem registos de histórico.</div>';
            return;
        }

        // Converte objeto Firebase em array e ordena do mais recente para o mais antigo
        const events = Object.values(data).sort((a, b) => new Date(b.data) - new Date(a.data));

        events.forEach(ev => {
            const row  = document.createElement('div');
            row.className = `history-row ${ev.acao === 'atribuida' ? 'history-out' : 'history-in'}`;
            const icon = ev.acao === 'atribuida' ? '→' : '↩';
            const label = ev.acao === 'atribuida'
                ? `Entregue a ${ev.colaborador || '?'}`
                : `Devolvida${ev.colaborador ? ` por ${ev.colaborador}` : ''}`;
            const date  = formatDate(ev.data);
            const iconEl = document.createElement('span');
            iconEl.className   = 'history-icon';
            iconEl.textContent = icon;
            const info  = document.createElement('div');
            info.className = 'history-info';
            const lbl   = document.createElement('span');
            lbl.className   = 'history-label';
            lbl.textContent = label;
            const dt    = document.createElement('span');
            dt.className   = 'history-date';
            dt.textContent = date;
            info.appendChild(lbl);
            info.appendChild(dt);
            row.appendChild(iconEl);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    } catch (e) {
        listEl.innerHTML = '<div class="empty-msg">Erro ao carregar histórico.</div>';
    }
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('active');
}

async function assignTool(worker) {
    const dataEntrega = new Date().toISOString();
    const id = toolToAllocate;
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'alocada', colaborador:worker, dataEntrega
    };
    closeModal(); renderTools(); renderDashboard(); showToast(`Entregue a ${worker}!`);
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'alocada',colaborador:worker,dataEntrega})
        });
        await addToolHistoryEvent(id, 'atribuida', worker);
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar.','error'); }
}

async function returnTool(id) {
    // PONTO 2: guarda colaborador ANTES de modificar cache — evita perda offline
    const colaborador = cache.ferramentas.data[id]?.colaborador || '';
    const dataEntregaOrig = cache.ferramentas.data[id]?.dataEntrega || '';
    cache.ferramentas.data[id] = {
        ...cache.ferramentas.data[id], status:'disponivel', colaborador:'', dataEntrega:''
    };
    renderTools(); renderDashboard(); showToast('Devolvida!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body:JSON.stringify({status:'disponivel',colaborador:'',dataEntrega:''})
        });
        // Regista histórico com colaborador preservado mesmo offline
        await addToolHistoryEvent(id, 'devolvida', colaborador);
    } catch (e) {
        console.warn('returnTool erro:', e?.message || e);
        // Reverte estado local
        cache.ferramentas.data[id] = {
            ...cache.ferramentas.data[id], status:'alocada', colaborador, dataEntrega: dataEntregaOrig
        };
        invalidateCache('ferramentas'); showToast('Erro ao guardar.','error');
    }
}

// PONTO 11: editar ferramenta (nome)
function openEditToolModal(id, tool) {
    document.getElementById('edit-tool-id').value   = id;
    document.getElementById('edit-tool-name').value = tool.nome || '';
    document.getElementById('edit-tool-modal').classList.add('active');
    focusModal('edit-tool-modal');
}

function closeEditToolModal() {
    document.getElementById('edit-tool-modal').classList.remove('active');
}

async function saveEditTool() {
    const id   = document.getElementById('edit-tool-id').value;
    const nome = document.getElementById('edit-tool-name').value.trim().toUpperCase();
    if (!nome) { showToast('Nome obrigatório', 'error'); return; }
    if (cache.ferramentas.data?.[id]) {
        cache.ferramentas.data[id] = { ...cache.ferramentas.data[id], nome };
    }
    closeEditToolModal();
    renderAdminTools();
    renderTools();
    renderDashboard();
    showToast('Ferramenta actualizada!');
    try {
        await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, {
            method:'PATCH', body: JSON.stringify({ nome })
        });
    } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao guardar','error'); }
}

async function deleteTool(id) {
    // PONTO 3: se ferramenta está alocada, força devolução antes de apagar
    const tool = cache.ferramentas.data?.[id];
    const _doDelete = async () => {
        delete cache.ferramentas.data[id]; renderAdminTools(); renderTools(); renderDashboard();
        try {
            await apiFetch(`${BASE_URL}/ferramentas/${id}.json`, { method:'DELETE' });
            showToast('Ferramenta apagada');
        } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao apagar.','error'); }
    };
    if (tool?.status === 'alocada') {
        openConfirmModal({
            icon: '',
            title: 'Ferramenta alocada!',
            desc: `"${escapeHtml(tool.nome)}" está com ${escapeHtml(tool.colaborador || '?')}. Apagar irá forçar a devolução sem registo. Confirmas?`,
            onConfirm: _doDelete
        });
    } else {
        await _doDelete();
    }
}

// =============================================
// FUNCIONÁRIOS
// =============================================
async function renderWorkers() {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id,v]) => ({id, nome:v.nome})) : [];
    const list    = document.getElementById('workers-list');
    if (!list) return;
    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionário adicionado.</div>'; return;
    }
    workers.forEach(w => {
        const row = document.createElement('div');
        row.className = 'admin-list-row';
        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label';
        lbl.textContent = `👤 ${w.nome}`;
        const btn = document.createElement('button');
        btn.className = 'admin-list-delete';
        btn.textContent = '';
        btn.onclick = () => openConfirmModal({
            icon:'👤', title:'Apagar funcionário?',
            desc:`"${escapeHtml(w.nome)}" será removido permanentemente.`,
            onConfirm: () => deleteWorker(w.id)
        });
        row.appendChild(lbl); row.appendChild(btn);
        list.appendChild(row);
    });
}

async function deleteWorker(id) {
    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();
    try {
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method:'DELETE' });
    } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao apagar.','error'); }
}

// =============================================
// MODAL — entregar ferramenta
// =============================================
let toolToAllocate = null;

async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid,v]) => ({id:wid,nome:v.nome})) : [];
    if (workers.length === 0) return showToast('Adicione funcionários na Administração','error');
    toolToAllocate = id;

    // Mostra o nome e ícone da ferramenta no modal
    const toolData = cache.ferramentas.data?.[id];
    const toolName = toolData?.nome || '';
    const toolIcon = toolData?.icone || '';
    const toolDesc = document.getElementById('worker-modal-tool-name');
    if (toolDesc) toolDesc.textContent = toolName ? `${toolIcon} ${toolName}` : '';
    // Actualiza também o ícone grande no topo do modal
    const modalIcon = document.getElementById('worker-modal-icon');
    if (modalIcon) modalIcon.textContent = toolIcon;

    const sel = document.getElementById('worker-select-list');
    sel.innerHTML = '';
    // Ordenar por nome
    workers.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
    workers.forEach(w => {
        const opt = document.createElement('div');
        opt.className   = 'worker-option';
        opt.textContent = w.nome;
        opt.onclick     = () => assignTool(w.nome);
        sel.appendChild(opt);
    });
    document.getElementById('worker-modal').classList.add('active');
    focusModal('worker-modal');
}
function closeModal() { document.getElementById('worker-modal').classList.remove('active'); }

// Focus first focusable element inside a modal when it opens
function focusModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const focusable = modal.querySelector('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

// =============================================
// MODAL — confirmação genérica
// =============================================
let confirmCallback = null;

function openConfirmModal({ icon='', title, desc, onConfirm }) {
    confirmCallback = onConfirm;
    document.getElementById('confirm-modal-icon').textContent  = icon;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent  = desc;
    document.getElementById('confirm-modal').classList.add('active');
    focusModal('confirm-modal');
}
function closeConfirmModal() {
    confirmCallback = null;
    document.getElementById('confirm-modal').classList.remove('active');
}

// =============================================
// MODAL — apagar produto (swipe left)
// =============================================
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    document.getElementById('delete-modal-desc').textContent =
        `"${String(item.codigo||'').toUpperCase()} — ${item.nome}" será removido permanentemente.`;
    document.getElementById('delete-modal').classList.add('active');
    focusModal('delete-modal');
}
function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-modal').classList.remove('active');
}

// =============================================
// MODAL — editar produto (swipe right)
// =============================================
function openEditModal(id, item) {
    document.getElementById('edit-id').value     = id;
    document.getElementById('edit-codigo').value = item.codigo || '';
    document.getElementById('edit-nome').value   = item.nome || '';
    document.getElementById('edit-loc').value    = item.localizacao || '';
    document.getElementById('edit-qtd').value    = item.quantidade ?? 0;
    setUnitSelector('edit', item.unidade || 'un');
    document.getElementById('edit-notas').value  = item.notas || '';
    document.getElementById('edit-modal').classList.add('active');
    focusModal('edit-modal');
}
function closeEditModal() { document.getElementById('edit-modal').classList.remove('active'); }

// =============================================
// SWIPE GESTURES
// FIX: único par de listeners globais — sem acumulação por card
// =============================================
const SWIPE_THRESHOLD = 80;
let _swipeCard    = null;
let _swipeWrapper = null;
let _swipeStartX  = 0;
let _swipeCurrentX = 0;
let _swipeDragging = false;
let _swipeMeta    = null; // { id, item }

document.addEventListener('mousemove', e => {
    if (!_swipeDragging) return;
    _onSwipeMove(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => {
    if (!_swipeDragging) return;
    _onSwipeEnd();
});

function attachSwipe(card, wrapper, id, item) {
    // Funcionários não têm swipe — apenas leitura
    if (currentRole === 'worker') return;
    card.addEventListener('touchstart', e => {
        e.stopPropagation();
        _onSwipeStart(card, wrapper, id, item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchmove',  e => _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend',   e => { e.stopPropagation(); _onSwipeEnd(); }, { passive: true });
    card.addEventListener('mousedown',  e => {
        // Não interferir com cliques nos botões +/−
        if (e.target.closest('.btn-qty')) return;
        _onSwipeStart(card, wrapper, id, item, e.clientX, e.clientY);
        e.preventDefault();
    });
}

let _swipeStartY  = 0;
let _swipeIntent  = null; // 'horizontal' | 'vertical' | null

function _onSwipeStart(card, wrapper, id, item, x, y = 0) {
    _swipeCard     = card;
    _swipeWrapper  = wrapper;
    _swipeMeta     = { id, item };
    _swipeStartX   = x;
    _swipeStartY   = y;
    _swipeCurrentX = 0;
    _swipeDragging  = true;
    _swipeIntent   = null;
    // Don't add is-swiping yet — wait to know direction
}

function _onSwipeMove(x, y = 0) {
    if (!_swipeDragging || !_swipeCard) return;
    const dx = x - _swipeStartX;
    const dy = y - _swipeStartY;

    // Determine intent on first meaningful movement
    if (_swipeIntent === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        _swipeIntent = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
        if (_swipeIntent === 'horizontal') _swipeCard.classList.add('is-swiping');
    }

    // Only track horizontal swipes
    if (_swipeIntent !== 'horizontal') return;

    _swipeCurrentX = dx;
    const clamped  = Math.max(-140, Math.min(140, dx));
    _swipeCard.style.transform = `translateX(${clamped}px)`;
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (clamped < -20)     _swipeWrapper.classList.add('swiping-left');
    else if (clamped > 20) _swipeWrapper.classList.add('swiping-right');
}

function _onSwipeEnd() {
    if (!_swipeDragging || !_swipeCard) return;
    _swipeDragging = false;
    _swipeCard.classList.remove('is-swiping');
    _swipeWrapper.classList.remove('swiping-left','swiping-right');
    if (_swipeIntent === 'horizontal') {
        snapBack(_swipeCard);
        if      (_swipeCurrentX < -SWIPE_THRESHOLD) openDeleteModal(_swipeMeta.id, _swipeMeta.item);
        else if (_swipeCurrentX >  SWIPE_THRESHOLD) openEditModal(_swipeMeta.id, _swipeMeta.item);
    }
    _swipeCard = _swipeWrapper = _swipeMeta = null;
    _swipeIntent = null;
}

function snapBack(card) {
    card.classList.add('snap-back');
    card.style.transform = 'translateX(0)';
    card.addEventListener('transitionend', () => card.classList.remove('snap-back'), { once:true });
}


// =============================================
// EXPORTAR CSV
// =============================================
async function exportCSV() {
    const btn = document.getElementById('export-csv-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    const data = await fetchCollection('stock', false);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para exportar','error');
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
        return;
    }
    const headers = ['Referência','Nome','Localização','Quantidade','Unidade'];
    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_tmp_')));
    const rows = Object.values(cleanData).map(item => [
        `"${(item.codigo||'').toUpperCase()}"`,
        `"${(item.nome||'').replace(/"/g,'""')}"`,
        `"${(item.localizacao||'').toUpperCase()}"`,
        item.quantidade ?? 0,
        item.unidade || 'un'
    ]);
    const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
        href: url,
        download: `hiperfrio-stock-${new Date().toISOString().slice(0,10)}.csv`
    }).click();
    URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = 'Exportar'; }
    showToast(`${Object.keys(cleanData).length} produtos exportados!`);
}

// =============================================
// ADMIN TABS
// =============================================
// PONTO 25: exportar histórico de ferramentas para CSV
async function exportToolHistoryCSV() {
    const btn = document.getElementById('export-hist-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    try {
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData || Object.keys(ferrData).length === 0) {
            showToast('Sem ferramentas para exportar', 'error');
            return;
        }
        const headers = ['Ferramenta','Ícone','Ação','Colaborador','Data'];
        const rows = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (!t.historico) continue;
            for (const ev of Object.values(t.historico)) {
                rows.push([
                    `"${(t.nome||'').replace(/"/g,'""')}"`,
                    `"${t.icone || ''}"`,
                    `"${ev.acao || ''}"`,
                    `"${(ev.colaborador||'').replace(/"/g,'""')}"`,
                    `"${ev.data ? new Date(ev.data).toLocaleString('pt-PT') : ''}"`
                ]);
            }
        }
        if (rows.length === 0) {
            showToast('Sem histórico para exportar', 'error');
            return;
        }
        rows.sort((a, b) => a[4] < b[4] ? 1 : -1); // mais recente primeiro
        const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
        const blob = new Blob(['﻿'+csv], { type:'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), {
            href: url,
            download: `hiperfrio-historico-ferramentas-${new Date().toISOString().slice(0,10)}.csv`
        }).click();
        URL.revokeObjectURL(url);
        showToast(`${rows.length} registos exportados!`);
    } catch(e) {
        showToast('Erro ao exportar histórico', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar Histórico'; }

    }
}

// =============================================
// ADMIN — slider com swipe entre tabs
// =============================================
const ADMIN_TABS  = ['workers', 'tools', 'clientes', 'users', 'settings'];
let   _adminIdx   = 0;   // índice activo

// ── Admin mobile — menu estilo Android ────────────────────────────────────────
const _adminMobileTitles = {
    workers:  'Funcionários',
    tools:    'Ferramentas',
    clientes: 'Clientes',
    users:    'Utilizadores',
    settings: 'Definições',
};
let _adminMobileActive = null;

function _buildAdminMobileMenu() {
    const viewAdmin = document.getElementById('view-admin');
    if (!viewAdmin) return;
    document.getElementById('admin-mobile-menu')?.remove();
    document.getElementById('admin-mobile-detail')?.remove();

    const items = [
        { tab:'workers',  bg:'#eff6ff', color:'#2563eb', label:'Funcionários', sub:'Gerir técnicos e colaboradores',
          svg:'<path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>', vb:'0 0 20 20', fill:true },
        { tab:'tools',    bg:'#dcfce7', color:'#16a34a', label:'Ferramentas',  sub:'Registar e gerir ferramentas',
          svg:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', vb:'0 0 24 24', fill:false },
        { tab:'clientes', bg:'#fef3c7', color:'#d97706', label:'Clientes',     sub:'Importar e consultar clientes',
          svg:'<path d="M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C3.74 11.846 4.632 14 6.414 14H15a1 1 0 000-2H6.414l1-1H14a1 1 0 00.894-.553l3-6A1 1 0 0017 3H6.28l-.31-1.243A1 1 0 005 1H3zM16 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM6.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>', vb:'0 0 20 20', fill:true },
        { tab:'users',    bg:'#ede9fe', color:'#7c3aed', label:'Utilizadores', sub:'Gerir contas e permissões',
          svg:'<path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
        { tab:'settings', bg:'#f1f5f9', color:'#64748b', label:'Definições',   sub:'OCR, tema, versão da app',
          svg:'<path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
    ];

    const menu = document.createElement('div');
    menu.id = 'admin-mobile-menu';

    const groups = [
        { label:'Gestão',  tabs: items.slice(0,3) },
        { label:'Sistema', tabs: items.slice(3) },
    ];

    groups.forEach(g => {
        // Label de secção
        const lbl = document.createElement('div');
        lbl.className = 'admin-mobile-section-label';
        lbl.textContent = g.label;
        menu.appendChild(lbl);

        // Grupo de cards
        const grp = document.createElement('div');
        grp.className = 'admin-mobile-group';

        g.tabs.forEach(item => {
            const row = document.createElement('div');
            row.className = 'admin-mobile-item';
            row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--border);background:var(--card-bg);-webkit-tap-highlight-color:transparent';
            row.addEventListener('click', () => adminMobileOpen(item.tab));

            // Ícone
            const iconWrap = document.createElement('div');
            iconWrap.className = 'admin-mobile-item-icon';
            iconWrap.style.cssText = `background:${item.bg};width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0`;
            const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svgEl.setAttribute('width', '22');
            svgEl.setAttribute('height', '22');
            svgEl.setAttribute('viewBox', item.vb);
            if (item.fill) {
                svgEl.setAttribute('fill', item.color);
            } else {
                svgEl.setAttribute('fill', 'none');
                svgEl.setAttribute('stroke', item.color);
                svgEl.setAttribute('stroke-width', '2');
                svgEl.setAttribute('stroke-linecap', 'round');
            }
            svgEl.innerHTML = item.svg;
            iconWrap.appendChild(svgEl);

            // Texto
            const textWrap = document.createElement('div');
            textWrap.style.cssText = 'flex:1;min-width:0';
            const labelEl = document.createElement('div');
            labelEl.className = 'admin-mobile-item-label';
            labelEl.textContent = item.label;
            const subEl = document.createElement('div');
            subEl.className = 'admin-mobile-item-sub';
            subEl.textContent = item.sub;
            textWrap.appendChild(labelEl);
            textWrap.appendChild(subEl);

            // Chevron
            const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            chevron.setAttribute('width', '16');
            chevron.setAttribute('height', '16');
            chevron.setAttribute('viewBox', '0 0 24 24');
            chevron.setAttribute('fill', 'none');
            chevron.setAttribute('stroke', '#94a3b8');
            chevron.setAttribute('stroke-width', '2.5');
            chevron.setAttribute('stroke-linecap', 'round');
            chevron.style.flexShrink = '0';
            chevron.innerHTML = '<path d="M9 18l6-6-6-6"/>';

            row.appendChild(iconWrap);
            row.appendChild(textWrap);
            row.appendChild(chevron);
            grp.appendChild(row);
        });

        menu.appendChild(grp);
    });

    // Construir detalhe
    const detail = document.createElement('div');
    detail.id = 'admin-mobile-detail';
    detail.style.display = 'none';

    // Linha do back btn
    const hdr = document.createElement('div');
    hdr.className = 'admin-mobile-detail-header';
    hdr.style.cssText = 'display:flex;align-items:center;padding:10px 0 4px;';

    const backBtn = document.createElement('button');
    backBtn.className = 'admin-mobile-back-btn';
    backBtn.type = 'button';
    backBtn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:transparent;border:none;outline:none;color:var(--primary);font-family:Inter,sans-serif;font-size:0.85rem;font-weight:600;cursor:pointer;padding:6px 0;margin:0;-webkit-appearance:none;appearance:none;letter-spacing:0.01em;';
    backBtn.addEventListener('click', adminMobileBack);
    backBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg> Administração';

    // Título da secção como h2
    const detailTitle = document.createElement('h2');
    detailTitle.className = 'admin-mobile-detail-title';
    detailTitle.id = 'admin-mobile-detail-title';
    detailTitle.style.cssText = 'font-size:1.35rem;font-weight:800;color:var(--text-main);letter-spacing:-0.4px;margin:4px 0 16px;padding:0;line-height:1.2;';

    hdr.appendChild(backBtn);

    const content = document.createElement('div');
    content.id = 'admin-mobile-detail-content';

    detail.appendChild(hdr);
    detail.appendChild(detailTitle);
    detail.appendChild(content);

    // Inserir antes do slider-wrap
    const sliderWrap = document.getElementById('admin-slider-wrap');
    viewAdmin.insertBefore(detail, sliderWrap);
    viewAdmin.insertBefore(menu, sliderWrap);
}

function adminMobileOpen(tab) {
    _adminMobileActive = tab;
    const menu   = document.getElementById('admin-mobile-menu');
    const detail = document.getElementById('admin-mobile-detail');
    const title  = document.getElementById('admin-mobile-detail-title');
    const content = document.getElementById('admin-mobile-detail-content');
    if (!menu || !detail || !title || !content) return;

    title.textContent = _adminMobileTitles[tab] || tab;

    const panel = document.getElementById(`panel-${tab}`);
    if (panel) {
        // Forçar dimensões — o .admin-panel tem width/min-width:20% do slider desktop
        panel.style.cssText = 'width:100% !important; min-width:100% !important; flex-shrink:0; box-sizing:border-box; padding:0;';
        content.appendChild(panel);
    }

    if (tab === 'clientes')  renderClientesList();
    if (tab === 'users')     renderUsersList();
    if (tab === 'settings')  { _updateOcrKeyStatus(); _loadOcrKeywordsInput(); }
    if (tab === 'tools')     renderAdminTools();
    if (tab === 'workers')   renderWorkers();

    menu.style.display   = 'none';
    detail.style.display = 'block';
    detail.style.padding = '0 16px 80px';
    detail.classList.remove('admin-mobile-detail-enter');
    void detail.offsetWidth;
    detail.classList.add('admin-mobile-detail-enter');

    const titleEl = document.getElementById('header-page-title');
    if (titleEl) titleEl.textContent = _adminMobileTitles[tab] || 'Administração';
    window.scrollTo(0, 0);
}

function adminMobileBack() {
    _adminMobileActive = null;
    const menu    = document.getElementById('admin-mobile-menu');
    const detail  = document.getElementById('admin-mobile-detail');
    const content = document.getElementById('admin-mobile-detail-content');
    if (!menu || !detail) return;

    const slider = document.getElementById('admin-slider');
    if (slider && content) {
        while (content.firstChild) {
            const child = content.firstChild;
            // Limpar estilos inline forçados — o slider desktop usa CSS próprio
            if (child.style) child.style.cssText = '';
            slider.appendChild(child);
        }
    }

    detail.style.display = 'none';
    menu.style.display   = 'block';

    const titleEl = document.getElementById('header-page-title');
    if (titleEl) titleEl.textContent = 'Administração';
    window.scrollTo(0, 0);
}

function switchAdminTab(tab, animate = true) {
    const idx = ADMIN_TABS.indexOf(tab);
    if (idx < 0) return;
    _adminIdx = idx;

    // Actualiza botões
    document.querySelectorAll('.admin-tab').forEach((t, i) =>
        t.classList.toggle('active', i === idx)
    );

    if (tab === 'clientes') renderClientesList();
    if (tab === 'users')    renderUsersList();
    if (tab === 'settings') { _updateOcrKeyStatus(); _loadOcrKeywordsInput(); }
    // Move slider (sem .active nos painéis — visibilidade é por transform)
    const slider = document.getElementById('admin-slider');
    if (slider) {
        if (!animate) slider.classList.add('is-dragging');
        // Cada painel ocupa 1/5 do slider (width:500%)
        // translateX(-idx * 20%) move para o painel certo
        slider.style.transform = `translateX(-${idx * 20}%)`;
        if (!animate) {
            // força reflow para garantir sem transição no reset
            void slider.offsetWidth;
            slider.classList.remove('is-dragging');
        }
    }
}

// AbortController para garantir que os listeners são limpos antes de re-setup
let _adminSwipeAC = null;

function _setupAdminSwipe() {
    const wrap   = document.getElementById('admin-slider-wrap');
    const slider = document.getElementById('admin-slider');
    if (!wrap || !slider) return;

    // Remove listeners anteriores antes de adicionar novos
    if (_adminSwipeAC) { _adminSwipeAC.abort(); }
    _adminSwipeAC = new AbortController();
    const sig = _adminSwipeAC.signal;

    let startX = 0, startY = 0;
    let deltaX = 0;
    let intent = null;   // 'h' | 'v' | null
    let active = false;

    const INTENT_THRESHOLD = 8;    // px para decidir h vs v
    const SWIPE_THRESHOLD  = 50;   // px para confirmar mudança de tab
    const RESIST = 0.25;           // resistência nos extremos

    wrap.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaX = 0;
        intent = null;
        active = true;
    }, { passive: true, signal: sig });

    wrap.addEventListener('touchmove', e => {
        if (!active || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        // Decide intenção uma só vez
        if (intent === null && (Math.abs(dx) > INTENT_THRESHOLD || Math.abs(dy) > INTENT_THRESHOLD)) {
            intent = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        if (intent !== 'h') return;   // scroll vertical — não interferir

        e.preventDefault();
        deltaX = dx;

        // Resistência nos extremos
        let extra = deltaX;
        if ((_adminIdx === 0 && deltaX > 0) || (_adminIdx === ADMIN_TABS.length - 1 && deltaX < 0)) {
            extra = deltaX * RESIST;
        }

        slider.classList.add('is-dragging');
        const base = -_adminIdx * 25;
        slider.style.transform = `translateX(calc(${base}% + ${extra}px))`;
    }, { passive: false, signal: sig });

    const onEnd = () => {
        if (!active) return;
        active = false;

        if (intent !== 'h') { intent = null; return; }

        slider.classList.remove('is-dragging');

        if (deltaX < -SWIPE_THRESHOLD && _adminIdx < ADMIN_TABS.length - 1) {
            switchAdminTab(ADMIN_TABS[_adminIdx + 1]);
        } else if (deltaX > SWIPE_THRESHOLD && _adminIdx > 0) {
            switchAdminTab(ADMIN_TABS[_adminIdx - 1]);
        } else {
            switchAdminTab(ADMIN_TABS[_adminIdx]);   // volta à posição
        }
        deltaX = 0;
        intent = null;
    };

    wrap.addEventListener('touchend',    onEnd, { passive: true, signal: sig });
    wrap.addEventListener('touchcancel', onEnd, { passive: true, signal: sig });
}

// =============================================
// TEMAS — claro / escuro
// =============================================
function _applyTheme(theme) {
    document.body.classList.remove('dark-mode');
    if (theme === 'dark')  document.body.classList.add('dark-mode');

    // Sync theme dropdown UI
    _syncThemeDropdown(theme);

    // Barra de status Android — meta theme-color dinâmica
    const themeColors = {
        light: '#2563eb',
        dark:  '#0f172a',
        
    };
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.name = 'theme-color';
        document.head.appendChild(metaTheme);
    }
    metaTheme.content = themeColors[theme] || themeColors.light;

    // Liga/desliga o comportamento de scroll da barra de pesquisa
    _setupSearchScrollBehaviour(false);
    // Scroll hide/show do pill — activo em todos os temas
    _setupBottomNavScrollBehaviour(true);
}

let _searchScrollCleanup = null;

function _setupSearchScrollBehaviour(enable) {
    // Remove listener anterior se existir
    if (_searchScrollCleanup) { _searchScrollCleanup(); _searchScrollCleanup = null; }

    const container  = document.querySelector('.search-container');
    if (!container) return;

    // Garante que o peek btn existe (criado uma vez, reutilizado)
    let peekBtn = document.getElementById('search-peek-btn');
    if (!peekBtn) {
        peekBtn = document.createElement('button');
        peekBtn.id        = 'search-peek-btn';
        peekBtn.className = 'search-peek-btn';
        peekBtn.innerHTML = ' Pesquisar';
        peekBtn.setAttribute('aria-label', 'Mostrar barra de pesquisa');
        peekBtn.onclick   = () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        document.body.appendChild(peekBtn);
    }

    if (!enable) {
        container.classList.remove('search-scrolled-away');
        peekBtn.classList.remove('visible');
        return;
    }

    const HIDE_THRESHOLD  = 80;  // px de scroll para esconder
    const SHOW_THRESHOLD  = 20;  // px de scroll para mostrar de volta
    let   _lastScrollY    = 0;
    let   _hidden         = false;
    let   _rafId          = null;

    const onScroll = () => {
        if (_rafId) return; // throttle via rAF
        _rafId = requestAnimationFrame(() => {
            _rafId = null;
            const sy = window.scrollY;
            if (!_hidden && sy > HIDE_THRESHOLD) {
                _hidden = true;
                container.classList.add('search-scrolled-away');
                peekBtn.classList.add('visible');
            } else if (_hidden && sy <= SHOW_THRESHOLD) {
                _hidden = false;
                container.classList.remove('search-scrolled-away');
                peekBtn.classList.remove('visible');
            }
            _lastScrollY = sy;
        });
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    // Retorna função de cleanup para quando o tema mudar
    _searchScrollCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        container.classList.remove('search-scrolled-away');
        peekBtn.classList.remove('visible');
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    };
}

let _bnavScrollCleanup = null;

function _setupBottomNavScrollBehaviour(enable) {
    // Limpa listener anterior
    if (_bnavScrollCleanup) { _bnavScrollCleanup(); _bnavScrollCleanup = null; }

    const nav = document.getElementById('bottom-nav');
    if (!nav) return;

    // Detecção de direcção: esconde ao descer, mostra ao subir
    const SCROLL_SENSITIVITY = 6;   // px mínimos de delta para reagir
    const SHOW_AT_TOP        = 30;  // px — perto do topo mostra sempre
    let _lastY   = window.scrollY;
    let _hidden  = false;
    let _rafId   = null;

    const onScroll = () => {
        if (_rafId) return;
        _rafId = requestAnimationFrame(() => {
            _rafId = null;
            const sy    = window.scrollY;
            const delta = sy - _lastY;
            _lastY = sy;

            if (sy <= SHOW_AT_TOP) {
                if (_hidden) { _hidden = false; nav.classList.remove('bnav-hidden'); if (window.innerWidth < 768 && document.getElementById('view-search')?.classList.contains('active')) document.getElementById('fab-add')?.classList.remove('bnav-hidden'); }
                return;
            }
            if (!_hidden && delta > SCROLL_SENSITIVITY) {
                _hidden = true;
                nav.classList.add('bnav-hidden');
                document.getElementById('fab-add')?.classList.add('bnav-hidden');
            } else if (_hidden && delta < -SCROLL_SENSITIVITY) {
                _hidden = false;
                nav.classList.remove('bnav-hidden');
                if (window.innerWidth < 768 && document.getElementById('view-search')?.classList.contains('active')) document.getElementById('fab-add')?.classList.remove('bnav-hidden');
            }
        });
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    _bnavScrollCleanup = () => {
        window.removeEventListener('scroll', onScroll);
        nav.classList.remove('bnav-hidden');
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    };
}



// Ponto de entrada único para mudança de tema
function setTheme(theme) {
    localStorage.setItem('hiperfrio-tema', theme);
    _applyTheme(theme);
    closeThemeDropdown();
}

// Sincroniza o dropdown com o tema activo
const _THEME_META = {
    light: { icon: '', label: 'Claro' },
    dark:  { icon: '', label: 'Escuro' },
    };
function _syncThemeDropdown(theme) {
    const meta = _THEME_META[theme] || _THEME_META.light;
    const iconEl  = document.getElementById('theme-dropdown-icon');
    const labelEl = document.getElementById('theme-dropdown-label');
    const descEl  = document.getElementById('theme-current-desc');
    if (iconEl)  iconEl.textContent  = meta.icon;
    if (labelEl) labelEl.textContent = meta.label;
    if (descEl)  descEl.textContent  = meta.label;
    // Tick nos itens do menu
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

function toggleThemeDropdown() {
    const menu = document.getElementById('theme-menu');
    const wrap = document.getElementById('theme-dropdown-wrap');
    if (!menu) return;
    const open = menu.classList.toggle('open');
    wrap?.classList.toggle('open', open);
    if (open) {
        // Fecha ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', closeThemeDropdown, { once: true });
        }, 0);
    }
}

function closeThemeDropdown() {
    document.getElementById('theme-menu')?.classList.remove('open');
    document.getElementById('theme-dropdown-wrap')?.classList.remove('open');
}

// =============================================
// INICIALIZAÇÃO
// =============================================

// =============================================
// DETECÇÃO DE CÓDIGO DUPLICADO
// =============================================
function checkDuplicateCodigo(codigo, onConfirm) {
    if (!codigo || codigo.toUpperCase() === 'SEMREF') {
        onConfirm(); return; // SEMREF é sempre permitido em duplicado
    }
    const stock = cache.stock.data || {};
    const dupes = Object.values(stock).filter(
        item => (item.codigo || '').toUpperCase() === codigo.toUpperCase()
    );
    if (dupes.length === 0) {
        onConfirm(); return;
    }
    // Existe duplicado — mostra modal de confirmação
    const names = dupes.map(d => d.nome || '(sem nome)').join(', ');
    document.getElementById('dup-modal-desc').textContent =
        `O código "${codigo.toUpperCase()}" já existe em: ${names}. Queres registar mesmo assim?`;
    document.getElementById('dup-confirm-btn').onclick = () => { closeDupModal(); onConfirm(); };
    document.getElementById('dup-modal').classList.add('active');
    focusModal('dup-modal');
}
function closeDupModal() {
    document.getElementById('dup-modal').classList.remove('active');
}

// =============================================
// UNIDADE DE MEDIDA — dropdown inline no input
// =============================================
// Fonte única de verdade para unidades — adicionar aqui para afectar toda a app
const UNITS = [
    { value: 'un', label: 'Unidade',     short: 'Unidade' },
    { value: 'L',  label: 'Litros (L)',  short: 'Litros'  },
    { value: 'm',  label: 'Metros (m)',  short: 'm'       },
    { value: 'm2', label: 'Metros² (m²)',short: 'm²'      },
];
// Mapas derivados
const UNIT_SHORT    = Object.fromEntries(UNITS.map(u => [u.value, u.short]));
const UNIT_PREFIXES = ['inp', 'bulk', 'edit'];

// Fecha todos os menus de unidade abertos
function _closeAllUnitMenus() {
    UNIT_PREFIXES.forEach(p => {
        document.getElementById(`${p}-unit-menu`)?.classList.remove('open');
        document.getElementById(`${p}-unit-btn`)?.classList.remove('active');
    });
}

// Listener nomeado para poder ser removido com segurança (ponto 7)
function _onOutsideUnitClick(e) {
    const isInsideAny = UNIT_PREFIXES.some(p =>
        document.getElementById(`${p}-unit-wrap`)?.contains(e.target)
    );
    if (!isInsideAny) {
        _closeAllUnitMenus();
        document.removeEventListener('click', _onOutsideUnitClick);
    }
}

function toggleUnitMenu(prefix) {
    const menu   = document.getElementById(`${prefix}-unit-menu`);
    const btn    = document.getElementById(`${prefix}-unit-btn`);
    const isOpen = menu.classList.contains('open');

    // Fecha todos primeiro (inclui outros menus de unidade)
    _closeAllUnitMenus();
    document.removeEventListener('click', _onOutsideUnitClick);

    if (!isOpen) {
        menu.classList.add('open');
        btn.classList.add('active');
        setTimeout(() => document.addEventListener('click', _onOutsideUnitClick), 0);
    }
}

function selectUnit(prefix, unit) {
    document.getElementById(`${prefix}-unidade`).value = unit;
    // Update button label
    const label = document.getElementById(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[unit] || unit;
    // Update active state in menu
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === unit);
    });
    // Close menu
    document.getElementById(`${prefix}-unit-menu`)?.classList.remove('open');
    document.getElementById(`${prefix}-unit-btn`)?.classList.remove('active');
}

function setUnitSelector(prefix, unit) {
    const val = unit || 'un';
    document.getElementById(`${prefix}-unidade`).value = val;
    const label = document.getElementById(`${prefix}-unit-label`);
    if (label) label.textContent = UNIT_SHORT[val] || val;
    document.querySelectorAll(`#${prefix}-unit-menu .unit-option`).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.unit === val);
    });
}

// Formata quantidade — só mostra unidade se não for "un"
function fmtQty(quantidade, unidade) {
    const qty = quantidade ?? 0;
    if (!unidade || unidade === 'un') return String(qty);
    return `${qty} ${UNIT_SHORT[unidade] || unidade}`;
}

// =============================================
// INVENTÁRIO GUIADO — v2
// Pontos: filtro por zona, revisão, retoma, stats, Excel, email
// =============================================

const INV_RESUME_KEY = 'hiperfrio-inv-resume';

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

    // Verifica se existe sessão guardada para retomar
    const saved = _invLoadResume();
    if (saved) {
        openConfirmModal({
            icon: '',
            title: 'Retomar inventário?',
            desc: `Tens um inventário em curso (${saved.idx + 1}/${saved.items.length} produtos). Continuar onde ficaste?`,
            onConfirm: () => _resumeInventory(saved),
        });
        // Adiciona botão "Começar novo" ao modal confirm
        setTimeout(() => {
            const okBtn = document.getElementById('confirm-modal-ok');
            if (!okBtn) return;
            let newBtn = document.getElementById('inv-resume-new-btn');
            if (!newBtn) {
                newBtn = document.createElement('button');
                newBtn.id        = 'inv-resume-new-btn';
                newBtn.className = 'btn-cancel';
                newBtn.style.cssText = 'width:100%;margin-top:6px;color:var(--text-muted)';
                newBtn.textContent = 'Começar novo inventário';
                newBtn.onclick = () => {
                    closeConfirmModal();
                    _invClearResume();
                    _openInvSetup(data);
                };
                okBtn.parentNode.insertBefore(newBtn, okBtn.nextSibling);
            }
        }, 60);
        return;
    }

    _openInvSetup(data);
}

function _openInvSetup(data) {
    // Extrai zonas únicas ordenadas
    const zones = [...new Set(
        Object.values(data)
            .filter(p => !String(p.codigo||'').startsWith('_tmp_'))
            .map(p => (p.localizacao||'').trim().toUpperCase())
            .filter(Boolean)
    )].sort((a,b) => a.localeCompare(b,'pt'));

    const container = document.getElementById('inv-setup-zones');
    container.innerHTML = '';

    if (zones.length === 0) {
        container.innerHTML = '<p class="modal-desc" style="margin:0">Todos os produtos serão inventariados (sem zonas definidas).</p>';
    } else {
        zones.forEach(zone => {
            const chip = document.createElement('button');
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

    document.getElementById('inv-skip-zeros').checked = false;
    _updateInvSetupBtn();
    document.getElementById('inv-setup-modal').classList.add('active');
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
    document.getElementById('inv-setup-modal').classList.remove('active');
}

async function invSetupStart() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const activeZones = chips.length === 0
        ? null
        : [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.zone);

    if (activeZones && activeZones.length === 0) return;

    const skipZeros = document.getElementById('inv-skip-zeros').checked;
    closeInvSetup();
    await _startInvWithOptions(activeZones, skipZeros);
}

async function _startInvWithOptions(zones, skipZeros) {
    const data = cache.stock.data;
    if (!data) return;
    _invLastData = data;

    const allChips  = document.querySelectorAll('.inv-zone-chip');
    const allZones  = allChips.length === 0 || zones === null
        || zones.length === document.querySelectorAll('.inv-zone-chip').length;

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

    document.getElementById('inv-modal').classList.add('active');
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
    _invLastData = cache.stock.data;
    document.getElementById('inv-modal').classList.add('active');
    focusModal('inv-modal');
    _renderInvStep();
    showToast(`A retomar — produto ${_invIdx + 1} de ${_invItems.length}`);
}

function _renderInvStep() {
    const total      = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    document.getElementById('inv-progress-text').textContent = `${_invIdx + 1} / ${total}`;
    document.getElementById('inv-progress-bar').style.width  = `${Math.round((_invIdx / total) * 100)}%`;

    const zona = (item.localizacao||'').trim().toUpperCase();
    document.getElementById('inv-local').textContent = zona ? ` ${zona}` : ' SEM LOCAL';
    document.getElementById('inv-ref').textContent   = item.codigo  || '';
    document.getElementById('inv-nome').textContent  = item.nome    || '';
    document.getElementById('inv-unidade').textContent =
        item.unidade && item.unidade !== 'un' ? item.unidade : '';

    // Badge de zona filtrada
    const badge = document.getElementById('inv-zone-badge');
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
    const qtyInput   = document.getElementById('inv-qtd');
    qtyInput.value   = currentVal;
    qtyInput.focus();
    qtyInput.select();

    // Mostra a quantidade original do sistema como referência
    const origEl = document.getElementById('inv-orig-qty');
    if (origEl) {
        const orig = item.quantidade || 0;
        origEl.textContent = `Sistema: ${fmtQty(orig, item.unidade)}`;
        origEl.className   = 'inv-orig-qty' + (_invChanges[id] !== undefined && _invChanges[id] !== orig ? ' inv-orig-changed' : '');
    }

    document.getElementById('inv-prev-btn').disabled = _invIdx === 0;
    _invSaveResume();
}

function invQtyDelta(delta) {
    const el = document.getElementById('inv-qtd');
    if (!el) return;
    el.value = Math.max(0, (parseFloat(el.value) || 0) + delta);
    el.focus();
}

function invConfirm() {
    const [id] = _invItems[_invIdx] || [];
    if (!id) return;
    const val = parseFloat(document.getElementById('inv-qtd').value);
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
    document.getElementById('inv-modal').classList.remove('active');
    // Progresso guardado — não apaga para possível retoma
}

function _finishInventory() {
    document.getElementById('inv-modal').classList.remove('active');
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

    const descEl = document.getElementById('inv-review-desc');
    descEl.textContent = changed.length === 0
        ? `${confirmed} produto${confirmed !== 1?'s':''} confirmado${confirmed !== 1?'s':''} — sem diferenças de quantidade.`
        : `${changed.length} diferença${changed.length !== 1?'s':''} encontrada${changed.length !== 1?'s':''}. Revê e confirma antes de guardar.`;

    const listEl = document.getElementById('inv-review-list');
    listEl.innerHTML = '';

    if (changed.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Tudo conforme ✓</div>';
    } else {
        changed.forEach(([id, newQty]) => {
            const item   = data[id] || {};
            const oldQty = item.quantidade || 0;
            const diff   = newQty - oldQty;
            const row    = document.createElement('label');
            row.className = 'inv-review-row';

            const cb  = document.createElement('input');
            cb.type   = 'checkbox';
            cb.checked = true;
            cb.dataset.id = id;
            cb.className  = 'inv-review-cb';

            const info = document.createElement('div');
            info.className = 'inv-review-info';

            const nome = document.createElement('span');
            nome.className   = 'inv-review-nome';
            nome.textContent = item.nome || id;

            const qty = document.createElement('span');
            qty.className = 'inv-review-qty';
            const sign = diff > 0 ? '+' : '';
            qty.innerHTML = `<span class="inv-rev-old">${fmtQty(oldQty, item.unidade)}</span>`
                + ` → <span class="inv-rev-new">${fmtQty(newQty, item.unidade)}</span>`
                + ` <span class="inv-rev-diff ${diff > 0 ? 'inv-rev-plus' : 'inv-rev-minus'}">(${sign}${fmtQty(diff, item.unidade)})</span>`;

            info.appendChild(nome);
            info.appendChild(qty);
            row.appendChild(cb);
            row.appendChild(info);
            listEl.appendChild(row);
        });
    }

    document.getElementById('inv-review-modal').classList.add('active');
    focusModal('inv-review-modal');
}

function invReviewBack() {
    document.getElementById('inv-review-modal').classList.remove('active');
    // Reabre o inventário no último produto
    document.getElementById('inv-modal').classList.add('active');
    _invSaveResume();
}

async function invReviewConfirm() {
    document.getElementById('inv-review-modal').classList.remove('active');

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
    const statsEl = document.getElementById('inv-result-stats');
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
    document.getElementById('inv-result-modal').classList.add('active');
    focusModal('inv-result-modal');
}

function closeInvResult() {
    document.getElementById('inv-result-modal').classList.remove('active');
}

async function exportInventoryExcel() {
    await loadXlsx();
    const wb       = _buildInventoryWorkbook();
    const filename = `inventario-hiperfrio-${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel exportado com sucesso!');
}

async function exportInventoryEmail() {
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

    const body = encodeURIComponent(
        'Inventário Hiperfrio — ' + dateStr + '\n\n'
        + 'Produtos verificados: ' + Object.keys(_invChanges).length + '/' + _invItems.length + '\n'
        + 'Diferenças encontradas: ' + diffRows.length + '\n\n'
        + (diffRows.length > 0 ? 'ALTERAÇÕES:\n' + diffRows.join('\n') + '\n\n' : 'Sem diferenças de stock.\n\n')
        + '(Ficheiro Excel em anexo — exportar com o botão "Exportar para Excel")'
    );

        const subject = encodeURIComponent(`Inventário Hiperfrio — ${dateStr}`);

    // Tenta Web Share API (Android partilha nativa com ficheiro)
    if (navigator.canShare) {
        try {
            // Gera o ficheiro para partilhar
            const wb   = _buildInventoryWorkbook();
            const blob = new Blob(
                [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
            );
            const file = new File([blob], `inventario-hiperfrio-${now.toISOString().slice(0,10)}.xlsx`,
                { type: blob.type });

            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title:   `Inventário Hiperfrio — ${dateStr}`,
                    text:    `Relatório de inventário de ${dateStr}`,
                    files:   [file],
                });
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('share:', e);
        }
    }

    // Fallback: download do Excel + abre cliente de email
    exportInventoryExcel();
    setTimeout(() => {
        window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
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
        ['Hiperfrio Stock — Relatório de Inventário',''],
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

function _invSaveResume() {
    try {
        localStorage.setItem(INV_RESUME_KEY, JSON.stringify({
            idx:     _invIdx,
            items:   _invItems,
            changes: _invChanges,
            skipped: [..._invSkipped],
            options: _invOptions,
            ts:      Date.now(),
        }));
    } catch (e) { console.warn('invSaveResume:', e); }
}

function _invLoadResume() {
    try {
        const raw = localStorage.getItem(INV_RESUME_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        // Ignora sessões com mais de 24 horas
        if (!saved || Date.now() - (saved.ts||0) > 86400000) { _invClearResume(); return null; }
        if (!saved.items || saved.items.length === 0) { _invClearResume(); return null; }
        return saved;
    } catch(_e) { return null; }
}

function _invClearResume() {
    localStorage.removeItem(INV_RESUME_KEY);
}

// =============================================
// PONTO 23: TIMELINE DE FERRAMENTAS
// =============================================
async function openToolTimeline() {
    const el = document.getElementById('timeline-list');
    el.innerHTML = '<div class="empty-msg">A carregar...</div>';
    document.getElementById('timeline-modal').classList.add('active');
    focusModal('timeline-modal');

    try {
        if (!navigator.onLine) {
            el.innerHTML = '<div class="empty-msg">Sem ligação — timeline indisponível offline.</div>';
            return;
        }
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData) { el.innerHTML = '<div class="empty-msg">Sem dados.</div>'; return; }

        // Recolhe todos os eventos de histórico
        const events = [];
        for (const [id, t] of Object.entries(ferrData)) {
            if (t.historico) {
                for (const ev of Object.values(t.historico)) {
                    events.push({ ...ev, toolNome: t.nome, toolIcone: t.icone || '', toolId: id });
                }
            }
            // Adiciona estado actual se alocada
            if (t.status === 'alocada' && t.dataEntrega) {
                const days = _calcDias(t.dataEntrega);
                events.push({
                    data: t.dataEntrega,
                    acao: 'alocada_agora',
                    colaborador: t.colaborador,
                    toolNome: t.nome,
                    toolIcone: t.icone || '',
                    toolId: id,
                    _dias: days
                });
            }
        }
        // Ordena do mais recente
        events.sort((a,b) => new Date(b.data) - new Date(a.data));

        el.innerHTML = '';
        if (events.length === 0) {
            el.innerHTML = '<div class="empty-msg">Sem eventos registados.</div>'; return;
        }

        let lastDate = '';
        events.slice(0, 100).forEach(ev => { // max 100 eventos
            const d     = new Date(ev.data);
            const dateStr = d.toLocaleDateString('pt-PT', { day:'numeric', month:'short', year:'numeric' });
            if (dateStr !== lastDate) {
                const sep = document.createElement('div');
                sep.className   = 'tl-date-sep';
                sep.textContent = dateStr;
                el.appendChild(sep);
                lastDate = dateStr;
            }
            const row  = document.createElement('div');
            const isOut = ev.acao === 'atribuida' || ev.acao === 'alocada_agora';
            row.className = `tl-event ${isOut ? 'tl-out' : 'tl-in'}`;

            const icoEl = document.createElement('span');
            icoEl.className = 'tl-tool-icon';
            icoEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

            const info = document.createElement('div');
            info.className = 'tl-info';

            const name = document.createElement('span');
            name.className   = 'tl-tool-name';
            name.textContent = ev.toolNome || '?';

            const action = document.createElement('span');
            action.className = 'tl-action';
            if (ev.acao === 'alocada_agora') {
                action.textContent = `🔴 Com ${ev.colaborador || '?'} há ${ev._dias}d`;
                action.className += ' tl-action-overdue';
            } else if (ev.acao === 'atribuida') {
                action.textContent = `→ Entregue a ${ev.colaborador || '?'}`;
            } else {
                action.textContent = `↩ Devolvida${ev.colaborador ? ' por ' + ev.colaborador : ''}`;
            }

            const time = document.createElement('span');
            time.className   = 'tl-time';
            time.textContent = d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });

            info.appendChild(name);
            info.appendChild(action);
            row.appendChild(icoEl);
            row.appendChild(info);
            row.appendChild(time);
            el.appendChild(row);
        });
    } catch(e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar timeline.</div>';
    }
}

function closeToolTimeline() {
    document.getElementById('timeline-modal').classList.remove('active');
}

// =============================================
// BOTTOM NAV — botão + com mini-menu
// =============================================
let _bnavAddOpen = false;

function bnavAddToggle() {
    _bnavAddOpen ? bnavAddClose() : bnavAddOpen();
}

function bnavAddOpen() {
    _bnavAddOpen = true;
    const menu    = document.getElementById('bnav-add-menu');
    const overlay = document.getElementById('bnav-add-overlay');
    const btn     = document.getElementById('fab-add');
    menu?.classList.add('open');
    overlay?.classList.add('open');
    btn?.classList.add('fab-open');
    document.addEventListener('keydown', _bnavAddEsc, { once: true });
}

function bnavAddClose() {
    _bnavAddOpen = false;
    const menu    = document.getElementById('bnav-add-menu');
    const overlay = document.getElementById('bnav-add-overlay');
    const btn     = document.getElementById('fab-add');
    menu?.classList.remove('open');
    overlay?.classList.remove('open');
    btn?.classList.remove('fab-open');
}

function _bnavAddEsc(e) {
    if (e.key === 'Escape') bnavAddClose();
}

function bnavAddChoose(viewId) {
    bnavAddClose();
    nav(viewId);
}

document.addEventListener('DOMContentLoaded', () => {
    // PAT: só aceita dígitos
    document.getElementById('pat-numero')?.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
        const hint = document.getElementById('pat-numero-hint');
        if (hint) {
            if (this.value.length > 0 && this.value.length < 6) {
                hint.textContent = `${this.value.length}/6 dígitos`;
                hint.style.color = 'var(--text-muted)';
            } else {
                hint.textContent = '';
            }
        }
    });

    // Tema
    const savedTheme = localStorage.getItem('hiperfrio-tema') || 'light';
    _applyTheme(savedTheme);
    // _applyTheme já chama _setupSearchScrollBehaviour e _setupBottomNavScrollBehaviour
    _setupAdminSwipe();

    // Verifica perfil guardado — se existir, arranca diretamente
    const savedRole = localStorage.getItem(ROLE_KEY);
    if (savedRole === 'worker' || savedRole === 'manager') {
        applyRole(savedRole);
        bootApp();
    }

    // Pesquisa com debounce — cache o elemento para evitar lookups repetidos
    const searchInput = document.getElementById('inp-search');
    const searchClear = document.getElementById('inp-search-clear');
    window._searchInputEl = searchInput; // referência global para renderList
    if (searchInput) {
        let debounceTimer;
        searchInput.oninput = e => {
            clearTimeout(debounceTimer);
            const val = e.target.value;
            if (searchClear) searchClear.classList.toggle('hidden', !val);
            if (val) { _zeroFilterActive = false; const b = document.getElementById('zero-filter-badge'); if (b) b.remove(); }
            debounceTimer = setTimeout(() => renderList(val), 300);
        };
    }

    // Pesquisa de ferramentas
    let _toolsSearchTimer;
    document.getElementById('inp-tools-search')?.addEventListener('input', e => {
        clearTimeout(_toolsSearchTimer);
        _toolsSearchTimer = setTimeout(() => {
            _toolsFilter = e.target.value.trim() || 'all';
            renderTools();
        }, 250);
    });

    // Escape fecha o modal ativo
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modals = [
            { id: 'worker-modal',       close: closeModal },
            { id: 'delete-modal',       close: closeDeleteModal },
            { id: 'edit-modal',         close: closeEditModal },
            { id: 'confirm-modal',      close: closeConfirmModal },
            { id: 'switch-role-modal',  close: closeSwitchRoleModal },
            { id: 'history-modal',      close: closeHistoryModal },
            { id: 'dup-modal',          close: closeDupModal },
            { id: 'inv-setup-modal',    close: closeInvSetup },
            { id: 'inv-modal',          close: closeInventory },
            { id: 'inv-review-modal',   close: invReviewBack },
            { id: 'inv-result-modal',   close: closeInvResult },
            { id: 'timeline-modal',     close: closeToolTimeline },
            { id: 'edit-tool-modal',    close: closeEditToolModal },
        ];
        for (const { id, close } of modals) {
            if (document.getElementById(id)?.classList.contains('active')) { close(); break; }
        }
        const anyUnitOpen = UNIT_PREFIXES.some(p =>
            document.getElementById(`${p}-unit-menu`)?.classList.contains('open')
        );
        if (anyUnitOpen) {
            _closeAllUnitMenus();
            document.removeEventListener('click', _onOutsideUnitClick);
        }
    });

    // Online/Offline
    window.addEventListener('offline', () => {
        updateOfflineBanner();
        showToast('Sem ligação — alterações guardadas localmente', 'error');
    });
    window.addEventListener('online', async () => {
        updateOfflineBanner();
        await syncQueue();
    });

    // Background Sync
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(sw => {
            window._registerBackgroundSync = () => {
                sw.sync.register('hiperfrio-sync').catch(() => {});
            };
        }).catch(() => {});
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', async e => {
            if (e.data?.type === 'SYNC_QUEUE') { await syncQueue(); }
        });
    }

    // Confirm modal OK
    document.getElementById('confirm-modal-ok').onclick = () => {
        const cb = confirmCallback; closeConfirmModal(); if (cb) cb();
    };

    // Delete confirm
    document.getElementById('delete-confirm-btn').onclick = async () => {
        if (!pendingDeleteId) return;
        const id   = pendingDeleteId;
        const item = cache.stock.data[id];
        closeDeleteModal();
        delete cache.stock.data[id];
        renderList(window._searchInputEl?.value || '', true);
        renderDashboard();
        showToast('Produto apagado');
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'DELETE' });
        } catch (e) {
            console.warn('deleteProduct erro:', e?.message || e);
            cache.stock.data[id] = item;
            renderList(window._searchInputEl?.value || '', true);
            renderDashboard();
            showToast('Erro ao apagar produto','error');
        }
    };

    // Form: Novo Produto
    document.getElementById('form-add')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = document.getElementById('inp-codigo').value.trim().toUpperCase();
        const payload = {
            nome:        document.getElementById('inp-nome').value.trim().toUpperCase(),
            localizacao: document.getElementById('inp-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat(document.getElementById('inp-qtd').value) || 0,
            unidade:     document.getElementById('inp-unidade').value || 'un',
            notas:       document.getElementById('inp-notas')?.value.trim() || '',
            codigo,
        };
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(`${BASE_URL}/stock.json`, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
                renderDashboard();
                setUnitSelector('inp', 'un');
                showToast('Produto Registado!'); nav('view-search'); e.target.reset();
            } catch(_e) { invalidateCache('stock'); showToast('Erro ao registar produto','error'); }
            finally { btn.disabled = false; }
        };
        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Lote
    document.getElementById('form-bulk')?.addEventListener('submit', async e => {
        e.preventDefault();
        const btn    = e.target.querySelector('button[type=submit]');
        const codigo = document.getElementById('bulk-codigo').value.trim().toUpperCase();
        const zona   = document.getElementById('bulk-loc').value.trim().replace(/\s+/g,'').toUpperCase();
        const payload = {
            localizacao: zona,
            codigo,
            nome:       document.getElementById('bulk-nome').value.trim().toUpperCase(),
            quantidade: parseFloat(document.getElementById('bulk-qtd').value) || 0,
            unidade:    document.getElementById('bulk-unidade').value || 'un',
            notas:      document.getElementById('bulk-notas')?.value.trim() || '',
        };
        const doSave = async () => {
            btn.disabled = true;
            try {
                const res = await apiFetch(`${BASE_URL}/stock.json`, { method:'POST', body:JSON.stringify(payload) });
                if (!cache.stock.data) cache.stock.data = {};
                if (res) { const r = await res.json(); if (r?.name) cache.stock.data[r.name] = payload; }
                else { cache.stock.data[`_tmp_${Date.now()}`] = payload; }
                _bulkCount++;
                _updateBulkCounter();
                _saveZoneToHistory(zona);
                showToast(`${payload.codigo} adicionado ao lote!`);
                document.getElementById('bulk-codigo').value = '';
                document.getElementById('bulk-nome').value   = '';
                document.getElementById('bulk-qtd').value    = '1';
                document.getElementById('bulk-notas').value  = '';
                document.getElementById('bulk-codigo').focus();
            } catch(_e) { invalidateCache('stock'); showToast('Erro ao adicionar ao lote','error'); }
            finally { btn.disabled = false; }
        };
        checkDuplicateCodigo(codigo, doSave);
    });

    // Form: Editar Produto
    document.getElementById('form-edit')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id  = document.getElementById('edit-id').value;
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        const updated = {
            codigo:      document.getElementById('edit-codigo').value.trim().toUpperCase(),
            nome:        document.getElementById('edit-nome').value.trim().toUpperCase(),
            localizacao: document.getElementById('edit-loc').value.trim().replace(/\s+/g,'').toUpperCase(),
            quantidade:  parseFloat(document.getElementById('edit-qtd').value) || 0,
            unidade:     document.getElementById('edit-unidade').value || 'un',
            notas:       document.getElementById('edit-notas')?.value.trim() || '',
        };
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        btn.textContent = 'A guardar...';
        closeEditModal();
        renderList(window._searchInputEl?.value || '', true);
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'PATCH', body:JSON.stringify(updated) });
            showToast('Produto atualizado!');
        } catch (e) { console.warn('editProduct:', e?.message||e); invalidateCache('stock'); showToast('Erro ao guardar alterações','error'); }
        finally { btn.disabled = false; btn.textContent = 'Guardar Alterações'; }
    });

    // Form: Funcionário
    document.getElementById('form-worker')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome = document.getElementById('worker-name').value.trim().toUpperCase();
        if (!nome) return;
        try {
            const res = await apiFetch(`${BASE_URL}/funcionarios.json`, { method:'POST', body:JSON.stringify({nome}) });
            if (!cache.funcionarios.data) cache.funcionarios.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.funcionarios.data[r.name] = {nome}; }
            else { cache.funcionarios.data[`_tmp_${Date.now()}`] = {nome}; }
            document.getElementById('worker-name').value = '';
            renderWorkers(); showToast('Funcionário adicionado');
        } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao adicionar funcionário','error'); }
    });

    // Form: Registar Ferramenta
    document.getElementById('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        const nome  = document.getElementById('reg-tool-name').value.trim().toUpperCase();
        const payload = { nome, status:'disponivel' };
        try {
            const res = await apiFetch(`${BASE_URL}/ferramentas.json`, { method:'POST', body:JSON.stringify(payload) });
            if (!cache.ferramentas.data) cache.ferramentas.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.ferramentas.data[r.name] = payload; }
            else { cache.ferramentas.data[`_tmp_${Date.now()}`] = payload; }
            document.getElementById('reg-tool-name').value = '';
            renderAdminTools(); showToast('Ferramenta registada');
        } catch(_e) { invalidateCache('ferramentas'); showToast('Erro ao registar ferramenta','error'); }
    });

    // Form: Editar Ferramenta
    document.getElementById('form-edit-tool')?.addEventListener('submit', async e => {
        e.preventDefault();
        await saveEditTool();
    });
});

// =============================================
// REGISTO PWA
// =============================================
const SW_EXPECTED_VERSION = 'hiperfrio-v5.69';

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // 1 — Regista o SW novo
        navigator.serviceWorker.register('sw.js?v=5.66')
            .then(reg => {
                // 2 — Verifica se o SW activo é a versão correcta
                // Se for uma versão antiga (cache-first), força update imediato
                if (reg.active) {
                    const msgChannel = new MessageChannel();
                    msgChannel.port1.onmessage = e => {
                        if (e.data && e.data.version !== SW_EXPECTED_VERSION) {
                            console.warn('SW desactualizado — a forçar update...');
                            reg.update().then(() => {
                                // Após update, recarrega para aplicar
                                navigator.serviceWorker.addEventListener('controllerchange', () => {
                                    window.location.reload();
                                }, { once: true });
                            });
                        }
                    };
                    reg.active.postMessage({ type: 'GET_VERSION' }, [msgChannel.port2]);
                }
            })
            .catch(e => console.warn('PWA SW erro:', e));

        // 3 — Se o SW mudar enquanto a app está aberta, recarrega automaticamente
        let swRefreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!swRefreshing) {
                swRefreshing = true;
                window.location.reload();
            }
        });
    });
}

// =============================================
// CLIENTES — autocomplete Nº Cliente no modal PAT
// =============================================
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
    const dd = document.getElementById('pat-client-dropdown');
    const q  = val.trim();
    if (!q) { dd.innerHTML = ''; _removeClientOutsideListener(); return; }

    const data = _clientesCache.data || {};

    // Número exacto — verifica quantos clientes partilham esse NR
    if (/^\d{1,3}$/.test(q)) {
        const exactMatches = Object.values(data).filter(c => c.numero === q);
        if (exactMatches.length === 1) {
            document.getElementById('pat-estabelecimento').value = exactMatches[0].nome;
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
    const matches = Object.values(data)
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
        const hdr = document.createElement('div');
        hdr.className = 'pat-dd-header';
        hdr.textContent = matches.length + ' estabelecimentos com este Nº — escolhe:';
        dd.appendChild(hdr);
    }
    matches.forEach((c, i) => {
        const opt = document.createElement('div');
        opt.className = 'pat-dd-option';
        opt.dataset.idx = i;
        const codeEl = document.createElement('span'); codeEl.className = 'pat-dd-code'; codeEl.textContent = c.numero;
        const nameEl = document.createElement('span'); nameEl.className = 'pat-dd-name';  nameEl.textContent = c.nome;
        opt.appendChild(codeEl); opt.appendChild(nameEl);
        opt.onmousedown = (e) => {
            e.preventDefault();
            document.getElementById('pat-cliente-num').value    = c.numero;
            document.getElementById('pat-estabelecimento').value = c.nome;
            dd.innerHTML = '';
            _removeClientOutsideListener();
        };
        dd.appendChild(opt);
    });
}

function _clientOutsideHandler(e) {
    const wrap = document.querySelector('.pat-client-wrap');
    if (wrap && !wrap.contains(e.target)) {
        document.getElementById('pat-client-dropdown').innerHTML = '';
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
    const dd   = document.getElementById('pat-client-dropdown');
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
    const list = document.getElementById('clientes-list');
    if (!list) return;
    list.innerHTML = '<div class="pat-loading">A carregar...</div>';
    const data    = await _fetchClientes(true);
    const entries = Object.entries(data || {})
        .sort((a, b) => Number(a[1].numero) - Number(b[1].numero));
    if (entries.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum cliente. Usa o botão acima para importar.</div>';
        return;
    }
    list.innerHTML = '';
    const total = document.createElement('div');
    total.className   = 'clientes-total';
    total.textContent = `${entries.length} clientes`;
    list.appendChild(total);
    entries.forEach(([id, c]) => {
        const row = document.createElement('div');
        row.className = 'admin-list-row';
        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label clientes-list-label';
        lbl.textContent = c.numero.padStart(3, '0') + '  ·  ' + c.nome;
        const del = document.createElement('button');
        del.className   = 'admin-list-delete';
        del.textContent = '🗑';
        del.onclick = () => openConfirmModal({
            icon: '', title: 'Apagar cliente?',
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
        row.appendChild(lbl);
        row.appendChild(del);
        list.appendChild(row);
    });
}

// ── Importar Excel de clientes ─────────────────────────────────────────────
function importClientesExcel() {
    const preview = document.getElementById('clientes-import-preview');
    preview.innerHTML = '<div class="clientes-preview-info">Para actualizar a lista, importa o ficheiro <strong>clientes_firebase.json</strong> na <a href="https://console.warn.google.com" target="_blank" style="color:var(--primary)">Firebase Console</a> → Realtime Database → nó <code>/clientes</code> → ⋮ Import JSON.</div>';
}

// =============================================
// PEDIDOS PAT
// =============================================
let _patProducts = []; // {id, codigo, nome, quantidade}
let _patDropdownIdx = -1;

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

function _autoLimparHistorico() {
    const expirados = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === 'historico' && p.saidaEm && _calcDias(p.saidaEm) >= 15);
    if (!expirados.length) return;
    expirados.forEach(([id]) => {
        apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' }).catch(() => {});
        delete _patCache.data[id];
    });
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

var _patSearchQuery  = '';
var _patTab          = 'pendentes'; // 'pendentes' | 'levantadas' | 'historico'
var _patSelMode      = false;       // modo seleção para levantar
var _patSelWorker    = '';          // funcionário escolhido
var _patSelIds       = new Set();   // IDs seleccionados

let _patSearchTimer;
function patSearchFilter(val) {
    clearTimeout(_patSearchTimer);
    _patSearchTimer = setTimeout(() => {
        _patSearchQuery = (val || '').toLowerCase().trim();
        renderPats();
    }, 250);
}

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

    const pop = document.createElement('div');
    pop.className = 'dup-popover';
    pop.innerHTML = `
        <div class="dup-pop-title">PATs — ${escapeHtml(pats[0]?.[1]?.estabelecimento || estabNorm)}</div>
        ${pats.map(([, p]) => {
            const dias = _calcDias(p.criadoEm);
            const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
            const urgente = dias >= 15;
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
    const el = document.getElementById('pat-list');
    if (!el) return;
    el.innerHTML = '<div class="pat-loading">A carregar...</div>';

    // Sync tab UI
    ['pendentes','levantadas','historico'].forEach(t => {
        document.getElementById(`pat-tab-${t}`)?.classList.toggle('active', _patTab === t);
    });
    const guiaFilter = document.getElementById('pat-guia-filter');
    const showGuiaFilter = _patTab === 'levantadas' || _patTab === 'historico';
    if (guiaFilter) guiaFilter.style.display = showGuiaFilter ? 'flex' : 'none';
    const soGuias = showGuiaFilter && document.getElementById('pat-guia-only')?.checked;

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

    // ── Pendentes: lista plana (comportamento original) ──────────────────
    if (_patTab === 'pendentes') {
        const estabCount = {};
        entries.forEach(([, p]) => {
            const n = (p.estabelecimento || '').trim().toLowerCase();
            if (n) estabCount[n] = (estabCount[n] || 0) + 1;
        });
        entries.forEach(([id, pat]) => el.appendChild(_buildPatCard(id, pat, 'pendentes', estabCount)));
        updatePatCount();
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
        const header = document.createElement('div');
        header.className = 'pat-group-header';
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
    const card = document.createElement('div');
    const separacao = !!pat.separacao;
    const isLev = tab === 'levantadas';
    const isHist = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);

    card.className = 'pat-card'
        + (separacao ? ' pat-card-separacao' : '')
        + (isLev  ? ' pat-card-levantada' : '')
        + (isHist ? ' pat-card-historico'  : '')
        + (isSelected ? ' pat-card-selected' : '');

    const dias = _calcDias(pat.criadoEm);
    const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Há 1 dia' : `Há ${dias} dias`;
    const urgente = tab === 'pendentes' && dias >= 15;
    const nomeNorm = (pat.estabelecimento || '').trim().toLowerCase();

    // Top row
    const cardTop = document.createElement('div');
    cardTop.className = 'pat-card-top';
    const cardTopLeft = document.createElement('div');
    cardTopLeft.className = 'pat-card-top-left';

    if (_patSelMode) {
        const cb = document.createElement('span');
        cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');
        cb.innerHTML = isSelected ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '';
        cardTopLeft.appendChild(cb);
    }

    const patBadge = document.createElement('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || '—');
    cardTopLeft.appendChild(patBadge);

    if (separacao) {
        const sepTag = document.createElement('span');
        sepTag.className   = 'pat-sep-tag';
        sepTag.textContent = ' Guia Transporte';
        cardTopLeft.appendChild(sepTag);
    }

    if (tab === 'pendentes') {
        const dupCount = estabCount[nomeNorm] || 0;
        if (dupCount > 1) {
            const dupBadge = document.createElement('span');
            dupBadge.className     = 'pat-dup-badge';
            dupBadge.dataset.estab = nomeNorm;
            dupBadge.textContent   = `! ${dupCount} pedidos`;
            cardTopLeft.appendChild(dupBadge);
        }
    }

    // Data label consoante o tab
    const diasSpan = document.createElement('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && pat.saidaEm) {
        const d = new Date(pat.saidaEm);
        diasSpan.textContent = d.toLocaleDateString('pt-PT', { day:'2-digit', month:'2-digit' });
        // Indicador de expiração: dias restantes no histórico
        const diasRestantes = 15 - _calcDias(pat.saidaEm);
        if (diasRestantes <= 3) {
            diasSpan.title = `Apagado em ${diasRestantes}d`;
            diasSpan.style.color = 'var(--text-muted)';
        }
    } else if (isLev && pat.levantadoEm) {
        diasSpan.textContent = new Date(pat.levantadoEm).toLocaleDateString('pt-PT', { day:'2-digit', month:'2-digit' });
    } else {
        diasSpan.textContent = diasLabel;
    }
    cardTop.appendChild(cardTopLeft);
    cardTop.appendChild(diasSpan);

    const estabDiv = document.createElement('div');
    estabDiv.className   = 'pat-card-estab';
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    const prodsDiv = document.createElement('div');
    prodsDiv.className = 'pat-card-produtos';
    (pat.produtos || []).forEach(p => {
        const chip = document.createElement('span');
        chip.className   = 'pat-prod-chip';
        chip.textContent = (p.codigo || '?') + ' × ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pat-card-actions';
    actionsDiv.onclick   = e => e.stopPropagation();

    if (_patSelMode) {
        // Botão de editar referências (não faz toggle, abre modal)
        const btnRefs = document.createElement('button');
        btnRefs.className = 'pat-btn-refs';
        btnRefs.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Refs';
        btnRefs.onclick = (e) => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionsDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnLev = document.createElement('button');
        btnLev.className = 'pat-btn-levantado';
        btnLev.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btnLev.appendChild(document.createTextNode('Dar como levantado'));
        btnLev.onclick = () => marcarPatLevantado(id);
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnLev);
        actionsDiv.appendChild(btnDel);
    } else if (tab === 'levantadas') {
        const btnSaida = document.createElement('button');
        btnSaida.className = 'pat-btn-guia';
        btnSaida.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Dar saída';
        btnSaida.onclick = () => darSaidaPat(id);
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnSaida);
        actionsDiv.appendChild(btnDel);
    } else if (tab === 'historico') {
        // Histórico: só apagar manualmente
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnDel);
    }

    card.appendChild(cardTop);
    card.appendChild(estabDiv);
    card.appendChild(prodsDiv);
    if (actionsDiv.children.length > 0) card.appendChild(actionsDiv);

    card.onclick = (e) => {
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
    const bar = document.getElementById('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    const searchEl = document.getElementById('pat-search');
    if (searchEl) searchEl.value = '';
    _patSearchQuery = '';
    if (tab === 'pendentes') {
        const cbEl = document.getElementById('pat-guia-only');
        if (cbEl) cbEl.checked = false;
    }
    renderPats();
}

// ── Levantar Encomenda — modal de funcionário ─────────────
async function openLevantarModal() {
    const modal = document.getElementById('levantar-modal');
    const list  = document.getElementById('levantar-worker-list');
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
        const opt = document.createElement('div');
        opt.className   = 'worker-option';
        opt.textContent = w.nome;
        opt.onclick     = () => { closeLevantarModal(); startLevantarMode(w.nome); };
        list.appendChild(opt);
    });
}
function closeLevantarModal() {
    document.getElementById('levantar-modal')?.classList.remove('active');
}

// ── Modo de seleção para levantar ─────────────────────────
function startLevantarMode(workerNome) {
    _patTab       = 'pendentes';
    _patSelMode   = true;
    _patSelWorker = workerNome;
    _patSelIds.clear();
    const bar = document.getElementById('pat-sel-bar');
    if (bar) bar.style.display = 'flex';
    const workerEl = document.getElementById('pat-sel-worker');
    if (workerEl) workerEl.textContent = workerNome;
    _updateLevantarBtn();
    renderPats();
}

function cancelLevantarMode() {
    _patSelMode   = false;
    _patSelWorker = '';
    _patSelIds.clear();
    const bar = document.getElementById('pat-sel-bar');
    if (bar) bar.style.display = 'none';
    renderPats();
}

function patSelToggleAll() {
    const pats = _patCache.data || {};
    const pendentes = Object.entries(pats).filter(([, p]) => p.status !== 'levantado');
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
    const btn = document.getElementById('pat-levantar-btn');
    if (!btn) return;
    btn.textContent = `Levantar ${_patSelIds.size}`;
    btn.disabled    = _patSelIds.size === 0;
}

async function levantarSelectedPats() {
    if (_patSelIds.size === 0) return;
    const ids    = [..._patSelIds];
    const worker = _patSelWorker;

    openConfirmModal({
        icon: '✅',
        title: `Levantar ${ids.length} PAT${ids.length > 1 ? 's' : ''}?`,
        desc: `Serão marcadas como levantadas por ${worker}. As que têm guia de transporte descontam stock.`,
        onConfirm: async () => {
            try {
                for (const id of ids) {
                    const pat = _patCache.data?.[id];
                    if (!pat) continue;
                    const payload = { status: 'levantado', levantadoEm: Date.now(), funcionario: worker };
                    await apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                        method: 'PATCH',
                        body: JSON.stringify(payload),
                    });
                    if (_patCache.data?.[id]) Object.assign(_patCache.data[id], payload);

                    if (pat.separacao && pat.produtos?.length) {
                        for (const p of pat.produtos) {
                            if (!p.id) continue;
                            const atual = cache.stock.data?.[p.id]?.quantidade ?? 0;
                            const nova  = Math.max(0, atual - (p.quantidade || 1));
                            if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = nova;
                            const sUrl = await authUrl(`${BASE_URL}/stock/${p.id}.json`);
                            await fetch(sUrl, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ quantidade: nova }),
                            }).catch(() => {});
                        }
                    }
                }
                cancelLevantarMode();
                renderList();
                updatePatCount();
                showToast(`${ids.length} PAT${ids.length > 1 ? 's' : ''} levantada${ids.length > 1 ? 's' : ''} por ${worker}!`);
            } catch(_e) { showToast('Erro ao levantar pedidos', 'error'); }
        }
    });
}

// ── Dar saída — apaga a PAT levantada imediatamente ─────
async function darSaidaPat(id) {
    const pat = _patCache.data?.[id];
    openConfirmModal({
        icon: '✅',
        title: 'Dar saída a esta PAT?',
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
        icon: '🗑',
        title: `Limpar ${alvo.length} registo${alvo.length > 1 ? 's' : ''}?`,
        desc: `Remove todas as PATs do ${label}. Esta acção é irreversível.`,
        onConfirm: async () => {
            try {
                for (const [id] of alvo) {
                    await apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' });
                    delete _patCache.data[id];
                }
                renderPats();
                updatePatCount();
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
    document.getElementById('pat-refs-title').textContent  = 'PAT ' + (pat.numero || '');
    document.getElementById('pat-refs-estab').textContent  = pat.estabelecimento || '';
    document.getElementById('pat-refs-search').value       = '';
    document.getElementById('pat-refs-dropdown').innerHTML = '';
    _renderRefsChips();
    document.getElementById('pat-refs-modal').classList.add('active');
    setTimeout(() => document.getElementById('pat-refs-search').focus(), 80);
}

function closePatRefsModal() {
    document.getElementById('pat-refs-modal').classList.remove('active');
    _patRefsId = null;
}

function patRefsSearch(val) {
    _patRefsDDIdx = -1;
    const dd = document.getElementById('pat-refs-dropdown');
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
        const manual = document.createElement('div');
        manual.className = 'pat-dd-option pat-dd-manual';
        manual.innerHTML = `<span class="pat-dd-code">${escapeHtml(val.trim().toUpperCase())}</span><span class="pat-dd-name" style="color:var(--text-muted)">→ Adicionar manual</span>`;
        manual.onmousedown = (e) => { e.preventDefault(); patRefsAddManual(val.trim()); };
        dd.appendChild(manual);
    }

    matches.forEach(([id, item], i) => {
        const opt = document.createElement('div');
        opt.className = 'pat-dd-option';
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
    const dd   = document.getElementById('pat-refs-dropdown');
    const opts = dd.querySelectorAll('.pat-dd-option');
    const val  = document.getElementById('pat-refs-search').value.trim();
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
    document.getElementById('pat-refs-search').value = '';
    document.getElementById('pat-refs-dropdown').innerHTML = '';
    document.getElementById('pat-refs-search').focus();
    _renderRefsChips();
}

function patRefsAddManual(raw) {
    const codigo = raw.toUpperCase().trim();
    if (!codigo) return;
    if (_patRefsList.some(p => p.codigo === codigo && !p.id)) return;
    _patRefsList.push({ id: null, codigo, nome: '', quantidade: 1 });
    document.getElementById('pat-refs-search').value = '';
    document.getElementById('pat-refs-dropdown').innerHTML = '';
    document.getElementById('pat-refs-search').focus();
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
    const el = document.getElementById('pat-refs-chips');
    el.innerHTML = '';
    _patRefsList.forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'pat-chip';
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
    } catch(_e) { showToast('Erro ao guardar', 'error'); }
}

function openPatModal() {
    _patProducts = [];
    document.getElementById('pat-numero').value = '';
    document.getElementById('pat-cliente-num').value = '';
    document.getElementById('pat-client-dropdown').innerHTML = '';
    document.getElementById('pat-estabelecimento').value = '';
    _fetchClientes();
    document.getElementById('pat-product-search').value = '';
    document.getElementById('pat-product-dropdown').innerHTML = '';
    document.getElementById('pat-product-chips').innerHTML = '';
    document.getElementById('pat-numero-hint').textContent = '';
    document.getElementById('pat-separacao').checked = false;
    document.getElementById('pat-modal').classList.add('active');
    focusModal('pat-modal');
    setTimeout(() => document.getElementById('pat-numero').focus(), 80);
}

function closePatModal() {
    document.getElementById('pat-modal').classList.remove('active');
    document.getElementById('pat-product-dropdown').innerHTML = '';
}

// =============================================
// ANTHROPIC API KEY — gestão local
// =============================================
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
    const val = document.getElementById('inp-anthropic-key').value.trim();
    if (val && !_isProxyUrl(val) && !val.startsWith('sk-ant-')) {
        showToast('Valor inválido — introduz o URL do Worker (https://...) ou uma chave sk-ant-...', 'error');
        return;
    }
    if (val) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, val);
        document.getElementById('inp-anthropic-key').value = '';
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
        const el = document.getElementById(id);
        if (el) { el.textContent = text; el.style.color = color; }
    });
}

function openOcrSettings() {
    _updateOcrKeyStatus();
    _loadOcrKeywordsInput();
    // Pré-preenche o campo da chave
    const key = _getAnthropicKey();
    const inp = document.getElementById('inp-anthropic-key');
    if (inp && key) inp.value = key;
    document.getElementById('ocr-settings-modal').classList.add('active');
    focusModal('ocr-settings-modal');
}

function closeOcrSettings() {
    document.getElementById('ocr-settings-modal').classList.remove('active');
}

async function testAnthropicProxy() {
    const val = _getAnthropicKey();
    if (!val) { showToast('Configura primeiro o URL do Worker', 'error'); return; }

    const btn = document.getElementById('btn-test-ocr');
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

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                messages: [{ role: 'user', content: 'Hi' }]
            })
        });

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

// =============================================
// OCR KEYWORDS — palavras-chave de estabelecimento
// =============================================
const OCR_KEYWORDS_KEY = 'hiperfrio-ocr-keywords';

function saveOcrKeywords() {
    const val = document.getElementById('inp-ocr-keywords').value.trim();
    if (val) localStorage.setItem(OCR_KEYWORDS_KEY, val);
    else localStorage.removeItem(OCR_KEYWORDS_KEY);
    showToast('Palavras-chave guardadas ✓', 'ok');
}

function _getOcrKeywords() {
    return (localStorage.getItem(OCR_KEYWORDS_KEY) || '')
        .split('\n').map(k => k.trim()).filter(Boolean);
}

function _loadOcrKeywordsInput() {
    const el = document.getElementById('inp-ocr-keywords');
    if (el) el.value = _getOcrKeywords().join('\n');
}

// =============================================
// PAT SCAN — câmara
// =============================================
let _patScanStream = null;

async function patScanStartCamera() {
    try {
        _patScanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        const video = document.getElementById('pat-scan-video');
        video.srcObject = _patScanStream;
        video.style.display = 'block';
        document.getElementById('pat-scan-placeholder').style.display = 'none';
        document.getElementById('pat-scan-preview').style.display    = 'none';
        document.getElementById('pat-scan-row-load').style.display    = 'none';
        document.getElementById('pat-scan-row-capture').style.display = 'flex';
        _patScanSetStatus('Câmara activa — aponta para o documento e captura', '');
    } catch(e) {
        // Câmara não disponível — mostrar botões de fallback (Galeria)
        document.getElementById('pat-scan-placeholder').style.display = 'flex';
        document.getElementById('pat-scan-row-load').style.display    = 'flex';
        // Esconder botão câmara pois não está disponível
        const camBtn = document.getElementById('pat-scan-cam-btn');
        if (camBtn) camBtn.style.display = 'none';
        _patScanSetStatus('Câmara não disponível — usa a Galeria', 'error');
    }
}

function patScanCapture() {
    const video  = document.getElementById('pat-scan-video');
    const canvas = document.getElementById('pat-scan-canvas');
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d').drawImage(video, 0, 0);
    _patScanMime = 'image/jpeg';
    _patScanB64  = canvas.toDataURL('image/jpeg', 0.80).split(',')[1];

    const prev = document.getElementById('pat-scan-preview');
    prev.src = canvas.toDataURL('image/jpeg', 0.80);
    prev.style.display = 'block';
    video.style.display = 'none';

    patScanStopCamera();
    document.getElementById('pat-scan-row-capture').style.display = 'none';
    document.getElementById('pat-scan-row-analyse').style.display = 'flex';
    // Auto-analisar se houver chave API configurada
    if (_getAnthropicKey()) {
        patScanAnalyse();
    } else {
        _patScanSetStatus('Foto capturada — clica em Analisar', '');
    }
}

function patScanStopCamera() {
    if (_patScanStream) {
        _patScanStream.getTracks().forEach(t => t.stop());
        _patScanStream = null;
    }
    document.getElementById('pat-scan-video').style.display = 'none';
}

// =============================================
// PAT SCAN — preenchimento por fotografia (OCR via Claude Vision)
// =============================================
let _patScanB64  = null;
let _patScanMime = 'image/jpeg';

function openPatScan() {
    patScanReset();
    document.getElementById('pat-scan-modal').classList.add('active');
    focusModal('pat-scan-modal');
}

function closePatScan() {
    patScanStopCamera();
    document.getElementById('pat-scan-modal').classList.remove('active');
}

function patScanFromFile(inp) {
    const f = inp.files[0];
    if (!f) return;
    _patScanMime = f.type || 'image/jpeg';
    const r = new FileReader();
    r.onload = e => {
        _patScanB64 = e.target.result.split(',')[1];
        // mostra preview
        document.getElementById('pat-scan-placeholder').style.display = 'none';
        const prev = document.getElementById('pat-scan-preview');
        prev.src = e.target.result;
        prev.style.display = 'block';
        document.getElementById('pat-scan-row-load').style.display = 'none';
        document.getElementById('pat-scan-row-analyse').style.display = 'flex';
        _patScanSetStatus('Imagem carregada — clica em Analisar', '');
    };
    r.readAsDataURL(f);
}

function patScanReset() {
    _patScanB64 = null;
    patScanStopCamera();
    document.getElementById('pat-scan-video').style.display       = 'none';
    document.getElementById('pat-scan-preview').style.display     = 'none';
    document.getElementById('pat-scan-placeholder').style.display = 'flex';
    document.getElementById('pat-scan-row-load').style.display    = 'flex';
    document.getElementById('pat-scan-row-capture').style.display = 'none';
    document.getElementById('pat-scan-row-analyse').style.display = 'none';
    document.getElementById('pat-scan-result').style.display      = 'none';
    const f1 = document.getElementById('pat-scan-file');
    const f2 = document.getElementById('pat-scan-file-2');
    if (f1) f1.value = '';
    if (f2) f2.value = '';
    _patScanSetStatus('', '');
}

function _patScanSetStatus(msg, cls) {
    const el = document.getElementById('pat-scan-status');
    el.textContent = msg;
    el.className   = 'pat-scan-status' + (cls ? ' ' + cls : '');
}

async function patScanAnalyse() {
    if (!_patScanB64) return;
    const btn = document.getElementById('pat-scan-go');
    btn.disabled = true;

    const apiKey = _getAnthropicKey();

    try {
        let patNum = null, patConf = 0, estab = null, estabConf = 0;

        if (apiKey) {
            // ── Modo Claude Vision (alta qualidade) ──────────────────────────
            _patScanSetStatus('A analisar com Claude Vision…', 'loading');

            const keywords = _getOcrKeywords();
            const kwHint = keywords.length > 0
                ? `\\n\\nPALAVRAS-CHAVE DE ESTABELECIMENTO (palavras que identificam o nome do cliente neste documento): ${keywords.map(k => '"' + k + '"').join(', ')}. Se encontrares uma linha que contenha alguma destas palavras, usa essa linha como nome do estabelecimento.`
                : '';

            const prompt = `És um sistema de OCR especializado em documentos de assistência técnica portugueses.

O documento pode ter qualquer formato: folha A4 impressa, papel térmico, recibo manuscrito, ou até uma fita com texto escrito à mão. Adapta-te ao formato que vês.

Extrai os dois campos abaixo. Segue RIGOROSAMENTE estas regras:

CAMPO 1 — pat_numero:
- É um número com EXACTAMENTE 6 dígitos
- Pode aparecer sozinho sem qualquer prefixo, ou precedido de "PAT", "OS", "N.º", "Ref." ou similar
- Ignora qualquer número que não tenha exactamente 6 dígitos
- Pode estar em qualquer zona do documento
- Se não encontrares, devolve null

CAMPO 2 — estabelecimento:
- É o nome do local/cliente onde a assistência foi prestada
- NUNCA tem prefixo ou label — aparece sozinho, sem "Cliente:", "Nome:" ou similar
- Pode aparecer em qualquer posição relativamente ao número PAT: antes, depois, acima, abaixo
- CADEIAS CONHECIDAS: o estabelecimento pertence quase sempre a uma destas cadeias — procura estas palavras-chave e extrai o nome completo que as acompanha:
    • "Pingo Doce" ou "PDD" = Pingo Doce (ex: "PINGO DOCE BRAGA RETAIL", "PDD VIANA")
    • "Continente" (ex: "CONTINENTE MODELO COIMBRA")
    • "Recheio" (ex: "RECHEIO PORTO")
- O nome completo inclui a palavra-chave da cadeia mais o identificador específico da loja
- Devolve o nome em MAIÚSCULAS${kwHint}
- Se não encontrares, devolve null

CONFIANÇA:
- pat_confianca: 0.0 a 1.0 (0.9+ = leste claramente, 0.5 = razoável, <0.4 = incerto)
- estab_confianca: 0.0 a 1.0

Responde APENAS com JSON válido, sem markdown, sem explicações:
{"pat_numero": "...", "estabelecimento": "...", "pat_confianca": 0.0, "estab_confianca": 0.0}`;
            const isProxy = _isProxyUrl(apiKey);
            const endpoint = isProxy ? apiKey : 'https://api.anthropic.com/v1/messages';
            const headers = { 'Content-Type': 'application/json' };
            if (!isProxy) {
                headers['x-api-key'] = apiKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-allow-browser'] = 'true';
            }

            const resp = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 300,
                    messages: [{ role: 'user', content: [
                        { type: 'image', source: { type: 'base64', media_type: _patScanMime, data: _patScanB64 } },
                        { type: 'text', text: prompt }
                    ]}]
                })
            });

            if (!resp.ok) {
                const e = await resp.json().catch(() => ({}));
                if (resp.status === 401) throw new Error('Chave API inválida ou expirada — actualiza em Admin → Definições');
                throw new Error(e?.error?.message || `HTTP ${resp.status}`);
            }

            const data   = await resp.json();
            const raw    = data.content?.map(b => b.text || '').join('') || '';
            const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());

            patNum    = result.pat_numero;
            patConf   = result.pat_confianca || 0;
            estab     = result.estabelecimento;
            estabConf = result.estab_confianca || 0;

        } else {
            // ── Modo Tesseract (OCR local, sem chave) ─────────────────────────
            _patScanSetStatus('A carregar motor OCR…', 'loading');
            await loadTesseract();

            const dataUrl = `data:${_patScanMime};base64,${_patScanB64}`;

            const { data: { text } } = await Tesseract.recognize(dataUrl, 'por', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const pct = Math.round((m.progress || 0) * 100);
                        _patScanSetStatus(`A reconhecer texto… ${pct}%`, 'loading');
                    }
                }
            });

            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const patRx = [
                /(?:PAT|OS|N[º°.]?\s*(?:PAT|OS)?)\s*[:\-]?\s*(\d{4,8})/i,
                /\b(\d{5,8})\b/
            ];
            for (const rx of patRx) {
                const m = text.match(rx);
                if (m) { patNum = m[1]; patConf = rx === patRx[0] ? 0.75 : 0.45; break; }
            }
            const skipWords = /^(PAT|OS|DATA|TÉCNICO|SERVIÇO|TEL|NIF|FAX|MORADA|RUA|AV|HORA|\d+)$/i;
            const nameLines = lines.filter(l =>
                l.length > 4 && l.length < 60 &&
                !/^\d+$/.test(l) &&
                !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(l) &&
                !skipWords.test(l.split(/\s/)[0])
            );
            const estabKw = nameLines.find(l => /CAFÉ|SNACK|BAR|REST|HOTEL|MINI|SUPER|MERCADO|LDA|SA\b|UNIP|POSTO/i.test(l));
            if (estabKw) { estab = estabKw.toUpperCase(); estabConf = 0.70; }
            else if (nameLines.length > 0) { estab = nameLines[0].toUpperCase(); estabConf = 0.40; }
        }

        // ── Preenche resultado ────────────────────────────────────────────────
        _patScanFill('ps-pat',   patNum, patConf,   'ps-pat-conf');
        _patScanFill('ps-estab', estab,  estabConf, 'ps-estab-conf');
        document.getElementById('pat-scan-result').style.display = 'flex';
        const mode = apiKey ? 'Claude Vision' : 'OCR local';
        _patScanSetStatus(`✓ Análise concluída (${mode}) — revê e confirma`, 'ok');

    } catch(e) {
        const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || 'Erro desconhecido';
        _patScanSetStatus('Erro: ' + msg, 'error');
        console.error('[patScan]', e);
    } finally {
        btn.disabled = false;
    }
}

function _patScanFill(inputId, value, conf, confId) {
    const inp  = document.getElementById(inputId);
    const badge = document.getElementById(confId);
    inp.value  = value || '';
    if (badge) {
        const pct = Math.round((conf || 0) * 100);
        badge.textContent = pct + '%';
        badge.className   = 'pat-scan-conf ' + (pct >= 75 ? 'high' : pct >= 50 ? 'mid' : 'low');
        badge.style.display = value ? '' : 'none';
    }
}

function patScanApply() {
    const pat   = document.getElementById('ps-pat').value.trim();
    const estab = document.getElementById('ps-estab').value.trim().toUpperCase();

    closePatScan();

    // Abrir o modal (que limpa os campos) e só depois preencher
    const patModalOpen = document.getElementById('pat-modal').classList.contains('active');
    if (!patModalOpen) openPatModal();

    // Preencher após o modal estar aberto (openPatModal tem setTimeout de 80ms para focus)
    setTimeout(() => {
        if (pat)   document.getElementById('pat-numero').value        = pat;
        if (estab) document.getElementById('pat-estabelecimento').value = estab;
        showToast('Campos preenchidos — revê antes de guardar', 'info');
    }, 100);
}

function patProductSearch(val) {
    _patDropdownIdx = -1;
    const dd = document.getElementById('pat-product-dropdown');
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
        const opt = document.createElement('div');
        opt.className = 'pat-dd-option';
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
    const dd = document.getElementById('pat-product-dropdown');
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
    document.getElementById('pat-product-search').value = '';
    document.getElementById('pat-product-dropdown').innerHTML = '';
    document.getElementById('pat-product-search').focus();
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
    const el = document.getElementById('pat-product-chips');
    el.innerHTML = '';
    _patProducts.forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'pat-chip';
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
    const numero      = document.getElementById('pat-numero').value.trim();
    const clienteNum  = document.getElementById('pat-cliente-num').value.trim();
    const estab       = document.getElementById('pat-estabelecimento').value.trim().toUpperCase();
    const separacao = document.getElementById('pat-separacao').checked;
    const hint      = document.getElementById('pat-numero-hint');

    if (!/^\d{6}$/.test(numero)) {
        hint.textContent = 'O Nº PAT deve ter exactamente 6 dígitos.';
        hint.style.color = 'var(--danger)';
        document.getElementById('pat-numero').focus();
        return;
    }
    hint.textContent = '';

    // Verificar duplicado — não permitir registar a mesma PAT duas vezes
    const patsExistentes = Object.values(_patCache.data || {});
    const duplicado = patsExistentes.find(p => p.numero === numero && p.status !== 'levantado');
    if (duplicado) {
        hint.textContent = `PAT ${numero} já está registada (${duplicado.estabelecimento || 'sem estabelecimento'}).`;
        hint.style.color = 'var(--danger)';
        document.getElementById('pat-numero').focus();
        return;
    }

    const payload = {
        numero,
        clienteNumero: clienteNum || null,
        estabelecimento: estab,
        separacao,
        produtos: _patProducts.map(p => ({
            id: p.id,
            codigo: p.codigo,
            nome: p.nome,
            quantidade: p.quantidade || 1
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
            // offline — guarda com ID temporário para mostrar imediatamente
            _patCache.data[`_tmp_pat_${Date.now()}`] = payload;
        }
        closePatModal();
        renderPats();
        showToast(res ? `PAT ${numero} registada!` : `PAT ${numero} guardada offline — sincroniza quando tiveres ligação`);
    } catch(_e) { showToast('Erro ao guardar pedido', 'error'); }
}

async function marcarPatLevantado(id) {
    const pat = _patCache.data?.[id];
    const separacao = !!pat?.separacao;

    const desc = separacao
        ? 'Pedido com Separação de Material — o stock dos produtos será descontado automaticamente.'
        : 'O pedido será removido dos pendentes. O stock não será alterado.';

    openConfirmModal({
        icon: '✅',
        title: 'Marcar como levantado?',
        desc,
        onConfirm: async () => {
            try {
                // 1 — Marca como levantado na Firebase (com suporte offline)
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'levantado', levantadoEm: Date.now() }),
                });
                if (_patCache.data?.[id]) _patCache.data[id].status = 'levantado';

                // 2 — Se separação: desconta stock de cada produto
                if (separacao && pat.produtos?.length) {
                    const patches = pat.produtos.map(async (p) => {
                        if (!p.id) return;
                        const stockItem = cache.stock.data?.[p.id];
                        const atual = stockItem?.quantidade ?? 0;
                        const novaQty = Math.max(0, atual - (p.quantidade || 1));
                        // Actualiza cache local
                        if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = novaQty;
                        // PATCH na Firebase
                        const sUrl = await authUrl(`${BASE_URL}/stock/${p.id}.json`);
                        return fetch(sUrl, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ quantidade: novaQty }),
                        });
                    });
                    await Promise.allSettled(patches);
                    renderList(); // actualiza lista de stock
                }

                renderPats();
                updatePatCount();
                showToast(separacao ? 'Levantado — stock descontado!' : 'Pedido marcado como levantado!');
            } catch(_e) { showToast('Erro ao actualizar pedido', 'error'); }
        }
    });
}

async function apagarPat(id) {
    openConfirmModal({
        icon: '',
        title: 'Apagar pedido?',
        desc: 'O pedido será eliminado permanentemente. O stock não é alterado.',
        onConfirm: async () => {
            try {
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
    const dias = _calcDias(pat.criadoEm);
    const data = pat.criadoEm ? new Date(pat.criadoEm).toLocaleDateString('pt-PT') : '—';
    const urgente = dias >= 15;
    const separacao = !!pat.separacao;

    document.getElementById('pat-detail-body').innerHTML = `
        <div class="pat-detail-header">
            <span class="pat-badge ${urgente ? 'pat-badge-urgente' : ''}" style="font-size:1rem;padding:6px 14px">PAT ${escapeHtml(pat.numero || '—')}</span>
            ${pat.clienteNumero ? `<span class="pat-cliente-badge" style="font-size:0.9rem;padding:5px 12px">${escapeHtml(pat.clienteNumero)}</span>` : ''}
            ${separacao ? '<span class="pat-sep-tag" style="margin-top:8px"> Guia Transporte de Material</span>' : ''}
        </div>
        ${pat.clienteNumero ? `<div class="pat-detail-row"><span class="pat-detail-lbl">Nº Cliente</span><span>${escapeHtml(pat.clienteNumero)}</span></div>` : ''}
        <div class="pat-detail-row"><span class="pat-detail-lbl">Estabelecimento</span><span>${escapeHtml(pat.estabelecimento || 'Não especificado')}</span></div>
        <div class="pat-detail-row"><span class="pat-detail-lbl">Criado em</span><span>${data}</span></div>
        <div class="pat-detail-row"><span class="pat-detail-lbl">Desconto stock</span><span>${separacao ? '✅ Sim (ao levantar)' : '⊘ Não'}</span></div>
        <div class="pat-detail-row"><span class="pat-detail-lbl">Estado</span><span>${urgente ? '🔴 Urgente' : '🟡 Pendente'} (${dias === 0 ? 'hoje' : `${dias}d`})</span></div>
        ${pat.produtos?.length ? `
        <div class="pat-detail-lbl" style="margin-top:14px;margin-bottom:8px">Produtos reservados</div>
        <div class="pat-detail-produtos">
            ${pat.produtos.map(p => `
                <div class="pat-detail-prod">
                    <span class="pat-dd-code">${escapeHtml(p.codigo || '?')}</span>
                    <span class="pat-dd-name">${escapeHtml(p.nome || '')}</span>
                    <span class="pat-detail-qty">× ${p.quantidade || 1}</span>
                </div>`).join('')}
        </div>` : '<div class="pat-empty" style="margin-top:12px">Sem produtos associados.</div>'}
        <div class="pat-detail-actions">
            <button class="pat-btn-levantado" style="flex:1" onclick="closePatDetail();marcarPatLevantado('${id}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Dar como levantado</button>
            <button class="pat-btn-apagar" onclick="closePatDetail();apagarPat('${id}')">🗑</button>
        </div>`;
    document.getElementById('pat-detail-modal').classList.add('active');
    focusModal('pat-detail-modal');
}

function closePatDetail() {
    document.getElementById('pat-detail-modal').classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════════════
// ENCOMENDAS A FORNECEDOR  (REST API — mesmo padrão do resto da app)
// Firebase: /encomendas/{id}
//   num, fornecedor, data, obs, estado, ts
//   linhas: { "0": {ref, nome, qtd, recebido}, ... }
// ══════════════════════════════════════════════════════════════════════════

const ENC_URL = `${BASE_URL}/encomendas`;

let _encFilter  = 'all';
let _encData    = {};
let _encDataTs  = 0;
const ENC_TTL   = 60000;
let _encEditId  = null;
let _encEntradaId   = null;
let _encEntradaLIdx = null;

// ── Carregar dados ────────────────────────────────────────────────────────
async function loadEncomendas(force = false) {
    if (!force && _encDataTs && (Date.now() - _encDataTs < ENC_TTL)) {
        renderEncList();
        return;
    }
    try {
        const res  = await apiFetch(`${ENC_URL}.json`);
        _encData   = res ? await res.json() : {};
        if (!_encData) _encData = {};
        _encDataTs = Date.now();
        renderEncList();
    } catch(e) {
        console.error('[encomendas] load error', e);
    }
}

// Carrega quando navega para a view
document.addEventListener('DOMContentLoaded', () => {

    // Desktop layout: sidebar visível, bottom nav escondido
    function applyDesktopLayout() {
        const isDesktop = window.innerWidth >= 768;
        const bottomNav = document.getElementById('bottom-nav');
        const sideMenu  = document.getElementById('side-menu');
        const appLayout = document.getElementById('app-layout');

        if (isDesktop) {
            if (bottomNav) bottomNav.style.display = 'none';
            const fab = document.getElementById('fab-add');
            if (fab) fab.style.display = 'none';
            const closeBtn = document.getElementById('close-menu');
            if (closeBtn) closeBtn.style.display = 'none';
            if (sideMenu) {
                sideMenu.style.position = 'relative';
                sideMenu.style.left = '0';
                sideMenu.style.top = '0';
                sideMenu.style.height = 'calc(100vh - 60px)';
                sideMenu.style.boxShadow = 'none';
                sideMenu.style.zIndex = '100';
                sideMenu.style.overflowY = 'auto';
            }
            if (appLayout) {
                appLayout.style.flexDirection = 'row';
                appLayout.style.alignItems = 'flex-start';
            }
        } else {
            if (bottomNav) bottomNav.style.display = '';
            const fab = document.getElementById('fab-add');
            if (fab) fab.style.display = '';
            const closeBtn = document.getElementById('close-menu');
            if (closeBtn) closeBtn.style.display = '';
            if (sideMenu) {
                sideMenu.style.position = '';
                sideMenu.style.left = '';
                sideMenu.style.top = '';
                sideMenu.style.height = '';
                sideMenu.style.boxShadow = '';
                sideMenu.style.zIndex = '';
                sideMenu.style.overflowY = '';
            }
            if (appLayout) {
                appLayout.style.flexDirection = '';
                appLayout.style.alignItems = '';
            }
        }
    }

    applyDesktopLayout();
    window.addEventListener('resize', applyDesktopLayout);
});

// ── Render lista ──────────────────────────────────────────────────────────
function renderEncList() {
    const wrap = document.getElementById('enc-list');
    if (!wrap) return;

    let entries = Object.entries(_encData)
        .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

    if (_encFilter !== 'all')
        entries = entries.filter(([, e]) => e.estado === _encFilter);

    wrap.innerHTML = '';

    if (entries.length === 0) {
        const label = _encFilter === 'all' ? 'Nenhuma encomenda registada' : 'Nenhuma encomenda ' + _encFilter;
        const sub   = _encFilter === 'all' ? 'Cria a primeira encomenda com o bot\u00e3o acima.' : 'N\u00e3o existem encomendas com este estado.';
        wrap.innerHTML = `
            <div class="enc-empty">
                <div class="enc-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                        <line x1="12" y1="22.08" x2="12" y2="12"/>
                    </svg>
                </div>
                <div class="enc-empty-title">${escapeHtml(label)}</div>
                <div class="enc-empty-text">${escapeHtml(sub)}</div>
            </div>`;
        return;
    }

    entries.forEach(([id, enc]) => {
        const linhas   = Object.values(enc.linhas || {});
        const total    = linhas.reduce((s, l) => s + (parseFloat(l.qtd) || 0), 0);
        const recebido = linhas.reduce((s, l) => s + Math.min(parseFloat(l.recebido) || 0, parseFloat(l.qtd) || 0), 0);
        const pct      = total > 0 ? Math.round(recebido / total * 100) : 0;
        const estadoLabel = { pendente: 'Pendente', parcial: 'Parcial', recebida: 'Recebida' }[enc.estado] || 'Pendente';
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : '—';

        // Card
        const card = document.createElement('div');
        card.className = 'enc-card';
        card.onclick   = () => openEncDetail(id);

        // Top row
        const top = document.createElement('div');
        top.className = 'enc-card-top';

        const left = document.createElement('div');
        const num  = document.createElement('div');
        num.className   = 'enc-card-num';
        num.textContent = 'Encomenda Nº ' + (enc.num || '—');
        const forn = document.createElement('div');
        forn.className   = 'enc-card-forn';
        forn.textContent = enc.fornecedor || '—';
        left.appendChild(num);
        left.appendChild(forn);

        const right = document.createElement('div');
        right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px';
        const badge = document.createElement('span');
        badge.className   = 'enc-badge enc-badge-' + (enc.estado || 'pendente');
        badge.textContent = estadoLabel;
        const date = document.createElement('span');
        date.className   = 'enc-card-date';
        date.textContent = dataFmt;
        right.appendChild(badge);
        right.appendChild(date);

        top.appendChild(left);
        top.appendChild(right);

        // Progress
        const progWrap = document.createElement('div');
        progWrap.className = 'enc-progress-wrap';
        const bar = document.createElement('div');
        bar.className = 'enc-progress-bar';
        const fill = document.createElement('div');
        fill.className    = 'enc-progress-fill';
        fill.style.width  = pct + '%';
        bar.appendChild(fill);
        const lbl = document.createElement('div');
        lbl.className   = 'enc-progress-label';
        lbl.textContent = `${recebido} / ${total} unidades recebidas (${pct}%)`;
        progWrap.appendChild(bar);
        progWrap.appendChild(lbl);

        card.appendChild(top);
        card.appendChild(progWrap);
        wrap.appendChild(card);
    });
}

function encFilterSet(btn, filter) {
    _encFilter = filter;
    document.querySelectorAll('.enc-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderEncList();
}

// ── Calculadora de Stock por Peso ─────────────────────────────────────────

function openWeightCalc() {
    weightCalcReset();
    document.getElementById('weight-calc-modal').classList.add('active');
    focusModal('weight-calc-modal');
    setTimeout(() => document.getElementById('wc-sample-units')?.focus(), 120);
}

function closeWeightCalc() {
    document.getElementById('weight-calc-modal').classList.remove('active');
}

function weightCalcReset() {
    ['wc-sample-units','wc-sample-weight','wc-total-weight'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('wc-unit-weight').textContent = '';
    document.getElementById('wc-result').style.display = 'none';
}

function weightCalcUpdate() {
    const sampleUnits  = parseFloat(document.getElementById('wc-sample-units').value);
    const sampleWeight = parseFloat(document.getElementById('wc-sample-weight').value);
    const totalWeight  = parseFloat(document.getElementById('wc-total-weight').value);

    const unitWeightEl = document.getElementById('wc-unit-weight');
    const resultEl     = document.getElementById('wc-result');
    const resultValEl  = document.getElementById('wc-result-value');
    const resultSubEl  = document.getElementById('wc-result-sub');

    // Mostrar peso por unidade
    if (sampleUnits > 0 && sampleWeight > 0) {
        const unitGrams = sampleWeight / sampleUnits;
        unitWeightEl.textContent = `≈ ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)} g por unidade`;
    } else {
        unitWeightEl.textContent = '';
    }

    // Calcular resultado
    if (sampleUnits > 0 && sampleWeight > 0 && totalWeight > 0) {
        const unitGrams = sampleWeight / sampleUnits;
        const units     = totalWeight / unitGrams;
        const rounded   = Math.round(units);
        const exact     = units % 1 === 0;

        resultValEl.textContent = rounded.toLocaleString('pt-PT');
        resultSubEl.textContent = exact
            ? `${totalWeight}g ÷ ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)}g = ${rounded} unidades exactas`
            : `${totalWeight}g ÷ ${unitGrams.toFixed(2)}g = ${units.toFixed(2)} → arredondado para ${rounded}`;
        resultEl.style.display = 'flex';
    } else {
        resultEl.style.display = 'none';
    }
}

// ── Importar PDF de encomenda via Claude ───────────────────────────────────

async function encImportPdf(inp) {
    const file = inp.files[0];
    if (!file) return;
    inp.value = '';

    const apiKey = _getAnthropicKey();
    if (!apiKey) {
        showToast('Configura o Worker em Definições → Leitura por fotografia', 'error');
        return;
    }

    const label = document.getElementById('enc-pdf-label');
    const originalHTML = label ? label.innerHTML : '';
    if (label) {
        label.innerHTML = '◷';
        label.style.pointerEvents = 'none';
        label.style.opacity = '0.6';
    }
    showToast('A analisar PDF…', 'info');

    try {
        const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result.split(',')[1]);
            r.onerror = () => rej(new Error('Erro a ler o ficheiro'));
            r.readAsDataURL(file);
        });

        const prompt = `Analisa este documento PDF de encomenda a fornecedor.

Extrai os seguintes campos e responde APENAS com JSON válido, sem markdown:

{
  "numero": "número da encomenda (alfanumérico) ou null",
  "fornecedor": "nome do fornecedor em MAIÚSCULAS ou null",
  "linhas": [
    { "ref": "referência do produto ou string vazia", "nome": "designação do produto em MAIÚSCULAS", "qtd": número }
  ]
}

REGRAS:
- numero: procura campos "N.º Encomenda", "Ordem de Compra", "OC", "PO", "Ref."
- fornecedor: quem fornece os produtos — procura "Fornecedor", "Supplier", "Para", "A/C"
- linhas: extrai TODAS as linhas de produtos com referência, designação e quantidade encomendada
- qtd deve ser número inteiro — usa coluna "Qtd", "Quantidade", "Qty" ou similar
- Se qtd não existir num produto, usa 1
- Responde APENAS com o JSON`;

        const isProxy  = _isProxyUrl(apiKey);
        const endpoint = isProxy ? apiKey : 'https://api.anthropic.com/v1/messages';
        const headers  = { 'Content-Type': 'application/json' };
        if (!isProxy) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-allow-browser'] = 'true';
        }

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1500,
                messages: [{ role: 'user', content: [
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                    { type: 'text', text: prompt }
                ]}]
            })
        });

        if (!resp.ok) {
            const e = await resp.json().catch(() => ({}));
            if (resp.status === 401) throw new Error('Chave API inválida — actualiza em Definições');
            throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }

        const data   = await resp.json();
        const raw    = data.content?.map(b => b.text || '').join('') || '';
        const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());

        openNovaEncomenda();
        if (result.numero)     document.getElementById('enc-num').value        = result.numero;
        if (result.fornecedor) document.getElementById('enc-fornecedor').value = result.fornecedor;

        if (Array.isArray(result.linhas) && result.linhas.length > 0) {
            document.getElementById('enc-linhas-wrap').innerHTML = '';
            for (const l of result.linhas) {
                encAddLinha(l.ref || '', l.nome || '', l.qtd ?? 1);
            }
        }

        const n = result.linhas?.length || 0;
        showToast(`PDF importado — ${n} produto${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}. Revê antes de guardar`, 'ok');

    } catch(e) {
        showToast('Erro ao importar PDF: ' + (e?.message || e), 'error');
        console.error('[encImportPdf]', e);
    } finally {
        if (label) {
            label.innerHTML = originalHTML;
            label.style.pointerEvents = '';
            label.style.opacity = '';
        }
    }
}

// ── Modal criar ───────────────────────────────────────────────────────────
function openNovaEncomenda() {
    _encEditId = null;
    document.getElementById('enc-modal-title').textContent = 'Nova Encomenda';
    document.getElementById('enc-num').value        = '';
    document.getElementById('enc-data').value       = new Date().toISOString().split('T')[0];
    document.getElementById('enc-fornecedor').value = '';
    document.getElementById('enc-obs').value        = '';
    document.getElementById('enc-linhas-wrap').innerHTML = '';
    encAddLinha();
    document.getElementById('enc-modal').classList.add('active');
    focusModal('enc-modal');
}

function closeEncModal() {
    document.getElementById('enc-modal').classList.remove('active');
}

function encAddLinha(ref = '', nome = '', qtd = '') {
    const wrap = document.getElementById('enc-linhas-wrap');
    const div  = document.createElement('div');
    div.className = 'enc-linha';
    div.innerHTML = `
        <input class="blue-input enc-linha-ref"  type="text"   placeholder="Ref."       value="${escapeHtml(String(ref))}"  autocomplete="off" spellcheck="false">
        <input class="blue-input enc-linha-nome" type="text"   placeholder="Designação" value="${escapeHtml(String(nome))}" autocomplete="off" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input enc-linha-qtd"  type="number" placeholder="Qtd."       value="${qtd}" min="0" step="0.01">
        <button class="enc-linha-del" onclick="this.closest('.enc-linha').remove()">✕</button>`;
    wrap.appendChild(div);
}

async function saveEncomenda() {
    const num  = document.getElementById('enc-num').value.trim();
    const data = document.getElementById('enc-data').value;
    const forn = document.getElementById('enc-fornecedor').value.trim();
    const obs  = document.getElementById('enc-obs').value.trim();

    if (!num)  { showToast('Indica o número da encomenda', 'error'); return; }
    if (!forn) { showToast('Indica o fornecedor', 'error'); return; }

    const linhasEls = document.querySelectorAll('#enc-linhas-wrap .enc-linha');
    const linhas = {};
    let i = 0;
    for (const el of linhasEls) {
        const ref  = el.querySelector('.enc-linha-ref').value.trim().toUpperCase();
        const nome = el.querySelector('.enc-linha-nome').value.trim();
        const qtd  = parseFloat(el.querySelector('.enc-linha-qtd').value) || 0;
        if (!nome && !ref) continue;
        linhas[i] = { ref, nome, qtd, recebido: 0 };
        i++;
    }
    if (i === 0) { showToast('Adiciona pelo menos um produto', 'error'); return; }

    const payload = { num, fornecedor: forn, data, obs, estado: 'pendente', ts: Date.now(), linhas };

    try {
        const res = await apiFetch(`${ENC_URL}.json`, { method: 'POST', body: JSON.stringify(payload) });
        if (res) { const r = await res.json(); if (r?.name) _encData[r.name] = payload; }
        showToast('Encomenda criada ✓', 'ok');
        closeEncModal();
        renderEncList();
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro ao guardar: ' + e.message, 'error');
    }
}

// ── Detalhe ───────────────────────────────────────────────────────────────
function openEncDetail(id) {
    const enc = _encData[id];
    if (!enc) return;
    _encEditId = id;

    const dataFmt = enc.data ? enc.data.split('-').reverse().join('/') : '—';
    document.getElementById('enc-detail-title').textContent = `Encomenda Nº ${enc.num || '—'}`;
    document.getElementById('enc-detail-sub').textContent   =
        `${enc.fornecedor || '—'} · ${dataFmt}${enc.obs ? ' · ' + enc.obs : ''}`;

    const linhas = enc.linhas || {};
    document.getElementById('enc-detail-linhas').innerHTML = Object.entries(linhas).map(([idx, l]) => {
        const qtd      = parseFloat(l.qtd) || 0;
        const recebido = Math.min(parseFloat(l.recebido) || 0, qtd);
        const pct      = qtd > 0 ? Math.round(recebido / qtd * 100) : 0;
        const cor      = pct >= 100 ? '#16a34a' : pct > 0 ? '#f59e0b' : 'var(--primary)';
        const done     = recebido >= qtd && qtd > 0;
        return `<div class="enc-detail-linha">
            <div class="enc-detail-linha-top">
                <div style="flex:1;min-width:0">
                    ${l.ref ? `<span class="enc-detail-ref">${escapeHtml(l.ref)}</span> ` : ''}
                    <span class="enc-detail-nome">${escapeHtml(l.nome || '—')}</span>
                </div>
                <div class="enc-detail-qty">${recebido}/${qtd}</div>
            </div>
            <div class="enc-detail-prog-wrap">
                <div class="enc-detail-prog-bar">
                    <div class="enc-detail-prog-fill" style="width:${pct}%;background:${cor}"></div>
                </div>
                <div class="enc-detail-prog-label">${pct}% recebido</div>
            </div>
            <button class="enc-entrada-btn ${done ? 'enc-entrada-btn-done' : ''}"
                ${done ? 'disabled' : `onclick="openEntradaModal('${id}',${idx})"`}>
                ${done ? '✓ Totalmente recebido' : '↓ Dar entrada'}
            </button>
        </div>`;
    }).join('');

    document.getElementById('enc-detail-modal').classList.add('active');
    focusModal('enc-detail-modal');
}

function closeEncDetail() {
    document.getElementById('enc-detail-modal').classList.remove('active');
}

async function deleteEncomenda() {
    if (!_encEditId) return;
    const enc = _encData[_encEditId];
    openConfirmModal({
        icon: '🗑',
        title: 'Apagar encomenda?',
        desc: `Encomenda Nº ${enc?.num} será apagada permanentemente.`,
        onConfirm: async () => {
            try {
                await apiFetch(`${ENC_URL}/${_encEditId}.json`, { method: 'DELETE' });
                // Remover do cache local imediatamente
                delete _encData[_encEditId];
                showToast('Encomenda apagada', 'ok');
                closeEncDetail();
                renderEncList();
                loadEncomendas(true);
            } catch(e) {
                showToast('Erro: ' + e.message, 'error');
            }
        }
    });
}

// ── Dar entrada ───────────────────────────────────────────────────────────
function openEntradaModal(encId, lIdx) {
    _encEntradaId   = encId;
    _encEntradaLIdx = lIdx;
    const l = _encData[encId]?.linhas?.[lIdx];
    if (!l) return;
    const falta = (parseFloat(l.qtd) || 0) - (parseFloat(l.recebido) || 0);
    document.getElementById('enc-entrada-desc').textContent =
        `${l.ref ? '[' + l.ref + '] ' : ''}${l.nome} — faltam ${falta} unidades`;
    const inp = document.getElementById('enc-entrada-qty');
    inp.value = falta;
    inp.max   = falta;
    document.getElementById('enc-entrada-info').textContent =
        `Já recebido: ${parseFloat(l.recebido) || 0} · Encomendado: ${parseFloat(l.qtd) || 0}`;
    document.getElementById('enc-entrada-modal').classList.add('active');
    focusModal('enc-entrada-modal');
    setTimeout(() => inp.focus(), 100);
}

function closeEntradaModal() {
    document.getElementById('enc-entrada-modal').classList.remove('active');
}

async function confirmarEntrada() {
    const qty = parseFloat(document.getElementById('enc-entrada-qty').value);
    if (isNaN(qty) || qty <= 0) { showToast('Quantidade inválida', 'error'); return; }

    const enc = _encData[_encEntradaId];
    const l   = enc?.linhas?.[_encEntradaLIdx];
    if (!l) return;

    const novoRecebido = Math.min((parseFloat(l.recebido) || 0) + qty, parseFloat(l.qtd) || 0);
    const novasLinhas  = { ...(enc.linhas || {}) };
    novasLinhas[_encEntradaLIdx] = { ...l, recebido: novoRecebido };
    const novoEstado   = _calcEstado(novasLinhas);

    try {
        await apiFetch(`${ENC_URL}/${_encEntradaId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({
                [`linhas/${_encEntradaLIdx}/recebido`]: novoRecebido,
                estado: novoEstado
            })
        });
        // Actualizar cache local imediatamente
        if (_encData[_encEntradaId]?.linhas?.[_encEntradaLIdx]) {
            _encData[_encEntradaId].linhas[_encEntradaLIdx].recebido = novoRecebido;
            _encData[_encEntradaId].estado = novoEstado;
        }
        showToast(`Entrada de ${qty} confirmada ✓`, 'ok');
        closeEntradaModal();
        renderEncList();
        openEncDetail(_encEntradaId);
        // Sincroniza com Firebase em background
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

function _calcEstado(linhas) {
    const arr = Object.values(linhas);
    if (arr.every(l => (parseFloat(l.recebido) || 0) >= (parseFloat(l.qtd) || 0))) return 'recebida';
    if (arr.some(l => (parseFloat(l.recebido) || 0) > 0)) return 'parcial';
    return 'pendente';
}
