# Medida do precache, novembro de 2026

Medida, sem corte: de onde vem o `PRECACHE-GROWTH +213911 B` que o build do PR 611 (miniaturas de produto, `MEDIA_THUMBS_ENABLED`) imprimiu, e se a referência de +44 000 B do verificador (`apps/web/pwa/precache-budget.ts`) ainda mede alguma coisa. Nenhum código nem a referência mudou neste documento.

Todos os tamanhos são gzip nível 9, arquivo a arquivo (as fontes `.woff2` entram sem gzip), de um build de produção do `apps/web` sem DSN do Sentry, com Node 24 (o mesmo cálculo do job de CI; o build sob Bun sai maior).

## Resposta curta

1. **O PR 611 acrescentou +5 011 B** à linha do resto (de +208 900 B para +213 911 B), 2,3 % do que o build relatou. Quase tudo está no chunk de entrada (`index-*.js`, +5 031 B), e o perfil por módulo (seção 3) liga esse crescimento ao carregador de miniaturas que o shell importa (99,5 % dos bytes renderizados novos do chunk); `current-organization` e a Venda não estão no chunk de entrada. A medida é em bytes renderizados por módulo, não em gzip: a parte do +5 031 B de gzip que cabe a cada módulo não foi separada. Os outros +208 900 B já estavam na `main` quando o PR 611 entrou.
2. **A `main` atual (`4ee22b40`) mede +214 222 B**: mais +311 B depois do PR 611, de outros PRs (Assinatura +117 B, Venda +124 B, `sale-redo-storage` +71 B).
3. **A referência de +44 000 B deixou de dizer quanto um PR custa.** A linha ultrapassou +44 000 B no fim de 23/10 e está acima dela há 13 dias; cada PR "excede em ~170 KB" por herança, e o excedente impresso não é do PR. Detalhe na seção 4.
4. **`MEDIA_THUMBS_ENABLED` não muda o precache.** Conclusão por leitura de código, sem build com a flag ligada e outro desligada: a variável está só como `var` do Worker em `apps/web/wrangler.jsonc`, nunca como `VITE_*`; `organization-handlers.ts` a devolve em `organization.listMine` como `mediaThumbs`, e `media-thumbs-flag.ts` só lê o contexto. O código das miniaturas vai no build de qualquer jeito, e as imagens vêm por `/media`, fora do precache. Ligar a flag em produção não altera nenhum byte da lista abaixo.

## 1. O que a linha do resto mede

A `baseline` de 1 018 327 B é o **total** do precache da `main` em `8c2ef580` (o piso do PR 0 da base de interface): reconstruí esse commit e a soma de todos os arquivos dá 1 018 327 B exatos, sem fontes, sem primitivos e sem chunks de gráfico, calendário, movimento ou mapa.

A linha "rest line" de hoje é o total do precache **menos** seis linhas que o verificador conta à parte (`measurePrecache`). Por isso o crescimento real do precache é bem maior que o número impresso:

| Origem (main `4ee22b40`, runtime offline desligado) | Bytes |
| --- | ---: |
| Total do precache, 96 arquivos | 1 517 739 |
| Total no `8c2ef580` (= baseline), 77 arquivos | 1 018 327 |
| **Crescimento real do precache** | **+499 412** |
| Fontes Geist (`.woff2`, 55 000 B de teto próprio) | 52 528 |
| Primitivos do Base UI (fração do gzip de cada chunk) | 92 617 |
| Chunk dos gráficos (`charts-*.js`) | 57 236 |
| Chunk do movimento (`motion-*.js`) | 49 639 |
| Chunk do calendário (`calendar-*.js`) | 22 988 |
| Chunk do mapa (`heatmap-*.js`) | 10 182 |
| Soma das seis linhas à parte | 285 190 |
| **Crescimento da linha do resto (`PRECACHE-GROWTH`)** | **+214 222** |

499 412 − 285 190 = 214 222. A linha do resto é a "tela e o resto" mais a infraestrutura de interface (35 155 B); o ADR 0103 (seção 4) pede que cada PR de tela não aumente o resto em líquido, mas essa linha agora carrega o código de todas as telas migradas.

## 2. Três commits, medidos

Comandos na seção 6. Os números do build local batem byte a byte com os do CI do mesmo código (runs 42079265073 para o pai, 42083227676 para o merge, 42125477457 para a `main`; o run 42077520201, do head do PR, que o CI constrói sobre a ref de merge, imprime o mesmo +213 911 B do merge).

| Commit | Runtime offline desligado: total / linha do resto / crescimento | Runtime offline ligado: linha do resto / crescimento |
| --- | --- | --- |
| Pai do merge do PR 611, `9ce39451` | 1 512 308 / 1 227 227 / +208 900 | 1 301 811 / +205 559 |
| Merge do PR 611, `514923cb` | 1 517 437 / 1 232 238 / +213 911 | 1 307 010 / +210 758 |
| `main` atual, `4ee22b40` | 1 517 739 / 1 232 549 / +214 222 | 1 307 314 / +211 062 |
| Diferença atribuída ao PR 611 (pai → merge) | +5 129 no total / **+5 011** na linha | +5 199 na linha |
| Diferença de outros PRs depois (merge → main) | +302 no total / +311 na linha | +304 na linha |

As bases são 1 018 327 B (offline desligado, o build do `bun run build`) e 1 096 252 B (ligado, o build do e2e-real).

### Linha por linha, runtime offline desligado

| Linha | Pai `9ce39451` | Merge `514923cb` | `main` `4ee22b40` |
| --- | ---: | ---: | ---: |
| Fontes | 52 528 | 52 528 | 52 528 |
| Primitivos do Base UI | 92 504 | 92 631 | 92 617 |
| Infraestrutura de interface | 35 012 | 35 179 | 35 155 |
| Tela e o resto | 1 192 215 | 1 197 059 | 1 197 394 |
| Gráficos | 57 235 | 57 234 | 57 236 |
| Movimento | 49 640 | 49 638 | 49 639 |
| Calendário | 22 991 | 22 988 | 22 988 |
| Mapa | 10 183 | 10 180 | 10 182 |

### Os 10 maiores arquivos (gzip), runtime offline desligado

`main` `4ee22b40`:

| # | Arquivo | Bruto (B) | Gzip (B) |
| --- | --- | ---: | ---: |
| 1 | `assets/opfs-worker-accoEoax-B2IN8tCs.js` | 1 698 634 | 699 309 |
| 2 | `assets/index-Dd5DLOdh.js` | 456 261 | 143 877 |
| 3 | `assets/catalog-shared-jslla1Mq.js` | 246 047 | 81 141 |
| 4 | `assets/app-core-CCtz26VO.js` | 264 717 | 76 804 |
| 5 | `assets/charts-CNyyNyL8.js` | 175 334 | 57 236 |
| 6 | `assets/motion-Y2xdEVVG.js` | 150 946 | 49 639 |
| 7 | `assets/geist-latin-wght-normal-BgDaEnEv.woff2` | 29 400 | 29 400 |
| 8 | `assets/products-page-D7ACX3p2.js` | 81 670 | 25 275 |
| 9 | `assets/sale-page-DmYaDZ3d.js` | 73 405 | 24 932 |
| 10 | `assets/geist-mono-latin-wght-normal-XN7g48iV.woff2` | 23 128 | 23 128 |

Pai do merge, `9ce39451`:

| # | Arquivo | Bruto (B) | Gzip (B) |
| --- | --- | ---: | ---: |
| 1 | `assets/opfs-worker-accoEoax-B2IN8tCs.js` | 1 698 634 | 699 309 |
| 2 | `assets/index-eDH3btp-.js` | 440 905 | 138 852 |
| 3 | `assets/catalog-shared-DQA-ky6Z.js` | 246 047 | 81 156 |
| 4 | `assets/app-core-DFpGt6z_.js` | 264 429 | 76 710 |
| 5 | `assets/charts-B1HMKqI9.js` | 175 334 | 57 235 |
| 6 | `assets/motion-DsU8YIy0.js` | 150 946 | 49 640 |
| 7 | `assets/geist-latin-wght-normal-BgDaEnEv.woff2` | 29 400 | 29 400 |
| 8 | `assets/products-page-BW3pTbuD.js` | 82 156 | 25 361 |
| 9 | `assets/sale-page-DVNVsCCa.js` | 72 315 | 24 623 |
| 10 | `assets/geist-mono-latin-wght-normal-XN7g48iV.woff2` | 23 128 | 23 128 |

Merge do PR 611, `514923cb`: a mesma lista de 10 arquivos; `index-B8la3P-P.js` 143 883 B, `catalog-shared-oVycwSMh.js` 81 143 B, `app-core-D8bPiN5L.js` 76 801 B, `charts-CrZyMAf-.js` 57 234 B, `motion-CgfjTUy3.js` 49 638 B, `products-page-qnqvzeCJ.js` 25 277 B, `sale-page-BQerS0nH.js` 24 808 B; os dois `opfs-worker` e fontes iguais.

Com o runtime offline ligado (`main`), a lista muda só no segundo lugar: `index-ChDdluWt.js` 223 343 B (768 236 B brutos), por trazer o runtime offline no chunk de entrada; o resto repete a de cima. O `opfs-worker` (699 309 B, 46 % do precache) é o maior arquivo em todas as medidas e tem o mesmo tamanho desde o piso `8c2ef580`.

## 3. O que o PR 611 custa, arquivo a arquivo (pai → merge, desligado)

| Chunk (nome lógico) | Antes | Depois | Diferença |
| --- | ---: | ---: | ---: |
| `index.js` (entrada) | 138 852 | 143 883 | +5 031 |
| `sale-page.js` | 24 623 | 24 808 | +185 |
| `sale-redo-storage.js` | 2 741 | 2 847 | +106 |
| `app-core.js` | 76 710 | 76 801 | +91 |
| `products-page.js` | 25 361 | 25 277 | −84 |
| `sale-detail-page.js` | 6 144 | 6 080 | −64 |
| Outros 68 chunks que mudaram (soma) | | | −136 |
| **Total do precache** | 1 512 308 | 1 517 437 | **+5 129** |

O PR trocou arquivos já existentes (96 antes e depois): não criou chunk. A diferença por arquivo (tabela acima) é o que o gzip de cada chunk cresceu; ela não diz de qual módulo veio. O perfil por módulo, abaixo, diz.

### Perfil por módulo do chunk de entrada (pai → merge)

Medido nos mesmos dois commits, com os mesmos builds (o `PRECACHE-GROWTH` impresso pelo build com o plugin de medida é igual ao da tabela: +208 900 B e +213 911 B). Mede-se o tamanho que o Rolldown renderiza por módulo no chunk (`chunk.modules[id].renderedLength`, lido no `generateBundle`); não é gzip, e a soma por chunk é maior que o arquivo final porque a medida é anterior à minificação. Serve para dizer quais módulos entraram, não para dar bytes de gzip por módulo.

| Módulo (chunk de entrada, `index.js`) | Pai | Merge | Diferença (B renderizados) |
| --- | ---: | ---: | ---: |
| `catalog/thumbnail-queue.ts` | não está | 6 035 | +6 035 |
| `catalog/product-thumbnail.tsx` | não está | 4 521 | +4 521 |
| `catalog/thumbnail-cache.ts` | não está | 4 487 | +4 487 |
| `offline/thumbnail-store.ts` | 830 | 5 294 | +4 464 |
| `catalog/thumbnail-transport.ts` | não está | 3 339 | +3 339 |
| `packages/domain/src/catalog/media.ts` | não está | 2 446 | +2 446 |
| `ui/thumbnail.tsx` | não está | 1 490 | +1 490 |
| `catalog/media-thumbnail-scope.tsx` | não está | 541 | +541 |
| `lib/media-thumbs-flag.ts` | não está | 262 | +262 |
| `app-shell/app-shell.tsx` e `offline/outbox/indexeddb-storage.ts` | | | +138 |
| **Chunk de entrada** | 1 505 998 | 1 533 721 | **+27 723** |

- **O chunk de entrada cresce por inteiro com o carregador de miniaturas** (99,5 % dos bytes renderizados novos): fila, cache em disco, transporte, armazenamento local, o provedor `product-thumbnail` e o componente de interface. Entra no chunk de entrada porque o `app-shell.tsx` importa `MediaThumbnailScope`, que importa `ThumbnailProvider` de `product-thumbnail.tsx` (cadeia lida no código de `514923cb`). O `thumbnail-store` já estava na entrada no pai (830 B), por `logout-purge.ts` e `outbox-store.ts`, e o `product-thumbnail` estar na entrada, e não só nas telas de Produtos e Venda, é o provedor no shell, que vai no build com a flag ligada ou desligada.
- **`current-organization` não está no chunk de entrada.** Ele e o `current-organization-model` ficam no `app-core.js` (grupo `APP_CORE` de `apps/web/vite.config.ts`); crescem +704 B renderizados (de +782 B do `app-core.js`, +91 B de gzip). `media-thumbs-flag.ts` está na entrada, com 262 B renderizados.
- **A Venda não está no chunk de entrada.** O seletor de variantes cresce no `sale-page.js` (+729 B renderizados) e no `sale-redo-storage.js` (+454 B); `products-page.js` encolhe (−1 260 B renderizados, −84 B de gzip); a causa dessa queda não foi investigada.
- Ficou sem medida o gzip por módulo: o +5 031 B de gzip do chunk de entrada é um número só, e a fração de cada módulo dele não foi separada. A proporção por bytes renderizados é o que sustenta "quase tudo é o carregador de miniaturas".

## 4. De onde vêm os +214 222 B, e a referência de +44 000 B

### A linha do resto por dia (último commit da `main` de cada dia, desligado)

| Dia | Commit | Linha do resto | Crescimento | Passo do dia |
| --- | --- | ---: | ---: | ---: |
| 21/10 | `bb258b43` | 1 049 212 | +30 885 | |
| 22/10 | `f8e232af` | 1 060 854 | +42 527 | +11 642 |
| 23/10 | `8462d080` | 1 063 202 | +44 875 | +2 348 |
| 24/10 | `31e0c8d7` | 1 084 261 | +65 934 | +21 059 |
| 25/10 | `8f9f922f` | 1 113 868 | +95 541 | +29 607 |
| 26/10 | `208ec3c7` | 1 153 027 | +134 700 | +39 159 |
| 27/10 | `cf93e4e3` | 1 156 531 | +138 204 | +3 504 |
| 28/10 | `12a68cc2` | 1 161 827 | +143 500 | +5 296 |
| 29/10 | `f64b3466` | 1 171 786 | +153 459 | +9 959 |
| 30/10 | `482e70b2` | 1 206 613 | +188 286 | +34 827 |
| 31/10 | `af475739` | 1 207 733 | +189 406 | +1 120 |
| 01/11 | `d93ab6bf` | 1 208 307 | +189 980 | +574 |
| 02/11 | `903fa1c4` | 1 208 840 | +190 513 | +533 |
| 03/11 | `3d205ee3` | 1 215 570 | +197 243 | +6 730 |
| 04/11 | `206627a3` | 1 224 970 | +206 643 | +9 400 |
| 05/11 | `9ce39451` (pai do PR 611) | 1 227 227 | +208 900 | +2 257 |
| 05/11 | `514923cb` (PR 611) | 1 232 238 | +213 911 | **+5 011** |
| 05/11 | `4ee22b40` (`main`) | 1 232 549 | +214 222 | +311 |

A linha passou de +44 000 B no fim de 23/10 (+44 875 B) e da marca de +80 000 B entre 24/10 e 25/10; a regra "só avisa" entrou no meio disso, em três emendas do ADR 0103: a referência de +44 000 B passou a só avisar em 23/10, a marca de +80 000 B deixou de reprovar em 24/10, e `BUDGET_MODE` (`"warn"` para todas as linhas de tamanho) veio em 25/10. Os quatro degraus diários de 20 KB ou mais foram 24/10, 25/10, 26/10 e 30/10 (juntos, +124 652 B dos +214 222 B).

### Quem puxou, por arquivo (do `8c2ef580` até a `main`, linha do resto e linhas à parte)

| Chunk (nome lógico) | Em `8c2ef580` | Na `main` | Diferença | Leitura provável (pelos títulos dos PRs do dia, não medida PR a PR) |
| --- | ---: | ---: | ---: | --- |
| `catalog-shared.js` | 0 | 81 141 | +81 141 | Base UI e telas de catálogo (os primitivos contam à parte) |
| `app-core.js` | 0 | 76 804 | +76 804 | código partilhado das telas (chunk novo, sem equivalente no piso) |
| `charts.js` | 0 | 57 236 | +57 236 | gráficos do Bklit (24/10 e 25/10), **linha à parte** |
| `index.js` (entrada) | 87 374 | 143 877 | +56 503 | shell v5.1 a v7, Início, menu, rotas |
| `motion.js` | 0 | 49 639 | +49 639 | `motion` (25/10), **linha à parte** |
| `leave-browser.js` | 36 912 | 0 | −36 912 | removido (a tela antiga) |
| fontes Geist | 0 | 52 528 | +52 528 | **linha à parte** |
| `calendar.js` | 0 | 22 988 | +22 988 | seletores de data (25/10), **linha à parte** |
| `index.css` | 4 157 | 23 122 | +18 965 | Tailwind 4 e os dois temas |
| `sale-page.js` | 9 911 | 24 932 | +15 021 | Venda |
| `home-page.js` | 0 | 14 443 | +14 443 | Início |
| `subscription-page.js` | 0 | 13 048 | +13 048 | Assinatura |
| `heatmap.js` | 0 | 10 182 | +10 182 | Ritmo de vendas, **linha à parte** |
| `products-page.js` | 15 405 | 25 275 | +9 870 | Produtos |

(Nomes lógicos: o hash do arquivo foi tirado para comparar o mesmo chunk entre builds.)

Em resumo, pelos nomes dos chunks e pelos títulos dos PRs de cada dia (leitura, não perfil por PR): a linha subiu com **funcionalidades novas e a migração de telas para a base nova** — Início v7 (sparkline, mapa, KPI), Assinatura, Resultado v2, Despesas em Dialog, Histórico com barra de filtros, seletores de data, encerramento de loja, Seus dados, Ajuda — e com a infraestrutura de interface. O `app-core` (sem equivalente no piso) provavelmente absorveu código que sumiu de outros chunks (`orpc` −6 424 B e `sale-form-model` −8 291 B entre o piso e a `main`). O maior degrau diário foi de +39 KB (26/10), somando vários PRs do dia; o PR 611 não está entre os grandes.

### Referência de +44 000 B: de onde vem e o que sobrou dela

Origem, no [ADR 0103](../adr/0103-base-de-componentes-shadcn-base-ui-e-tailwind-4.md), seção 4: "Resto: +40 KB gzip" sobre o precache antes da base, para Tailwind, tokens e CSS dos dois temas, com a regra de que cada PR de tela não aumenta o resto em líquido ("o zero líquido vale para o código e o CSS da tela"). O teto passou por 40, 46, 47, 48, 50, 44 e 44,5 KB (exceções do shell v5.1, da F7, do crescimento da `main`, do lote 6 e do zod), e voltou a +44 000 B como **referência que só avisa** (emendas de 23/10 a 25/10).

Por que ela deixou de servir:

- **A regra de zero líquido por tela não se manteve.** O teto de +40 KB foi pensado para Tailwind, tokens e CSS, com cada tela neutra; a própria emenda do lote 6 já registra que "o resto do crescimento é JS das telas". Hoje a linha contém o JS de todas as telas migradas e a infraestrutura de interface, e os 214 KB são 16 dias de produto, de 20/10 a 05/11, sem um único PR a explicar.
- **O excedente que o PR cita não é do PR.** Cada build imprime "over by 169 911 B" porque compara com um piso de 20/10; o PR 611 custa 5 011 B desse número. Quem revisa precisa do delta contra a `main`, que o build não imprime.
- **O texto já diz que é marca, não teto** (`BUDGET_MODE` `"warn"` até a etapa de corte). A referência só volta a ter função quando a etapa de corte fixar o teto firme (ADR 0103, emenda de 23/10/2026, que registra a etapa de corte, e as de 24/10 e 25/10).
- **A linha do resto exclui por desenho seis linhas que não existiam no piso.** A baseline é o total de 20/10, quando fontes, primitivos e os quatro chunks de carga sob demanda valiam zero; hoje essas seis linhas somam 285 190 B e ficam fora do número impresso (seção 1). O crescimento total do precache é +499 412 B, não +214 222 B.

## 5. Proposta (não aplicada aqui)

1. **Imprimir o delta contra a base do PR no build, além de contra a baseline**: o PR leria "+5 011 B sobre a `main` em que se apoia" em vez de "+213 911 B sobre o piso", e o revisor julgaria o que o PR de fato custa. **Caminho preferido: construir o SHA-base no mesmo job do CI** (o SHA-base do PR, por `github.event.pull_request.base.sha` ou pelo primeiro pai da ref de merge, um build do `apps/web` com o mesmo Node, de 7 a 15 s, e o delta impresso por linha ao lado do `PRECACHE-GROWTH`). Ele não envelhece, não deixa arquivo para atualizar e mede o código real da base, com o mesmo Node e o mesmo lockfile do build do PR. **Alternativa não preferida: um `precache-main.json` versionado** com os tamanhos por linha da `main`, atualizado pelo job `Push on main`. Envelhece a cada PR que entra e fica errado enquanto o job não roda, gera conflito entre PRs abertos que o regeneram, e fica atrás da `main` enquanto o job não roda. Só valeria se o segundo build custasse mais caro que o arquivo, o que 7 a 15 s não indicam. Mudar o CI não é desta medida.
2. **Somar a linha do resto, as fontes, os primitivos e os quatro chunks (gráficos, movimento, calendário e mapa) numa linha "total do precache"** no `PRECACHE-GROWTH` (hoje +499 412 B), para que o número do aviso não esconda 285 KB que moraram em outra linha.
3. **Na etapa de corte antes do go-live, partir de um teto novo e firme**, medido em cima dos 1 232 549 B (ou do total de 1 517 739 B), em vez de perseguir +44 000 B; o alvo realista de corte já conhecido (tirar `tailwind-merge`, cerca de −8 KB) não chega perto de 170 KB. O maior bloco sozinho é o `opfs-worker` (699 309 B, 46 % do precache), que não mudou desde o piso; tirá-lo do precache ou carregá-lo sob demanda mexe no offline e é decisão de produto, não desta medida.
4. **Para o PR 611**: nada a corrigir por tamanho. Ligar `MEDIA_THUMBS_ENABLED` não altera o precache (seção "Resposta curta", item 4); o chunk de entrada cresce +5 031 B de gzip (a linha do resto, +5 011 B), e o perfil por módulo (seção 3) o liga ao carregador de miniaturas que o `app-shell.tsx` importa. O `import()` desse provedor tiraria os bytes da primeira carga, mas o chunk novo continuaria no precache (o precache é tudo menos a lista de exclusões da seção 6) e o `PRECACHE-GROWTH` não encolheria, a menos que o chunk saísse do precache, o que mexe no offline e é decisão de produto. Não foi testado aqui.

## 6. Como reproduzir

Pré-requisitos: Node 24 (o gzip do orçamento só bate com o CI sob Node), `bun install --frozen-lockfile` em cada commit medido, nenhum `SENTRY_DSN` no ambiente.

```bash
export PATH=<caminho do Node 24>/bin:$PATH
for sha in 9ce39451947999636d115945ed165a7e12f12020 514923cb42ed43ab8aba682be1b5a9f6ef35f1f7 4ee22b4066b4d0844ed4ee43e0fd070fc6f2d82d; do
  git checkout --detach "$sha" && bun install --frozen-lockfile
  cd apps/web
  for runtime in off on; do
    rm -rf dist
    if [ "$runtime" = on ]; then export VITE_OFFLINE_RUNTIME_ENABLED=true; else unset VITE_OFFLINE_RUNTIME_ENABLED; fi
    LEGAL_DRAFT_BUILD=1 node node_modules/vite/bin/vite.js build 2>&1 | grep -E "PRECACHE-GROWTH|precache \(offline"
    node medir-precache.mjs dist/client > "arquivos-$sha-$runtime.json"
  done
  cd ../..
done
```

O build leva de 7 a 15 s. As linhas `PRECACHE-GROWTH` e `precache (offline runtime ...)` vêm do próprio plugin (`apps/web/pwa/precache-budget.ts`) e são as que o CI imprime. Para a lista dos 10 maiores, salve o script abaixo como `medir-precache.mjs`, dentro de `apps/web/` e sem versionar, que soma o gzip nível 9 dos arquivos que o service worker precacheia (tudo menos `.map`, `sw.js`, `_headers`, `_redirects`, `.assetsignore`, o chunk `product-import-dialog-*` e o `sentry-sdk-*`):

```js
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const root = process.argv[2];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [relative(root, join(dir, entry.name)).split(sep).join("/")]
  );
const skip =
  /\.map$|^assets\/product-import-dialog-[\w-]+\.js$|(^|\/)assets\/sentry-sdk-[\w-]+\.js$|^(sw\.js|_headers|_redirects|\.assetsignore)$/;
const all = [];
for (const file of walk(root)) {
  if (skip.test(file)) continue;
  const raw = readFileSync(join(root, file));
  const font = /\.woff2?$/.test(file);
  all.push({
    file,
    raw: raw.byteLength,
    gzip: font ? raw.byteLength : gzipSync(raw, { level: 9 }).byteLength,
  });
}
all.sort((a, b) => b.gzip - a.gzip);
console.log(
  JSON.stringify({
    files: all.length,
    total: all.reduce((sum, row) => sum + row.gzip, 0),
    top: all.slice(0, 10),
    all,
  })
);
```

As tabelas por chunk (seções 3 e 4) comparam dois desses JSON pelo nome lógico do arquivo, que é o nome sem o hash de 8 caracteres antes da extensão (`nome.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, "$1")`), somando a diferença do `gzip` de cada nome; um arquivo que só existe de um lado conta como 0 do outro. `LEGAL_DRAFT_BUILD=1` é o valor do script `build` de `apps/web/package.json`.

A soma de todos os arquivos do `8c2ef580` (`git checkout --detach 8c2ef580e35dfc5069b23d36183a204fde0f7430`, build com o mesmo comando) dá 1 018 327 B, igual à baseline do verificador. A série diária da seção 4 usa o mesmo build, só com o runtime offline desligado, no último commit de cada dia da `main` pela data do commit (`git log --first-parent --format='%ad %H' --date=short origin/main`, o primeiro de cada data), lendo a linha `rest line` do log do build.

### Perfil por módulo (seção 3)

Mesmos dois commits (`9ce39451` e `514923cb`), mesmo Node 24, sem `SENTRY_DSN`, runtime offline desligado. Salve o arquivo abaixo como `vite.config.medida.ts` dentro de `apps/web/`, sem versionar: ele reaproveita a configuração do `vite.config.ts` e acrescenta um plugin que, no `generateBundle`, grava em JSON o `renderedLength` de cada módulo de cada chunk. Rode com `PERFIL_OUT=/tmp/perfil-<rotulo> node node_modules/vite/bin/vite.js build --config vite.config.medida.ts`; sai um `/tmp/perfil-<rotulo>.client.json`.

```ts
import { writeFileSync } from "node:fs";
import base from "./vite.config";

const dump = {
  name: "medida-modulos",
  enforce: "post" as const,
  generateBundle(_o: unknown, bundle: Record<string, any>) {
    const out: Record<string, Record<string, number>> = {};
    for (const [file, chunk] of Object.entries(bundle)) {
      if (chunk.type !== "chunk") continue;
      const modules: Record<string, number> = {};
      for (const [id, info] of Object.entries<any>(chunk.modules ?? {})) {
        modules[id] = info.renderedLength;
      }
      out[file] = modules;
    }
    const name = (this as any).environment?.name ?? "x";
    writeFileSync(`${process.env.PERFIL_OUT}.${name}.json`, JSON.stringify(out));
  },
};

export default async (env: any) => {
  const cfg: any = await (base as any)(env);
  return { ...cfg, plugins: [...(cfg.plugins ?? []), dump] };
};
```

O `PRECACHE-GROWTH` impresso pelos dois builds (+208 900 B e +213 911 B) confere com o da seção 2, o que mostra que o plugin não mudou o resultado. A comparação junta os chunks pelo nome lógico (seção 6) e subtrai, módulo a módulo, o `renderedLength` do pai do do merge.

## 7. O que não foi feito

- Não mexi em código, na referência de +44 000 B, em `BUDGET_MODE` nem na baseline; as propostas da seção 5 são para decisão do Arrascaeta e do usuário.
- A série diária pega um commit por dia: o degrau de um dia não diz qual PR o causou. O de 26/10 e o de 30/10 (cerca de 39 KB e 35 KB) cobrem 19 e 30 PRs; atribuir PR a PR pede um build por commit (de 7 a 15 s cada).
- O perfil por módulo (seção 3) é em bytes renderizados do Rolldown, não em gzip: não separei o +5 031 B de gzip por módulo. Não usei `rollup-plugin-visualizer`, que seria dependência nova; o plugin de medida ficou fora do repositório.
- Não medi o `bun run build` completo nem o e2e-real; só o `vite build` do `apps/web`, que é onde o verificador roda.
- A medida é de bytes de download (gzip nível 9), não de tempo de instalação do service worker nem de uso de armazenamento.
