(function () {
    const state = {
        config: {
            authUrl: async url => url,
            apiFetch: async () => null,
            getCache: () => ({}),
        },
    };

    function init(config = {}) {
        state.config = { ...state.config, ...config };
    }

    async function readServerStockQty(id, fallbackQty = 0) {
        if (!navigator.onLine) return fallbackQty;
        try {
            const url = await state.config.authUrl(`${window.BASE_URL}/stock/${id}/quantidade.json`);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const qty = await res.json();
            const parsed = typeof qty === 'number' ? qty : parseFloat(qty);
            return Number.isFinite(parsed) ? parsed : fallbackQty;
        } catch (e) {
            console.warn('[Stock] fallback para cache local:', id, e?.message);
            return fallbackQty;
        }
    }

    async function commitStockDelta(id, baseQty, finalQty) {
        if (finalQty === undefined) return baseQty;
        if (!navigator.onLine) {
            await state.config.apiFetch(`${window.BASE_URL}/stock/${id}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ quantidade: finalQty })
            });
            return finalQty;
        }

        const cache = state.config.getCache();
        const delta = finalQty - baseQty;
        const latestQty = await readServerStockQty(id, cache?.stock?.data?.[id]?.quantidade ?? baseQty);
        const mergedQty = Math.max(0, latestQty + delta);
        await state.config.apiFetch(`${window.BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: mergedQty })
        });
        return mergedQty;
    }

    async function commitStockAbsolute(id, baseQty, finalQty) {
        if (finalQty === undefined) return baseQty;
        if (!navigator.onLine) {
            await state.config.apiFetch(`${window.BASE_URL}/stock/${id}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ quantidade: finalQty })
            });
            return finalQty;
        }

        const cache = state.config.getCache();
        const latestQty = await readServerStockQty(id, cache?.stock?.data?.[id]?.quantidade ?? baseQty);
        if (Math.abs(latestQty - baseQty) > 0.000001) {
            throw new Error('STOCK_CONFLICT');
        }
        await state.config.apiFetch(`${window.BASE_URL}/stock/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ quantidade: finalQty })
        });
        return finalQty;
    }

    window.HiperfrioStockCore = {
        init,
        readServerStockQty,
        commitStockDelta,
        commitStockAbsolute,
    };
})();
