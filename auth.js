// ─────────────────────────────────────────────────────────────────────────────
// auth.js — Hiperfrio v6.56
// Fase 2 da modularização: autenticação, perfis e gestão de utilizadores.
// Carrega DEPOIS de utils.js e ANTES de app.js.
//
// Dependências (globais fornecidas por outros ficheiros):
//   utils.js → BASE_URL, $id, $el, showToast, escapeHtml, modalClose, focusModal
//   app.js   → cache, apiFetch, openConfirmModal, renderList, nav, etc.
// ─────────────────────────────────────────────────────────────────────────────

// ── Token Firebase ────────────────────────────────────────────────────────────
let _authToken    = null;
let _authTokenExp = 0; // timestamp de expiração (tokens duram ~1h)

// Obtém token válido — aguarda Promise do SDK Firebase ou renova se expirado
async function getAuthToken() {
    const now = Date.now();
    // Token em cache ainda válido (margem de 5 min)
    if (_authToken && now < _authTokenExp - 300_000) return _authToken;

    const tokenPromise = window._firebaseTokenPromise
        ? window._firebaseTokenPromise
        : Promise.reject(new Error('Firebase SDK não carregou'));

    _authToken = await Promise.race([
        tokenPromise,
        new Promise((_, rej) => setTimeout(() =>
            rej(new Error('Auth timeout — verifica Anonymous Auth na consola Firebase')), 10_000))
    ]);

    // Se o user está disponível, renova o token (force=true garante token fresco)
    if (window._firebaseUser) {
        try {
            const forceRefreshToken = (_authToken !== null);
            _authToken = await window._firebaseUser.getIdToken(forceRefreshToken);
        } catch(_e) { console.warn('[Auth] falha ao renovar token:', _e?.message); }
    }

    _authTokenExp = now + 3_500_000; // ~58 min
    return _authToken;
}

// Renovação proactiva do token a cada 45 min — protege sessões longas
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
        _scheduleTokenRenewal();
    }, 45 * 60 * 1000);
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

// ── Perfis — Funcionário vs Gestor ────────────────────────────────────────────
const ROLE_KEY    = 'hiperfrio-role'; // 'worker' | 'manager'
let   currentRole = null;             // definido no arranque

function requireManagerAccess({ silent = false } = {}) {
    if (currentRole === 'manager') return true;
    if (!silent) showToast('Acesso reservado a gestores', 'error');
    return false;
}

// Aplica o perfil à UI — chamado uma vez no boot
function applyRole(role) {
    currentRole = role;
    document.body.classList.toggle('worker-mode', role === 'worker');

    let badge = $id('role-badge');
    if (!badge) {
        badge = $el('button');
        badge.id      = 'role-badge';
        badge.onclick = () => openSwitchRoleModal();
        document.querySelector('.header-titles')?.appendChild(badge);
    }
    const savedUser    = localStorage.getItem('hiperfrio-username') || '';
    const displayName  = localStorage.getItem('hiperfrio-displayname') || '';
    const displayLabel = displayName || savedUser || (role === 'worker' ? 'Funcionário' : 'Gestor');
    badge.textContent = `${displayLabel} ▾`;
    badge.className   = role === 'worker' ? 'role-badge-worker' : 'role-badge-manager';

    const footerUser = $id('menu-footer-username');
    const footerRole = $id('menu-footer-role');
    if (footerUser) footerUser.textContent = displayLabel;
    if (footerRole) footerRole.textContent = role === 'worker' ? 'Operador' : 'Gestor';

    $id('role-screen')?.classList.add('hidden');
}

// ── Login ─────────────────────────────────────────────────────────────────────
const USERS_URL      = `${BASE_URL}/config/users.json`;
const USERS_BASE_URL = `${BASE_URL}/config/users`;
const USER_KEY       = 'hiperfrio-username';

// Hash SHA-256 com salt de username — rainbow tables ineficazes por utilizador
async function hashPassword(password, username = '') {
    const saltedInput = password + 'hiperfrio-pw-salt' + username.toLowerCase();
    const data    = new TextEncoder().encode(saltedInput);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Verificador offline — salt diferente do Firebase para isolar compromissos
const _OFFLINE_SALT = 'hiperfrio-offline-v2';
async function _offlineVerifier(username, password) {
    const raw = new TextEncoder().encode(username + ':' + password + ':' + _OFFLINE_SALT);
    const buf = await crypto.subtle.digest('SHA-256', raw);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadUsers() {
    try { await getAuthToken(); } catch(e) { console.warn('[Login] sem token Firebase:', e.message); }
    try {
        const url = await authUrl(USERS_URL);
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && !data.error) {
            localStorage.setItem('hiperfrio-last-online', Date.now().toString());
            return data;
        }
        throw new Error(data?.error || 'resposta inválida');
    } catch (e) {
        console.warn('[Login] servidor inacessível — tenta sessão offline');
        return null;
    }
}

// Floating label — adiciona/remove classe has-value
function lsFieldUpdate(input, fieldId) {
    const field = $id(fieldId);
    if (!field) return;
    field.classList.toggle('has-value', input.value.length > 0);
}

// Toggle mostrar/esconder password
function toggleLoginPassword() {
    const inp  = $id('ls-password');
    const icon = $id('ls-eye-icon');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
        ? '<path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd"/><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z"/>'
        : '<path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/>';
}

// Handler principal do formulário de login
async function handleLogin(e) {
    if (e) e.preventDefault();

    const errEl   = $id('ls-error');
    const btn     = $id('ls-submit-btn');
    const btnText = $id('ls-btn-text');
    const spinner = $id('ls-spinner');

    const showError = (msg) => {
        if (!errEl) return;
        errEl.textContent = msg;
        if (msg) errEl.classList.add('visible');
        else     errEl.classList.remove('visible');
    };

    const username = ($id('ls-username')?.value || '').trim().toLowerCase();
    const password = $id('ls-password')?.value || '';

    if (!username || !password) { showError('Preenche o utilizador e a password.'); return; }

    showError('');
    if (btn)     btn.disabled = true;
    if (btnText) btnText.textContent = 'A verificar...';
    if (spinner) spinner.classList.remove('hidden');

    // BUG FIX: rate limiting simples — bloqueia 5s após 3 falhas consecutivas
    const failKey  = 'hiperfrio-login-fails';
    const failData = JSON.parse(sessionStorage.getItem(failKey) || '{"count":0,"until":0}');
    if (failData.until > Date.now()) {
        const secsLeft = Math.ceil((failData.until - Date.now()) / 1000);
        showError(`Demasiadas tentativas. Aguarda ${secsLeft}s.`);
        if (btn)     btn.disabled = false;
        if (btnText) btnText.textContent = 'Entrar';
        if (spinner) spinner.classList.add('hidden');
        return;
    }

    try {
        const users = await loadUsers();

        if (users === null) {
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
                    const role = session.role || 'worker';
                    localStorage.setItem(ROLE_KEY, role);
                    localStorage.setItem(USER_KEY, username);
                    if (session.displayName) localStorage.setItem('hiperfrio-displayname', session.displayName);
                    sessionStorage.removeItem(failKey);
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
            _loginFail(failKey, failData);
            return;
        }

        const pwHash       = await hashPassword(password, username);
        const pwHashLegacy = await hashPassword(password); // retrocompatibilidade
        if (pwHash !== userObj.passwordHash && pwHashLegacy !== userObj.passwordHash) {
            showError('Password incorrecta.');
            _loginFail(failKey, failData);
            return;
        }

        // Migração silenciosa para hash com username no salt
        if (pwHashLegacy === userObj.passwordHash && pwHash !== userObj.passwordHash) {
            const migrUrl = await authUrl(`${USERS_BASE_URL}/${username}.json`);
            fetch(migrUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passwordHash: pwHash }) }).catch(() => {});
        }

        // Login bem sucedido
        const role        = userObj.role || 'worker';
        const displayName = userObj.displayName || '';
        const verifier    = await _offlineVerifier(username, password);
        localStorage.setItem('hiperfrio-session', JSON.stringify({ username, role, displayName, verifier, ts: Date.now() }));
        localStorage.removeItem('hiperfrio-users-cache');
        localStorage.setItem(ROLE_KEY, role);
        localStorage.setItem(USER_KEY, username);
        if (displayName) localStorage.setItem('hiperfrio-displayname', displayName);
        else             localStorage.removeItem('hiperfrio-displayname');
        sessionStorage.removeItem(failKey);

        showError('');
        const card = document.querySelector('.ls-card');
        if (card) {
            card.style.transition = 'opacity 0.3s, transform 0.3s';
            card.style.opacity    = '0';
            card.style.transform  = 'scale(0.96) translateY(-10px)';
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

// Regista falha e aplica backoff: 3 falhas → bloqueia 5s, 5 → 15s, 7+ → 30s
function _loginFail(key, data) {
    const count = (data.count || 0) + 1;
    const delay = count >= 7 ? 30000 : count >= 5 ? 15000 : count >= 3 ? 5000 : 0;
    sessionStorage.setItem(key, JSON.stringify({ count, until: Date.now() + delay }));
}

// ── Gestão de utilizadores (Admin → tab Utilizadores) ─────────────────────────

async function createUser() {
    if (!requireManagerAccess()) return;
    const nameRaw     = $id('new-user-name')?.value.trim().toLowerCase();
    const role        = $id('new-user-role')?.value;
    const password    = $id('new-user-pass')?.value;
    const displayName = $id('new-user-displayname')?.value.trim() || '';

    if (!nameRaw) { showToast('Indica o nome de utilizador', 'error'); return; }
    // BUG FIX: mínimo aumentado para 8 caracteres
    if (!password || password.length < 8) { showToast('Password deve ter pelo menos 8 caracteres', 'error'); return; }
    if (!/^[a-z0-9._]+$/.test(nameRaw)) { showToast('Nome só pode ter letras, números, ponto e _', 'error'); return; }

    const pwHash = await hashPassword(password, nameRaw);
    const url    = await authUrl(`${USERS_BASE_URL}/${nameRaw}.json`);

    try {
        const checkRes = await fetch(url);
        if (checkRes.ok) {
            const existing = await checkRes.json();
            if (existing !== null && !existing.error) {
                showToast('Utilizador já existe', 'error'); return;
            }
        }

        const userData = { role, passwordHash: pwHash, createdAt: Date.now() };
        if (displayName) userData.displayName = displayName;

        const saveRes = await fetch(url, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(userData)
        });
        if (!saveRes.ok) {
            const err = await saveRes.json().catch(() => ({}));
            showToast('Erro ao guardar: ' + (err.error || saveRes.status), 'error');
            return;
        }

        localStorage.removeItem('hiperfrio-users-cache');
        localStorage.removeItem('hiperfrio-session');
        $id('new-user-name').value = '';
        $id('new-user-pass').value = '';
        const dnEl = $id('new-user-displayname');
        if (dnEl) dnEl.value = '';
        showToast(`Utilizador "${nameRaw}" criado`);
        renderUsersList();
    } catch (e) {
        showToast('Erro de ligação: ' + (e.message || e), 'error');
    }
}

async function renderUsersList() {
    if (!requireManagerAccess({ silent: true })) return;
    const el = $id('users-list');
    if (!el) return;
    el.innerHTML = '<div class="empty-msg">A carregar...</div>';

    try {
        const res = await fetch(await authUrl(USERS_URL));
        // BUG FIX: verificar res.ok antes de chamar .json()
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const users = await res.json() || {};

        if (!Object.keys(users).length) {
            el.innerHTML = '<div class="empty-msg">Nenhum utilizador criado ainda.</div>';
            return;
        }

        el.innerHTML = Object.entries(users).map(([name, u]) => {
            const safeName    = escapeHtml(name);
            const safeDisplay = escapeHtml(u.displayName || '');
            return `
            <div class="admin-list-row" style="gap:10px;">
                <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
                    <span style="font-size:1.3rem">${u.role === 'manager' ? '👔' : '🔧'}</span>
                    <div style="min-width:0;">
                        <div style="font-weight:700;font-size:0.9rem;color:var(--text-main)">${safeDisplay || safeName}</div>
                        <div style="font-size:0.72rem;color:var(--text-muted)">${safeName} · ${u.role === 'manager' ? 'Gestor' : 'Funcionário'}</div>
                    </div>
                </div>
                <button class="btn-danger-sm" onclick="deleteUser('${safeName}')">🗑</button>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = '<div class="empty-msg">Erro ao carregar utilizadores.</div>';
    }
}

async function deleteUser(username) {
    if (!requireManagerAccess()) return;
    const currentUser = localStorage.getItem('hiperfrio-username') || '';
    if (username === currentUser) {
        showToast('Não podes eliminar a tua própria conta', 'error');
        return;
    }
    openConfirmModal({
        title: 'Eliminar utilizador?',
        desc: `"${username}" será removido permanentemente.`,
        type: 'danger',
        onConfirm: async () => {
            try {
                await apiFetch(`${USERS_BASE_URL}/${username}.json`, { method: 'DELETE' });
                localStorage.removeItem('hiperfrio-users-cache');
                localStorage.removeItem('hiperfrio-session');
                showToast(`Utilizador "${username}" eliminado`);
                renderUsersList();
            } catch(e) {
                showToast('Erro ao eliminar utilizador: ' + (e?.message || e), 'error');
            }
        }
    });
}

// ── Trocar de perfil ──────────────────────────────────────────────────────────
function switchRole() {
    modalClose('switch-role-modal');
    localStorage.removeItem(ROLE_KEY);
    currentRole = null;
    $id('role-badge')?.remove();
    document.body.classList.remove('worker-mode');
    // Invalida cache em memória (cache definido em app.js)
    Object.keys(cache).forEach(k => { cache[k].data = null; cache[k].lastFetch = 0; });
    clearTimeout(_tokenRenewalTimer);
    _authToken    = null;
    _authTokenExp = 0;
    localStorage.removeItem('hiperfrio-username');
    localStorage.removeItem('hiperfrio-displayname');
    localStorage.removeItem('hiperfrio-users-cache');
    localStorage.removeItem('hiperfrio-session');
    const u = $id('ls-username'); if (u) u.value = '';
    const p = $id('ls-password'); if (p) p.value = '';
    const e = $id('ls-error');    if (e) e.classList.remove('visible');
    const rs = $id('role-screen');
    if (rs) {
        rs.style.opacity = '0';
        rs.style.transition = 'opacity 0s';
        rs.classList.remove('hidden');
        requestAnimationFrame(() => { rs.style.transition = 'opacity 0.3s'; rs.style.opacity = '1'; });
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.menu-items li, .bottom-nav-item').forEach(b => b.classList.remove('active'));
    $id('view-dashboard')?.classList.add('active');
    $id('nav-dashboard')?.classList.add('active');
}

function openSwitchRoleModal() {
    $id('switch-role-modal')?.classList.add('active');
    focusModal('switch-role-modal');
}

// ── Arranque da app após login ────────────────────────────────────────────────
// bootApp() é o ponto de entrada após autenticação bem sucedida.
// Chama funções definidas em app.js — mantém-se aqui por enquanto porque
// precisa de ser invocado tanto por handleLogin() como por DOMContentLoaded.
async function bootApp() {
    try {
        await getAuthToken();
    } catch(_e) {
        console.warn('bootApp: sem token, continua offline');
    }
    _scheduleTokenRenewal();
    await Promise.all([
        renderList(),
        fetchCollection('ferramentas'),
        fetchCollection('funcionarios'),
        _fetchClientes(),
        _fetchPats(),
    ]).catch(e => console.warn('bootApp fetch error:', e));
    _autoFecharMesSeNecessario();
    _pruneMovimentos().catch(() => {});
    updateOfflineBanner();
    nav('view-dashboard');
}
