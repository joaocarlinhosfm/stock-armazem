// NOTA DE SEGURANÃ‡A (#24): a apiKey do Firebase Ã© pÃºblica por design.
// A protecÃ§Ã£o real Ã© feita pelas Firebase Security Rules (exigem Anonymous Auth).
// Confirmar que as rules nÃ£o permitem leitura/escrita sem token vÃ¡lido.
const BASE_URL = "https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app";
window.BASE_URL = BASE_URL;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// _calcDias(tsOrStr, tsEnd?) â€” dias de calendÃ¡rio entre dois pontos
// tsEnd opcional â€” se omitido usa hoje. Conta 1 dia a partir das 00:00.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _calcDias(tsOrStr, tsEnd) {
    if (!tsOrStr) return 0;
    let origem;
    if (typeof tsOrStr === 'string') {
        if (tsOrStr.includes('T') || tsOrStr.includes(' ')) {
            // ISO datetime: "2024-03-20T10:30:00.000Z" ou "2024-03-20 10:30:00"
            const dt = new Date(tsOrStr);
            origem = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
        } else {
            // Apenas data: "2024-03-20"
            const [y, m, d] = tsOrStr.split('-').map(Number);
            origem = new Date(y, m - 1, d);
        }
        const dt = new Date(tsOrStr);
        origem = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    }
    if (isNaN(origem.getTime())) return 0;
    const fim = tsEnd ? new Date(tsEnd) : new Date();
    const fimZero = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate());
    return Math.max(0, Math.round((fimZero - origem) / 86400000));
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// _debounce(fn, ms) â€” funÃ§Ã£o utilitÃ¡ria centralizada para debounce de pesquisa
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// â”€â”€ Lazy loading de bibliotecas pesadas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tesseract (~2.5 MB) e XLSX (~1 MB) sÃ³ sÃ£o carregados quando realmente usados,
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
// XSS â€” escapar sempre dados do utilizador
// =============================================
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================
// FIREBASE AUTH â€” token anÃ³nimo para REST API
// =============================================
let _authToken     = null;
let _authTokenExp  = 0;     // timestamp de expiraÃ§Ã£o (tokens duram 1h)

// ObtÃ©m token vÃ¡lido â€” aguarda Promise do SDK Firebase ou renova se expirado
async function getAuthToken() {
    const now = Date.now();
    // Token em cache ainda vÃ¡lido (margem de 5 min)
    if (_authToken && now < _authTokenExp - 300_000) return _authToken;

    // Aguarda a Promise criada pelo SDK (com timeout de 10s)
    const tokenPromise = window._firebaseTokenPromise
        ? window._firebaseTokenPromise
        : Promise.reject(new Error('Firebase SDK nÃ£o carregou'));

    _authToken = await Promise.race([
        tokenPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Auth timeout â€” verifica Anonymous Auth na consola Firebase')), 10_000))
    ]);

    // Se o user estÃ¡ disponÃ­vel, renova o token (force=true garante token fresco)
    if (window._firebaseUser) {
        try {
            const forceRefreshToken = (_authToken !== null); // forÃ§a renovaÃ§Ã£o se jÃ¡ tivemos token antes
            _authToken = await window._firebaseUser.getIdToken(forceRefreshToken);
        } catch(_e) { console.warn('[Auth] falha ao renovar token:', _e?.message); }
    }

    _authTokenExp = now + 3_500_000; // ~58 min
    return _authToken;
}

// RenovaÃ§Ã£o proactiva do token a cada 45 min â€” protege sessÃµes longas (ponto 1)
let _tokenRenewalTimer = null;
function _scheduleTokenRenewal() {
    clearTimeout(_tokenRenewalTimer);
    _tokenRenewalTimer = setTimeout(async () => {
        if (window._firebaseUser) {
            try {
                _authToken = await window._firebaseUser.getIdToken(true);
                _authTokenExp = Date.now() + 3_500_000;
            } catch(e) { console.warn('[Auth] falha na renovaÃ§Ã£o:', e.message); }
        }
        _scheduleTokenRenewal(); // agenda prÃ³xima renovaÃ§Ã£o
    }, 45 * 60 * 1000); // 45 minutos
}

// Adiciona ?auth=TOKEN a um URL da Firebase REST API
async function authUrl(url) {
    try {
        const token = await getAuthToken();
        const sep   = url.includes('?') ? '&' : '?';
        return `${url}${sep}auth=${token}`;
    } catch (e) {
        console.warn('Auth token indisponÃ­vel:', e.message);
        return url; // offline â€” a fila offline trata do reenvio quando voltar online
    }
}

// =============================================
// PERFIL â€” FuncionÃ¡rio vs Gestor
// =============================================
const ROLE_KEY    = 'hiperfrio-role';   // 'worker' | 'manager'
let   currentRole = null;               // definido no arranque

function requireManagerAccess({ silent = false } = {}) {
    if (currentRole === 'manager') return true;
    if (!silent) showToast('Acesso reservado a gestores', 'error');
    return false;
}

// Aplica o perfil Ã  UI â€” chamado uma vez no boot
function applyRole(role) {
    currentRole = role;
    document.body.classList.toggle('worker-mode', role === 'worker');

    // Badge no header â€” inserido dentro de .header-titles para nÃ£o quebrar o flex layout
    let badge = document.getElementById('role-badge');
    if (!badge) {
        badge = document.createElement('button');
        badge.id      = 'role-badge';
        badge.onclick = () => openSwitchRoleModal();
        document.querySelector('.header-titles')?.appendChild(badge);
    }
    const savedUser = localStorage.getItem('hiperfrio-username') || '';
    const displayName = savedUser || (role === 'worker' ? 'FuncionÃ¡rio' : 'Gestor');
    if (role === 'worker') {
        badge.textContent = `${displayName} â–¾`;
        badge.className   = 'role-badge-worker';
    } else {
        badge.textContent = `${displayName} â–¾`;
        badge.className   = 'role-badge-manager';
    }

    // Footer da sidebar â€” username + role
    const footerUser = document.getElementById('menu-footer-username');
    const footerRole = document.getElementById('menu-footer-role');
    if (footerUser) footerUser.textContent = displayName;
    if (footerRole) footerRole.textContent = role === 'worker' ? 'Operador' : 'Gestor';

    // Esconde o ecrÃ£ de seleÃ§Ã£o
    document.getElementById('role-screen')?.classList.add('hidden');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SISTEMA DE LOGIN POR USERNAME + PASSWORD
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const USERS_URL = `${BASE_URL}/config/users.json`;
const USER_KEY  = 'hiperfrio-username';

// Hash SHA-256 da password (com salt diferente do PIN)
// hashPassword â€” salt inclui o username para que o mesmo password gere hashes
// diferentes por utilizador, dificultando rainbow table attacks em massa.
// O salt fixo mantÃ©m-se por retrocompatibilidade com hashes jÃ¡ criados.
async function hashPassword(password, username = '') {
    const saltedInput = password + 'hiperfrio-pw-salt' + username.toLowerCase();
    const data    = new TextEncoder().encode(saltedInput);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Carrega lista de utilizadores da Firebase
// Gera um verificador offline derivado da password â€” nunca guarda dados Firebase localmente.
// salt diferente do Firebase para que compromisso local nÃ£o dÃª acesso ao servidor.
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

    // 2) Pedido Ã  Firebase
    try {
        const url = await authUrl(USERS_URL);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && !data.error) {
            // NÃ£o guardar dados Firebase localmente â€” apenas marca timestamp de sucesso
            localStorage.setItem('hiperfrio-last-online', Date.now().toString());
            return data;
        }
        throw new Error(data?.error || 'resposta invÃ¡lida');
    } catch (e) {
        console.warn('[Login] servidor inacessÃ­vel â€” tenta sessÃ£o offline');
        return null; // null = offline, {} = sem utilizadores
    }
}

// Floating label â€” adiciona/remove classe has-value consoante o input tem conteÃºdo
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

// Handler do formulÃ¡rio de login
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
            // Offline â€” tentar autenticaÃ§Ã£o com sessÃ£o local guardada de forma segura
            const sessionRaw = localStorage.getItem('hiperfrio-session');
            if (!sessionRaw) {
                showError('Sem ligaÃ§Ã£o ao servidor. Liga-te Ã  internet para autenticares pela primeira vez.');
                return;
            }
            try {
                const session  = JSON.parse(sessionRaw);
                const TTL_24H  = 24 * 60 * 60 * 1000;
                const verifier = await _offlineVerifier(username, password);
                if (session.username === username && session.verifier === verifier
                    && Date.now() - session.ts < TTL_24H) {
                    // SessÃ£o offline vÃ¡lida
                    const role = session.role || 'worker';
                    localStorage.setItem(ROLE_KEY, role);
                    localStorage.setItem(USER_KEY, username);
                    applyRole(role);
                    bootApp();
                    return;
                }
            } catch (_e) { /* sessÃ£o corrompida */ }
            showError('Sem ligaÃ§Ã£o. SÃ³ o Ãºltimo utilizador autenticado pode entrar offline.');
            return;
        }

        if (!users || !Object.keys(users).length) {
            showError('NÃ£o foi possÃ­vel contactar o servidor. Verifica a ligaÃ§Ã£o.');
            return;
        }

        const userObj = users[username];
        if (!userObj) {
            showError('Utilizador nÃ£o encontrado.');
            return;
        }

        const pwHash = await hashPassword(password, username);
        // Retrocompatibilidade: testa tambÃ©m o hash antigo (sem username no salt)
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

        // Login bem sucedido â€” guardar sessÃ£o offline segura (sÃ³ verifier, nunca dados Firebase)
        const role = userObj.role || 'worker';
        const verifier = await _offlineVerifier(username, password);
        localStorage.setItem('hiperfrio-session', JSON.stringify({ username, role, verifier, ts: Date.now() }));
        // Limpar qualquer cache antiga com dados sensÃ­veis
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
        showError('Erro de ligaÃ§Ã£o. Tenta novamente.');
        console.error('[Login] erro:', err);
    } finally {
        if (btn)     btn.disabled = false;
        if (btnText) btnText.textContent = 'Entrar';
        if (spinner) spinner.classList.add('hidden');
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GESTÃƒO DE UTILIZADORES (Admin â†’ tab Utilizadores)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const USERS_BASE_URL = `${BASE_URL}/config/users`;

async function createUser() {
    if (!requireManagerAccess()) return;
    const nameRaw  = document.getElementById('new-user-name')?.value.trim().toLowerCase();
    const role     = document.getElementById('new-user-role')?.value;
    const password = document.getElementById('new-user-pass')?.value;

    if (!nameRaw)    { showToast('Indica o nome de utilizador', 'error'); return; }
    if (!password || password.length < 4) { showToast('Password deve ter pelo menos 4 caracteres', 'error'); return; }
    // SÃ³ letras, nÃºmeros, ponto e underscore
    if (!/^[a-z0-9._]+$/.test(nameRaw)) { showToast('Nome sÃ³ pode ter letras, nÃºmeros, ponto e _', 'error'); return; }

    const pwHash = await hashPassword(password, nameRaw);
    const url    = await authUrl(`${USERS_BASE_URL}/${nameRaw}.json`);

    try {
        // Verifica se jÃ¡ existe â€” sÃ³ considera existente se HTTP 200 e valor nÃ£o-null
        const checkRes = await fetch(url);
        if (checkRes.ok) {
            const existing = await checkRes.json();
            if (existing !== null && !existing.error) {
                showToast('Utilizador jÃ¡ existe', 'error'); return;
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
        showToast('Erro de ligaÃ§Ã£o: ' + (e.message || e), 'error');
    }
}

async function renderUsersList() {
    if (!requireManagerAccess({ silent: true })) return;
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
                        <div style="font-size:0.72rem;color:var(--text-muted)">${u.role === 'manager' ? 'Gestor' : 'FuncionÃ¡rio'}</div>
                    </div>
                </div>
                <button class="btn-danger-sm" onclick="deleteUser('${safeName}')">ðŸ—‘</button>
            </div>
        `}).join('');
    } catch (e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar utilizadores.</div>';
    }
}

async function deleteUser(username) {
    if (!requireManagerAccess()) return;
    const currentUser = localStorage.getItem('hiperfrio-username') || '';
    if (username === currentUser) {
        showToast('NÃ£o podes eliminar a tua prÃ³pria conta', 'error');
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

// Trocar de perfil â€” sem reload para ser mais rÃ¡pido
function switchRole() {
    closeSwitchRoleModal();
    localStorage.removeItem(ROLE_KEY);
    currentRole = null;
    // Remove badge
    document.getElementById('role-badge')?.remove();
    // RepÃµe body classes
    document.body.classList.remove('worker-mode');
    // Invalida cache em memÃ³ria
    Object.keys(cache).forEach(k => { cache[k].data = null; cache[k].lastFetch = 0; });
    // Para renovaÃ§Ã£o de token
    clearTimeout(_tokenRenewalTimer);
    // Limpa username
    localStorage.removeItem('hiperfrio-username');
    localStorage.removeItem('hiperfrio-users-cache');
    localStorage.removeItem('hiperfrio-session');
    // Limpa campos do login
    const u = document.getElementById('ls-username'); if (u) u.value = '';
    const p = document.getElementById('ls-password'); if (p) p.value = '';
    const e = document.getElementById('ls-error'); if (e) e.classList.remove('visible');
    // Mostra ecrÃ£ de login
    const rs = document.getElementById('role-screen');
    if (rs) { rs.style.opacity='0'; rs.style.transition='opacity 0s'; rs.classList.remove('hidden'); requestAnimationFrame(() => { rs.style.transition='opacity 0.3s'; rs.style.opacity='1'; }); }
    // Esconde todas as vistas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // Reset nav activo
    document.querySelectorAll('.menu-items li, .bottom-nav-item').forEach(b => b.classList.remove('active'));
    // Volta ao dashboard ao prÃ³ximo login
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
    return requireManagerAccess();
}

// Inicializa a app apÃ³s o perfil estar definido
async function bootApp() {
    // Garante token vÃ¡lido antes de qualquer fetch â€” crÃ­tico apÃ³s login
    try {
        await getAuthToken();
    } catch(_e) {
        console.warn('bootApp: sem token, continua offline');
    }
    _scheduleTokenRenewal();
    // Auto-fechar mÃªs anterior se for dia 1
    _autoFecharMesSeNecessario();
    // PrÃ©-preencher campo de email do inventÃ¡rio nas DefiniÃ§Ãµes
    setTimeout(_invLoadEmailField, 400);
    // LanÃ§a fetches em paralelo apÃ³s ter token
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
// CACHE EM MEMÃ“RIA â€” TTL 60s
// =============================================
const CACHE_TTL = 300_000; // 5 min â€” stock de armazÃ©m nÃ£o muda por segundo
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

const offlineSync = window.HiperfrioOfflineSync;
offlineSync.init({
    authUrl,
    onSyncSuccess: () => {
        invalidateCache('stock');
        invalidateCache('ferramentas');
        invalidateCache('funcionarios');
        if (typeof _patCache !== 'undefined') _patCache.lastFetch = 0;
        renderList(window._searchInputEl?.value || '', true);
        if (typeof renderPats === 'function') renderPats();
        if (typeof updatePatCount === 'function') updatePatCount();
    },
});
const queueLoad = (...args) => offlineSync.queueLoad(...args);
const queueSave = (...args) => offlineSync.queueSave(...args);
const queueAdd = (...args) => offlineSync.queueAdd(...args);
const syncQueue = (...args) => offlineSync.syncQueue(...args);
const apiFetch = (...args) => offlineSync.apiFetch(...args);
const updateOfflineBanner = (...args) => offlineSync.updateOfflineBanner(...args);

// =============================================
// UI HELPERS
// =============================================
function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const t    = document.createElement('div');
    t.className = 'toast';
    if (type === 'error') t.style.borderLeftColor = 'var(--danger)';
    const icon = document.createElement('span');
    icon.textContent = type === 'success' ? 'âœ…' : 'âœ—';
    const text = document.createElement('span');
    text.textContent = msg;
    t.appendChild(icon);
    t.appendChild(text);
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}
window.showToast = showToast;

function setRefreshSpinning(s) { document.getElementById('btn-refresh')?.classList.toggle('spinning', s); }

function toggleMenu() {
    document.getElementById('side-menu').classList.toggle('open');
    document.getElementById('menu-overlay')?.classList.toggle('active');
}

// â”€â”€ Avatar dropdown (header) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// NAVEGAÃ‡ÃƒO
// FIX: active state sÃ³ actualizado apÃ³s acesso confirmado
// =============================================
// ARQUITECTURA (#18): esta funÃ§Ã£o gere routing + side-effects.
// Para refactor futuro: separar em _activateView(id) e callbacks por vista.
function nav(viewId) {
    if (viewId === 'view-admin' && !checkAdminAccess()) return;

    // Actualiza tÃ­tulo do header
    const pageTitles = {
        'view-dashboard': 'Dashboard',
        'view-search':    'Stock',
        'view-pedidos':   'Pedidos PAT',
        'view-admin':     'AdministraÃ§Ã£o',
        'view-tools':     'Ferramentas',
        'view-register':  'Novo Artigo',
        'view-bulk':      'Entrada de Lote',
        'view-encomendas':'Encomendas',
        'view-map':       'Mapa PAT',
    };
    const titleEl = document.getElementById('header-page-title');
    if (titleEl && pageTitles[viewId]) titleEl.textContent = pageTitles[viewId];

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId)?.classList.add('active');

    // Desktop: admin precisa de padding 0 para o layout Windows Settings funcionar
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
        mainContent.classList.remove('admin-view-active');
    }

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
        // PONTO 4: limpa zona se vazia para evitar confusÃ£o com lote anterior persistido pelo browser
        const bulkLoc = document.getElementById('bulk-loc');
        if (bulkLoc && !bulkLoc.value.trim()) bulkLoc.value = '';
    }
    if (viewId === 'view-tools')  renderTools();
    if (viewId === 'view-dashboard') { renderDashboard(true); }
    if (viewId === 'view-encomendas') { loadEncomendas(); }

    if (viewId === 'view-admin') {
        // Mesmo comportamento em mobile e desktop â€” menu full-screen com cards
        _buildAdminMobileMenu();
    }
    if (viewId === 'view-pedidos') {
        // Limpa pesquisa ao entrar na vista para nÃ£o confundir ao voltar
        _patSearchQuery = '';
        const searchEl = document.getElementById('pat-search');
        if (searchEl) searchEl.value = '';
        renderPats();
    }
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
    // Garante que o bottom nav pill estÃ¡ visÃ­vel ao mudar de vista
    document.getElementById('bottom-nav')?.classList.remove('bnav-hidden');
    if (window.innerWidth < 768) {
        const fab = document.getElementById('fab-add');
        if (fab) fab.style.display = viewId === 'view-search' ? '' : 'none';
    }
}

// =============================================
// DASHBOARD â€” resumo no topo do stock
// =============================================
// PONTO 17: snapshot diÃ¡rio para tendÃªncia no dashboard
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

    // SubtÃ­tulo com hora de actualizaÃ§Ã£o
    const subEl = document.getElementById('dash-subtitle');
    if (subEl) {
        const now = new Date();
        subEl.textContent = `Actualizado Ã s ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
    }

    // â”€â”€ helper: cria um metric card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ GRID 2Ã—2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const grid = document.createElement('div');
    grid.className = 'dv2-grid';

    grid.appendChild(_metricCard({
        label: 'Produtos', value: total, icon: 'box',
        sub: `${comStock} com stock Â· ${semStock} esgotados`,
        accent: '#2563eb',
        progress: total > 0 ? comStock / total : 1,
        onClick: () => nav('view-search'),
        stats: [
            { label: 'Com stock', value: comStock, color: '#16a34a' },
            { label: 'Esgotados', value: semStock, color: semStock > 0 ? '#dc2626' : '#16a34a' },
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'Sem stock', value: semStock, icon: semStock > 0 ? '' : 'âœ…',
        sub: semStock > 0 ? `${Math.round(semStock/total*100)}% do inventÃ¡rio` : 'Tudo com stock',
        accent: semStock > 0 ? '#dc2626' : '#16a34a',
        warn: semStock > 0,
        progress: total > 0 ? semStock / total : 0,
        onClick: semStock > 0 ? () => { _pendingZeroFilter = true; nav('view-search'); } : null,
        stats: semStock > 0 ? [
            { label: '% inventÃ¡rio', value: Math.round(semStock/total*100) + '%', color: '#dc2626' },
        ] : [
            { label: 'Total produtos', value: total, color: '#16a34a' },
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'Ferramentas', value: `${alocadas}/${totalFerr}`, icon: '',
        sub: alocadasHaMuito.length > 0
            ? `! ${alocadasHaMuito.length} hÃ¡ +${ALERTA_DIAS}d`
            : alocadas === 0 ? 'Todas em armazÃ©m' : `${totalFerr - alocadas} em armazÃ©m`,
        accent: alocadasHaMuito.length > 0 ? '#f59e0b' : '#2563eb',
        warn: alocadasHaMuito.length > 0,
        progress: totalFerr > 0 ? alocadas / totalFerr : 0,
        onClick: () => nav('view-tools'),
        stats: [
            { label: 'Em armazÃ©m', value: totalFerr - alocadas, color: '#16a34a' },
            { label: 'Alocadas', value: alocadas, color: alocadas > 0 ? '#f59e0b' : '#64748b' },
            ...(alocadasHaMuito.length > 0 ? [{ label: `+${ALERTA_DIAS}d fora`, value: alocadasHaMuito.length, color: '#dc2626' }] : []),
        ],
    }));

    grid.appendChild(_metricCard({
        label: 'PATs', value: patPendentes, icon: 'â‰¡',
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

    // â”€â”€ SECÃ‡ÃƒO: Ãšltimas PATs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        hdrTitle.textContent = 'Ãšltimas PATs';
        const hdrLink = document.createElement('button');
        hdrLink.className   = 'dv2-section-link';
        hdrLink.textContent = 'Ver todas â†’';
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

            // Barra lateral colorida
            const bar = document.createElement('div');
            bar.className = 'dv2-pat-bar';

            const left = document.createElement('div');
            left.className = 'dv2-pat-left';

            const info = document.createElement('div');
            info.className = 'dv2-pat-info';

            const num = document.createElement('span');
            num.className   = 'dv2-pat-num';
            num.textContent = `PAT ${escapeHtml(pat.numero || 'â€”')}`;

            const estab = document.createElement('span');
            estab.className   = 'dv2-pat-estab';
            estab.textContent = pat.estabelecimento || 'Sem estabelecimento';

            info.appendChild(num);
            info.appendChild(estab);
            left.appendChild(bar);
            left.appendChild(info);

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

    // â”€â”€ SECÃ‡ÃƒO: Ferramentas por colaborador â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        hdr2Link.textContent = 'Painel â†’';
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
            toolNames.textContent = tools.map(t => t.nome).join(' Â· ');

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
// ORDENAÃ‡ÃƒO DO STOCK
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
let _zeroFilterActive  = false; // zero-stock filter estÃ¡ activo (persiste entre navegaÃ§Ãµes)

// Menu de ordenaÃ§Ã£o â€” criado no body para evitar clipping por stacking contexts
function _getSortMenu() {
    let menu = document.getElementById('sort-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id        = 'sort-menu';
        menu.className = 'sort-menu';
        const options  = [
            { val: 'recente',  label: 'Mais recente' },
            { val: 'nome',     label: 'Nome Aâ†’Z'     },
            { val: 'qtd-asc',  label: 'Quantidade â†‘' },
            { val: 'qtd-desc', label: 'Quantidade â†“' },
            { val: 'local',    label: 'LocalizaÃ§Ã£o'  },
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

    // Posiciona o menu sob o botÃ£o usando coordenadas absolutas
    const rect = btn.getBoundingClientRect();
    menu.style.top   = `${rect.bottom + window.scrollY + 6}px`;
    menu.style.right = `${window.innerWidth - rect.right - window.scrollX}px`;
    menu.style.left  = 'auto';
    menu.classList.add('open');
    btn.classList.add('active');

    // Fecha ao clicar fora (prÃ³ximo tick para nÃ£o capturar o click actual)
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

// Fecha sort menu em scroll ou resize (posiÃ§Ã£o desactualizada)
window.addEventListener('scroll', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
}, { passive: true });
window.addEventListener('resize', () => {
    if (document.getElementById('sort-menu')?.classList.contains('open')) _closeSortMenu();
});

function setStockSort(val) {
    _stockSort = val;
    // Actualiza estado visual das opÃ§Ãµes
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
// STOCK â€” RENDER
// FIX: usa [...entries].reverse() para nÃ£o mutar o cache
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
        _badgeBtn.textContent = 'âœ• Limpar';
        _badgeBtn.onclick = clearZeroFilter;
        badge.appendChild(_badgeTxt);
        badge.appendChild(_badgeBtn);
        listEl.parentNode.insertBefore(badge, listEl);
        // Scroll para o topo e foca o badge
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => badge.classList.add('badge-pulse'), 100);
    }
}

// PONTO 16: histÃ³rico de zonas
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
        icon: 'ðŸ“¦',
        title: 'Fechar lote?',
        desc: `${_bulkCount} produto${_bulkCount > 1 ? 's' : ''} adicionado${_bulkCount > 1 ? 's' : ''} na zona "${zona}". Fechar e ir para o stock?`,
        onConfirm: () => {
            // Limpa o formulÃ¡rio completo
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

// PONTO 8: lÃ³gica de filtragem centralizada â€” usada por renderList em ambos os caminhos
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

    // Se DOM jÃ¡ tem cards (re-render por filtro), apenas faz show/hide
    const existingCards = listEl.querySelectorAll('.swipe-wrapper[data-id]');
    if (existingCards.length > 0 && !force) {
        // Remove "Mostrar mais" antes de filtrar â€” contagem pode mudar
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

    // Hint contextual â€” swipe para gestores, leitura para funcionÃ¡rios
    const hintKey = currentRole === 'worker' ? 'worker-hint-seen' : 'swipe-hint-seen';
    if (!filter && !localStorage.getItem(hintKey)) {
        const hint = document.createElement('div');
        hint.className = 'swipe-hint';
        if (currentRole === 'worker') {
            const msg = document.createElement('span');
            msg.textContent = 'ðŸ‘ï¸ Modo consulta â€” apenas visualizaÃ§Ã£o';
            hint.appendChild(msg);
        } else {
            const l = document.createElement('span'); l.textContent = 'âœï¸ Swipe direita para editar';
            const r = document.createElement('span'); r.textContent = 'ðŸ—‘ï¸ Swipe esquerda para apagar';
            hint.appendChild(l); hint.appendChild(r);
        }
        listEl.appendChild(hint);
        localStorage.setItem(hintKey, '1');
    }

    const filterLower = filter.toLowerCase();
    let found = 0;
    const PAGE_SIZE = 80; // PONTO 9: paginaÃ§Ã£o
    let _shownCount = 0;

    // OrdenaÃ§Ã£o configurÃ¡vel
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

        // Card content â€” tudo via textContent (sem XSS)
        const el = document.createElement('div');
        el.className = 'item-card';

        const refLabel = document.createElement('div');
        refLabel.className   = 'ref-label';
        refLabel.textContent = 'REFERÃŠNCIA';

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
        btnM.textContent = 'âˆ’';
        btnM.disabled    = qty === 0;
        btnM.id          = `btn-minus-${id}`;
        btnM.onclick     = () => changeQtd(id, -1);

        const qtySpan = document.createElement('span');
        qtySpan.className   = 'qty-display' + (qty === 0 ? ' is-zero' : '');
        qtySpan.id          = `qty-${id}`;
        qtySpan.textContent = fmtQty(qty, item.unidade);
        // Duplo-toque/duplo-clique abre ediÃ§Ã£o inline de quantidade
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
            notasRow.textContent = `ðŸ“ ${item.notas}`;
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
            el.appendChild(notasRow);
        } else {
            el.appendChild(refLabel); el.appendChild(refVal); el.appendChild(nomEl);
        }
        el.appendChild(hr); el.appendChild(row);

        attachSwipe(el, wrapper, id, item);
        wrapper.appendChild(el);
        if (!matches) { listEl.appendChild(wrapper); return; }
        // PONTO 9: sÃ³ renderiza os primeiros PAGE_SIZE visÃ­veis
        if (_shownCount < PAGE_SIZE) {
            listEl.appendChild(wrapper);
        } else {
            wrapper.style.display = 'none';
            wrapper.dataset.deferred = '1';
            listEl.appendChild(wrapper);
        }
        _shownCount++;
    });

    // BotÃ£o "Mostrar mais" se hÃ¡ cards diferidos
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

// EdiÃ§Ã£o inline de quantidade â€” abre mini-form no lugar do span
function openInlineQtyEdit(id, item) {
    const qtyEl = document.getElementById(`qty-${id}`);
    if (!qtyEl || qtyEl.querySelector('input')) return; // jÃ¡ em ediÃ§Ã£o
    const currentQty = cache.stock.data?.[id]?.quantidade ?? item.quantidade ?? 0; // PONTO 5: lÃª do cache actualizado
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
        const oldValInline = cache.stock.data?.[id]?.quantidade ?? 0;
        wrap.replaceWith(qtyEl);
        qtyEl.textContent = fmtQty(newVal, item.unidade);
        qtyEl.classList.toggle('is-zero', newVal === 0);
        document.getElementById(`btn-minus-${id}`)?.toggleAttribute('disabled', newVal === 0);
        if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = newVal;
        if (newVal < oldValInline) {
            registarMovimento('saida_manual', id, item.codigo, item.nome, oldValInline - newVal);
        }
        try {
            const savedQty = await _commitStockAbsolute(id, oldValInline, newVal);
            if (cache.stock.data?.[id]) cache.stock.data[id].quantidade = savedQty;
            qtyEl.textContent = fmtQty(savedQty, item.unidade);
            qtyEl.classList.toggle('is-zero', savedQty === 0);
            document.getElementById(`btn-minus-${id}`)?.toggleAttribute('disabled', savedQty === 0);
            renderDashboard();
        } catch(_e) {
            if (_e?.message === 'STOCK_CONFLICT') {
                showToast('Stock alterado por outro operador. Actualiza e tenta novamente.', 'error');
            } else {
                showToast('Erro ao guardar','error');
            }
        }
    };
    const cancelFn = () => { wrap.replaceWith(qtyEl); };
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmFn(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelFn(); }
    });
    inp.addEventListener('blur', () => setTimeout(cancelFn, 150));
    const ok = document.createElement('button');
    ok.className = 'qty-inline-ok';
    ok.textContent = 'âœ“';
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

// Debounce de escrita para changeQtd â€” agrupa toques rÃ¡pidos numa sÃ³ chamada Ã  Firebase
const _qtyTimers = {};
const _qtyPendingBase = {};

const stockCore = window.HiperfrioStockCore;
stockCore.init({
    authUrl,
    apiFetch,
    getCache: () => cache,
});
const _readServerStockQty = (...args) => stockCore.readServerStockQty(...args);
const _commitStockDelta = (...args) => stockCore.commitStockDelta(...args);
const _commitStockAbsolute = (...args) => stockCore.commitStockAbsolute(...args);

async function changeQtd(id, delta) {
    if (navigator.vibrate) navigator.vibrate(30);
    const stockData = cache.stock.data;
    if (!stockData?.[id]) return;

    const oldQty = stockData[id].quantidade || 0;
    if (!Object.prototype.hasOwnProperty.call(_qtyPendingBase, id)) {
        _qtyPendingBase[id] = oldQty;
    }
    const newQty = Math.max(0, oldQty + delta);
    if (newQty === oldQty) return;
    if (delta < 0) {
        const _itm = cache.stock.data?.[id];
        registarMovimento('saida_manual', id, _itm?.codigo, _itm?.nome, Math.abs(delta));
    }

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

    // Mostra indicador de "a guardar" apÃ³s 300ms sem actividade
    if (qtyEl) qtyEl.classList.add('qty-saving');
    clearTimeout(_qtyTimers[id]);
    _qtyTimers[id] = setTimeout(async () => {
        const finalQty = stockData[id]?.quantidade;
        if (finalQty === undefined) return;
        const baseQty = _qtyPendingBase[id] ?? oldQty;
        try {
            const savedQty = await _commitStockDelta(id, baseQty, finalQty);
            stockData[id].quantidade = savedQty;
            if (qtyEl) {
                qtyEl.textContent = fmtQty(savedQty, stockData[id]?.unidade);
                qtyEl.classList.toggle('is-zero', savedQty === 0);
            }
            if (minusEl) minusEl.disabled = savedQty === 0;
            if (qtyEl) qtyEl.classList.remove('qty-saving');
        } catch (e) {
            console.warn('changeQtd erro:', e?.message || e);
            if (qtyEl) qtyEl.classList.remove('qty-saving');
            stockData[id].quantidade = baseQty;
            if (qtyEl)   { qtyEl.textContent = fmtQty(baseQty, stockData[id]?.unidade); qtyEl.classList.toggle('is-zero', baseQty === 0); }
            if (minusEl)   minusEl.disabled = baseQty === 0;
            showToast('Erro ao guardar quantidade', 'error');
        }
        delete _qtyTimers[id];
        delete _qtyPendingBase[id];
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


async function renderTools() {
    const list = document.getElementById('tools-list');
    if (!list) return;
    const data = await fetchCollection('ferramentas');

    const TOOL_ALERT_DAYS = 7;

    // Stat chips
    if (data) {
        const entries = Object.values(data);
        const total   = entries.length;
        const disp    = entries.filter(t => t.status === 'disponivel').length;
        const aloc    = entries.filter(t => t.status === 'alocada').length;
        const over    = entries.filter(t => t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS).length;
        const sub = document.getElementById('tools-header-sub');
        if (sub) sub.textContent = `${total} ferramenta${total !== 1 ? 's' : ''} Â· ${aloc} alocada${aloc !== 1 ? 's' : ''}`;
        const el = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
        el('ts-total', total); el('ts-disp', disp); el('ts-aloc', aloc); el('ts-over', over);
        // Esconder stat de atraso se zero
        const overStat = document.querySelector('.ts-red');
        if (overStat) overStat.style.display = over > 0 ? '' : 'none';
    }

    // Filtros activos
    document.querySelectorAll('.tools-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === (_toolsFilter || 'all'));
    });

    list.innerHTML = '';
    if (!data || Object.keys(data).length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div><div class="empty-state-title">Sem ferramentas</div><div class="empty-state-sub">Adiciona ferramentas em AdministraÃ§Ã£o.</div></div>`;
        return;
    }

    const filterLower = typeof _toolsFilter === 'string' && _toolsFilter !== 'all' && !['disponivel','alocada'].includes(_toolsFilter)
        ? _toolsFilter.toLowerCase() : '';
    const statusFilter = ['disponivel','alocada'].includes(_toolsFilter) ? _toolsFilter : null;

    // Separar em grupos: overdue â†’ alocadas â†’ disponÃ­veis
    const all = [...Object.entries(data)].reverse();
    const overdueList  = all.filter(([,t]) => t.status === 'alocada' && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS);
    const alocList     = all.filter(([,t]) => t.status === 'alocada' && !(t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS));
    const dispList     = all.filter(([,t]) => t.status !== 'alocada');

    const TOOL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
    const RETURN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg>`;
    const CHEVRON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>`;

    function _makeCard(id, t) {
        if (filterLower && !t.nome?.toLowerCase().includes(filterLower)) return null;
        if (statusFilter && t.status !== statusFilter) return null;

        const isAv = t.status === 'disponivel';
        const isOverdue = !isAv && t.dataEntrega && _calcDias(t.dataEntrega) > TOOL_ALERT_DAYS;

        const div = document.createElement('div');
        div.className = `tool-card ${isAv ? 'tool-available' : 'tool-allocated'}${isOverdue ? ' tool-overdue' : ''}`;

        // Long press â†’ histÃ³rico
        div.addEventListener('contextmenu', e => { e.preventDefault(); openHistoryModal(id, t.nome); });
        div.addEventListener('touchstart', () => {
            _toolLongPressTimer = setTimeout(() => openHistoryModal(id, t.nome), 600);
        }, { passive: true });
        div.addEventListener('touchend',  () => clearTimeout(_toolLongPressTimer), { passive: true });
        div.addEventListener('touchmove', () => clearTimeout(_toolLongPressTimer), { passive: true });

        // Ãcone
        const icon = document.createElement('div');
        icon.className = 'tool-icon';
        icon.innerHTML = TOOL_ICON;

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
            lbl.textContent = 'Em armazÃ©m';
            sub.appendChild(dot);
            sub.appendChild(lbl);
        } else {
            const days = t.dataEntrega ? _calcDias(t.dataEntrega) : null;
            const colabBadge = document.createElement('span');
            colabBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-colab'}`;
            colabBadge.textContent = (t.colaborador || '').toUpperCase();
            sub.appendChild(colabBadge);
            if (days !== null) {
                const daysBadge = document.createElement('span');
                daysBadge.className   = `tool-badge ${isOverdue ? 'tool-badge-overdue' : 'tool-badge-days'}`;
                daysBadge.textContent = days === 0 ? 'hoje' : days === 1 ? '1d fora' : `${days}d fora`;
                sub.appendChild(daysBadge);
            }
            if (isOverdue) {
                const ovd = document.createElement('span');
                ovd.className   = 'tool-badge tool-badge-overdue';
                ovd.textContent = 'verificar';
                sub.appendChild(ovd);
            }
        }

        info.appendChild(nome);
        info.appendChild(sub);
        div.appendChild(icon);
        div.appendChild(info);

        if (isAv) {
            // Clicar no card â†’ alocar
            div.onclick = () => openModal(id);
            const arrow = document.createElement('span');
            arrow.className = 'tool-arrow';
            arrow.innerHTML = CHEVRON;
            div.appendChild(arrow);
        } else {
            // Clicar no card â†’ histÃ³rico; botÃ£o explÃ­cito â†’ devolver
            div.onclick = () => openHistoryModal(id, t.nome);
            const retBtn = document.createElement('button');
            retBtn.className = 'tool-return-btn';
            retBtn.innerHTML = RETURN_ICON;
            retBtn.title = 'Devolver';
            retBtn.onclick = e => {
                e.stopPropagation();
                openConfirmModal({
                    icon: 'â†©', title: 'Confirmar devoluÃ§Ã£o?',
                    desc: `"${escapeHtml(t.nome)}" serÃ¡ marcada como disponÃ­vel.`,
                    onConfirm: () => returnTool(id)
                });
            };
            div.appendChild(retBtn);
        }

        return div;
    }

    function _addSection(label, items) {
        let added = 0;
        const frag = document.createDocumentFragment();
        items.forEach(([id, t]) => {
            const card = _makeCard(id, t);
            if (card) { frag.appendChild(card); added++; }
        });
        if (added > 0) {
            const lbl = document.createElement('div');
            lbl.className = 'tools-section-label';
            lbl.textContent = label;
            list.appendChild(lbl);
            list.appendChild(frag);
        }
        return added;
    }

    let total = 0;
    total += _addSection('Em atraso', overdueList);
    total += _addSection('Alocadas', alocList);
    total += _addSection('DisponÃ­veis', dispList);

    if (total === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhuma ferramenta encontrada.</div>';
    }
}

async function renderAdminTools() {
    if (!requireManagerAccess({ silent: true })) return;
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

        // Barra de acÃ§Ãµes alinhada Ã  esquerda
        const actions = document.createElement('div');
        actions.className = 'admin-tool-actions';

        const editBtn = document.createElement('button');
        editBtn.className   = 'admin-tool-btn admin-tool-btn-edit';
        editBtn.innerHTML   = 'âœï¸ <span>Editar</span>';
        editBtn.onclick     = () => openEditToolModal(id, t);

        const histBtn = document.createElement('button');
        histBtn.className   = 'admin-tool-btn admin-tool-btn-hist';
        histBtn.innerHTML   = 'â‰¡ <span>HistÃ³rico</span>';
        histBtn.onclick     = () => openHistoryModal(id, t.nome);

        const delBtn = document.createElement('button');
        delBtn.className   = 'admin-tool-btn admin-tool-btn-del';
        delBtn.innerHTML   = 'ðŸ—‘ï¸ <span>Eliminar</span>';
        delBtn.onclick     = () => openConfirmModal({
            icon:'', title:'Apagar ferramenta?',
            desc:`"${escapeHtml(t.nome)}" serÃ¡ removida permanentemente.`,
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
// HISTÃ“RICO DAS FERRAMENTAS
// =============================================
const HISTORY_MAX = 50; // mÃ¡ximo de registos por ferramenta

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
            // Faz fetch apenas quando necessÃ¡rio para obter os IDs ordenados
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
            } catch (e) { console.warn('Limpeza histÃ³rico:', e?.message || e); }
        }
    } catch (e) { console.warn('addToolHistoryEvent:', e?.message || e); /* best-effort */ }
}

async function openHistoryModal(toolId, toolName) {
    document.getElementById('history-modal-tool-name').textContent = `ðŸª› ${toolName}`;
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = '<div class="empty-msg">A carregar...</div>';
    document.getElementById('history-modal').classList.add('active');
    focusModal('history-modal');

    try {
        if (!navigator.onLine) {
            listEl.innerHTML = '<div class="empty-msg">Sem ligaÃ§Ã£o â€” histÃ³rico indisponÃ­vel offline.</div>';
            return;
        }
        const url  = await authUrl(`${BASE_URL}/ferramentas/${toolId}/historico.json`);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        listEl.innerHTML = '';

        if (!data) {
            listEl.innerHTML = '<div class="empty-msg">Sem registos de histÃ³rico.</div>';
            return;
        }

        // Converte objeto Firebase em array e ordena do mais recente para o mais antigo
        const events = Object.values(data).sort((a, b) => new Date(b.data) - new Date(a.data));

        events.forEach(ev => {
            const row  = document.createElement('div');
            row.className = `history-row ${ev.acao === 'atribuida' ? 'history-out' : 'history-in'}`;
            const icon = ev.acao === 'atribuida' ? 'â†’' : 'â†©';
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
        listEl.innerHTML = '<div class="empty-msg">Erro ao carregar histÃ³rico.</div>';
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
    // PONTO 2: guarda colaborador ANTES de modificar cache â€” evita perda offline
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
        // Regista histÃ³rico com colaborador preservado mesmo offline
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
    if (!requireManagerAccess()) return;
    const id   = document.getElementById('edit-tool-id').value;
    const nome = document.getElementById('edit-tool-name').value.trim().toUpperCase();
    if (!nome) { showToast('Nome obrigatÃ³rio', 'error'); return; }
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
    if (!requireManagerAccess()) return;
    // PONTO 3: se ferramenta estÃ¡ alocada, forÃ§a devoluÃ§Ã£o antes de apagar
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
            desc: `"${escapeHtml(tool.nome)}" estÃ¡ com ${escapeHtml(tool.colaborador || '?')}. Apagar irÃ¡ forÃ§ar a devoluÃ§Ã£o sem registo. Confirmas?`,
            onConfirm: _doDelete
        });
    } else {
        await _doDelete();
    }
}

// =============================================
// FUNCIONÃRIOS
// =============================================
async function renderWorkers() {
    if (!requireManagerAccess({ silent: true })) return;
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([id,v]) => ({id, nome:v.nome})) : [];
    const list    = document.getElementById('workers-list');
    if (!list) return;

    // Badge de contagem no card header
    const badge = document.getElementById('workers-count-badge');
    if (badge) badge.textContent = workers.length ? `${workers.length} registados` : '';

    list.innerHTML = '';
    if (workers.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum funcionÃ¡rio adicionado.</div>'; return;
    }
    workers.forEach(w => {
        const row = document.createElement('div');
        row.className = 'admin-list-row';

        const avatar = document.createElement('div');
        avatar.className = 'admin-list-avatar';
        const initials = w.nome.trim().split(/\s+/).map(p => p[0]).slice(0,2).join('').toUpperCase();
        avatar.textContent = initials || '?';

        const lbl = document.createElement('span');
        lbl.className   = 'admin-list-label';
        lbl.textContent = w.nome;
        const btn = document.createElement('button');
        btn.className = 'admin-list-delete';
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
        btn.onclick = () => openConfirmModal({
            icon:'ðŸ‘¤', title:'Apagar funcionÃ¡rio?',
            desc:`"${escapeHtml(w.nome)}" serÃ¡ removido permanentemente.`,
            onConfirm: () => deleteWorker(w.id)
        });
        row.appendChild(avatar); row.appendChild(lbl); row.appendChild(btn);
        list.appendChild(row);
    });
}

async function deleteWorker(id) {
    if (!requireManagerAccess()) return;
    if (cache.funcionarios.data) delete cache.funcionarios.data[id];
    renderWorkers();
    try {
        await apiFetch(`${BASE_URL}/funcionarios/${id}.json`, { method:'DELETE' });
    } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao apagar.','error'); }
}

// =============================================
// MODAL â€” entregar ferramenta
// =============================================
let toolToAllocate = null;

async function openModal(id) {
    const data    = await fetchCollection('funcionarios');
    const workers = data ? Object.entries(data).map(([wid,v]) => ({id:wid,nome:v.nome})) : [];
    if (workers.length === 0) return showToast('Adicione funcionÃ¡rios na AdministraÃ§Ã£o','error');
    toolToAllocate = id;

    // Mostra o nome e Ã­cone da ferramenta no modal
    const toolData = cache.ferramentas.data?.[id];
    const toolName = toolData?.nome || '';
    const toolIcon = toolData?.icone || '';
    const toolDesc = document.getElementById('worker-modal-tool-name');
    if (toolDesc) toolDesc.textContent = toolName ? `${toolIcon} ${toolName}` : '';
    // Actualiza tambÃ©m o Ã­cone grande no topo do modal
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
// MODAL â€” confirmaÃ§Ã£o genÃ©rica
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
// MODAL â€” apagar produto (swipe left)
// =============================================
let pendingDeleteId = null;

function openDeleteModal(id, item) {
    pendingDeleteId = id;
    document.getElementById('delete-modal-desc').textContent =
        `"${String(item.codigo||'').toUpperCase()} â€” ${item.nome}" serÃ¡ removido permanentemente.`;
    document.getElementById('delete-modal').classList.add('active');
    focusModal('delete-modal');
}
function closeDeleteModal() {
    pendingDeleteId = null;
    document.getElementById('delete-modal').classList.remove('active');
}

// =============================================
// MODAL â€” editar produto (swipe right)
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
// FIX: Ãºnico par de listeners globais â€” sem acumulaÃ§Ã£o por card
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
    // FuncionÃ¡rios nÃ£o tÃªm swipe â€” apenas leitura
    if (currentRole === 'worker') return;
    card.addEventListener('touchstart', e => {
        e.stopPropagation();
        _onSwipeStart(card, wrapper, id, item, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    card.addEventListener('touchmove',  e => _onSwipeMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend',   e => { e.stopPropagation(); _onSwipeEnd(); }, { passive: true });
    card.addEventListener('mousedown',  e => {
        // NÃ£o interferir com cliques nos botÃµes +/âˆ’
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
    // Don't add is-swiping yet â€” wait to know direction
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
    const headers = ['ReferÃªncia','Nome','LocalizaÃ§Ã£o','Quantidade','Unidade'];
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
// PONTO 25: exportar histÃ³rico de ferramentas para CSV
async function exportToolHistoryCSV() {
    const btn = document.getElementById('export-hist-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A exportar...'; }
    try {
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData || Object.keys(ferrData).length === 0) {
            showToast('Sem ferramentas para exportar', 'error');
            return;
        }
        const headers = ['Ferramenta','Ãcone','AÃ§Ã£o','Colaborador','Data'];
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
            showToast('Sem histÃ³rico para exportar', 'error');
            return;
        }
        rows.sort((a, b) => a[4] < b[4] ? 1 : -1); // mais recente primeiro
        const csv  = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
        const blob = new Blob(['ï»¿'+csv], { type:'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), {
            href: url,
            download: `hiperfrio-historico-ferramentas-${new Date().toISOString().slice(0,10)}.csv`
        }).click();
        URL.revokeObjectURL(url);
        showToast(`${rows.length} registos exportados!`);
    } catch(e) {
        showToast('Erro ao exportar histÃ³rico', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Exportar HistÃ³rico'; }

    }
}

// =============================================
// ADMIN â€” slider com swipe entre tabs
// =============================================
const ADMIN_TABS  = ['workers', 'tools', 'clientes', 'users', 'settings', 'relatorio'];
let   _adminIdx   = 0;   // Ã­ndice activo

// â”€â”€ Admin mobile â€” menu estilo Android â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _adminMobileTitles = {
    workers:   'FuncionÃ¡rios',
    tools:     'Ferramentas',
    clientes:  'Clientes',
    users:     'Utilizadores',
    settings:  'DefiniÃ§Ãµes',
    relatorio: 'RelatÃ³rios',
};
let _adminMobileActive = null;

function _buildAdminMobileMenu() {
    const viewAdmin = document.getElementById('view-admin');
    if (!viewAdmin) return;
    document.getElementById('admin-mobile-menu')?.remove();
    document.getElementById('admin-mobile-detail')?.remove();

    const items = [
        { tab:'workers',  bg:'#eff6ff', color:'#2563eb', label:'FuncionÃ¡rios', sub:'Gerir tÃ©cnicos e colaboradores',
          svg:'<path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>', vb:'0 0 20 20', fill:true },
        { tab:'tools',    bg:'#dcfce7', color:'#16a34a', label:'Ferramentas',  sub:'Registar e gerir ferramentas',
          svg:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', vb:'0 0 24 24', fill:false },
        { tab:'clientes', bg:'#fef3c7', color:'#d97706', label:'Clientes',     sub:'Importar e consultar clientes',
          svg:'<path d="M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C3.74 11.846 4.632 14 6.414 14H15a1 1 0 000-2H6.414l1-1H14a1 1 0 00.894-.553l3-6A1 1 0 0017 3H6.28l-.31-1.243A1 1 0 005 1H3zM16 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM6.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>', vb:'0 0 20 20', fill:true },
        { tab:'users',    bg:'#ede9fe', color:'#7c3aed', label:'Utilizadores', sub:'Gerir contas e permissÃµes',
          svg:'<path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
        { tab:'settings',  bg:'#f1f5f9', color:'#64748b', label:'DefiniÃ§Ãµes',   sub:'OCR, tema, versÃ£o da app',
          svg:'<path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
        { tab:'relatorio', bg:'#ecfdf5', color:'#059669', label:'RelatÃ³rios',   sub:'AnÃ¡lise mensal de tendÃªncias',
          svg:'<path fill-rule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11 4a1 1 0 10-2 0v4a1 1 0 102 0V7zm-3 1a1 1 0 10-2 0v3a1 1 0 102 0V8zM8 9a1 1 0 00-2 0v2a1 1 0 102 0V9z" clip-rule="evenodd"/>', vb:'0 0 20 20', fill:true },
    ];

    const menu = document.createElement('div');
    menu.id = 'admin-mobile-menu';

    const groups = [
        { label:'GestÃ£o',  tabs: items.slice(0,3) },
        { label:'Sistema',  tabs: items.slice(3,5) },
        { label:'AnÃ¡lise',  tabs: items.slice(5) },
    ];

    groups.forEach(g => {
        // Label de secÃ§Ã£o
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

            // Ãcone
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
    backBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg> AdministraÃ§Ã£o';

    // TÃ­tulo da secÃ§Ã£o como h2
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
        // ForÃ§ar dimensÃµes â€” o .admin-panel tem width/min-width:20% do slider desktop
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
    if (titleEl) titleEl.textContent = _adminMobileTitles[tab] || 'AdministraÃ§Ã£o';
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
            // Limpar estilos inline forÃ§ados â€” o slider desktop usa CSS prÃ³prio
            if (child.style) child.style.cssText = '';
            slider.appendChild(child);
        }
    }

    // Re-aplicar ws-active no painel correcto (para desktop)
    if (window.innerWidth >= 768) {
        ADMIN_TABS.forEach((t, i) => {
            const p = document.getElementById(`panel-${t}`);
            if (p) p.classList.toggle('ws-active', i === _adminIdx);
        });
    }

    detail.style.display = 'none';
    menu.style.display   = 'block';

    const titleEl = document.getElementById('header-page-title');
    if (titleEl) titleEl.textContent = 'AdministraÃ§Ã£o';
    window.scrollTo(0, 0);
}

function switchAdminTab(tab, animate = true) {
    const idx = ADMIN_TABS.indexOf(tab);
    if (idx < 0) return;
    _adminIdx = idx;

    // Actualiza botÃµes
    document.querySelectorAll('.admin-tab').forEach((t, i) =>
        t.classList.toggle('active', i === idx)
    );

    // Desktop â‰¥768px: mostra/esconde painÃ©is via classe (sem transform)
    // transform num elemento pai quebra position:fixed dos modais
    if (window.innerWidth >= 768) {
        ADMIN_TABS.forEach((t, i) => {
            const p = document.getElementById(`panel-${t}`);
            if (p) p.classList.toggle('ws-active', i === idx);
        });
    }

    if (tab === 'clientes') renderClientesList();
    if (tab === 'users')    renderUsersList();
    if (tab === 'settings') { _updateOcrKeyStatus(); _loadOcrKeywordsInput(); }
    if (tab === 'relatorio') { renderRelatorio(); }
    if (tab === 'workers')  renderWorkers();
    if (tab === 'tools')    renderAdminTools();
    // Move slider apenas em mobile â€” no desktop usamos display:none/block
    // (transform num pai quebra position:fixed dos modais no desktop)
    const slider = document.getElementById('admin-slider');
    if (slider) {
        if (window.innerWidth < 768) {
            if (!animate) slider.classList.add('is-dragging');
            slider.style.transform = `translateX(-${(idx * 100 / 6).toFixed(4)}%)`;
            if (!animate) {
                void slider.offsetWidth;
                slider.classList.remove('is-dragging');
            }
        } else {
            // Garantir que nÃ£o fica transform inline residual
            slider.style.transform = '';
            slider.style.transition = '';
        }
    }
}

// AbortController para garantir que os listeners sÃ£o limpos antes de re-setup
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
    const SWIPE_THRESHOLD  = 50;   // px para confirmar mudanÃ§a de tab
    const RESIST = 0.25;           // resistÃªncia nos extremos

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

        // Decide intenÃ§Ã£o uma sÃ³ vez
        if (intent === null && (Math.abs(dx) > INTENT_THRESHOLD || Math.abs(dy) > INTENT_THRESHOLD)) {
            intent = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        if (intent !== 'h') return;   // scroll vertical â€” nÃ£o interferir

        e.preventDefault();
        deltaX = dx;

        // ResistÃªncia nos extremos
        let extra = deltaX;
        if ((_adminIdx === 0 && deltaX > 0) || (_adminIdx === ADMIN_TABS.length - 1 && deltaX < 0)) {
            extra = deltaX * RESIST;
        }

        slider.classList.add('is-dragging');
        const base = -(_adminIdx * 100 / 6);
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
            switchAdminTab(ADMIN_TABS[_adminIdx]);   // volta Ã  posiÃ§Ã£o
        }
        deltaX = 0;
        intent = null;
    };

    wrap.addEventListener('touchend',    onEnd, { passive: true, signal: sig });
    wrap.addEventListener('touchcancel', onEnd, { passive: true, signal: sig });
}

// =============================================
// TEMAS â€” claro / escuro
// =============================================
function _applyTheme(theme) {
    document.body.classList.remove('dark-mode');
    if (theme === 'dark')  document.body.classList.add('dark-mode');

    // Sync theme dropdown UI
    _syncThemeDropdown(theme);

    // Barra de status Android â€” meta theme-color dinÃ¢mica
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
    // Scroll hide/show do pill â€” activo em todos os temas
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

    // Retorna funÃ§Ã£o de cleanup para quando o tema mudar
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

    // DetecÃ§Ã£o de direcÃ§Ã£o: esconde ao descer, mostra ao subir
    const SCROLL_SENSITIVITY = 6;   // px mÃ­nimos de delta para reagir
    const SHOW_AT_TOP        = 30;  // px â€” perto do topo mostra sempre
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



// Ponto de entrada Ãºnico para mudanÃ§a de tema
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
// INICIALIZAÃ‡ÃƒO
// =============================================

// =============================================
// DETECÃ‡ÃƒO DE CÃ“DIGO DUPLICADO
// =============================================
function checkDuplicateCodigo(codigo, onConfirm) {
    if (!codigo || codigo.toUpperCase() === 'SEMREF') {
        onConfirm(); return; // SEMREF Ã© sempre permitido em duplicado
    }
    const stock = cache.stock.data || {};
    const dupes = Object.values(stock).filter(
        item => (item.codigo || '').toUpperCase() === codigo.toUpperCase()
    );
    if (dupes.length === 0) {
        onConfirm(); return;
    }
    // Existe duplicado â€” mostra modal de confirmaÃ§Ã£o
    const names = dupes.map(d => d.nome || '(sem nome)').join(', ');
    document.getElementById('dup-modal-desc').textContent =
        `O cÃ³digo "${codigo.toUpperCase()}" jÃ¡ existe em: ${names}. Queres registar mesmo assim?`;
    document.getElementById('dup-confirm-btn').onclick = () => { closeDupModal(); onConfirm(); };
    document.getElementById('dup-modal').classList.add('active');
    focusModal('dup-modal');
}
function closeDupModal() {
    document.getElementById('dup-modal').classList.remove('active');
}

// =============================================
// UNIDADE DE MEDIDA â€” dropdown inline no input
// =============================================
// Fonte Ãºnica de verdade para unidades â€” adicionar aqui para afectar toda a app
const UNITS = [
    { value: 'un', label: 'Unidade',     short: 'Unidade' },
    { value: 'L',  label: 'Litros (L)',  short: 'Litros'  },
    { value: 'm',  label: 'Metros (m)',  short: 'm'       },
    { value: 'm2', label: 'MetrosÂ² (mÂ²)',short: 'mÂ²'      },
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

// Listener nomeado para poder ser removido com seguranÃ§a (ponto 7)
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

// Formata quantidade â€” sÃ³ mostra unidade se nÃ£o for "un"
function fmtQty(quantidade, unidade) {
    const qty = quantidade ?? 0;
    if (!unidade || unidade === 'un') return String(qty);
    return `${qty} ${UNIT_SHORT[unidade] || unidade}`;
}

// =============================================
// INVENTÃRIO GUIADO â€” v2
// Pontos: filtro por zona, revisÃ£o, retoma, stats, Excel, email
// =============================================

// INV_RESUME_KEY removida â€” resume migrado para Firebase /inv-resume/{user}
const INV_EMAIL_KEY = 'hiperfrio-inv-email';

function _invGetEmail() {
    return localStorage.getItem(INV_EMAIL_KEY) || '';
}

// Carrega o email guardado no campo das DefiniÃ§Ãµes ao arrancar
function _invLoadEmailField() {
    const el = document.getElementById('inv-email-input');
    if (el) el.value = _invGetEmail();
}

// Estado da sessÃ£o de inventÃ¡rio
let _invItems     = [];        // produtos a percorrer
let _invIdx       = 0;         // Ã­ndice actual
let _invChanges   = {};        // { id: newQty } â€” confirmados
let _invSkipped   = new Set(); // ids saltados
let _invOptions   = { zones: null, skipZeros: false }; // null = todas as zonas
let _invLastData  = null;      // snapshot dos dados no inÃ­cio (para o Excel)

async function startInventory() {
    const data = await fetchCollection('stock', true);
    if (!data || Object.keys(data).length === 0) {
        showToast('Sem produtos para inventariar', 'error'); return;
    }

    // Carrega sessÃ£o guardada ANTES de abrir o modal â€” banner jÃ¡ estÃ¡ pronto ao aparecer
    const saved = await _invLoadResume();

    _openInvSetup(data);

    const banner = document.getElementById('inv-resume-banner');
    if (banner) {
        if (!saved) {
            banner.style.display = 'none';
        } else {
            const hoursAgo = Math.round((Date.now() - (saved.ts || 0)) / 3600000);
            const timeLabel = hoursAgo < 1 ? 'hÃ¡ menos de 1h' : `hÃ¡ ${hoursAgo}h`;
            document.getElementById('inv-resume-banner-text').textContent =
                `InventÃ¡rio em curso Â· ${saved.idx + 1}/${saved.items.length} Â· guardado ${timeLabel}`;
            banner.style.display = 'flex';
            document.getElementById('inv-resume-btn-retomar').onclick = () => {
                closeInvSetup();
                _resumeInventory(saved);
            };
            document.getElementById('inv-resume-btn-novo').onclick = () => {
                banner.style.display = 'none';
                _invClearResume();
            };
        }
    }
}

function _openInvSetup(data) {
    // Extrai zonas Ãºnicas ordenadas
    const zones = [...new Set(
        Object.values(data)
            .filter(p => !String(p.codigo||'').startsWith('_tmp_'))
            .map(p => (p.localizacao||'').trim().toUpperCase())
            .filter(Boolean)
    )].sort((a,b) => a.localeCompare(b,'pt'));

    const container = document.getElementById('inv-setup-zones');
    container.innerHTML = '';

    if (zones.length === 0) {
        container.innerHTML = '<p class="modal-desc" style="margin:0">Todos os produtos serÃ£o inventariados (sem zonas definidas).</p>';
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
        btn.textContent = 'Iniciar InventÃ¡rio â†’';
    } else if (active.length === 0) {
        btn.textContent = 'Selecciona pelo menos uma zona';
        btn.disabled = true;
        if (toggleBtn) toggleBtn.textContent = 'Seleccionar todas';
        return;
    } else {
        const allActive = active.length === chips.length;
        btn.textContent = allActive
            ? `Iniciar â€” todos os produtos â†’`
            : `Iniciar â€” ${active.length} zona${active.length > 1 ? 's' : ''} â†’`;
        if (toggleBtn) toggleBtn.textContent = allActive ? 'Limpar selecÃ§Ã£o' : 'Seleccionar todas';
    }
    btn.disabled = false;
}

function closeInvSetup() {
    document.getElementById('inv-setup-modal').classList.remove('active');
}

async function invSetupStart() {
    const chips = document.querySelectorAll('.inv-zone-chip');
    const totalChips = chips.length;
    const activeZones = totalChips === 0
        ? null
        : [...chips].filter(c => c.classList.contains('active')).map(c => c.dataset.zone);

    if (activeZones && activeZones.length === 0) return;

    const skipZeros = document.getElementById('inv-skip-zeros').checked;
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
    // Bug 5: garantir que _invLastData nÃ£o Ã© null ao exportar depois de retomar
    _invLastData = cache.stock.data ? { ...cache.stock.data } : null;
    if (!_invLastData) {
        fetchCollection('stock', false).then(d => { if (d) _invLastData = { ...d }; });
    }
    document.getElementById('inv-modal').classList.add('active');
    focusModal('inv-modal');
    _renderInvStep();
    showToast(`A retomar â€” produto ${_invIdx + 1} de ${_invItems.length}`);
}

function _renderInvStep() {
    const total      = _invItems.length;
    const [id, item] = _invItems[_invIdx] || [];
    if (!id) { _finishInventory(); return; }

    document.getElementById('inv-progress-text').textContent = `${_invIdx + 1} / ${total}`;
    document.getElementById('inv-progress-bar').style.width  = `${Math.round((_invIdx / total) * 100)}%`;

    // Zone progress: "Zona 201-001A â€” 4 de 12"
    const zonaEl = document.getElementById('inv-zone-progress');
    if (zonaEl) {
        const zona = (item.localizacao||'').trim().toUpperCase() || 'SEM LOCAL';
        const zonaItems = _invItems.filter(([,p]) => (p.localizacao||'').trim().toUpperCase() === zona || (zona === 'SEM LOCAL' && !(p.localizacao||'').trim()));
        const zonaIdx   = zonaItems.findIndex(([i]) => i === id);
        zonaEl.innerHTML = `<strong>${zona}</strong> â€” ${zonaIdx + 1} de ${zonaItems.length}`;
    }

    const zona = (item.localizacao||'').trim().toUpperCase();
    document.getElementById('inv-local').textContent = zona ? ` ${zona}` : ' SEM LOCAL';
    document.getElementById('inv-ref').textContent   = item.codigo  || '';
    document.getElementById('inv-nome').textContent  = item.nome    || '';
    document.getElementById('inv-unidade').textContent =
        item.unidade && item.unidade !== 'un' ? item.unidade : '';

    // Limpar search ao navegar
    invSearchClear();

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

    // Quantidade: usa valor jÃ¡ confirmado se existir, senÃ£o o original
    const currentVal = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
    const qtyInput   = document.getElementById('inv-qtd');
    qtyInput.value   = currentVal;
    qtyInput.focus();
    qtyInput.select();

    // Enter = Confirmar (fix bug UX mobile â€” substitui listener anterior para evitar duplicados)
    const newInput = qtyInput.cloneNode(true);
    qtyInput.parentNode.replaceChild(newInput, qtyInput);
    newInput.value = currentVal;
    newInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); invConfirm(); }
    });
    newInput.focus();
    newInput.select();

    // Mostra a quantidade original do sistema como referÃªncia
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
    invSearchClear();
    // Progresso guardado â€” nÃ£o apaga para possÃ­vel retoma
}

// â”€â”€ Pesquisa inline no inventÃ¡rio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function invSearchInput(q) {
    const clearBtn = document.getElementById('inv-search-clear');
    const results  = document.getElementById('inv-search-results');
    if (!q.trim()) { invSearchClear(); return; }
    if (clearBtn) clearBtn.style.display = 'flex';
    results.style.display = 'flex';
    results.innerHTML = '';

    const term = q.trim().toLowerCase();
    // Produto actual para referÃªncia de zona
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

        const card = document.createElement('div');
        card.className = 'inv-search-result' + (isCurrent ? ' inv-search-current' : '');

        // Header: ref + zona
        const hdr = document.createElement('div');
        hdr.className = 'inv-search-result-header';
        const ref = document.createElement('span');
        ref.className = 'inv-search-result-ref';
        ref.textContent = item.codigo || 'â€”';
        const zonaBadge = document.createElement('span');
        zonaBadge.className = 'inv-search-result-zona';
        zonaBadge.textContent = zona;
        hdr.appendChild(ref); hdr.appendChild(zonaBadge);

        // Nome
        const nome = document.createElement('div');
        nome.className = 'inv-search-result-nome';
        nome.textContent = item.nome || id;

        // AcÃ§Ãµes
        const acts = document.createElement('div');
        acts.className = 'inv-search-result-actions';

        if (!isCurrent) {
            const btnGoto = document.createElement('button');
            btnGoto.className = 'inv-search-btn-goto';
            btnGoto.textContent = 'Ir para â†’';
            btnGoto.onclick = () => _invSearchJumpTo(idx);

            const btnOnly = document.createElement('button');
            btnOnly.className = 'inv-search-btn-only';
            btnOnly.textContent = 'Confirmar sÃ³ este';
            btnOnly.onclick = () => _invSearchConfirmOnly(id, item);

            acts.appendChild(btnGoto); acts.appendChild(btnOnly);
        } else {
            const lbl = document.createElement('span');
            lbl.style.cssText = 'font-size:0.75rem;color:var(--primary);font-weight:700;padding:4px 0';
            lbl.textContent = 'â† Produto actual';
            acts.appendChild(lbl);
        }

        // Contexto: outros produtos da mesma zona (atÃ© 3)
        const zonaNeighbours = _invItems
            .map(([i, p], ni) => ({ i, p, ni }))
            .filter(({ i, p }) => i !== id && (p.localizacao||'').trim().toUpperCase() === zona)
            .slice(0, 3);

        if (zonaNeighbours.length > 0) {
            const ctx = document.createElement('div');
            ctx.className = 'inv-search-result-ctx';
            zonaNeighbours.forEach(({ i, p, ni }) => {
                const row = document.createElement('div');
                row.className = 'inv-search-ctx-row' + (ni === _invIdx ? ' ctx-current' : '');
                const confirmed = _invChanges[i] !== undefined;
                row.innerHTML = `<span>${p.codigo || 'â€”'} Â· ${(p.nome||'').slice(0,22)}</span>`
                    + `<span style="color:${confirmed?'var(--success)':'var(--text-muted)'}">${confirmed ? 'âœ“' : 'â€“'}</span>`;
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
    const inp      = document.getElementById('inv-search-input');
    const clearBtn = document.getElementById('inv-search-clear');
    const results  = document.getElementById('inv-search-results');
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
    const inp = document.getElementById('inv-search-input');
    // Abre modal rÃ¡pido de confirmaÃ§Ã£o para este produto
    openConfirmModal({
        icon: 'ðŸ“¦',
        title: `Confirmar ${item.codigo || id}`,
        desc: `Qual a quantidade actual de "${item.nome || id}"? (Sistema: ${item.quantidade || 0})`,
        onConfirm: () => {
            const val = parseFloat(document.getElementById('inv-qtd')?.value);
            if (!isNaN(val) && val >= 0) {
                _invChanges[id] = val;
                _invSkipped.delete(id);
                _invSaveResume();
                showToast(`${item.codigo || id} confirmado`);
                invSearchClear();
            }
        },
    });
    // Injecto um input de quantidade no modal
    setTimeout(() => {
        const desc = document.getElementById('confirm-modal-desc');
        if (!desc) return;
        const qInput = document.createElement('input');
        qInput.type = 'number'; qInput.min = '0'; qInput.step = 'any';
        qInput.value = _invChanges[id] !== undefined ? _invChanges[id] : (item.quantidade || 0);
        qInput.className = 'inv-qty-input';
        qInput.id = 'inv-qtd'; // reutiliza o mesmo id para o onConfirm ler
        qInput.style.cssText = 'margin-top:12px;width:100%;text-align:center';
        qInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('confirm-modal-ok')?.click(); }});
        desc.parentNode.insertBefore(qInput, desc.nextSibling);
        qInput.focus(); qInput.select();
    }, 50);
}

// â”€â”€ Guardar progresso parcial â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _openInvSavePartial() {
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;
    const remaining = _invItems.length - confirmed - skipped;

    const statsEl = document.getElementById('inv-partial-stats');
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
    document.getElementById('inv-partial-modal').classList.add('active');
    focusModal('inv-partial-modal');
}

function closeInvPartial() {
    document.getElementById('inv-partial-modal').classList.remove('active');
}

// Guarda progresso no Firebase (jÃ¡ estÃ¡ guardado incrementalmente) e sai para o menu
async function invSaveAndExit() {
    // ForÃ§a um Ãºltimo save para garantir que estÃ¡ actualizado
    await _invSaveResume();
    // Fecha todos os modais do inventÃ¡rio
    document.getElementById('inv-partial-modal').classList.remove('active');
    document.getElementById('inv-modal').classList.remove('active');
    invSearchClear();
    showToast('Progresso guardado â€” podes retomar em qualquer dispositivo', 'success');
}

async function exportInventoryPartialEmail() {
    // Guarda no Firebase antes de exportar
    await _invSaveResume();
    closeInvPartial();
    // Fecha o inventÃ¡rio
    document.getElementById('inv-modal').classList.remove('active');
    invSearchClear();
    await exportInventoryEmail(true); // true = parcial
}

function _finishInventory() {
    document.getElementById('inv-modal').classList.remove('active');
    _invClearResume(); // limpa a sessÃ£o guardada

    const data = cache.stock.data || {};
    const changed = Object.entries(_invChanges).filter(([id, newQty]) => {
        const oldQty = data[id]?.quantidade;
        return oldQty !== undefined && newQty !== oldQty;
    });

    // Abre modal de revisÃ£o
    _openInvReview(changed, data);
}

function _openInvReview(changed, data) {
    const total     = _invItems.length;
    const confirmed = Object.keys(_invChanges).length;
    const skipped   = _invSkipped.size;

    const descEl = document.getElementById('inv-review-desc');
    descEl.textContent = changed.length === 0
        ? `${confirmed} produto${confirmed !== 1?'s':''} confirmado${confirmed !== 1?'s':''} â€” sem diferenÃ§as de quantidade.`
        : `${changed.length} diferenÃ§a${changed.length !== 1?'s':''} encontrada${changed.length !== 1?'s':''}. RevÃª e confirma antes de guardar.`;

    const listEl = document.getElementById('inv-review-list');
    listEl.innerHTML = '';

    if (changed.length === 0) {
        listEl.innerHTML = '<div class="empty-msg">Tudo conforme âœ“</div>';
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
            const oldSpan  = document.createElement('span');
            oldSpan.className   = 'inv-rev-old';
            oldSpan.textContent = fmtQty(oldQty, item.unidade);
            const arr  = document.createTextNode(' â†’ ');
            const newSpan  = document.createElement('span');
            newSpan.className   = 'inv-rev-new';
            newSpan.textContent = fmtQty(newQty, item.unidade);
            const sp = document.createTextNode(' ');
            const diffSpan = document.createElement('span');
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

    document.getElementById('inv-review-modal').classList.add('active');
    focusModal('inv-review-modal');
}

function invReviewBack() {
    document.getElementById('inv-review-modal').classList.remove('active');
    // Reabre o inventÃ¡rio no Ãºltimo produto
    document.getElementById('inv-modal').classList.add('active');
    _invSaveResume();
}

async function invReviewConfirm() {
    document.getElementById('inv-review-modal').classList.remove('active');

    const data    = cache.stock.data || {};
    const checked = [...document.querySelectorAll('.inv-review-cb:checked')].map(cb => cb.dataset.id);

    // EstatÃ­sticas para o ecrÃ£ de resultado
    let totalAdded   = 0;
    let totalRemoved = 0;
    let savedCount   = 0;

    // Calcula estatÃ­sticas e actualiza cache local primeiro
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
        patches.push({ id, oldQty, newQty });
    }
    // Envia todos os PATCHes em paralelo â€” muito mais rÃ¡pido que em sÃ©rie
    const results = await Promise.allSettled(
        patches.map(({ id, oldQty, newQty }) =>
            _commitStockAbsolute(id, oldQty, newQty).then(savedQty => {
                if (data[id]) data[id].quantidade = savedQty;
            })
        )
    );
    if (results.some(r => r.status === 'rejected')) {
        console.warn('invSave: alguns PATCHes falharam');
        invalidateCache('stock');
        if (results.some(r => r.status === 'rejected' && r.reason?.message === 'STOCK_CONFLICT')) {
            showToast('Inventario com conflito: houve movimentos durante a contagem. Revê os artigos afectados.', 'error');
        }
    }

    renderList(window._searchInputEl?.value || '', true);
    renderDashboard();

    // Guardar snapshot final para exportaÃ§Ã£o
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
                <span class="inv-stat-num">âˆ’${stats.removed}</span>
                <span class="inv-stat-label">Unid. removidas</span>
            </div>
        </div>
        ${stats.saved > 0
            ? `<p class="inv-result-saved">${stats.saved} alteraÃ§Ã£o${stats.saved !== 1?'s':''} guardada${stats.saved !== 1?'s':''} no sistema.</p>`
            : '<p class="inv-result-saved">Nenhuma diferenÃ§a encontrada â€” stock conforme!</p>'}
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
            return `â€¢ ${item.nome||id} (${item.localizacao||'sem zona'}): ${fmtQty(oq, item.unidade)} â†’ ${fmtQty(nq, item.unidade)}`;
        });

    const parcialLabel = parcial ? ' [PARCIAL]' : '';
    const subject = encodeURIComponent(`InventÃ¡rio Hiperfrio${parcialLabel} â€” ${dateStr}`);
    const body = encodeURIComponent(
        `InventÃ¡rio Hiperfrio${parcialLabel} â€” ${dateStr}\n\n`
        + `Produtos verificados: ${Object.keys(_invChanges).length}/${_invItems.length}\n`
        + (parcial ? `Por verificar: ${_invItems.length - Object.keys(_invChanges).length - _invSkipped.size}\n` : '')
        + `DiferenÃ§as encontradas: ${diffRows.length}\n\n`
        + (diffRows.length > 0 ? 'ALTERAÃ‡Ã•ES:\n' + diffRows.join('\n') + '\n\n' : 'Sem diferenÃ§as de stock.\n\n')
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
            const filename = `inventario-hiperfrio${parcial ? '-parcial' : ''}-${now.toISOString().slice(0,10)}.xlsx`;
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: `InventÃ¡rio Hiperfrio${parcialLabel} â€” ${dateStr}`,
                    text:  `RelatÃ³rio de inventÃ¡rio de ${dateStr}`,
                    files: [file],
                });
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('share:', e);
        }
    }

    // Fallback: download do Excel + mailto com destinatÃ¡rio prÃ©-preenchido
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
            : newQty === undefined ? 'NÃ£o verificado'
            : newQty === origQty   ? 'Conforme'
            : newQty > origQty     ? 'Corrigido â†‘' : 'Corrigido â†“';
        return {
            'ReferÃªncia': item.codigo||'', 'Nome': item.nome||'',
            'Zona': item.localizacao||'SEM LOCAL',
            'Qtd Sistema': origQty,
            'Qtd InventÃ¡rio': newQty !== undefined ? newQty : origQty,
            'DiferenÃ§a': newQty !== undefined ? newQty - origQty : 0,
            'Unidade': item.unidade === 'un' || !item.unidade ? '' : item.unidade,
            'Estado': status, 'Notas': item.notas||'',
        };
    });
    const wb  = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(rows);
    ws1['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, 'InventÃ¡rio Completo');
    const diffRows = rows.filter(r => r['DiferenÃ§a'] !== 0);
    if (diffRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(diffRows);
        ws2['!cols'] = [12,30,12,14,16,12,10,18,25].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws2, 'DiferenÃ§as');
    }
    const ws3 = XLSX.utils.aoa_to_sheet([
        ['Hiperfrio Stock â€” RelatÃ³rio de InventÃ¡rio',''],
        ['Data', now.toLocaleDateString('pt-PT')],
        ['Hora', now.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'})],
        ['Produtos verificados', Object.keys(_invChanges).length],
        ['Produtos saltados', _invSkipped.size],
        ['Total de produtos', _invItems.length],
        ['DiferenÃ§as encontradas', diffRows.length],
    ]);
    ws3['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Resumo');
    return wb;
}

// â”€â”€ InventÃ¡rio Resume â€” Firebase /inv-resume/shared (72h TTL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Caminho Ãºnico partilhado â€” nÃ£o depende do dispositivo nem do username em localStorage
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
        // await o fetch â€” garante que os dados chegaram ao Firebase antes de continuar
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
            console.log('invLoadResume: sem sessÃ£o guardada');
            return null;
        }
        if (Date.now() - (saved.ts || 0) > INV_RESUME_FIREBASE_TTL) {
            console.log('invLoadResume: sessÃ£o expirada');
            _invClearResume();
            return null;
        }
        console.log(`invLoadResume: encontrada sessÃ£o â€” produto ${saved.idx + 1}/${saved.items.length}`);
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAPA DE PEDIDOS PAT â€” Leaflet + Nominatim (OpenStreetMap)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let _patMap            = null;  // instÃ¢ncia Leaflet
let _markerJustClicked = false; // flag para nÃ£o fechar sheet ao clicar marker
let _patMapMarkers = [];    // markers actuais
let _patMapOpen    = false;

// â”€â”€ Geocoding cache â€” Firebase /geocode-cache/ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Estrutura: { "pingo doce esmoriz": { lat, lng, ts }, ... }
// Cache em memÃ³ria para a sessÃ£o actual (evita re-fetch do Firebase)
const _geocodeCache = {};         // memÃ³ria: key â†’ {lat,lng} | null
let   _geocodeCacheLoaded = false; // flag: jÃ¡ carregÃ¡mos do Firebase?

const GEOCODE_CACHE_URL = `${BASE_URL}/geocode-cache.json`;

function _normEstabKey(nome) {
    return (nome || '').trim().toLowerCase();
}

function _firebaseGeocodeKey(key) {
    return key.replace(/[.#$\/\[\]]/g, '_');
}

async function _persistEstabCoords(nome, coords, clienteNumero = '') {
    const key = _normEstabKey(nome);
    if (!key || !coords) return;

    _geocodeCache[key] = { lat: coords.lat, lng: coords.lng };
    _saveGeocodeCacheEntry(key, coords);

    const clientes = _clientesCache.data || {};
    const clienteMatch = Object.entries(clientes).find(([, c]) => {
        const sameNumero = clienteNumero && String(c.numero || '').trim() === String(clienteNumero).trim();
        const sameNome = _normEstabKey(c.nome) === key;
        return sameNumero || sameNome;
    });
    if (!clienteMatch) return;

    const [clienteId, cliente] = clienteMatch;
    const lat = parseFloat(coords.lat);
    const lng = parseFloat(coords.lng);
    const oldLat = parseFloat(cliente.lat);
    const oldLng = parseFloat(cliente.lng);
    const changed = !Number.isFinite(oldLat) || !Number.isFinite(oldLng)
        || Math.abs(oldLat - lat) > 0.000001
        || Math.abs(oldLng - lng) > 0.000001;
    if (!changed) return;

    if (_clientesCache.data?.[clienteId]) {
        _clientesCache.data[clienteId] = { ..._clientesCache.data[clienteId], lat, lng };
    }
    try {
        await apiFetch(`${BASE_URL}/clientes/${clienteId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng })
        });
    } catch (e) {
        console.warn('[geocache] falha ao guardar coords no cliente:', clienteId, e?.message);
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

// Carrega toda a cache do Firebase para memÃ³ria (1 fetch, feito uma vez)
async function _loadGeocodeCache() {
    if (_geocodeCacheLoaded) return;
    try {
        const url = await authUrl(GEOCODE_CACHE_URL);
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[geocache] HTTP ${res.status} â€” a continuar sem cache Firebase`);
            // 401 = rules nÃ£o publicadas ainda; continua sem cache (geocodifica tudo)
            _geocodeCacheLoaded = true;
            return;
        }
        const data = await res.json();
        if (data && typeof data === 'object') {
            Object.entries(data).forEach(([k, v]) => {
                const rawKey = _normEstabKey(v?.keyOriginal || k);
                if (!rawKey) return;
                _geocodeCache[rawKey] = (v && v.lat != null && v.lng != null) ? { lat: v.lat, lng: v.lng } : null;
            });
            console.log(`[geocache] ${Object.keys(_geocodeCache).length} entradas carregadas`);
        } else {
            console.log('[geocache] cache vazia (primeira utilizaÃ§Ã£o)');
        }
    } catch(e) {
        console.warn('[geocache] erro ao carregar:', e);
    }
    _geocodeCacheLoaded = true;
}

// Persiste uma entrada na cache Firebase (fire-and-forget, ignora erros de rules)
async function _saveGeocodeCacheEntry(key, coords) {
    try {
        const safeKey = _firebaseGeocodeKey(key);
        const url = await authUrl(`${BASE_URL}/geocode-cache/${encodeURIComponent(safeKey)}.json`);
        const payload = coords
            ? JSON.stringify({ keyOriginal: key, lat: coords.lat, lng: coords.lng, ts: Date.now() })
            : JSON.stringify(null);
        fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload })
            .then(r => { if (!r.ok) console.warn(`[geocache] save ${r.status} para "${key}"`); })
            .catch(e => console.warn('[geocache] save erro:', e));
    } catch(e) { console.warn('[geocache] saveEntry:', e); }
}

// Atraso entre pedidos Nominatim (1 req/s conforme ToS)
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _geocodeEstab(nome, saveToFirebase = true) {
    const key = _normEstabKey(nome);

    // 1. Verificar se o cliente tem coordenadas manuais na Firebase
    const clientes = _clientesCache.data || {};
    const clienteMatch = Object.values(clientes).find(c =>
        _normEstabKey(c.nome) === key && c.lat != null && c.lng != null
    );
    if (clienteMatch) {
        const coords = { lat: parseFloat(clienteMatch.lat), lng: parseFloat(clienteMatch.lng) };
        _geocodeCache[key] = coords;
        return coords;
    }

    // 2. Cache em memÃ³ria (sessÃ£o ou Firebase prÃ©-carregado)
    if (_geocodeCache[key] !== undefined) return _geocodeCache[key];

    // 2. Nominatim â€” estratÃ©gia multi-tentativa
    const cleaned = nome
        .replace(/-\s*\d+\s*$/, '')
        .replace(/\s+\d+\s*$/, '')
        .replace(/[()]/g, '')
        .trim();

    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    const stopWords = ['PINGO','DOCE','CONTINENTE','JUMBO','LIDL','ALDI','MERCADONA','BP','GALP','REPSOL','DISCOUNT','ARMAZEM','GERAL','HIPERFRIO','SUPERMERCADO','MINIPRECO','INTERMARCHE','SHOPPING','RECHEIO'];
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
                    await _persistEstabCoords(nome, result, clienteMatch?.numero || '');
                } else {
                    _geocodeCache[key] = result;
                }
                return result;
            }
        } catch(e) { continue; }
        await _sleep(800);
    }

    _geocodeCache[key] = null;
    if (saveToFirebase) _saveGeocodeCacheEntry(key, null);
    return null;
}

// Ãcones de estabelecimentos customizados
// Para adicionar novos: { match: /regex/, icon: 'ficheiro.png', size: [w, h] }
const _CHAIN_ICONS = [
    {
        match: /pingo\s*doce/i,
        icon:  'pingo-doce-pin.png',
        size:  [64, 50],
        anchor: [32, 50],
        popup:  [0, -52],
    },
    {
        match: /continente/i,
        icon:  'continente-pin.png',
        size:  [64, 57],
        anchor: [32, 57],
        popup:  [0, -59],
    },
    {
        match: /recheio/i,
        icon:  'recheio-pin.png',
        size:  [64, 57],
        anchor: [32, 57],
        popup:  [0, -59],
    },
    {
        match: /leclerc/i,
        icon:  'leclerc-pin.png',
        size:  [64, 57],
        anchor: [32, 57],
        popup:  [0, -59],
    },
];

function _getChainIcon(nomeEstab) {
    const nome = (nomeEstab || '').trim();
    for (const chain of _CHAIN_ICONS) {
        if (chain.match.test(nome)) {
            return L.icon({
                iconUrl:    chain.icon,
                iconSize:   chain.size,
                iconAnchor: chain.anchor,
                popupAnchor: chain.popup,
            });
        }
    }
    return null;
}

function _makePinIcon(count, urgente, separacao) {
    const color = urgente ? 'red' : separacao ? 'amber' : 'blue';
    const cls   = count > 1 ? 'cluster' : color;

    // SVG de gota invertida (teardrop) com buraco branco no centro
    const countHtml = count > 1
        ? `<div class="pat-pin-count">${count}</div>`
        : '';

    const html = `
        <div class="pat-pin ${cls}">
            <svg viewBox="0 0 36 44" xmlns="http://www.w3.org/2000/svg">
                <path class="pat-pin-body"
                    d="M18 2 C9.163 2 2 9.163 2 18 C2 28.5 18 42 18 42 C18 42 34 28.5 34 18 C34 9.163 26.837 2 18 2 Z"
                    stroke="white" stroke-width="1.5"
                />
                <circle class="pat-pin-hole" cx="18" cy="17" r="6"/>
            </svg>
            ${countHtml}
        </div>`;

    return L.divIcon({
        className: '',
        html,
        iconSize:    [36, 44],
        iconAnchor:  [18, 44],
        popupAnchor: [0, -46],
    });
}

// â”€â”€ Map Pin Bottom-Sheet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _mapPinCoords  = null;
let _mapPinExpanded = null; // id da PAT expandida (modo detalhe)

function openMapPinSheet(pats, coords) {
    _mapPinCoords   = coords;
    _mapPinExpanded = pats.length === 1 ? pats[0][0] : null;

    const sheet = document.getElementById('map-pin-sheet');
    if (!sheet) return;

    _renderMapPinSheet(pats);
    sheet.classList.remove('closing');
    sheet.classList.add('open');

    // Posicionar junto ao pin apÃ³s render (precisamos da altura real)
    requestAnimationFrame(() => _positionSheetNearPin(coords, sheet));
}

function _positionSheetNearPin(coords, sheet) {
    if (!_patMap || !coords) return;

    const point = _patMap.latLngToContainerPoint([coords.lat, coords.lng]);
    const mapContainer = document.getElementById('pat-map-container');
    if (!mapContainer) return;

    const mapRect = mapContainer.getBoundingClientRect();
    const pinX    = mapRect.left + point.x;
    const pinY    = mapRect.top  + point.y;

    const sheetW  = sheet.offsetWidth  || 320;
    const sheetH  = sheet.offsetHeight || 200;
    const vw      = window.innerWidth;
    const vh      = window.innerHeight;
    const margin  = 12;
    const gap     = 14; // espaÃ§o entre pin e sheet

    // PreferÃªncia: acima do pin, centrado horizontalmente
    let left = pinX - sheetW / 2;
    let top  = pinY - sheetH - gap;
    let arrowBelow = true; // seta aponta para baixo (pin estÃ¡ abaixo do sheet)

    // Se sair pelo topo â†’ colocar abaixo do pin
    if (top < mapRect.top + margin) {
        top = pinY + gap;
        arrowBelow = false; // seta aponta para cima (pin estÃ¡ acima do sheet)
    }

    // Ajustar horizontalmente
    if (left < mapRect.left + margin) left = mapRect.left + margin;
    if (left + sheetW > vw - margin)  left = vw - sheetW - margin;

    // Garantir que nÃ£o sai pela base
    if (top + sheetH > vh - margin) top = vh - sheetH - margin;

    sheet.style.left   = Math.round(left) + 'px';
    sheet.style.top    = Math.round(top)  + 'px';
    sheet.style.bottom = 'auto';
    sheet.style.right  = 'auto';

    // Posicionar a seta a apontar para o pin
    const arrow = document.getElementById('map-pin-arrow');
    if (arrow) {
        const arrowX = Math.round(pinX - left); // posiÃ§Ã£o X da seta relativa ao sheet
        const clampedX = Math.max(20, Math.min(arrowX, sheetW - 20));
        arrow.style.left      = clampedX + 'px';
        arrow.style.transform = 'translateX(-50%)';
        if (arrowBelow) {
            // Seta em baixo do sheet
            arrow.style.bottom   = '-7px';
            arrow.style.top      = 'auto';
            arrow.style.clipPath = 'polygon(0 0, 100% 0, 50% 100%)';
        } else {
            // Seta em cima do sheet
            arrow.style.top      = '-7px';
            arrow.style.bottom   = 'auto';
            arrow.style.clipPath = 'polygon(50% 0, 0 100%, 100% 100%)';
        }
    }
}

function _renderMapPinSheet(pats) {
    const estabEl  = document.getElementById('map-pin-estab');
    const badgesEl = document.getElementById('map-pin-badges');
    const patsEl   = document.getElementById('map-pin-pats');

    const nome     = pats[0][1].estabelecimento || 'â€”';
    const urgentes = pats.filter(([, p]) => _calcDias(p.criadoEm) >= 15);
    const comGuia  = pats.filter(([, p]) => !!p.separacao);

    // Header â€” nome em destaque
    estabEl.textContent = nome;
    badgesEl.innerHTML  = '';
    if (pats.length > 1) {
        const b = document.createElement('span');
        b.className = 'map-pin-badge count';
        b.textContent = `${pats.length} pedidos`;
        badgesEl.appendChild(b);
    }
    if (urgentes.length > 0) {
        const b = document.createElement('span');
        b.className = 'map-pin-badge urgente';
        b.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${urgentes.length} urgente${urgentes.length !== 1 ? 's' : ''}`;
        badgesEl.appendChild(b);
    }
    if (comGuia.length > 0) {
        const b = document.createElement('span');
        b.className = 'map-pin-badge guia';
        b.textContent = 'Guia Transporte';
        badgesEl.appendChild(b);
    }

    patsEl.innerHTML = '';

    if (pats.length === 1) {
        // Vista Ãºnica â€” mostrar detalhe completo directamente
        patsEl.appendChild(_buildPatDetail(pats[0], pats));
    } else {
        // MÃºltiplas â€” resumo + expandir ao clicar
        pats.forEach(([id, pat]) => {
            const dias    = _calcDias(pat.criadoEm);
            const urgente = dias >= 15;
            const diasLbl = dias === 0 ? 'Hoje' : dias === 1 ? 'HÃ¡ 1 dia' : `HÃ¡ ${dias} dias`;
            const isExpanded = _mapPinExpanded === id;

            const wrapper = document.createElement('div');
            wrapper.className = `map-pin-pat-row${urgente ? ' urgente' : ''}`;
            wrapper.dataset.patId = id;

            // CabeÃ§alho resumo (sempre visÃ­vel)
            const summary = document.createElement('div');
            summary.className = 'map-pin-pat-summary';
            summary.innerHTML = `
                <div class="map-pin-pat-top">
                    <span class="map-pin-pat-num">PAT ${pat.numero || 'â€”'}</span>
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

            // Detalhe (expansÃ­vel)
            if (isExpanded) {
                wrapper.appendChild(_buildPatDetail([id, pat], pats));
            }

            patsEl.appendChild(wrapper);
        });
    }
}

function _buildPatDetail([id, pat], allPats) {
    const dias    = _calcDias(pat.criadoEm);
    const urgente = dias >= 15;
    const prods   = pat.produtos || [];

    const detail = document.createElement('div');
    detail.className = 'map-pin-pat-detail';

    // Tags
    if (pat.separacao) {
        const tags = document.createElement('div');
        tags.className = 'map-pin-pat-tags';
        tags.innerHTML = '<span class="map-pin-pat-tag guia">Guia Transporte</span>';
        detail.appendChild(tags);
    }

    // Produtos
    if (prods.length > 0) {
        const prodsEl = document.createElement('div');
        prodsEl.className = 'map-pin-pat-prods';
        prods.forEach(p => {
            const chip = document.createElement('span');
            chip.className = 'map-pin-pat-prod';
            chip.textContent = `${p.codigo || '?'} Ã—${p.quantidade || 1}`;
            prodsEl.appendChild(chip);
        });
        detail.appendChild(prodsEl);
    } else {
        const empty = document.createElement('p');
        empty.className = 'map-pin-no-prods';
        empty.textContent = 'Sem produtos associados';
        detail.appendChild(empty);
    }

    // BotÃ£o levantar com confirmaÃ§Ã£o
    const levBtn = document.createElement('button');
    levBtn.className = 'map-pin-lev-btn';
    levBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Dar como levantado`;
    levBtn.onclick = () => {
        // ConfirmaÃ§Ã£o via modal existente da app
        openConfirmModal({
            icon: 'âœ“',
            title: 'Confirmar levantamento',
            desc: `PAT ${pat.numero || id} â€” ${escapeHtml(pat.estabelecimento || '')}`,
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
                        const sheet = document.getElementById('map-pin-sheet');
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
    const sheet = document.getElementById('map-pin-sheet');
    if (!sheet || !sheet.classList.contains('open')) return;
    sheet.classList.add('closing');
    setTimeout(() => {
        sheet.classList.remove('open', 'closing');
        // Repor posiÃ§Ã£o para prÃ³xima abertura
        sheet.style.left   = '';
        sheet.style.top    = '';
        sheet.style.bottom = '';
        sheet.style.right  = '';
    }, 200);
}

function openMapPinGmaps() {
    if (!_mapPinCoords) return;
    const { lat, lng } = _mapPinCoords;
    const nome = document.getElementById('map-pin-estab')?.textContent || '';
    const q = encodeURIComponent(nome + ', Portugal');
    window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank');
}

function centerMapOnPin() {
    if (!_patMap || !_mapPinCoords) return;
    _patMap.setView([_mapPinCoords.lat, _mapPinCoords.lng], 15, { animate: true });
}

async function openPatMap() {
    _patMapOpen = true;

    // Navegar para a vista do mapa
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-map')?.classList.add('active');
    document.getElementById('main-content')?.classList.add('map-view-active');
    window.scrollTo(0, 0);

    const loadingEl  = document.getElementById('pat-map-loading');
    const loadingTxt = document.getElementById('pat-map-loading-text');
    const errorEl    = document.getElementById('pat-map-error');
    const subtitleEl = document.getElementById('pat-map-subtitle');
    const container  = document.getElementById('pat-map-container');

    if (loadingEl) loadingEl.style.display = 'flex';
    if (errorEl)   errorEl.style.display   = 'none';
    if (subtitleEl) subtitleEl.textContent  = '';
    if (loadingTxt) loadingTxt.textContent  = 'A preparar mapa...';

    if (!container) { console.error('[map] container nÃ£o encontrado'); return; }

    // Calcular altura disponÃ­vel directamente via viewport
    // vh - header (~60px) - topbar da vista (~80px) - padding bottom
    const headerEl = document.getElementById('app-header');
    const headerH  = headerEl ? headerEl.offsetHeight : 60;
    const mapHeaderEl = document.querySelector('.pat-map-header');
    await _sleep(50); // um tick para o DOM pintar
    const mapHeaderH = mapHeaderEl ? mapHeaderEl.offsetHeight : 80;
    const availH = window.innerHeight - headerH - mapHeaderH;
    container.style.height = availH + 'px';
    container.style.width  = '100%';
    console.log(`[map] header:${headerH}px mapHeader:${mapHeaderH}px container:${container.offsetWidth}x${availH}px`);

    // Reutilizar instÃ¢ncia do mapa se jÃ¡ existir (evita reload desnecessÃ¡rio)
    if (_patMap) {
        _patMapMarkers.forEach(m => m.remove());
        _patMapMarkers = [];
    }

    // Bounds de Portugal continental + ilhas (AÃ§ores e Madeira incluÃ­dos)
    const PT_BOUNDS = L.latLngBounds(
        L.latLng(30.0, -31.5),   // SW â€” inclui AÃ§ores
        L.latLng(42.2, -6.2)     // NE â€” nordeste de TrÃ¡s-os-Montes
    );

    if (!_patMap) { _patMap = L.map('pat-map-container', {
        center:       [39.6, -8.0],  // centro aproximado de Portugal continental
        zoom:         7,
        minZoom:      6,             // nÃ£o deixa afastar mais do que isto
        maxZoom:      17,
        maxBounds:    PT_BOUNDS,
        maxBoundsViscosity: 1.0,     // 1.0 = limite rÃ­gido, nÃ£o deixa arrastar para fora
        zoomControl:  true,
    });

    // CartoDB Positron â€” minimalista, sem API key, gratuito
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: 'Â© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> Â© <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20,
        minZoom: 6,
    }).addTo(_patMap);

    // Centrar em Portugal ao arrancar
    _patMap.fitBounds(PT_BOUNDS, { padding: [20, 20] });
    _patMap.invalidateSize();
    // Fechar sheet ao clicar no mapa
    _patMap.on('click', () => {
        if (_markerJustClicked) { _markerJustClicked = false; return; }
        closeMapPinSheet();
    }); } // fim do if (!_patMap)

    if (loadingTxt) loadingTxt.textContent = 'A carregar pedidos...';

    // Limpar markers anteriores
    _patMapMarkers.forEach(m => m.remove());
    _patMapMarkers = [];

    // Buscar PATs pendentes
    const pats = await _fetchPats();
    const pendentes = Object.entries(pats || {})
        .filter(([, p]) => p.status !== 'levantado' && p.status !== 'historico');

    if (pendentes.length === 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'flex';
        document.getElementById('pat-map-error-text').textContent = 'Sem pedidos pendentes para mostrar.';
        return;
    }

    subtitleEl.textContent = `A preparar localizaÃ§Ãµes...`;

    // Agrupar por estabelecimento (mesmo nome â†’ mesmo pin)
    const groups = {};
    pendentes.forEach(([id, pat]) => {
        const key = _normEstabKey(pat.estabelecimento);
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        groups[key].push([id, pat]);
    });
    const groupEntries = Object.entries(groups);

    // â”€â”€ Passo 1: Carregar cache do Firebase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (loadingTxt) loadingTxt.textContent = 'A carregar localizaÃ§Ãµes guardadas...';
    await _loadGeocodeCache();

    const cached  = groupEntries.filter(([k]) => _geocodeCache[k] !== undefined);
    const missing = groupEntries.filter(([k]) => _geocodeCache[k] === undefined);
    console.log(`[map] ${cached.length} em cache, ${missing.length} por geocodificar`);

    // â”€â”€ Passo 2: Helper para adicionar marker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function _addMarker(estabKey, items) {
        const coords = _geocodeCache[estabKey];
        if (!coords) return false;
        const urgente   = items.some(([, p]) => _calcDias(p.criadoEm) >= 15);
        const separacao = items.some(([, p]) => !!p.separacao);
        const nomeEstab = items[0][1].estabelecimento || '';
        const chainIcon = _getChainIcon(nomeEstab);
        const icon = chainIcon || _makePinIcon(items.length, urgente, separacao);
        const marker = L.marker([coords.lat, coords.lng], { icon })
            .addTo(_patMap);
        const _lat   = coords.lat;
        const _lng   = coords.lng;
        marker.on('click', () => {
            const currentItems = _getMapPendingPatsForEstab(items[0]?.[1]?.estabelecimento || estabKey);
            if (currentItems.length === 0) {
                marker.remove();
                _patMapMarkers = _patMapMarkers.filter(m => m !== marker);
                closeMapPinSheet();
                return;
            }
            console.log('[map] marker clicado:', currentItems[0][1].estabelecimento);
            _markerJustClicked = true;
            console.log('[map] a chamar openMapPinSheet, tipo:', typeof openMapPinSheet);
            try {
                openMapPinSheet(currentItems, { lat: _lat, lng: _lng });
                console.log('[map] openMapPinSheet concluiu sem erro');
            } catch(e) {
                console.error('[map] ERRO em openMapPinSheet:', e.message, e.stack);
            }
        });
        _patMapMarkers.push(marker);
        return true;
    }

    // â”€â”€ Passo 3: Mostrar pins da cache imediatamente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        if (bounds.length === 1) { _patMap.setView(bounds[0], 13); }
        else if (bounds.length > 1) { _patMap.fitBounds(bounds, { padding: [40, 40] }); }
        const pendingTxt = ''; // sem mensagem de 'a localizar novos'
        subtitleEl.textContent = `${geocoded} estabelecimento${geocoded !== 1 ? 's' : ''} no mapa${pendingTxt}`;
        setTimeout(() => _patMap && _patMap.invalidateSize(), 200);
    }

    // â”€â”€ Passo 4: Geocodificar os que faltam (background se jÃ¡ hÃ¡ pins) â”€â”€â”€
    if (missing.length === 0) {
        if (geocoded === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) { errorEl.style.display = 'flex'; document.getElementById('pat-map-error-text').textContent = 'NÃ£o foi possÃ­vel localizar nenhum estabelecimento.'; }
        }
        const naoEncontrados = groupEntries.filter(([k]) => _geocodeCache[k] === null).length;
        if (naoEncontrados > 0) subtitleEl.textContent += ` Â· ${naoEncontrados} nÃ£o localizado${naoEncontrados !== 1 ? 's' : ''}`;
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

        const coords = await _geocodeEstab(nomeOriginal, true);
        if (!_patMapOpen) break;
        if (!coords) { failed++; continue; }

        newGeocoded++;
        bounds.push([coords.lat, coords.lng]);
        _addMarker(estabKey, items);

        if (bounds.length > 1) { _patMap.fitBounds(bounds, { padding: [40, 40] }); }
        else { _patMap.setView([coords.lat, coords.lng], 13); }

        if (newGeocoded === 1 && geocoded === 0) {
            if (loadingEl) loadingEl.style.display = 'none';
        }
        if (i < missing.length - 1) await _sleep(1100);
    }

    if (loadingEl) loadingEl.style.display = 'none';

    const totalShown = geocoded + newGeocoded;
    if (totalShown === 0) {
        if (errorEl) { errorEl.style.display = 'flex'; document.getElementById('pat-map-error-text').textContent = 'NÃ£o foi possÃ­vel localizar nenhum estabelecimento.'; }
        return;
    }

    const failedTxt = failed > 0 ? ` Â· ${failed} nÃ£o localizad${failed !== 1 ? 'os' : 'o'}` : '';
    const newTxt    = ''; // sem mensagem de 'novos guardados'
    subtitleEl.textContent = `${totalShown} estabelecimento${totalShown !== 1 ? 's' : ''} no mapa${newTxt}${failedTxt}`;

    // ForÃ§ar Leaflet a recalcular dimensÃµes
    setTimeout(() => _patMap && _patMap.invalidateSize(), 200);
}

function closePatMap() {
    _patMapOpen = false;
    document.getElementById('main-content')?.classList.remove('map-view-active');
    nav('view-pedidos');
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
            el.innerHTML = '<div class="empty-msg">Sem ligaÃ§Ã£o â€” timeline indisponÃ­vel offline.</div>';
            return;
        }
        const ferrData = await fetchCollection('ferramentas', true);
        if (!ferrData) { el.innerHTML = '<div class="empty-msg">Sem dados.</div>'; return; }

        // Recolhe todos os eventos de histÃ³rico
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
                action.textContent = `ðŸ”´ Com ${ev.colaborador || '?'} hÃ¡ ${ev._dias}d`;
                action.className += ' tl-action-overdue';
            } else if (ev.acao === 'atribuida') {
                action.textContent = `â†’ Entregue a ${ev.colaborador || '?'}`;
            } else {
                action.textContent = `â†© Devolvida${ev.colaborador ? ' por ' + ev.colaborador : ''}`;
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
// BOTTOM NAV â€” botÃ£o + com mini-menu
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
    // PAT: sÃ³ aceita dÃ­gitos
    document.getElementById('pat-numero')?.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
        const hint = document.getElementById('pat-numero-hint');
        if (hint) {
            if (this.value.length > 0 && this.value.length < 6) {
                hint.textContent = `${this.value.length}/6 dÃ­gitos`;
                hint.style.color = 'var(--text-muted)';
            } else {
                hint.textContent = '';
            }
        }
    });

    // Tema
    const savedTheme = localStorage.getItem('hiperfrio-tema') || 'light';
    _applyTheme(savedTheme);
    // _applyTheme jÃ¡ chama _setupSearchScrollBehaviour e _setupBottomNavScrollBehaviour
    _setupAdminSwipe();

    // Verifica perfil guardado â€” se existir, arranca diretamente
    const savedRole = localStorage.getItem(ROLE_KEY);
    if (savedRole === 'worker' || savedRole === 'manager') {
        applyRole(savedRole);
        bootApp();
    }

    // Pesquisa com debounce â€” cache o elemento para evitar lookups repetidos
    const searchInput = document.getElementById('inp-search');
    const searchClear = document.getElementById('inp-search-clear');
    window._searchInputEl = searchInput; // referÃªncia global para renderList
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

    // DelegaÃ§Ã£o de eventos nas ferramentas â€” um Ãºnico listener no container
    const toolsListEl = document.getElementById('tools-list');
    if (toolsListEl) {
        toolsListEl.addEventListener('contextmenu', e => {
            const div = e.target.closest('[data-tool-id]');
            if (!div) return;
            e.preventDefault();
            openHistoryModal(div.dataset.toolId, div.dataset.toolNome);
        });
        let _lpTimer = null;
        toolsListEl.addEventListener('touchstart', e => {
            const div = e.target.closest('[data-tool-id]');
            if (!div) return;
            _lpTimer = setTimeout(() => openHistoryModal(div.dataset.toolId, div.dataset.toolNome), 600);
        }, { passive: true });
        toolsListEl.addEventListener('touchend',  () => clearTimeout(_lpTimer), { passive: true });
        toolsListEl.addEventListener('touchmove', () => clearTimeout(_lpTimer), { passive: true });
    }

    // Pesquisa de ferramentas (usa _debounce centralizado)
    document.getElementById('inp-tools-search')?.addEventListener('input', _debounce(e => {
        _toolsFilter = e.target.value.trim() || 'all';
        renderTools();
    }, 250));

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
            { id: 'modal-edit-cliente', close: closeEditClienteModal },
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
        showToast('Sem ligaÃ§Ã£o â€” alteraÃ§Ãµes guardadas localmente', 'error');
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

    // Confirm modal OK â€” desabilita durante operaÃ§Ãµes async
    document.getElementById('confirm-modal-ok').onclick = async () => {
        const cb = confirmCallback;
        if (!cb) return;
        const btn = document.getElementById('confirm-modal-ok');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'A processar...';
        closeConfirmModal();
        try { await cb(); }
        finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    // Delete confirm
    document.getElementById('delete-confirm-btn').onclick = async () => {
        if (!pendingDeleteId) return;
        const id   = pendingDeleteId;
        const item = cache.stock.data[id];
        closeDeleteModal();
        delete cache.stock.data[id];
        if (item) registarMovimento('remocao', id, item.codigo, item.nome, item.quantidade || 0);
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
        const _oldQtyEdit = cache.stock.data?.[id]?.quantidade ?? 0;
        cache.stock.data[id] = { ...cache.stock.data[id], ...updated };
        btn.textContent = 'A guardar...';
        closeEditModal();
        renderList(window._searchInputEl?.value || '', true);
        if (updated.quantidade < _oldQtyEdit) {
            registarMovimento('saida_manual', id, updated.codigo, updated.nome, _oldQtyEdit - updated.quantidade);
        }
        try {
            await apiFetch(`${BASE_URL}/stock/${id}.json`, { method:'PATCH', body:JSON.stringify(updated) });
            showToast('Produto atualizado!');
        } catch (e) { console.warn('editProduct:', e?.message||e); invalidateCache('stock'); showToast('Erro ao guardar alteraÃ§Ãµes','error'); }
        finally { btn.disabled = false; btn.textContent = 'Guardar AlteraÃ§Ãµes'; }
    });

    // Form: FuncionÃ¡rio
    document.getElementById('form-worker')?.addEventListener('submit', async e => {
        e.preventDefault();
        if (!requireManagerAccess()) return;
        const nome = document.getElementById('worker-name').value.trim().toUpperCase();
        if (!nome) return;
        try {
            const res = await apiFetch(`${BASE_URL}/funcionarios.json`, { method:'POST', body:JSON.stringify({nome}) });
            if (!cache.funcionarios.data) cache.funcionarios.data = {};
            if (res) { const r = await res.json(); if (r?.name) cache.funcionarios.data[r.name] = {nome}; }
            else { cache.funcionarios.data[`_tmp_${Date.now()}`] = {nome}; }
            document.getElementById('worker-name').value = '';
            renderWorkers(); showToast('FuncionÃ¡rio adicionado');
        } catch(_e) { invalidateCache('funcionarios'); showToast('Erro ao adicionar funcionÃ¡rio','error'); }
    });

    // Form: Registar Ferramenta
    document.getElementById('form-tool-reg')?.addEventListener('submit', async e => {
        e.preventDefault();
        if (!requireManagerAccess()) return;
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
const SW_EXPECTED_VERSION = 'hiperfrio-v6.46';
const SW_SCRIPT_URL = 'sw.js?v=6.46';

if ('serviceWorker' in navigator) {
    // ForÃ§ar limpeza de SW desactualizados
    /* preserva o SW actual */
    // Limpar todas as caches
    /* preserva cache do SW activo */
    window.addEventListener('load', () => {
        // 1 â€” Regista o SW novo
        navigator.serviceWorker.register(SW_SCRIPT_URL)
            .then(reg => {
                reg.update().catch(() => {});
                // 2 â€” Verifica se o SW activo Ã© a versÃ£o correcta
                // Se for uma versÃ£o antiga (cache-first), forÃ§a update imediato
                if (reg.active) {
                    const msgChannel = new MessageChannel();
                    msgChannel.port1.onmessage = e => {
                        if (e.data && e.data.version !== SW_EXPECTED_VERSION) {
                            console.warn('SW desactualizado â€” a forÃ§ar update...');
                            reg.update().then(() => {
                                // ApÃ³s update, recarrega para aplicar
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

        // 3 â€” Se o SW mudar enquanto a app estÃ¡ aberta, recarrega automaticamente
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
// CLIENTES â€” autocomplete NÂº Cliente no modal PAT
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

    // NÃºmero exacto â€” verifica quantos clientes partilham esse NR
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

    // SugestÃµes parciais
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
        hdr.textContent = matches.length + ' estabelecimentos com este NÂº â€” escolhe:';
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

// â”€â”€ Lista de clientes no Admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderClientesList() {
    const list = document.getElementById('clientes-list');
    if (!list) return;
    list.innerHTML = '<div class="pat-loading">A carregar...</div>';
    const data    = await _fetchClientes(true);
    const entries = Object.entries(data || {})
        .sort((a, b) => Number(a[1].numero) - Number(b[1].numero));
    if (entries.length === 0) {
        list.innerHTML = '<div class="empty-msg">Nenhum cliente. Usa o botÃ£o acima para importar.</div>';
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
        lbl.textContent = c.numero.padStart(3, '0') + '  Â·  ' + c.nome;

        // Badge de localizaÃ§Ã£o
        const locBadge = document.createElement('span');
        const hasCoords = c.lat && c.lng;
        locBadge.className = `cliente-loc-badge ${hasCoords ? 'has-loc' : 'no-loc'}`;
        locBadge.title = hasCoords ? `${c.lat}, ${c.lng}` : 'Sem localizaÃ§Ã£o';
        locBadge.innerHTML = hasCoords
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`
            : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

        const edit = document.createElement('button');
        edit.className   = 'admin-list-edit';
        edit.title = 'Editar';
        edit.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        edit.onclick = () => openEditClienteModal(id, c);

        const del = document.createElement('button');
        del.className   = 'admin-list-delete';
        del.innerHTML = 'ðŸ—‘';
        del.onclick = () => openConfirmModal({
            icon: '', title: 'Apagar cliente?',
            desc: `${escapeHtml(c.numero)} â€” ${escapeHtml(c.nome)}`,
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
        row.appendChild(locBadge);
        row.appendChild(edit);
        row.appendChild(del);
        list.appendChild(row);
    });
}

// â”€â”€ Modal Editar Cliente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _ecInitials(nome) {
    const words = (nome || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function ecUpdatePreview() {
    const nome = document.getElementById('edit-cliente-nome')?.value || '';
    const disp = document.getElementById('ec-nome-display');
    const avt  = document.getElementById('ec-avatar');
    if (disp) disp.textContent = nome || 'â€”';
    if (avt)  avt.textContent  = _ecInitials(nome);
}

function ecUpdateLocStatus() {
    const lat = document.getElementById('edit-cliente-lat')?.value?.trim();
    const lng = document.getElementById('edit-cliente-lng')?.value?.trim();
    const el  = document.getElementById('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status editing-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg> Coordenadas definidas â€” a guardar ao clicar em Guardar`;
    } else if (!lat && !lng) {
        // Mostrar estado original (repor ao que estava ao abrir)
        _ecSetInitialLocStatus();
    }
}

function _ecSetInitialLocStatus(lat, lng) {
    const el = document.getElementById('ec-loc-status');
    if (!el) return;
    if (lat && lng) {
        el.className = 'ec-loc-status has-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> LocalizaÃ§Ã£o guardada Â· ${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`;
    } else {
        el.className = 'ec-loc-status no-loc';
        el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Sem localizaÃ§Ã£o â€” serÃ¡ geocodificada automaticamente`;
    }
}

function openEditClienteModal(id, c) {
    document.getElementById('edit-cliente-id').value  = id;
    document.getElementById('edit-cliente-numero').value = c.numero || '';
    document.getElementById('edit-cliente-nome').value   = c.nome   || '';
    document.getElementById('edit-cliente-lat').value    = c.lat    || '';
    document.getElementById('edit-cliente-lng').value    = c.lng    || '';

    // Preview no header
    const nomeDisplay = document.getElementById('ec-nome-display');
    const numDisplay  = document.getElementById('ec-numero-display');
    const avatar      = document.getElementById('ec-avatar');
    if (nomeDisplay) nomeDisplay.textContent = c.nome  || 'â€”';
    if (numDisplay)  numDisplay.textContent  = `NÂº ${(c.numero || '').padStart(3, '0')}`;
    if (avatar)      avatar.textContent      = _ecInitials(c.nome);

    // Estado da localizaÃ§Ã£o
    _ecSetInitialLocStatus(c.lat, c.lng);

    document.getElementById('modal-edit-cliente').classList.add('active');
    setTimeout(() => document.getElementById('edit-cliente-nome')?.focus(), 120);
}

function closeEditClienteModal() {
    document.getElementById('modal-edit-cliente').classList.remove('active');
}

async function saveEditCliente() {
    const id     = document.getElementById('edit-cliente-id').value;
    const numero = document.getElementById('edit-cliente-numero').value.trim(); // readonly, sÃ³ para payload
    const nome   = document.getElementById('edit-cliente-nome').value.trim();
    const latVal = document.getElementById('edit-cliente-lat').value.trim();
    const lngVal = document.getElementById('edit-cliente-lng').value.trim();
    const previousNome = _clientesCache.data?.[id]?.nome || '';

    if (!nome) { showToast('O nome nÃ£o pode estar vazio', 'error'); return; }

    // SÃ³ alterar nome (nÃºmero fica inalterado)
    const payload = { nome };

    if (latVal !== '' && lngVal !== '') {
        const lat = parseFloat(latVal);
        const lng = parseFloat(lngVal);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            showToast('Coordenadas invÃ¡lidas', 'error'); return;
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
            _saveGeocodeCacheEntry(previousKey, null);
        }
        if (payload.lat != null && payload.lng != null && cacheKey) {
            await _persistEstabCoords(nome, { lat: payload.lat, lng: payload.lng }, numero);
        } else if (cacheKey) {
            _geocodeCache[cacheKey] = null;
            _saveGeocodeCacheEntry(cacheKey, null);
        }
        closeEditClienteModal();
        renderClientesList();
        showToast('Cliente guardado');
    } catch(_e) { showToast('Erro ao guardar', 'error'); }
}

// â”€â”€ Importar Excel de clientes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function importClientesExcel(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const preview = document.getElementById('clientes-import-preview');
    preview.innerHTML = '<div class="pat-loading">A processar ficheiro...</div>';

    try {
        await _ensureXLSX();
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

        preview.innerHTML = `<div class="clientes-preview-info">âœ“ ${count} clientes encontrados. A importar...</div>`;

        // Guardar no Firebase (merge â€” preserva coords existentes)
        const existing = await _fetchClientes(true);
        const merged = {};
        for (const [id, c] of Object.entries(clientes)) {
            merged[id] = { ...c };
            // Preservar lat/lng se jÃ¡ existia
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
        preview.innerHTML = `<div class="clientes-preview-info">âœ“ ${count} clientes importados com sucesso.</div>`;
        renderClientesList();
        input.value = '';
    } catch(e) {
        console.error('[clientes] importar:', e);
        preview.innerHTML = `<div class="clientes-preview-error">Erro ao processar ficheiro: ${e.message}</div>`;
    }
}

// â”€â”€ Exportar Excel de clientes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function exportClientesExcel() {
    try {
        await _ensureXLSX();
        const data    = await _fetchClientes(true);
        const entries = Object.entries(data || {})
            .sort((a, b) => Number(a[1].numero) - Number(b[1].numero));

        if (entries.length === 0) { showToast('Sem clientes para exportar', 'error'); return; }

        const rows = [['NÃºmero', 'Nome', 'Latitude', 'Longitude']];
        entries.forEach(([, c]) => {
            rows.push([c.numero, c.nome, c.lat || '', c.lng || '']);
        });

        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols'] = [{ wch: 8 }, { wch: 40 }, { wch: 14 }, { wch: 14 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
        XLSX.writeFile(wb, `clientes-hiperfrio-${new Date().toISOString().slice(0,10)}.xlsx`);
        showToast(`${entries.length} clientes exportados`);
    } catch(e) {
        console.error('[clientes] exportar:', e);
        showToast('Erro ao exportar', 'error');
    }
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
        // Auto-limpeza: apaga entradas de histÃ³rico com mais de 15 dias
        _autoLimparHistorico();
    } catch(_e) { _patCache.data = _patCache.data || {}; }
    return _patCache.data;
}

async function _autoLimparHistorico() {
    const expirados = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === 'historico' && p.saidaEm && _calcDias(p.saidaEm) >= 15);
    if (!expirados.length) return;
    for (const [id, pat] of expirados) {
        await _relSalvarPatAntesDeApagar(pat);
        apiFetch(`${BASE_URL}/pedidos/${id}.json`, { method: 'DELETE' }).catch(e => console.warn('[HistÃ³rico] falha auto-limpeza:', id, e?.message));
        delete _patCache.data[id];
    }
}

function _getPatPendingCount() {
    // _patCache Ã© a variÃ¡vel module-level correcta (cache principal nÃ£o inclui pedidos)
    const data = (_patCache && _patCache.data) ? _patCache.data : {};
    return Object.values(data).filter(p => p.status !== 'levantado' && p.status !== 'historico').length;
}

async function updatePatCount() {
    // Actualiza a cache de PATs â€” card do dashboard lÃª _getPatPendingCount() da cache
    await _fetchPats();
}

let _patSearchQuery  = '';
let _patTab          = 'pendentes'; // 'pendentes' | 'levantadas' | 'historico'
let _patSelMode      = false;       // modo seleÃ§Ã£o para levantar
let _patSelWorker    = '';          // funcionÃ¡rio escolhido
let _patSelIds       = new Set();   // IDs seleccionados

const _debouncedPatSearch = _debounce(val => {
    _patSearchQuery = (val || '').toLowerCase().trim();
    renderPats();
}, 300);

function patSearchFilter(val) { _debouncedPatSearch(val); }

// â”€â”€ Popover de pedidos duplicados por estabelecimento â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _dupPopoverEl = null;
let _dupPopoverCloseHandler = null;

function showDupPopover(badge, estabNorm) {
    // fecha se jÃ¡ aberto + limpa listener anterior
    if (_dupPopoverCloseHandler) { document.removeEventListener('click', _dupPopoverCloseHandler); _dupPopoverCloseHandler = null; }
    if (_dupPopoverEl) { _dupPopoverEl.remove(); _dupPopoverEl = null; }

    const pats = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status !== 'levantado' &&
                (p.estabelecimento || '').trim().toLowerCase() === estabNorm)
        .sort((a, b) => (a[1].criadoEm || 0) - (b[1].criadoEm || 0));

    const pop = document.createElement('div');
    pop.className = 'dup-popover';
    pop.innerHTML = `
        <div class="dup-pop-title">PATs â€” ${escapeHtml(pats[0]?.[1]?.estabelecimento || estabNorm)}</div>
        ${pats.map(([, p]) => {
            const dias = _calcDias(p.criadoEm);
            const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'HÃ¡ 1 dia' : `HÃ¡ ${dias} dias`;
            const urgente = dias >= 15;
            return `<div class="dup-pop-row">
                <span class="dup-pop-pat ${urgente ? 'dup-pop-urgente' : ''}">PAT ${escapeHtml(p.numero || 'â€”')}</span>
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
        const msgs = { pendentes: 'Nenhum pedido pendente.', levantadas: 'Nenhuma PAT levantada.', historico: 'Sem histÃ³rico.' };
        el.innerHTML = `<div class="pat-empty">${msgs[_patTab] || ''}</div>`;
        updatePatCount();
        return;
    }

    el.innerHTML = '';

    // â”€â”€ Pendentes: lista plana com count bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (_patTab === 'pendentes') {
        const estabCount = {};
        entries.forEach(([, p]) => {
            const n = (p.estabelecimento || '').trim().toLowerCase();
            if (n) estabCount[n] = (estabCount[n] || 0) + 1;
        });

        // Count bar com urgentes
        const urgentes = entries.filter(([, p]) => _calcDias(p.criadoEm) >= 15).length;
        const countBar = document.createElement('div');
        countBar.className = 'pat-count-bar';
        countBar.innerHTML = `<span class="pat-count-lbl">${entries.length} pedido${entries.length !== 1 ? 's' : ''} pendente${entries.length !== 1 ? 's' : ''}</span>`
            + (urgentes > 0 ? `<span class="pat-count-badge">${urgentes} urgente${urgentes !== 1 ? 's' : ''} (+15 dias)</span>` : '');
        el.appendChild(countBar);

        entries.forEach(([id, pat]) => el.appendChild(_buildPatCard(id, pat, 'pendentes', estabCount)));
        updatePatCount();

        // Actualizar contador na tab
        const tabEl = document.getElementById('pat-tab-pendentes');
        if (tabEl) {
            let cnt = tabEl.querySelector('.pat-tab-cnt');
            if (!cnt) { cnt = document.createElement('span'); cnt.className = 'pat-tab-cnt'; tabEl.appendChild(cnt); }
            cnt.textContent = entries.length;
        }
        return;
    }

    // â”€â”€ Levantadas / HistÃ³rico: agrupadas por funcionÃ¡rio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const grupos = {};
    entries.forEach(([id, pat]) => {
        const key = pat.funcionario || 'â€”';
        if (!grupos[key]) grupos[key] = [];
        grupos[key].push([id, pat]);
    });
    const sortedGroups = Object.entries(grupos).sort(([a], [b]) => a.localeCompare(b, 'pt'));

    sortedGroups.forEach(([func, items]) => {
        // CabeÃ§alho do grupo
        const header = document.createElement('div');
        header.className = 'pat-group-header';
        header.innerHTML = `
            <div class="pat-group-info">
                <span class="pat-group-avatar">${func === 'â€”' ? '?' : func[0].toUpperCase()}</span>
                <span class="pat-group-name">${func === 'â€”' ? 'Sem funcionÃ¡rio' : func}</span>
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
    const isLev  = tab === 'levantadas';
    const isHist = tab === 'historico';
    const isSelected = _patSelMode && _patSelIds.has(id);

    const dias    = _calcDias(pat.criadoEm);
    const urgente = tab === 'pendentes' && dias >= 15;
    const nomeNorm = (pat.estabelecimento || '').trim().toLowerCase();

    // Classes do card
    let cardClass = 'pat-card';
    if (separacao && !urgente) cardClass += ' pat-card-separacao';
    if (urgente)               cardClass += ' pat-card-urgente';
    if (isLev)                 cardClass += ' pat-card-levantada';
    if (isHist)                cardClass += ' pat-card-historico';
    if (isSelected)            cardClass += ' pat-card-selected';
    card.className = cardClass;

    // Barra lateral colorida
    const bar = document.createElement('div');
    bar.className = 'pat-card-bar';
    card.appendChild(bar);

    // Body com padding
    const body = document.createElement('div');
    body.className = 'pat-card-body';

    // Top row
    const cardTop = document.createElement('div');
    cardTop.className = 'pat-card-top';
    const cardTopLeft = document.createElement('div');
    cardTopLeft.className = 'pat-card-top-left';

    // Checkbox selecÃ§Ã£o
    if (_patSelMode) {
        const cb = document.createElement('span');
        cb.className = 'pat-sel-cb' + (isSelected ? ' checked' : '');
        cb.innerHTML = isSelected
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '';
        cardTopLeft.appendChild(cb);
    }

    // Badge PAT nÃºmero
    const patBadge = document.createElement('span');
    patBadge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    patBadge.textContent = 'PAT ' + (pat.numero || 'â€”');
    cardTopLeft.appendChild(patBadge);

    // Tag Guia Transporte
    if (separacao) {
        const sepTag = document.createElement('span');
        sepTag.className   = 'pat-sep-tag';
        sepTag.textContent = 'Guia Transporte';
        cardTopLeft.appendChild(sepTag);
    }

    // Badge duplicados
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

    // Data / dias
    const diasSpan = document.createElement('span');
    diasSpan.className = 'pat-dias' + (urgente ? ' pat-dias-urgente' : '');
    if (isHist && pat.saidaEm) {
        const d = new Date(pat.saidaEm);
        diasSpan.textContent = d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
        const diasRestantes = 15 - _calcDias(pat.saidaEm);
        if (diasRestantes <= 3) diasSpan.style.color = 'var(--text-muted)';
    } else if (isLev && pat.levantadoEm) {
        diasSpan.textContent = new Date(pat.levantadoEm).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    } else {
        const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'HÃ¡ 1 dia' : `HÃ¡ ${dias} dias`;
        diasSpan.textContent = diasLabel;
    }
    cardTop.appendChild(cardTopLeft);
    cardTop.appendChild(diasSpan);

    // Estabelecimento
    const estabDiv = document.createElement('div');
    estabDiv.className   = 'pat-card-estab';
    estabDiv.textContent = pat.estabelecimento || 'Sem estabelecimento';

    // Produtos
    const prodsDiv = document.createElement('div');
    prodsDiv.className = 'pat-card-produtos';
    (pat.produtos || []).forEach(p => {
        const chip = document.createElement('span');
        chip.className   = 'pat-prod-chip';
        chip.textContent = (p.codigo || '?') + ' Ã— ' + (p.quantidade || 1);
        prodsDiv.appendChild(chip);
    });

    // AcÃ§Ãµes
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pat-card-actions';
    actionsDiv.onclick   = e => e.stopPropagation();

    const DEL_SVG = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
    const CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    if (_patSelMode) {
        const btnRefs = document.createElement('button');
        btnRefs.className = 'pat-btn-refs';
        btnRefs.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Refs';
        btnRefs.onclick = e => { e.stopPropagation(); openPatRefsModal(id, pat); };
        actionsDiv.appendChild(btnRefs);
    } else if (tab === 'pendentes') {
        const btnLev = document.createElement('button');
        btnLev.className = 'pat-btn-levantado';
        btnLev.innerHTML = CHECK_SVG + ' Dar como levantado';
        btnLev.onclick = () => marcarPatLevantado(id);
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = DEL_SVG;
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnLev);
        actionsDiv.appendChild(btnDel);
    } else if (tab === 'levantadas') {
        const btnSaida = document.createElement('button');
        btnSaida.className = 'pat-btn-guia';
        btnSaida.innerHTML = CHECK_SVG + ' Dar saÃ­da';
        btnSaida.onclick = () => darSaidaPat(id);
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = DEL_SVG;
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnSaida);
        actionsDiv.appendChild(btnDel);
    } else if (tab === 'historico') {
        const btnDel = document.createElement('button');
        btnDel.className = 'pat-btn-apagar';
        btnDel.innerHTML = DEL_SVG;
        btnDel.onclick = () => apagarPat(id);
        actionsDiv.appendChild(btnDel);
    }

    body.appendChild(cardTop);
    body.appendChild(estabDiv);
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

// â”€â”€ Levantar Encomenda â€” modal de funcionÃ¡rio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem">Sem funcionÃ¡rios registados.</div>';
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

// â”€â”€ Modo de seleÃ§Ã£o para levantar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // SÃ³ selecciona PATs pendentes (tab activo no modo levantar)
    const pendentes = Object.entries(pats).filter(([, p]) => p.status === 'pendente');
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
        icon: 'âœ…',
        title: `Levantar ${ids.length} PAT${ids.length > 1 ? 's' : ''}?`,
        desc: `SerÃ£o marcadas como levantadas por ${worker}. As que tÃªm guia de transporte descontam stock.`,
        onConfirm: async () => {
            // Mostrar feedback imediato
            const levBtn = document.getElementById('pat-levantar-btn');
            if (levBtn) { levBtn.disabled = true; levBtn.textContent = 'A processar...'; }
            try {
                const ts = Date.now();
                // Calcula novas quantidades de stock antes de lanÃ§ar os pedidos
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

                // LanÃ§a todos os PATCHes em paralelo
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
                const levBtn = document.getElementById('pat-levantar-btn');
                if (levBtn) { levBtn.disabled = false; levBtn.textContent = `Levantar ${_patSelIds.size}`; }
            }
        }
    });
}

// â”€â”€ Dar saÃ­da â€” apaga a PAT levantada imediatamente â”€â”€â”€â”€â”€
async function darSaidaPat(id) {
    const pat = _patCache.data?.[id];
    openConfirmModal({
        icon: 'âœ…',
        title: 'Dar saÃ­da a esta PAT?',
        desc: pat?.separacao
            ? 'A PAT vai para o histÃ³rico (15 dias). Guia de transporte concluÃ­da.'
            : 'A PAT vai para o histÃ³rico onde ficarÃ¡ 15 dias.',
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
                showToast('SaÃ­da dada â€” PAT no histÃ³rico!');
            } catch(_e) { showToast('Erro ao dar saÃ­da', 'error'); }
        }
    });
}

async function limparTabActual() {
    const statusAlvo = _patTab === 'historico' ? 'historico' : 'levantado';
    const alvo = Object.entries(_patCache.data || {})
        .filter(([, p]) => p.status === statusAlvo);
    if (!alvo.length) { showToast('Nada para limpar.', 'info'); return; }

    const label = statusAlvo === 'historico' ? 'histÃ³rico' : 'levantadas';
    openConfirmModal({
        icon: 'ðŸ—‘',
        title: `Limpar ${alvo.length} registo${alvo.length > 1 ? 's' : ''}?`,
        desc: `Remove todas as PATs do ${label}. Esta acÃ§Ã£o Ã© irreversÃ­vel.`,
        onConfirm: async () => {
            try {
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

// â”€â”€ Editar referÃªncias de uma PAT (modo levantar) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    focusModal('pat-refs-modal');
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

    // OpÃ§Ã£o de adicionar manualmente se nÃ£o hÃ¡ resultado exacto
    const exactMatch = Object.values(stock).some(i => (i.codigo||'').toLowerCase() === q);
    if (!exactMatch) {
        const manual = document.createElement('div');
        manual.className = 'pat-dd-option pat-dd-manual';
        manual.innerHTML = `<span class="pat-dd-code">${escapeHtml(val.trim().toUpperCase())}</span><span class="pat-dd-name" style="color:var(--text-muted)">â†’ Adicionar manual</span>`;
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
        dd.innerHTML = '<div class="pat-dd-empty">JÃ¡ adicionado</div>';
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
            <button class="pat-chip-remove" onclick="patRefsRemove('${escapeHtml(p.codigo)}')">âœ•</button>`;
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
        showToast('ReferÃªncias actualizadas!');
    } catch(_e) {
        showToast('Erro ao guardar', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
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
// ANTHROPIC API KEY â€” gestÃ£o local
// =============================================
const ANTHROPIC_KEY_STORAGE  = 'hiperfrio-anthropic-key';

// Chave Anthropic em sessionStorage (nÃ£o persiste entre sessÃµes nem Ã© acessÃ­vel
// por outras abas â€” reduz exposiÃ§Ã£o vs localStorage)
function _getAnthropicKey() {
    return sessionStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
}
// MigraÃ§Ã£o Ãºnica: mover chave antiga de localStorage para sessionStorage e limpar
(function _migrateAnthropicKey() {
    const old = localStorage.getItem(ANTHROPIC_KEY_STORAGE);
    if (old && _isProxyUrl(old)) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, old);
    }
    localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
})();

function _isProxyUrl(val) {
    return val.startsWith('https://') || val.startsWith('http://');
}

function saveAnthropicKey() {
    const val = document.getElementById('inp-anthropic-key').value.trim();
    if (val && !_isProxyUrl(val)) {
        showToast('Valor invalido - introduz apenas o URL HTTPS do Worker/proxy.', 'error');
        return;
    }
    if (val) {
        sessionStorage.setItem(ANTHROPIC_KEY_STORAGE, val);
        document.getElementById('inp-anthropic-key').value = '';
        showToast('Proxy configurado - OCR por foto usa agora Claude Vision', 'ok');
    } else {
        sessionStorage.removeItem(ANTHROPIC_KEY_STORAGE);
        showToast('ConfiguraÃ§Ã£o removida â€” OCR volta ao modo local', 'ok');
    }
    _updateOcrKeyStatus();
}

function _updateOcrKeyStatus() {
    const val = _getAnthropicKey();
    let text, color;
    if (!val) {
        text  = 'Nao configurada - usa OCR local';
        color = '';
    } else {
        text  = 'Claude Vision activo (' + new URL(val).hostname + ')';
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
    // Pre-preenche o campo do proxy
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
    if (btn) { btn.disabled = true; btn.textContent = 'â—· A testarâ€¦'; }

    try {
        const endpoint = val;
        const headers = { 'Content-Type': 'application/json' };

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
            showToast('âœ“ LigaÃ§Ã£o OK â€” Claude Vision pronto a usar!', 'ok');
        } else if (data.error) {
            showToast('Erro da API: ' + (data.error.message || JSON.stringify(data.error)), 'error');
        } else {
            showToast('Resposta inesperada: ' + JSON.stringify(data).slice(0, 80), 'error');
        }
    } catch(e) {
        showToast('Falha na ligaÃ§Ã£o: ' + (e.message || e), 'error');
        console.error('[testProxy]', e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Testar ligaÃ§Ã£o'; }
    }
}

// =============================================
// OCR KEYWORDS â€” palavras-chave de estabelecimento
// =============================================
const OCR_KEYWORDS_KEY = 'hiperfrio-ocr-keywords';

function saveOcrKeywords() {
    const val = document.getElementById('inp-ocr-keywords').value.trim();
    if (val) localStorage.setItem(OCR_KEYWORDS_KEY, val);
    else localStorage.removeItem(OCR_KEYWORDS_KEY);
    showToast('Palavras-chave guardadas âœ“', 'ok');
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
// PAT SCAN â€” cÃ¢mara
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
        _patScanSetStatus('CÃ¢mara activa â€” aponta para o documento e captura', '');
    } catch(e) {
        // CÃ¢mara nÃ£o disponÃ­vel â€” mostrar botÃµes de fallback (Galeria)
        document.getElementById('pat-scan-placeholder').style.display = 'flex';
        document.getElementById('pat-scan-row-load').style.display    = 'flex';
        // Esconder botÃ£o cÃ¢mara pois nÃ£o estÃ¡ disponÃ­vel
        const camBtn = document.getElementById('pat-scan-cam-btn');
        if (camBtn) camBtn.style.display = 'none';
        _patScanSetStatus('CÃ¢mara nÃ£o disponÃ­vel â€” usa a Galeria', 'error');
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
    // Auto-analisar se houver proxy OCR configurado
    if (_getAnthropicKey()) {
        patScanAnalyse();
    } else {
        _patScanSetStatus('Foto capturada â€” clica em Analisar', '');
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
// PAT SCAN â€” preenchimento por fotografia (OCR via Claude Vision)
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
        _patScanSetStatus('Imagem carregada â€” clica em Analisar', '');
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
            // â”€â”€ Modo Claude Vision (alta qualidade) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            _patScanSetStatus('A analisar com Claude Visionâ€¦', 'loading');

            const keywords = _getOcrKeywords();
            const kwHint = keywords.length > 0
                ? `\\n\\nPALAVRAS-CHAVE DE ESTABELECIMENTO (palavras que identificam o nome do cliente neste documento): ${keywords.map(k => '"' + k + '"').join(', ')}. Se encontrares uma linha que contenha alguma destas palavras, usa essa linha como nome do estabelecimento.`
                : '';

            const prompt = `Ã‰s um sistema de OCR especializado em documentos de assistÃªncia tÃ©cnica portugueses.

O documento pode ter qualquer formato: folha A4 impressa, papel tÃ©rmico, recibo manuscrito, ou atÃ© uma fita com texto escrito Ã  mÃ£o. Adapta-te ao formato que vÃªs.

Extrai os dois campos abaixo. Segue RIGOROSAMENTE estas regras:

CAMPO 1 â€” pat_numero:
- Ã‰ um nÃºmero com EXACTAMENTE 6 dÃ­gitos
- Pode aparecer sozinho sem qualquer prefixo, ou precedido de "PAT", "OS", "N.Âº", "Ref." ou similar
- Ignora qualquer nÃºmero que nÃ£o tenha exactamente 6 dÃ­gitos
- Pode estar em qualquer zona do documento
- Se nÃ£o encontrares, devolve null

CAMPO 2 â€” estabelecimento:
- Ã‰ o nome do local/cliente onde a assistÃªncia foi prestada
- NUNCA tem prefixo ou label â€” aparece sozinho, sem "Cliente:", "Nome:" ou similar
- Pode aparecer em qualquer posiÃ§Ã£o relativamente ao nÃºmero PAT: antes, depois, acima, abaixo
- CADEIAS CONHECIDAS: o estabelecimento pertence quase sempre a uma destas cadeias â€” procura estas palavras-chave e extrai o nome completo que as acompanha:
    â€¢ "Pingo Doce" ou "PDD" = Pingo Doce (ex: "PINGO DOCE BRAGA RETAIL", "PDD VIANA")
    â€¢ "Continente" (ex: "CONTINENTE MODELO COIMBRA")
    â€¢ "Recheio" (ex: "RECHEIO PORTO")
- O nome completo inclui a palavra-chave da cadeia mais o identificador especÃ­fico da loja
- Devolve o nome em MAIÃšSCULAS${kwHint}
- Se nÃ£o encontrares, devolve null

CONFIANÃ‡A:
- pat_confianca: 0.0 a 1.0 (0.9+ = leste claramente, 0.5 = razoÃ¡vel, <0.4 = incerto)
- estab_confianca: 0.0 a 1.0

Responde APENAS com JSON vÃ¡lido, sem markdown, sem explicaÃ§Ãµes:
{"pat_numero": "...", "estabelecimento": "...", "pat_confianca": 0.0, "estab_confianca": 0.0}`;
            const endpoint = apiKey;
            const headers = { 'Content-Type': 'application/json' };

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
                if (resp.status === 401) throw new Error('Proxy OCR invalido ou sem permissao - actualiza em Admin > Definicoes');
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
            // â”€â”€ Modo Tesseract (OCR local, sem chave) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            _patScanSetStatus('A carregar motor OCRâ€¦', 'loading');
            await loadTesseract();

            const dataUrl = `data:${_patScanMime};base64,${_patScanB64}`;

            const { data: { text } } = await Tesseract.recognize(dataUrl, 'por', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const pct = Math.round((m.progress || 0) * 100);
                        _patScanSetStatus(`A reconhecer textoâ€¦ ${pct}%`, 'loading');
                    }
                }
            });

            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const patRx = [
                /(?:PAT|OS|N[ÂºÂ°.]?\s*(?:PAT|OS)?)\s*[:\-]?\s*(\d{4,8})/i,
                /\b(\d{5,8})\b/
            ];
            for (const rx of patRx) {
                const m = text.match(rx);
                if (m) { patNum = m[1]; patConf = rx === patRx[0] ? 0.75 : 0.45; break; }
            }
            const skipWords = /^(PAT|OS|DATA|TÃ‰CNICO|SERVIÃ‡O|TEL|NIF|FAX|MORADA|RUA|AV|HORA|\d+)$/i;
            const nameLines = lines.filter(l =>
                l.length > 4 && l.length < 60 &&
                !/^\d+$/.test(l) &&
                !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(l) &&
                !skipWords.test(l.split(/\s/)[0])
            );
            const estabKw = nameLines.find(l => /CAFÃ‰|SNACK|BAR|REST|HOTEL|MINI|SUPER|MERCADO|LDA|SA\b|UNIP|POSTO/i.test(l));
            if (estabKw) { estab = estabKw.toUpperCase(); estabConf = 0.70; }
            else if (nameLines.length > 0) { estab = nameLines[0].toUpperCase(); estabConf = 0.40; }
        }

        // â”€â”€ Preenche resultado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        _patScanFill('ps-pat',   patNum, patConf,   'ps-pat-conf');
        _patScanFill('ps-estab', estab,  estabConf, 'ps-estab-conf');
        document.getElementById('pat-scan-result').style.display = 'flex';
        const mode = apiKey ? 'Claude Vision' : 'OCR local';
        _patScanSetStatus(`âœ“ AnÃ¡lise concluÃ­da (${mode}) â€” revÃª e confirma`, 'ok');

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

    // Abrir o modal (que limpa os campos) e sÃ³ depois preencher
    const patModalOpen = document.getElementById('pat-modal').classList.contains('active');
    if (!patModalOpen) openPatModal();

    // Preencher apÃ³s o modal estar aberto (openPatModal tem setTimeout de 80ms para focus)
    setTimeout(() => {
        if (pat)   document.getElementById('pat-numero').value        = pat;
        if (estab) document.getElementById('pat-estabelecimento').value = estab;
        showToast('Campos preenchidos â€” revÃª antes de guardar', 'info');
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
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',-1)">âˆ’</button>
                    <input class="pat-chip-qty" type="number" min="1" value="${p.quantidade}"
                        onchange="patSetQty('${p.id}',this.value)"
                        onblur="patSetQty('${p.id}',this.value)">
                    <button class="pat-chip-qty-btn" onmousedown="event.preventDefault()" onclick="patQtyStep('${p.id}',1)">+</button>
                </div>
                <button class="pat-chip-remove" onclick="patRemoveProduct('${p.id}')" aria-label="Remover">Ã—</button>
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
        hint.textContent = 'O NÂº PAT deve ter exactamente 6 dÃ­gitos.';
        hint.style.color = 'var(--danger)';
        document.getElementById('pat-numero').focus();
        return;
    }
    hint.textContent = '';

    // Verificar duplicado â€” nÃ£o permitir registar a mesma PAT duas vezes
    const patsExistentes = Object.values(_patCache.data || {});
    const duplicado = patsExistentes.find(p => p.numero === numero && p.status !== 'levantado');
    if (duplicado) {
        hint.textContent = `PAT ${numero} jÃ¡ estÃ¡ registada (${duplicado.estabelecimento || 'sem estabelecimento'}).`;
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
            // offline â€” guarda com ID temporÃ¡rio para mostrar imediatamente
            _patCache.data[`_tmp_pat_${Date.now()}`] = payload;
        }
        closePatModal();
        renderPats();
        showToast(res ? `PAT ${numero} registada!` : `PAT ${numero} guardada offline â€” sincroniza quando tiveres ligaÃ§Ã£o`);
    } catch(_e) { showToast('Erro ao guardar pedido', 'error'); }
}

async function marcarPatLevantado(id) {
    const pat = _patCache.data?.[id];
    const separacao = !!pat?.separacao;

    const desc = separacao
        ? 'Pedido com SeparaÃ§Ã£o de Material â€” o stock dos produtos serÃ¡ descontado automaticamente.'
        : 'O pedido serÃ¡ removido dos pendentes. O stock nÃ£o serÃ¡ alterado.';

    openConfirmModal({
        icon: 'âœ…',
        title: 'Marcar como levantado?',
        desc,
        onConfirm: async () => {
            try {
                // 1 â€” Marca como levantado na Firebase (com suporte offline)
                await apiFetch(`${BASE_URL}/pedidos/${id}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'levantado', levantadoEm: Date.now() }),
                });
                if (_patCache.data?.[id]) _patCache.data[id].status = 'levantado';

                // 2 â€” Se separaÃ§Ã£o: desconta stock em paralelo via apiFetch (suporta offline)
                if (separacao && pat.produtos?.length) {
                    const patches = pat.produtos
                        .filter(p => p.id)
                        .map(p => {
                            const atual = cache.stock.data?.[p.id]?.quantidade ?? 0;
                            const novaQty = Math.max(0, atual - (p.quantidade || 1));
                            if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = novaQty;
                            registarMovimento('saida_pat', p.id, p.codigo, p.nome, p.quantidade || 1);
                            return _commitStockDelta(p.id, atual, novaQty)
                                .then(savedQty => {
                                    if (cache.stock.data?.[p.id]) cache.stock.data[p.id].quantidade = savedQty;
                                })
                                .catch(e => console.warn('[Stock] PATCH falhou:', p.id, e.message));
                        });
                    await Promise.allSettled(patches);
                    renderList();
                }

                // updatePatCount jÃ¡ faz fetch â€” evitar chamada dupla apÃ³s renderPats
                renderPats();
                showToast(separacao ? 'Levantado â€” stock descontado!' : 'Pedido marcado como levantado!');
            } catch(_e) { showToast('Erro ao actualizar pedido', 'error'); }
        }
    });
}

async function apagarPat(id) {
    openConfirmModal({
        icon: '',
        title: 'Apagar pedido?',
        desc: 'O pedido serÃ¡ eliminado permanentemente. O stock nÃ£o Ã© alterado.',
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
    const dias      = _calcDias(pat.criadoEm);
    const dataStr   = pat.criadoEm ? new Date(pat.criadoEm).toLocaleDateString('pt-PT') : 'â€”';
    const urgente   = dias >= 15;
    const separacao = !!pat.separacao;
    const body      = document.getElementById('pat-detail-body');
    body.innerHTML  = '';

    // â”€â”€ Helper: criar linha de detalhe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function _row(lbl, val) {
        const d = document.createElement('div');
        d.className = 'pat-detail-row';
        const l = document.createElement('span');
        l.className   = 'pat-detail-lbl';
        l.textContent = lbl;
        const v = document.createElement('span');
        v.textContent = val;
        d.appendChild(l); d.appendChild(v);
        return d;
    }

    // â”€â”€ Header badges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const hdr = document.createElement('div');
    hdr.className = 'pat-detail-header';

    const badge = document.createElement('span');
    badge.className   = 'pat-badge' + (urgente ? ' pat-badge-urgente' : '');
    badge.style.cssText = 'font-size:1rem;padding:6px 14px';
    badge.textContent = 'PAT ' + (pat.numero || 'â€”');
    hdr.appendChild(badge);

    if (pat.clienteNumero) {
        const cb = document.createElement('span');
        cb.className   = 'pat-cliente-badge';
        cb.style.cssText = 'font-size:0.9rem;padding:5px 12px';
        cb.textContent = pat.clienteNumero;
        hdr.appendChild(cb);
    }
    if (separacao) {
        const st = document.createElement('span');
        st.className   = 'pat-sep-tag';
        st.style.marginTop = '8px';
        st.textContent = ' Guia Transporte de Material';
        hdr.appendChild(st);
    }
    body.appendChild(hdr);

    // â”€â”€ Linhas de informaÃ§Ã£o â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (pat.clienteNumero) body.appendChild(_row('NÂº Cliente', pat.clienteNumero));
    body.appendChild(_row('Estabelecimento', pat.estabelecimento || 'NÃ£o especificado'));
    body.appendChild(_row('Criado em', dataStr));
    body.appendChild(_row('Desconto stock', separacao ? 'âœ… Sim (ao levantar)' : 'âŠ˜ NÃ£o'));
    body.appendChild(_row('Estado', (urgente ? 'ðŸ”´ Urgente' : 'ðŸŸ¡ Pendente') + ' (' + (dias === 0 ? 'hoje' : `${dias}d`) + ')'));
    if (pat.funcionario) body.appendChild(_row('Levantado por', pat.funcionario));

    // â”€â”€ Produtos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (pat.produtos?.length) {
        const lbl = document.createElement('div');
        lbl.className   = 'pat-detail-lbl';
        lbl.style.cssText = 'margin-top:14px;margin-bottom:8px';
        lbl.textContent = 'Produtos reservados';
        body.appendChild(lbl);
        const prodsDiv = document.createElement('div');
        prodsDiv.className = 'pat-detail-produtos';
        pat.produtos.forEach(p => {
            const row = document.createElement('div');
            row.className = 'pat-detail-prod';
            const code = document.createElement('span');
            code.className   = 'pat-dd-code';
            code.textContent = p.codigo || '?';
            const name = document.createElement('span');
            name.className   = 'pat-dd-name';
            name.textContent = p.nome || '';
            const qty = document.createElement('span');
            qty.className   = 'pat-detail-qty';
            qty.textContent = 'Ã— ' + (p.quantidade || 1);
            row.appendChild(code); row.appendChild(name); row.appendChild(qty);
            prodsDiv.appendChild(row);
        });
        body.appendChild(prodsDiv);
    } else {
        const empty = document.createElement('div');
        empty.className   = 'pat-empty';
        empty.style.marginTop = '12px';
        empty.textContent = 'Sem produtos associados.';
        body.appendChild(empty);
    }

    // â”€â”€ AcÃ§Ãµes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const actions = document.createElement('div');
    actions.className = 'pat-detail-actions';

    if (pat.status !== 'levantado' && pat.status !== 'historico') {
        const btnLev = document.createElement('button');
        btnLev.className   = 'pat-btn-levantado';
        btnLev.style.flex  = '1';
        btnLev.innerHTML   = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btnLev.appendChild(document.createTextNode('Dar como levantado'));
        btnLev.onclick     = () => { closePatDetail(); marcarPatLevantado(id); };
        actions.appendChild(btnLev);
    }

    const btnDel = document.createElement('button');
    btnDel.className = 'pat-btn-apagar';
    btnDel.setAttribute('aria-label', 'Apagar PAT');
    btnDel.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
    btnDel.onclick   = () => { closePatDetail(); apagarPat(id); };
    actions.appendChild(btnDel);

    body.appendChild(actions);

    document.getElementById('pat-detail-modal').classList.add('active');
    focusModal('pat-detail-modal');
}

function closePatDetail() {
    document.getElementById('pat-detail-modal').classList.remove('active');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENCOMENDAS A FORNECEDOR  (REST API â€” mesmo padrÃ£o do resto da app)
// Firebase: /encomendas/{id}
//   num, fornecedor, data, obs, estado, ts
//   linhas: { "0": {ref, nome, qtd, recebido}, ... }
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const ENC_URL = `${BASE_URL}/encomendas`;

let _encFilter  = 'all';
let _encData    = {};
let _encDataTs  = 0;
const ENC_TTL   = 60000;
let _encEditId  = null;
let _encEntradaId   = null;
let _encEntradaLIdx = null;

// â”€â”€ Carregar dados â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RELATÃ“RIO MENSAL
// Firebase: /relatorios/{YYYY-MM} â€” snapshot mensal guardado automaticamente
//           /movimentos/{id}      â€” log de movimentos de stock
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const REL_URL = `${BASE_URL}/relatorios`;
const MOV_URL = `${BASE_URL}/movimentos`;

let _relMesOffset = 0; // 0 = mÃªs actual, -1 = anterior, etc.

// â”€â”€ UtilitÃ¡rios de data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _mesKey(offset = 0) {
    const d = new Date();
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function _mesLabel(key) {
    const [y, m] = key.split('-');
    const nomes = ['Janeiro','Fevereiro','MarÃ§o','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    return `${nomes[parseInt(m)-1]} ${y}`;
}
function _mesRange(key) {
    const [y, m] = key.split('-').map(Number);
    const ini = new Date(y, m-1, 1).getTime();
    const fim = new Date(y, m, 1).getTime() - 1;
    return { ini, fim };
}

// â”€â”€ Registar movimento de stock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// tipo: 'saida_pat' | 'saida_manual' | 'remocao'
async function registarMovimento(tipo, itemId, codigo, nome, quantidade) {
    if (!itemId && !codigo) return;
    const mov = {
        tipo,
        itemId:    itemId || null,
        codigo:    (codigo || '').toUpperCase(),
        nome:      nome   || '',
        quantidade: Math.abs(quantidade || 1),
        ts:        Date.now(),
        mes:       _mesKey(0),
    };
    apiFetch(`${MOV_URL}.json`, { method: 'POST', body: JSON.stringify(mov) })
        .catch(e => console.warn('[Movimentos] falha ao registar:', e?.message));
}

// â”€â”€ Snapshot mensal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _buildSnapshot(mesKey) {
    const { ini, fim } = _mesRange(mesKey);

    // Fetch movimentos do mÃªs
    const movUrl = await authUrl(`${MOV_URL}.json?orderBy="mes"&equalTo="${mesKey}"`);
    const movRes = await fetch(movUrl);
    const movData = movRes.ok ? (await movRes.json() || {}) : {};

    // Fetch PATs (todas â€” pendentes, levantadas, histÃ³rico)
    const pats = Object.values(_patCache.data || {});

    // PATs criadas neste mÃªs
    const patsMes = pats.filter(p => p.criadoEm >= ini && p.criadoEm <= fim);

    // PATs levantadas neste mÃªs
    const patsLevantadas = pats.filter(p =>
        p.levantadoEm && p.levantadoEm >= ini && p.levantadoEm <= fim);

    // DuraÃ§Ã£o mÃ©dia (criaÃ§Ã£o â†’ levantamento, sÃ³ levantadas com ambos os campos)
    let duracaoMedia = null;
    const comDuracao = patsLevantadas.filter(p => p.criadoEm && p.levantadoEm);
    if (comDuracao.length) {
        const totalDias = comDuracao.reduce((acc, p) =>
            acc + _calcDias(p.criadoEm, p.levantadoEm), 0);
        duracaoMedia = Math.round(totalDias / comDuracao.length);
    }

    // PATs pendentes incluÃ­das na mÃ©dia parcial
    const pendentes = pats.filter(p => p.status === 'pendente' && p.criadoEm >= ini);
    const pendentesMedia = pendentes.length
        ? pendentes.reduce((acc, p) => acc + _calcDias(p.criadoEm), 0) / pendentes.length
        : 0;

    // DuraÃ§Ã£o mÃ©dia combinada
    const totalN = comDuracao.length + pendentes.length;
    const mediaGlobal = totalN > 0
        ? Math.round((comDuracao.reduce((a,p) => a + _calcDias(p.criadoEm, p.levantadoEm),0)
            + pendentes.reduce((a,p) => a + _calcDias(p.criadoEm), 0)) / totalN)
        : null;

    // Por funcionÃ¡rio
    const porFunc = {};
    patsLevantadas.forEach(p => {
        const f = p.funcionario || 'Sem funcionÃ¡rio';
        porFunc[f] = (porFunc[f] || 0) + 1;
    });

    // Top 5 referÃªncias saÃ­das (movimentos)
    const refCount = {};
    Object.values(movData).forEach(m => {
        if (!m.codigo) return;
        if (!refCount[m.codigo]) refCount[m.codigo] = { codigo: m.codigo, nome: m.nome, qty: 0 };
        refCount[m.codigo].qty += m.quantidade || 1;
    });
    const top5 = Object.values(refCount)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);

    // Ferramentas mais requisitadas
    const ferrData = cache.ferramentas.data || {};
    const ferrCount = {};
    Object.values(ferrData).forEach(t => {
        const hist = t.historico ? Object.values(t.historico) : [];
        hist.forEach(ev => {
            if (ev.acao !== 'atribuida') return;
            const evTs = ev.data ? new Date(ev.data).getTime() : 0;
            if (evTs < ini || evTs > fim) return;
            const nome = t.nome || '?';
            ferrCount[nome] = (ferrCount[nome] || 0) + 1;
        });
    });
    const topFerr = Object.entries(ferrCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([nome, count]) => ({ nome, count }));

    // Top clientes (estabelecimentos) com mais PATs no mÃªs
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

    // Ferramentas com mais dias fora do armazÃ©m no mÃªs
    const ferrDias = [];
    Object.values(ferrData).forEach(t => {
        if (!t.nome) return;
        const hist = t.historico ? Object.values(t.historico)
            .sort((a, b) => new Date(a.data) - new Date(b.data)) : [];

        let diasFora = 0;
        let lastAtrib = null;
        hist.forEach(ev => {
            const evTs = ev.data ? new Date(ev.data).getTime() : 0;
            if (ev.acao === 'atribuida') {
                // Conta sÃ³ se a atribuiÃ§Ã£o foi dentro ou antes do mÃªs
                lastAtrib = Math.max(evTs, ini);
            } else if (ev.acao === 'devolvida' && lastAtrib) {
                // Conta dias dentro do intervalo do mÃªs
                const devTs = Math.min(evTs, fim);
                if (devTs > lastAtrib) diasFora += Math.round((devTs - lastAtrib) / 86400000);
                lastAtrib = null;
            }
        });
        // Se ainda estÃ¡ alocada no fim do mÃªs, conta atÃ© fim do mÃªs
        if (lastAtrib && t.status === 'alocada') {
            diasFora += Math.round((fim - lastAtrib) / 86400000);
        }
        if (diasFora > 0) ferrDias.push({ nome: t.nome, dias: diasFora });
    });
    const topFerrDias = ferrDias.sort((a, b) => b.dias - a.dias).slice(0, 5);

    return {
        mes:           mesKey,
        totalPats:     patsMes.length,
        levantadas:    patsLevantadas.length,
        pendentes:     pendentes.length,
        duracaoMedia:  mediaGlobal,
        porFunc,
        top5,
        topFerr,
        topClientes,
        topFerrDias,
        ts:            Date.now(),
    };
}

// _calcDias unificada â€” ver definiÃ§Ã£o global no topo do ficheiro

// â”€â”€ Guardar snapshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _guardarSnapshot(mesKey) {
    try {
        const snap = await _buildSnapshot(mesKey);
        await apiFetch(`${REL_URL}/${mesKey}.json`, {
            method: 'PUT',
            body: JSON.stringify(snap),
        });
        console.warn(`[RelatÃ³rio] snapshot guardado: ${mesKey}`);
        return snap;
    } catch(e) {
        console.warn('[RelatÃ³rio] falha ao guardar snapshot:', e?.message);
        return null;
    }
}

// â”€â”€ Auto-fechar mÃªs no dia 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _REL_LAST_CLOSE_KEY = 'hiperfrio-rel-last-close';
async function _autoFecharMesSeNecessario() {
    const today = new Date();
    if (today.getDate() !== 1) return; // sÃ³ no dia 1
    const mesAnterior = _mesKey(-1);
    const lastClose   = localStorage.getItem(_REL_LAST_CLOSE_KEY);
    if (lastClose === mesAnterior) return; // jÃ¡ fechado

    // Verificar se jÃ¡ existe snapshot no Firebase
    try {
        const url = await authUrl(`${REL_URL}/${mesAnterior}.json`);
        const res = await fetch(url);
        const existing = res.ok ? await res.json() : null;
        let closedOk = !!existing;
        if (!existing) {
            const saved = await _guardarSnapshot(mesAnterior);
            closedOk = !!saved;
        }
        if (closedOk) {
            localStorage.setItem(_REL_LAST_CLOSE_KEY, mesAnterior);
        }
    } catch(e) {
        console.warn('[RelatÃ³rio] auto-fechar falhou:', e?.message);
    }
}

// â”€â”€ Guardar antes de apagar PATs expiradas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _relSalvarPatAntesDeApagar(pat) {
    if (!pat?.criadoEm) return;
    const mesKey = (() => {
        const d = new Date(pat.levantadoEm || pat.saidaEm || pat.criadoEm);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    })();
    // Verifica se snapshot do mÃªs jÃ¡ existe â€” se nÃ£o, gera
    try {
        const url = await authUrl(`${REL_URL}/${mesKey}.json`);
        const res = await fetch(url);
        const existing = res.ok ? await res.json() : null;
        if (!existing) await _guardarSnapshot(mesKey);
    } catch(e) { /* silencioso â€” nÃ£o bloquear apagar */ }
}

// â”€â”€ Fechar mÃªs manualmente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function relFecharMes() {
    const mesKey = _mesKey(_relMesOffset);
    const btn = document.getElementById('rel-fechar-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'A guardar...'; }
    const snap = await _guardarSnapshot(mesKey);
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Fechar mÃªs'; }
    if (snap) { showToast(`RelatÃ³rio de ${_mesLabel(mesKey)} guardado!`); renderRelatorio(); }
    else       { showToast('Erro ao guardar relatÃ³rio', 'error'); }
}

// â”€â”€ NavegaÃ§Ã£o de mÃªs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function relMoveMonth(delta) {
    _relMesOffset += delta;
    if (_relMesOffset > 0) _relMesOffset = 0; // nÃ£o ir para o futuro
    renderRelatorio();
}

// â”€â”€ Renderizar relatÃ³rio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderRelatorio() {
    const mesKey  = _mesKey(_relMesOffset);
    const lblEl   = document.getElementById('rel-month-label');
    const content = document.getElementById('rel-content');
    const strip   = document.getElementById('rel-summary-strip');
    if (lblEl) lblEl.textContent = _mesLabel(mesKey);
    if (!content) return;

    // BotÃ£o fechar mÃªs â€” sÃ³ no mÃªs actual
    const btnFechar = document.getElementById('rel-fechar-btn');
    if (btnFechar) btnFechar.style.display = _relMesOffset === 0 ? 'inline-flex' : 'none';

    content.innerHTML = '<div class="rel-loading">A carregar relatÃ³rio...</div>';
    if (strip) { ['rel-sum-pats','rel-sum-dur','rel-sum-saidas'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'â€”'; }); }

    // Fetch snapshot
    let snap = null;
    try {
        const url = await authUrl(`${REL_URL}/${mesKey}.json`);
        const res = await fetch(url);
        snap = res.ok ? await res.json() : null;
    } catch(e) {}
    if (!snap && _relMesOffset === 0) snap = await _buildSnapshot(mesKey);

    if (!snap) {
        content.innerHTML = `<div class="rel-empty">Sem dados para ${_mesLabel(mesKey)}.<br><small>Gerado automaticamente no dia 1 do mÃªs seguinte.</small></div>`;
        return;
    }

    // Fetch snap anterior
    let snapAnt = null;
    try {
        const url2 = await authUrl(`${REL_URL}/${_mesKey(_relMesOffset - 1)}.json`);
        const res2 = await fetch(url2);
        snapAnt = res2.ok ? await res2.json() : null;
    } catch(e) {}

    // â”€â”€ Actualizar summary strip com animaÃ§Ã£o â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totalSaidas = (snap.top5 || []).reduce((a, b) => a + (b.qty || 0), 0);
    _relAnimCount('rel-sum-pats',   snap.totalPats ?? 0);
    _relAnimCount('rel-sum-saidas', totalSaidas);
    const durEl = document.getElementById('rel-sum-dur');
    if (durEl) durEl.textContent = snap.duracaoMedia != null ? snap.duracaoMedia + 'd' : 'â€”';

    content.innerHTML = '';

    // â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function _trend(val, ant, invertido = false, unidade = '') {
        if (ant == null || val == null) return '';
        const diff = val - ant;
        if (Math.abs(diff) < 0.05) return `<div class="rel-kpi-chip chip-neu">= igual ao mÃªs ant.</div>`;
        const up = diff > 0, bom = up !== invertido;
        const cls = bom ? 'chip-up' : 'chip-dn';
        const ico = up ? 'â–²' : 'â–¼';
        return `<div class="rel-kpi-chip ${cls}">${ico} ${Math.abs(diff)}${unidade} vs mÃªs ant.</div>`;
    }

    function _card(content_html, delay_class = '') {
        const d = document.createElement('div');
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

    // â”€â”€ 1: KPI Cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const kpiCard = document.createElement('div');
    kpiCard.className = 'rel-card';
    kpiCard.style.padding = '10px';
    const durColor = (snap.duracaoMedia > 7) ? '#dc2626' : (snap.duracaoMedia > 3) ? '#f59e0b' : '#4ade80';
    kpiCard.innerHTML = `
        <div class="rel-kpi-grid">
            <div class="rel-kpi-dark rel-kpi-navy">
                <div class="rel-kpi-bg-icon"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                <div class="rel-kpi-lbl">PATs registadas</div>
                <div class="rel-kpi-num" id="kpi-pats">0</div>
                <div class="rel-kpi-sub">${snap.levantadas ?? 0} levant. Â· ${snap.pendentes ?? 0} pend.</div>
                ${_trend(snap.totalPats, snapAnt?.totalPats)}
            </div>
            <div class="rel-kpi-dark rel-kpi-forest">
                <div class="rel-kpi-bg-icon"><svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
                <div class="rel-kpi-lbl">DuraÃ§Ã£o mÃ©dia</div>
                <div class="rel-kpi-num">${snap.duracaoMedia != null ? snap.duracaoMedia + 'd' : 'â€”'}</div>
                <div class="rel-kpi-sub">criaÃ§Ã£o â†’ levantamento</div>
                ${_trend(snap.duracaoMedia, snapAnt?.duracaoMedia, true, 'd')}
            </div>
        </div>`;
    content.appendChild(kpiCard);
    setTimeout(() => _relAnimCount('kpi-pats', snap.totalPats ?? 0, 900), 100);

    // â”€â”€ 2: Insight automÃ¡tico â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const insightMsg = _relBuildInsight(snap);
    if (insightMsg) {
        const ins = document.createElement('div');
        ins.className = 'rel-insight';
        ins.innerHTML = `
            <div class="rel-insight-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="rel-insight-body">
                <div class="rel-insight-lbl">Alerta automÃ¡tico</div>
                <div class="rel-insight-msg">${escapeHtml(insightMsg)}</div>
            </div>`;
        content.appendChild(ins);
    }

    // â”€â”€ 3: Donut â€” distribuiÃ§Ã£o PATs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const donutCard = document.createElement('div');
    donutCard.className = 'rel-card';
    const totalPats = snap.totalPats || 0;
    const levantadas = snap.levantadas || 0;
    const comGuia   = (snap.topClientes || []).reduce((a, c) => a + (c.comGuia || 0), 0);
    const pendentes  = snap.pendentes  || 0;
    const historico  = Math.max(0, totalPats - levantadas - pendentes);
    donutCard.innerHTML = `
        ${_cardHdr('DistribuiÃ§Ã£o de PATs', _mesLabel(mesKey))}
        <div class="rel-donut-wrap">
            <div class="rel-donut-canvas">
                <canvas id="rel-donut" width="110" height="110" class="rel-gauge-canvas"></canvas>
                <div class="rel-donut-center">
                    <span class="rel-donut-center-val">${totalPats}</span>
                    <span class="rel-donut-center-lbl">total</span>
                </div>
            </div>
            <div class="rel-donut-legend">
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#1e3a5f"></div>Levantadas</div><span class="rel-leg-val">${levantadas}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#2563eb"></div>Com guia</div><span class="rel-leg-val">${comGuia}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#f59e0b"></div>Pendentes</div><span class="rel-leg-val">${pendentes}</span></div>
                <div class="rel-leg-row"><div class="rel-leg-left"><div class="rel-leg-dot" style="background:#e2e8f0"></div>HistÃ³rico</div><span class="rel-leg-val">${historico}</span></div>
            </div>
        </div>`;
    content.appendChild(donutCard);

    // â”€â”€ 4: Top Clientes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const cliCard = document.createElement('div');
    cliCard.className = 'rel-card';
    const cliLen = snap.topClientes?.length || 0;
    cliCard.innerHTML = _cardHdr('Top clientes', cliLen + ' estabelec.', 'rel-pill-blue');
    if (cliLen) {
        const list = document.createElement('div');
        list.className = 'rel-rank-list';
        snap.topClientes.forEach((cli, i) => {
            const badges = ['rb1','rb2','rb3'];
            const bc = i < 3 ? badges[i] : 'rbn';
            const row = document.createElement('div');
            row.className = 'rel-rank-row';
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
    } else { cliCard.innerHTML += _emptyInline('Sem PATs registadas este mÃªs'); }
    content.appendChild(cliCard);

    // â”€â”€ 5: Top referÃªncias â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const refsCard = document.createElement('div');
    refsCard.className = 'rel-card';
    refsCard.innerHTML = _cardHdr('Top referÃªncias saÃ­das', 'unidades', 'rel-pill-blue');
    if (snap.top5?.length) {
        const blist = document.createElement('div');
        blist.className = 'rel-bar-list';
        const maxQ = snap.top5[0]?.qty || 1;
        const colors = ['#1e3a5f','#2563eb','#2563eb','#60a5fa','#93c5fd'];
        snap.top5.forEach((item, i) => {
            const pct = Math.round((item.qty / maxQ) * 100);
            const el = document.createElement('div');
            el.className = 'rel-bar-row';
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(item.codigo)}${item.nome ? ' â€” ' + escapeHtml(item.nome) : ''}</span>
                    <span class="rel-bar-val" style="color:${colors[i]}">${item.qty} un.</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:${colors[i]}"></div>
                </div>`;
            blist.appendChild(el);
        });
        refsCard.appendChild(blist);
    } else { refsCard.innerHTML += _emptyInline('Sem movimentos registados este mÃªs'); }
    content.appendChild(refsCard);

    // â”€â”€ 6: Ferramentas dias fora â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ferrCard = document.createElement('div');
    ferrCard.className = 'rel-card';
    const diasMes = new Date(_mesRange(mesKey).fim).getDate();
    ferrCard.innerHTML = _cardHdr('Dias fora do armazÃ©m', diasMes + ' dias no mÃªs', 'rel-pill-amber');
    if (snap.topFerrDias?.length) {
        const blist2 = document.createElement('div');
        blist2.className = 'rel-bar-list';
        snap.topFerrDias.forEach(t => {
            const pct  = Math.round((t.dias / diasMes) * 100);
            const alerta = pct >= 80;
            const warn   = pct >= 50 && pct < 80;
            const color  = alerta ? '#dc2626' : warn ? '#f59e0b' : '#2563eb';
            const valColor = alerta ? '#dc2626' : warn ? '#f59e0b' : '#2563eb';
            const el = document.createElement('div');
            el.className = 'rel-bar-row';
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="rel-bar-val" style="color:${valColor}">${t.dias}d Â· ${pct}%</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:${color}"></div>
                </div>`;
            blist2.appendChild(el);
        });
        ferrCard.appendChild(blist2);
    } else { ferrCard.innerHTML += _emptyInline('Sem dados de alocaÃ§Ã£o registados'); }
    content.appendChild(ferrCard);

    // â”€â”€ 7: Ferramentas mais requisitadas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (snap.topFerr?.length) {
        const ferrReqCard = document.createElement('div');
        ferrReqCard.className = 'rel-card';
        ferrReqCard.innerHTML = _cardHdr('Ferramentas mais requisitadas', snap.topFerr.length + ' ferramentas', 'rel-pill-blue');
        const blist3 = document.createElement('div');
        blist3.className = 'rel-bar-list';
        const maxF = snap.topFerr[0]?.count || 1;
        snap.topFerr.forEach(t => {
            const pct = Math.round((t.count / maxF) * 100);
            const el = document.createElement('div');
            el.className = 'rel-bar-row';
            el.innerHTML = `
                <div class="rel-bar-meta">
                    <span class="rel-bar-name">${escapeHtml(t.nome)}</span>
                    <span class="rel-bar-val" style="color:#1e3a5f">${t.count}Ã— requisitada${t.count > 1 ? 's' : ''}</span>
                </div>
                <div class="rel-bar-track">
                    <div class="rel-bar-fill" data-w="${pct}" style="background:#1e3a5f"></div>
                </div>`;
            blist3.appendChild(el);
        });
        ferrReqCard.appendChild(blist3);
        content.appendChild(ferrReqCard);
    }

    // â”€â”€ 8: PATs por funcionÃ¡rio (gauges) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (snap.porFunc && Object.keys(snap.porFunc).length) {
        const funcCard = document.createElement('div');
        funcCard.className = 'rel-card';
        const totalLev = Object.values(snap.porFunc).reduce((a, b) => a + b, 0) || 1;
        const funcEntries = Object.entries(snap.porFunc).sort((a, b) => b[1] - a[1]).slice(0, 4);
        funcCard.innerHTML = _cardHdr('PATs por funcionÃ¡rio', totalLev + ' levantadas', 'rel-pill-green');
        const gaugeRow = document.createElement('div');
        gaugeRow.className = 'rel-gauge-row';
        const gColors = ['#1e3a5f','#2563eb','#f59e0b','#16a34a'];
        funcEntries.forEach(([nome, val], i) => {
            const pct = Math.round((val / totalLev) * 100);
            const col = gColors[i] || '#64748b';
            const col_div = document.createElement('div');
            col_div.className = 'rel-gauge-col';
            col_div.innerHTML = `
                <canvas id="rel-gauge-${i}" width="72" height="72" class="rel-gauge-canvas"></canvas>
                <span class="rel-gauge-name">${escapeHtml(nome)}</span>
                <span class="rel-gauge-pct" style="color:${col}">${val} PAT${val > 1 ? 's' : ''}</span>`;
            gaugeRow.appendChild(col_div);
        });
        funcCard.appendChild(gaugeRow);
        content.appendChild(funcCard);

        // Desenhar gauges apÃ³s DOM insert
        setTimeout(() => {
            funcEntries.forEach(([nome, val], i) => {
                const pct = Math.round((val / totalLev) * 100);
                _relDrawGauge('rel-gauge-' + i, pct, gColors[i] || '#64748b', i * 120);
            });
        }, 200);
    }

    // â”€â”€ Animar barras + donut â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    setTimeout(() => {
        content.querySelectorAll('.rel-bar-fill[data-w]').forEach((bar, i) => {
            setTimeout(() => { bar.style.width = bar.dataset.w + '%'; }, i * 70);
        });
        // Donut Chart.js
        const donutCanvas = document.getElementById('rel-donut');
        if (donutCanvas && window.Chart) {
            new Chart(donutCanvas, {
                type: 'doughnut',
                data: {
                    datasets: [{
                        data: [levantadas, comGuia, pendentes, historico].map(v => Math.max(v, 0)),
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

// â”€â”€ Contador animado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _relAnimCount(elId, target, dur = 800) {
    const el = document.getElementById(elId);
    if (!el || !target) return;
    const start = performance.now();
    const step  = ts => {
        const p    = Math.min((ts - start) / dur, 1);
        const ease = 1 - Math.pow(1 - p, 4);
        el.textContent = Math.round(target * ease);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// â”€â”€ Gauge canvas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _relDrawGauge(canvasId, pct, color, delayMs = 0) {
    setTimeout(() => {
        const c = document.getElementById(canvasId);
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

// â”€â”€ Insight automÃ¡tico â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _relBuildInsight(snap) {
    if (snap.topFerrDias?.length) {
        const top = snap.topFerrDias[0];
        const diasMes = 30;
        const pct = Math.round((top.dias / diasMes) * 100);
        if (pct >= 80) return `"${top.nome}" esteve fora do armazÃ©m ${pct}% do mÃªs (${top.dias} dias). Considera adquirir uma segunda unidade.`;
    }
    if (snap.duracaoMedia != null && snap.duracaoMedia > 10) {
        return `DuraÃ§Ã£o mÃ©dia das PATs estÃ¡ em ${snap.duracaoMedia} dias â€” acima do recomendado. Verifica pendÃªncias em aberto.`;
    }
    if (snap.pendentes > 5) {
        return `${snap.pendentes} PATs ainda pendentes no final do mÃªs. Garante que estÃ£o atribuÃ­das a um tÃ©cnico.`;
    }
    return null;
}

document.addEventListener('DOMContentLoaded', () => {

    // Desktop layout: sidebar visÃ­vel, bottom nav escondido
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

// â”€â”€ Render lista â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        const dataFmt  = enc.data ? enc.data.split('-').reverse().join('/') : 'â€”';

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
        num.textContent = 'Encomenda NÂº ' + (enc.num || 'â€”');
        const forn = document.createElement('div');
        forn.className   = 'enc-card-forn';
        forn.textContent = enc.fornecedor || 'â€”';
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

// â”€â”€ Calculadora de Stock por Peso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        unitWeightEl.textContent = `â‰ˆ ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)} g por unidade`;
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
            ? `${totalWeight}g Ã· ${unitGrams % 1 === 0 ? unitGrams : unitGrams.toFixed(2)}g = ${rounded} unidades exactas`
            : `${totalWeight}g Ã· ${unitGrams.toFixed(2)}g = ${units.toFixed(2)} â†’ arredondado para ${rounded}`;
        resultEl.style.display = 'flex';
    } else {
        resultEl.style.display = 'none';
    }
}

// â”€â”€ Importar PDF de encomenda via Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function encImportPdf(inp) {
    const file = inp.files[0];
    if (!file) return;
    inp.value = '';

    const apiKey = _getAnthropicKey();
    if (!apiKey) {
        showToast('Configura o Worker em DefiniÃ§Ãµes â†’ Leitura por fotografia', 'error');
        return;
    }

    const label = document.getElementById('enc-pdf-label');
    const originalHTML = label ? label.innerHTML : '';
    if (label) {
        label.innerHTML = 'â—·';
        label.style.pointerEvents = 'none';
        label.style.opacity = '0.6';
    }
    showToast('A analisar PDFâ€¦', 'info');

    try {
        const b64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result.split(',')[1]);
            r.onerror = () => rej(new Error('Erro a ler o ficheiro'));
            r.readAsDataURL(file);
        });

        const prompt = `Analisa este documento PDF de encomenda a fornecedor.

Extrai os seguintes campos e responde APENAS com JSON vÃ¡lido, sem markdown:

{
  "numero": "nÃºmero da encomenda (alfanumÃ©rico) ou null",
  "fornecedor": "nome do fornecedor em MAIÃšSCULAS ou null",
  "linhas": [
    { "ref": "referÃªncia do produto ou string vazia", "nome": "designaÃ§Ã£o do produto em MAIÃšSCULAS", "qtd": nÃºmero }
  ]
}

REGRAS:
- numero: procura campos "N.Âº Encomenda", "Ordem de Compra", "OC", "PO", "Ref."
- fornecedor: quem fornece os produtos â€” procura "Fornecedor", "Supplier", "Para", "A/C"
- linhas: extrai TODAS as linhas de produtos com referÃªncia, designaÃ§Ã£o e quantidade encomendada
- qtd deve ser nÃºmero inteiro â€” usa coluna "Qtd", "Quantidade", "Qty" ou similar
- Se qtd nÃ£o existir num produto, usa 1
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
            if (resp.status === 401) throw new Error('Proxy OCR invalido ou sem permissao - actualiza em Admin > Definicoes');
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
        showToast(`PDF importado â€” ${n} produto${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}. RevÃª antes de guardar`, 'ok');

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

// â”€â”€ Modal criar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        <input class="blue-input enc-linha-nome" type="text"   placeholder="DesignaÃ§Ã£o" value="${escapeHtml(String(nome))}" autocomplete="off" spellcheck="false" oninput="this.value=this.value.toUpperCase()">
        <input class="blue-input enc-linha-qtd"  type="number" placeholder="Qtd."       value="${qtd}" min="0" step="0.01">
        <button class="enc-linha-del" onclick="this.closest('.enc-linha').remove()">âœ•</button>`;
    wrap.appendChild(div);
}

async function saveEncomenda() {
    const num  = document.getElementById('enc-num').value.trim();
    const data = document.getElementById('enc-data').value;
    const forn = document.getElementById('enc-fornecedor').value.trim();
    const obs  = document.getElementById('enc-obs').value.trim();

    if (!num)  { showToast('Indica o nÃºmero da encomenda', 'error'); return; }
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
        showToast('Encomenda criada âœ“', 'ok');
        closeEncModal();
        renderEncList();
        loadEncomendas(true);
    } catch(e) {
        showToast('Erro ao guardar: ' + e.message, 'error');
    }
}

// â”€â”€ Detalhe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openEncDetail(id) {
    const enc = _encData[id];
    if (!enc) return;
    _encEditId = id;

    const dataFmt = enc.data ? enc.data.split('-').reverse().join('/') : 'â€”';
    document.getElementById('enc-detail-title').textContent = `Encomenda NÂº ${enc.num || 'â€”'}`;
    document.getElementById('enc-detail-sub').textContent   =
        `${enc.fornecedor || 'â€”'} Â· ${dataFmt}${enc.obs ? ' Â· ' + enc.obs : ''}`;

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
                    <span class="enc-detail-nome">${escapeHtml(l.nome || 'â€”')}</span>
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
                ${done ? 'âœ“ Totalmente recebido' : 'â†“ Dar entrada'}
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
        icon: 'ðŸ—‘',
        title: 'Apagar encomenda?',
        desc: `Encomenda NÂº ${enc?.num} serÃ¡ apagada permanentemente.`,
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

// â”€â”€ Dar entrada â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openEntradaModal(encId, lIdx) {
    _encEntradaId   = encId;
    _encEntradaLIdx = lIdx;
    const l = _encData[encId]?.linhas?.[lIdx];
    if (!l) return;
    const falta = (parseFloat(l.qtd) || 0) - (parseFloat(l.recebido) || 0);
    document.getElementById('enc-entrada-desc').textContent =
        `${l.ref ? '[' + l.ref + '] ' : ''}${l.nome} â€” faltam ${falta} unidades`;
    const inp = document.getElementById('enc-entrada-qty');
    inp.value = falta;
    inp.max   = falta;
    document.getElementById('enc-entrada-info').textContent =
        `JÃ¡ recebido: ${parseFloat(l.recebido) || 0} Â· Encomendado: ${parseFloat(l.qtd) || 0}`;
    document.getElementById('enc-entrada-modal').classList.add('active');
    focusModal('enc-entrada-modal');
    setTimeout(() => inp.focus(), 100);
}

function closeEntradaModal() {
    document.getElementById('enc-entrada-modal').classList.remove('active');
}

async function confirmarEntrada() {
    const qty = parseFloat(document.getElementById('enc-entrada-qty').value);
    if (isNaN(qty) || qty <= 0) { showToast('Quantidade invÃ¡lida', 'error'); return; }

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
        showToast(`Entrada de ${qty} confirmada âœ“`, 'ok');
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


