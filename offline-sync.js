(function () {
    const state = {
        queueKey: 'hiperfrio-offline-queue',
        queueTtlMs: 7 * 24 * 60 * 60 * 1000,
        isSyncing: false,
        config: {
            authUrl: async url => url,
            onSyncSuccess: () => {},
        },
    };

    function init(config = {}) {
        state.config = { ...state.config, ...config };
    }

    function pruneQueue(queue) {
        const cutoff = Date.now() - state.queueTtlMs;
        return queue.filter(op => !op.ts || op.ts > cutoff);
    }

    function queueLoad() {
        try {
            const raw = JSON.parse(localStorage.getItem(state.queueKey) || '[]');
            return pruneQueue(raw);
        } catch {
            return [];
        }
    }

    function queueSave(queue) {
        localStorage.setItem(state.queueKey, JSON.stringify(queue));
    }

    function updateOfflineBanner() {
        const isOffline = !navigator.onLine;
        document.body.classList.toggle('is-offline', isOffline);
        const queue = queueLoad();
        const countEl = document.getElementById('offline-pending-count');
        if (countEl) {
            countEl.textContent = queue.length > 0 ? `${queue.length} alteraÃ§Ã£o(Ãµes) pendente(s)` : '';
            countEl.style.display = queue.length > 0 ? 'inline' : 'none';
        }
    }

    function queueAdd(op) {
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
            navigator.serviceWorker.ready.then(sw => sw.sync.register('hiperfrio-sync')).catch(() => {});
        }
        if (!op.method || op.method === 'GET') return;
        op.ts = Date.now();
        const queue = pruneQueue(queueLoad());
        if (op.method === 'PATCH') {
            const idx = queue.findIndex(o => o.method === 'PATCH' && o.url === op.url);
            if (idx !== -1) queue[idx] = op;
            else queue.push(op);
        } else {
            if (op.url && op.url.includes('/_tmp_')) return;
            queue.push(op);
        }
        queueSave(queue);
        updateOfflineBanner();
    }

    async function syncQueue() {
        if (state.isSyncing) return;
        const queue = queueLoad();
        if (queue.length === 0) return;
        state.isSyncing = true;
        const failed = [];
        for (const op of queue) {
            try {
                const opts = { method: op.method, headers: { 'Content-Type': 'application/json' } };
                if (op.body) opts.body = op.body;
                const signedUrl = await state.config.authUrl(op.url);
                const res = await fetch(signedUrl, opts);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (_e) {
                console.warn('[Queue] falha ao sincronizar op:', op?.method, _e?.message);
                failed.push(op);
            }
        }
        queueSave(failed);
        state.isSyncing = false;
        updateOfflineBanner();
        if (failed.length < queue.length) {
            const synced = queue.length - failed.length;
            if (typeof window.showToast === 'function') {
                window.showToast(`${synced} alteraÃ§Ã£o(Ãµes) sincronizada(s)`);
            }
            try {
                state.config.onSyncSuccess();
            } catch (e) {
                console.warn('[Queue] onSyncSuccess falhou:', e?.message);
            }
        }
    }

    async function apiFetch(url, opts = {}) {
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        if (!navigator.onLine) {
            queueAdd({ method: opts.method || 'GET', url, body: opts.body || null });
            return null;
        }
        const signedUrl = await state.config.authUrl(url);
        const res = await fetch(signedUrl, { ...opts, headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    }

    window.HiperfrioOfflineSync = {
        init,
        queueLoad,
        queueSave,
        queueAdd,
        syncQueue,
        apiFetch,
        updateOfflineBanner,
    };
})();
