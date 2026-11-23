# Gestão Armazém (`hiperfrio-stock`)

Aplicação web progressiva (PWA) para gestão de stock, ferramentas, pedidos PAT (com mapa interativo), encomendas a fornecedores, guias técnicos de separação, inventário guiado e relatórios operacionais.

> Para o mapa detalhado de módulos, coleções Firebase e fluxos internos, consulta [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Arrancar Localmente

O projeto não requer Node.js, compilação nem *bundlers*. Basta servir a pasta através de um servidor HTTP local (necessário para o Service Worker, `manifest.json` e CORS):

```bash
# Python 3
python3 -m http.server 8080

# ou Node (npx)
npx serve -l 8080 .
```

Acede a `http://localhost:8080`.

> **Atenção ao Service Worker em desenvolvimento:** como o `sw.js` faz cache dos assets e força *reload* em upgrades, ativa **"Bypass for network"** (Chrome DevTools → Application → Service Workers) enquanto desenvolves, ou limpa os dados do site após alterações grandes.

---

## 2. Serviços Externos e Configuração

### Obrigatórios (já configurados no código)
* **Firebase Auth (Anonymous) + Realtime Database:** inicializado em `index.html` (`projectId: "stock-f477e"`).
  * Regras da base de dados devem incluir os índices:
    ```json
    {
      "rules": {
        "movimentos": { ".indexOn": ["ts", "mes"] },
        "pedidos":    { ".indexOn": ["numero"] },
        "guias":      { ".indexOn": ["separadoEm"] }
      }
    }
    ```
* **CARTO Basemaps:** chave `CARTO_BASEMAP_KEY` no topo de `pats.js` (restringir por domínio no painel da CARTO).

### Opcionais (configurados na UI em *Administração → Definições*)
* **Claude Vision / Importação de PDFs (Guias e Encomendas):** aceita o URL de um Cloudflare Worker proxy (`https://...workers.dev`) ou chave direta `sk-ant-...` (guardada em `sessionStorage`).
* **SerpApi (Pesquisa automática de imagens de produto):** recomenda-se um Cloudflare Worker proxy para evitar bloqueios de CORS no browser; sem chave, abre o Google Images numa nova aba.
* **Email do Inventário:** pré-preenche o destinatário no fallback `mailto:` quando a Web Share API não está disponível.

### Content Security Policy (CSP)
Se adicionares uma nova CDN, fonte ou API externa, atualiza a `<meta http-equiv="Content-Security-Policy">` no `<head>` do `index.html` (`script-src`, `style-src`, `connect-src`, `img-src`, etc.), caso contrário o browser bloqueará o pedido.

---

## 3. Convenções de Código (Importante antes de editar)

1. **Ordem dos scripts:** nunca reordenes os `<script defer>` no `index.html` sem verificar dependências em `ARCHITECTURE.md`.
2. **Nomenclatura global:** como tudo partilha o escopo global, prefixa helpers internos por módulo (`_dv*` Dashboard, `_rel*` Relatórios, `_si*` Importação Stock, `_bk*` Backup, `_enc*` Encomendas, `_inv*` Inventário, `_pat*` PATs, `_guias*` Guias).
3. **Segurança XSS:** escapa sempre dados vindos do Firebase ou de inputs com `escapeHtml()` antes de usar `innerHTML`, ou usa `textContent` / `$el()`.
4. **Permissões (RBAC):**
   * UI: adiciona `data-manager-only` a botões/itens exclusivos de gestor.
   * Lógica: chama `if (!requireManagerAccess()) return;` no início de qualquer mutação restrita.
5. **Alterações de stock:**
   * Usa `findStockByCodigo(ref)` para localizar artigos por referência.
   * Para somar ou subtrair quantidades em cenários multi-utilizador/offline, usa sempre `_commitStockDelta(id, baseQty, finalQty)` em vez de `PATCH { quantidade: valorAbsoluto }`.
   * Regista saídas reais nos relatórios via `registarMovimento(tipo, itemId, codigo, nome, qtd)` **apenas depois** da escrita confirmada (ou enfileirada offline).
6. **Datas e fuso horário:** usa `_calcDias()` e datas locais (`new Date(y, m - 1, d)`) em vez de `new Date("YYYY-MM-DD")` para evitar desvios à meia-noite em Portugal (`WET`/`WEST`).
7. **Bibliotecas externas:** antes de usar `XLSX`, `Chart` ou `L` (Leaflet), chama `await loadXlsx()`, `await loadChart()` ou `await loadLeaflet()`.

---

## 4. Checklists Rápidas para Alterações Comuns

### A. Lançar uma nova versão (*Version Bump*)
Sempre que fizeres *deploy* com alterações em JS/CSS/HTML, atualiza a versão nos **4 locais** para evitar loops de atualização no Service Worker:
- [ ] `index.html` — query strings `?v=X.XX` em todos os `<script defer>`, versão em `.ls-version` e `?v=...` do `style.css` (se alterado).
- [ ] `app.js` — constantes `SW_EXPECTED_VERSION = 'hiperfrio-vX.XX'` e `SW_SCRIPT_URL = 'sw.js?v=X.XX'`.
- [ ] `sw.js` — constante `SW_VERSION = 'hiperfrio-vX.XX'` e todas as entradas de `APP_SHELL`.
- [ ] Se adicionares um novo ficheiro `.js`, inclui-o no `index.html` **e** em `APP_SHELL` no `sw.js`.

### B. Adicionar uma nova vista (`.view`)
- [ ] Adicionar `<div id="view-xxx" class="view">...</div>` dentro de `<main id="main-content">` em `index.html`.
- [ ] Adicionar entrada no menu lateral (`#side-menu`) e, se aplicável, na barra inferior (`#bottom-nav`).
- [ ] Registar o título em `pageTitles`, o mapeamento em `sideMap` / `bnavMap` e o *hook* de carregamento em `nav()` (`app.js`).

### C. Adicionar um novo modal (`.modal-overlay`)
- [ ] Criar o `<div id="xxx-modal" class="modal-overlay" role="dialog" aria-modal="true">` em `index.html`.
- [ ] Abrir/fechar com `modalOpen('xxx-modal')` e `modalClose('xxx-modal')`.
- [ ] Registar o fecho por tecla `Escape` na lista `modals` do `DOMContentLoaded` em `app.js`.

### D. Alterar estilos CSS
- [ ] Verificar primeiro se a classe não está sobrescrita nos blocos `<style>` inline do `index.html` (`#sheet-guias`, `#sheet-critical`, `#sheet-relatorio` e grelha de stock), que ganham na cascata sobre o `style.css`.
- [ ] Testar sempre em **Modo Claro**, **Modo Escuro** (`.dark-mode`), **Mobile (`< 768px`)** e **Desktop (`>= 768px`)**.

---

## 5. Dívida Técnica e Bugs Conhecidos (Backlog Inicial)

Problemas detetados na auditoria inicial da `v6.78` — úteis para priorizar correções antes de acrescentar novas funcionalidades:

### Bugs funcionais
1. **Relatórios não carregam ao abrir pelo menu de Administração (`app.js`):** `adminMobileOpen(tab)` não chama `renderRelatorio(true)` quando `tab === 'relatorio'` (nem `_relDestroyCharts()` em `adminMobileBack()`).
2. **Botão sem handler em Definições (`index.html`):** *"Token para script local"* chama `exportFirebaseToken()`, que não existe em nenhum `.js`.
3. **KPI de Duração invertido em Relatórios (`reports.js`):** o sufixo `'d'` está em `data-prefix` com `prefixed = true`, animando como `d5` em vez de `5d`.
4. **Dupla contagem no donut de PATs (`reports.js`):** como as PATs levantadas passam diretamente a `status: 'historico'`, os contadores `levantadasSemGuia` e `historico` sobrepõem-se.
5. **Web Share Target incompleto (`manifest.json`):** `sw.js` e `app.js` implementam receção de PDFs (`?share=pending` → `?share=ready`), mas falta declarar `share_target` no `manifest.json`.
6. **Comentários CSS partidos (`style.css`):** dois blocos sem `/*` de abertura invalidam a regra utilitária `.hidden { display: none !important; }` e `.dash-view-header`.

### Consistência e manutenção
7. **Escritas absolutas vs. atómicas no stock:** `toggleLinhaRecolhida()` (`guias.js`) e `invReviewConfirm()` (`app.js`) ainda escrevem quantidades absolutas em vez de `_commitStockDelta()`; o Inventário Guiado também não regista movimentos `saida_inventario`.
8. **CSS duplicado/inline:** `.stock-grid`, `.sdc-*`, `.img-edit-*`, `.pdm-*` e `.guia-*` estão duplicados entre `style.css` e os `<style>` do `index.html` (com conflitos de *dark mode* em `.map-pin-sheet` e `.sdc-loc`).
9. **Código legado e globais implícitas:** CSS antigo de Dashboard v3 (`.dv3-*`), Relatórios v2 (`.rel-card`, `.rel-kpi-*`), scan OCR antigo (`.pat-scan-*`) e dropdown de sort antigo (`.sort-dropdown-*`) podem ser removidos; `_patProducts` e `_patDropdownIdx` em `pats.js` precisam de declaração explícita; `_fetchWithTimeout` está duplicada em `utils.js` e `pats.js`.