# Arquitetura — Gestão Armazém (`hiperfrio-stock`)

> **Versão documentada:** `v6.78`  
> **Stack:** HTML5, CSS3, JavaScript puro (ES2020+, sem *build step* nem *frameworks*), PWA com Service Worker e Firebase Realtime Database via REST API.

---

## 1. Visão Geral do Sistema

A **Gestão Armazém** é uma *Single-Page Application* (SPA) e *Progressive Web App* (PWA) orientada a operações de armazém com suporte *offline-first* para mutações.

### Princípios estruturais
* **Sem bundler nem módulos ES (`import`/`export`):** todos os scripts partilham o âmbito global (`window`) e são carregados no `index.html` com o atributo `defer`, o que garante execução sequencial rigorosa antes de `DOMContentLoaded`.
* **Backend *serverless* via REST:** o SDK do Firebase (`v10.12.0 compat`) é usado apenas para **Anonymous Auth** (obtenção e renovação do *ID Token*). Todas as leituras e escritas na base de dados são feitas via `fetch()` contra a REST API do Firebase Realtime Database (`?auth=<token>`).
* **UI orientada a vistas e modais:** todo o markup reside em `index.html`. A navegação alterna a classe `.active` entre secções `.view` e caixas `.modal-overlay`.
* **Bibliotecas pesadas sob demanda (*lazy loading*):** SheetJS (`XLSX`), Chart.js e Leaflet (+ MarkerCluster) só são injetados no `<head>` quando o utilizador abre a funcionalidade correspondente.

---

## 2. Mapa de Ficheiros e Ordem de Carregamento

A ordem dos `<script defer>` no `index.html` é **obrigatória** devido às referências entre globais:

```text
hiperfrio-stock/
├── index.html          # Shell SPA: CSP, estilos inline críticos, login, vistas, modais, bootstrap Firebase
├── style.css           # Folha de estilos principal (variáveis, layout, componentes, dark mode)
├── manifest.json       # Metadados da PWA (nome, tema, ícones)
├── sw.js               # Service Worker: pré-cache, estratégias fetch, Web Share Target, Background Sync
├── icon-192.png        # Ícone PWA 192×192
├── icon-512.png        # Ícone PWA 512×512
│
│   ── Carregamento sequencial (defer) ──
├── 1. utils.js         # Constantes base (BASE_URL, SVGs), DOM helpers, lazy loaders, lightbox, unidades
├── 2. auth.js          # Token Firebase, RBAC (worker/manager), login online/offline, gestão de contas, bootApp()
├── 3. reports.js       # Movimentos de stock, snapshots mensais versionados, gráficos e insights
├── 4. stock.js         # Catálogo (desktop grid / mobile swipe paginado), ordenação, deltas atómicos
├── 5. stockimport.js   # Importação de inventário Excel/CSV com resolução interativa de conflitos
├── 6. backup.js        # Exportação JSON completa das 13 coleções Firebase (sem passwordHash)
├── 7. tools.js         # Ferramentas, alocações, histórico, timeline, funcionários e modais partilhados
├── 8. pats.js          # Pedidos PAT, mapa Leaflet/CARTO, geocoding, clientes, levantamento e settings OCR/Img
├── 9. guias.js         # Guias técnicos de separação, recolha linha a linha e importação de PDF
└── 10. app.js          # Cache central, fila offline, router nav(), Dashboard v4, Admin, Inventário v2, Encomendas
```

---

## 3. Responsabilidades e Dependências por Módulo

| Ficheiro | Estado / Globais que define | Principais funções exportadas (globais) | Depende de |
| :--- | :--- | :--- | :--- |
| **`utils.js`** | `BASE_URL`, `SVG_*`, `UNITS`, `UNIT_SHORT`, `UNIT_PREFIXES` | `$id`, `$el`, `modalOpen`, `modalClose`, `focusModal`, `_calcDias`, `_debounce`, `_fetchWithTimeout`, `loadXlsx`, `loadChart`, `loadLeaflet`, `escapeHtml`, `showToast`, `formatDate`, `fmtQty`, `openImageViewer` | — *(módulo raiz)* |
| **`auth.js`** | `ROLE_KEY`, `USER_KEY`, `currentRole`, `_authToken`, `_authTokenExp` | `getAuthToken`, `authUrl`, `requireManagerAccess`, `applyRole`, `handleLogin`, `createUser`, `deleteUser`, `renderUsersList`, `switchRole`, `bootApp` | `utils.js`, `app.js` *(em runtime)* |
| **`reports.js`** | `REL_URL`, `MOV_URL`, `_relMesOffset`, `_relRange`, `_relDonutChart` | `registarMovimento`, `_pruneMovimentos`, `_mesKey`, `_autoFecharMesSeNecessario`, `_relSalvarSnapshotSePreciso`, `_relSalvarPatAntesDeApagar`, `renderRelatorio`, `_relDestroyCharts` | `utils.js`, `auth.js`, `pats.js` & `app.js` *(runtime)* |
| **`stock.js`** | `_stockSort`, `_pendingZeroFilter`, `_zeroFilterActive`, `_bulkCount`, `_toolsFilter` | `renderList`, `setStockSort`, `filterZeroStock`, `clearZeroFilter`, `findStockByCodigo`, `_commitStockDelta`, `changeQtd`, `openInlineQtyEdit`, `openProductDetail`, `exportCSV`, `checkDuplicateCodigo`, `toolsFilterSet` | `utils.js`, `auth.js`, `reports.js`, `tools.js` & `app.js` *(runtime)* |
| **`stockimport.js`** | `_SI` | `renderStockImport`, `siHandleFile`, `siApply`, `siCancel`, `siRv*` | `utils.js`, `auth.js`, `reports.js`, `stock.js`, `app.js` |
| **`backup.js`** | `_BK_COLLECTIONS`, `_BK_LAST_KEY` | `bkUpdateStatus`, `exportBackupJSON` | `utils.js`, `auth.js` |
| **`tools.js`** | `toolToAllocate`, `confirmCallback`, `pendingDeleteId` | `renderTools`, `renderAdminTools`, `renderWorkers`, `assignTool`, `returnTool`, `openHistoryModal`, `openToolTimeline`, `exportToolHistoryCSV`, `openConfirmModal`, `closeConfirmModal`, `openDeleteModal`, `openEditModal` | `utils.js`, `auth.js`, `app.js`, `pats.js` (`_loadImgEdit`) |
| **`pats.js`** | `CARTO_BASEMAP_KEY`, `_patCache`, `_clientesCache`, `_geocodeCache`, `_patMap`, `_patMapPanel` | `_fetchPats`, `_fetchClientes`, `renderPats`, `savePat`, `marcarPatLevantado`, `levantarSelectedPats`, `openPatMap`, `expandPatMap`, `_openPatMapPanel`, `renderClientesList`, `importClientesExcel`, `openOcrSettings`, `openGimgSettings`, `imgSearchAuto`, `_loadImgEdit`, `runDedup` | `utils.js`, `auth.js`, `reports.js`, `stock.js`, `tools.js`, `app.js` |
| **`guias.js`** | `GUIAS_URL`, `_guiasCache`, `_guiasTab` | `_fetchGuias`, `renderGuias`, `updateGuiasCount`, `openNovaGuia`, `saveGuia`, `toggleLinhaRecolhida`, `arquivarGuia`, `deleteGuia`, `guiaImportPdf` | `utils.js`, `auth.js`, `reports.js`, `tools.js`, `pats.js` (`_getAnthropicKey`, `_isProxyUrl`), `app.js` |
| **`app.js`** | `cache`, `ENC_URL`, `_encData`, `SW_EXPECTED_VERSION`, `_invItems`, `_invChanges` | `fetchCollection`, `invalidateCache`, `apiFetch`, `queueAdd`, `syncQueue`, `updateOfflineBanner`, `nav`, `renderDashboard`, `_buildAdminMobileMenu`, `switchAdminTab`, `setTheme`, `startInventory`, `loadEncomendas`, `confirmarEntrada`, `encImportPdf`, `_handleSharedPdf`, `openWeightCalc` | Todos os módulos anteriores |

---

## 4. Modelo de Dados — Firebase Realtime Database

URL base: `https://stock-f477e-default-rtdb.europe-west1.firebasedatabase.app`

```text
/
├── stock/{itemId}
│   └── { codigo, nome, localizacao, quantidade, unidade, notas, imgUrl?, gasMax?, gasAlerta? }
│
├── pedidos/{patId}
│   └── { numero (6 dígitos), clienteNumero?, clienteId?, estabelecimento, obs?,
│         produtos: [{ id|null, codigo, nome, quantidade }],
│         status: 'pendente' | 'historico' (legado: 'levantado'),
│         criadoEm, levantadoEm?, saidaEm?, funcionario? }
│
├── guias/{guiaId}
│   └── { numero, tecnico, data (YYYY-MM-DD), status: 'pendente' | 'separado' | 'historico',
│         criadoEm, separadoEm?,
│         linhas: { l0: { codigo, nome, quantidade, unidade, recolhido, recolhidoEm? } } }
│
├── encomendas/{encId}
│   └── { num, fornecedor, data (YYYY-MM-DD), obs, estado: 'pendente' | 'parcial' | 'recebida', ts,
│         linhas: { "0": { ref, nome, qtd, recebido } } }
│
├── ferramentas/{toolId}
│   └── { nome, status: 'disponivel' | 'alocada', colaborador?, dataEntrega?,
│         historico: { {evId}: { acao: 'atribuida'|'devolvida', colaborador, data (ISO) } } }
│
├── funcionarios/{workerId}
│   └── { nome }
│
├── clientes/{clienteId}              # ex.: c001
│   └── { numero, nome, lat?, lng? }
│
├── geocode-cache/{sanitizedKey}
│   └── { keyOriginal?, lat|null, lng|null, ts }
│
├── movimentos/{movId}                # Retenção: 90 dias (_pruneMovimentos)
│   └── { tipo: 'saida_manual' | 'saida_pat' | 'saida_guia' | 'saida_inventario'
│             | 'remocao' | 'estorno_guia',
│         itemId|null, codigo, nome, quantidade, ts, mes (YYYY-MM) }
│
├── relatorios/{YYYY-MM}
│   ├── current: "vN"                 # Ponteiro para versão ativa (retém últimas 5)
│   └── v{N}: { mes, totalPats, levantadas, pendentes, historico, duracaoMedia,
│               totalSaidas, saidasPorTipo, guiasCount, stockZero, topEsgotados,
│               porFunc, top5, topGuias, topFerr, topClientes, topFerrDias, ts }
│
├── dash-snapshots/{YYYY-MM-DD}       # Retenção: 30 dias
│   └── { date, total, semStock, alocadas, patPendentes, encActivas, ts }
│
├── inv-resume/{username}             # Retenção: 72 horas
│   └── { idx, items, changes, skipped, options, ts }
│
└── config/
    └── users/{username}
        └── { role: 'worker'|'manager', displayName?, passwordHash (SHA-256), createdAt }
```

### Índices obrigatórios nas Regras do Firebase (`.indexOn`)
Sem estes índices, as queries filtradas falham ou devolvem arrays/erros:
* `/movimentos`: `".indexOn": ["ts", "mes"]`
* `/pedidos`: `".indexOn": ["numero"]`
* `/guias`: `".indexOn": ["separadoEm"]`

---

## 5. Fluxos Críticos de Dados

### 5.1 Autenticação e Arranque (`index.html` → `auth.js`)
1. `index.html` inicializa o Firebase e executa `signInAnonymously()`, expondo `window._firebaseTokenPromise`.
2. O utilizador autentica-se contra `/config/users.json` com hash `SHA-256(password + 'hiperfrio-pw-salt' + username)`.
   * **Offline:** valida contra um verificador isolado (`hiperfrio-offline-v2`) em `localStorage['hiperfrio-session']` válido por 24h (apenas último utilizador).
   * **Segurança:** *backoff* progressivo em `sessionStorage['hiperfrio-login-fails']` (3 falhas → 5s; 5 → 15s; 7+ → 30s).
3. `applyRole(role)` aplica `body.worker-mode` (que esconde `[data-manager-only]` via CSS) e `bootApp()` carrega coleções em paralelo via `Promise.allSettled`, renova o token a cada 45 min (e em `visibilitychange`) e remove `.ls-form` do DOM para impedir *autocomplete* indesejado do Chrome.

### 5.2 Escrita Atómica de Stock e Fila Offline (`stock.js` + `app.js`)
* **Incremento atómico no servidor:** `_commitStockDelta()` envia `PATCH` com `{ "quantidade": { ".sv": { "increment": delta } } }`. Dois utilizadores a movimentar o mesmo artigo em simultâneo somam variações sem se sobrescreverem. Se o resultado ficar negativo, é enviado um incremento compensatório até `0`.
* **Fila offline (`hiperfrio-offline-queue`):**
  * `apiFetch()` enfileira mutações (`POST`/`PUT`/`PATCH`/`DELETE`) em memória quando `!navigator.onLine` e persiste em `localStorage` com *debounce* de 400ms (e *flush* imediato em `pagehide`, `beforeunload` e `visibilitychange`).
  * Operações com mais de 7 dias são descartadas (`QUEUE_TTL_MS`).
  * Múltiplos `PATCH` ao mesmo URL são fundidos por `_mergePatchBodies()`, somando incrementos `.sv.increment` consecutivos.
  * Ao regressar online (ou via evento `sync` do SW), `syncQueue()` envia sequencialmente a fila, corrige saldos negativos (`_syncFixNegativeStock`) e invalida caches.

### 5.3 Pipeline de Geocoding e Mapa (`pats.js`)
1. `/clientes/{id}` (`lat`, `lng`) — **fonte de verdade**, sempre carregada fresca.
2. `/geocode-cache/{key}` — fallback para estabelecimentos sem ficha de cliente (resultados `null` retentados após 7 dias).
3. **Nominatim (OpenStreetMap)** — até 3 queries progressivas com pausas de `800ms`–`1100ms`; coordenadas encontradas são gravadas tanto no cliente como na cache.

### 5.4 Importação de PDFs e Web Share Target (`sw.js` → `app.js` / `guias.js`)
1. Partilha de PDF no Android envia `POST ./index.html?share=pending` → `sw.js` guarda blob e metadados na Cache API (`hiperfrio-share-pending`, TTL 60s) → redireciona `303` para `./index.html?share=ready`.
2. `bootApp()` deteta `?share=ready` → `_handleSharedPdf()` recupera o ficheiro via `MessageChannel` (`GET_SHARED_FILE`) → utilizador escolhe **Guia Técnica** ou **Encomenda** → `guiaImportPdf()` ou `encImportPdf()` envia o PDF em base64 para Claude (`claude-haiku-4-5-20251001`) via Cloudflare Worker proxy (ou API direta Anthropic).

---

## 6. Estratégia de Cache e PWA (`sw.js`)

| Tipo de pedido | Estratégia | Notas |
| :--- | :--- | :--- |
| `POST ?share=pending` | Cache API (`hiperfrio-share-pending`) + redirect `303` | TTL 60s; consumido na primeira leitura |
| Métodos não-GET | *Pass-through* | Nunca entram na Cache API |
| Firebase, Google APIs, `gstatic`, `tessdata`, `unpkg` | *Pass-through* | Sempre diretos à rede |
| `cdnjs.cloudflare.com` (XLSX, Chart.js, Leaflet) | **Cache-First** | Libs versionadas e imutáveis |
| Assets *same-origin* (`index.html`, `style.css`, `*.js`) | **Network-First** com fallback à cache | Só cacheia `200 OK`; pré-cacheados no `install` (`APP_SHELL`) |

Quando uma nova versão de `sw.js` ativa (`SW_VERSION`), apaga caches antigas, executa `clients.claim()` e envia `SW_UPDATED` às abas abertas para recarregarem os ficheiros novos.

---

## 7. Arquitetura de CSS e Armazenamento Local

### Cascata de estilos
1. `style.css?v=1777900000` — base global (13 secções temáticas + `.dark-mode` + breakpoint desktop `768px`).
2. Blocos `<style>` inline em `index.html` (`#sheet-guias`, `#sheet-critical`, `#sheet-relatorio` e bloco da grelha de stock) — carregados **depois** do `style.css` originalmente para contornar cache do SW; têm precedência na cascata.

### Chaves de `localStorage` e `sessionStorage`
| Storage | Chave | Módulo | Propósito |
| :--- | :--- | :--- | :--- |
| `localStorage` | `hiperfrio-role`, `hiperfrio-username`, `hiperfrio-displayname` | `auth.js` | Sessão ativa e apresentação |
| `localStorage` | `hiperfrio-session`, `hiperfrio-last-online` | `auth.js` | Login offline (verificador + TTL 24h) |
| `localStorage` | `hiperfrio-offline-queue` | `app.js` | Fila de mutações offline (TTL 7d) |
| `localStorage` | `hiperfrio-tema` | `app.js` | Tema `'light'` \| `'dark'` |
| `localStorage` | `hiperfrio-zone-history` | `stock.js` | Últimas 8 zonas do lote |
| `localStorage` | `hiperfrio-serpapi-key`, `hiperfrio-ocr-keywords` | `pats.js` | Pesquisa de imagens e palavras-chave OCR |
| `localStorage` | `hiperfrio-inv-email` | `app.js` | Email destino do inventário |
| `localStorage` | `hiperfrio-last-backup` | `backup.js` | Timestamp da última cópia JSON completa |
| `localStorage` | `hiperfrio-gasmax-{id}` | `app.js` | Máximo local de referência para garrafas sem `gasMax` |
| `localStorage` | `hiperfrio-dashsnap-wrote`, `hiperfrio-dashsnap-pruned` | `app.js` | Controlo diário/semanal dos snapshots do dashboard |
| `localStorage` | `hiperfrio-rel-last-close`, `hiperfrio-prune-mov-ts` | `reports.js` | Controlo mensal de fecho e semanal de limpeza de movimentos |
| `sessionStorage` | `hiperfrio-anthropic-key` | `pats.js` | URL do Cloudflare Worker ou API key Anthropic (não persiste entre sessões) |
| `sessionStorage` | `hiperfrio-login-fails` | `auth.js` | Contador/timestamp de *rate limiting* no login |
| `sessionStorage` | `sw-reload-done` | `app.js` | Evita ciclo de *reload* após `SW_UPDATED` |