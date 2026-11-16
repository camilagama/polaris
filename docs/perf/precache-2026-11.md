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

1. **Feito em parte (t1167): `PRECACHE-DELTA`; falta o passo no `ci.yml`.** O plugin grava as medidas por linha em `apps/web/dist/precache-size.json` (ao lado de `dist/client`, fora do que se serve; num diretório de saída que não se chama `client` vai para `<nome>.precache-size.json` no diretório pai, nunca dentro dele), a mesma `measurePrecache` que imprime as linhas; `apps/web/scripts/precache-delta.ts` lê o JSON do PR e o da base (o SHA-base do evento, construído num segundo checkout, que é o que o passo do `Checks` fará quando entrar no `ci.yml`; esse passo está pendente, porque quem implementa não altera workflows) e imprime `PRECACHE-DELTA total +N B (rest +a, interface +b, …) vs base <sha8>`. O `total` do delta soma as oito linhas (fontes, primitivos, interface, resto e os quatro chunks), diferente do `total` do `PRECACHE-GROWTH`, que é só a linha do resto. Só imprime e sempre sai com 0: base que não compila, ou de antes do arquivo existir, dá `PRECACHE-DELTA indisponível (…)` e o job segue verde. Não reprova por delta nem mexe em baseline ou `BUDGET_MODE`. A proposta original, mantida abaixo como registro, era:

   **Imprimir o delta contra a base do PR no build, além de contra a baseline**: o PR leria "+5 011 B sobre a `main` em que se apoia" em vez de "+213 911 B sobre o piso", e o revisor julgaria o que o PR de fato custa. **Caminho preferido: construir o SHA-base no mesmo job do CI** (o SHA-base do PR, por `github.event.pull_request.base.sha` ou pelo primeiro pai da ref de merge, um build do `apps/web` com o mesmo Node, de 7 a 15 s, e o delta impresso por linha ao lado do `PRECACHE-GROWTH`). Ele não envelhece, não deixa arquivo para atualizar e mede o código real da base, com o mesmo Node e o mesmo lockfile do build do PR. **Alternativa não preferida: um `precache-main.json` versionado** com os tamanhos por linha da `main`, atualizado pelo job `Push on main`. Envelhece a cada PR que entra e fica errado enquanto o job não roda, gera conflito entre PRs abertos que o regeneram, e fica atrás da `main` enquanto o job não roda. Só valeria se o segundo build custasse mais caro que o arquivo, o que 7 a 15 s não indicam. Mudar o CI não é desta medida.
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

## 8. Atualização de 16/11/2026: a linha de base está velha?

Medida, sem corte e sem mudar código: o PR 943 relatou `PRECACHE-GROWTH +244245 B` sem acrescentar ativo, e a seção 4 tinha parado em +214 222 B (05/11). Mesmo método das seções 2 e 6: Node 24, sem `SENTRY_DSN`, gzip nível 9 arquivo a arquivo, `vite build` do `apps/web`. Não toquei em código, na baseline, na referência de +44 000 B nem em `BUDGET_MODE`.

### Resposta curta

1. **A `main` atual mede +243 736 B** (build desligado, `48a621ec`) e **+240 537 B** com o runtime offline ligado (`27d47199`, que depois de `48a621ec` só mudou `packages/db/scripts/verify-media-gate.ts`, então o web é o mesmo). O +244 245 B do PR 943 é +440 B sobre a base dele (`b3f92548`, que mede +243 805 B), e +509 B sobre a `main` de hoje. O PR não foi construído aqui; o +440 B é o relato dele menos a minha medida da base. O número não é do PR: é a herança do piso de 20/10.
2. **A baseline é de 20/10 e nunca foi regravada.** `REST_BASELINE_GZIP_BYTES` (1 018 327 B desligado, 1 096 252 B ligado) entrou no commit `633903f8` (20/10/2026, ADR 0103, PR 215), com a medida da `main` em `8c2ef580`; `git log -S` por cada um dos dois valores em `apps/web/pwa/precache-budget.ts` devolve só esse commit. Desde então são 27 dias e 708 commits na `main`.
3. **"Velha" no sentido de que não mede mais o custo de um PR: sim. Esquecida: não.** O ADR 0103 (seção 4, "Baseline do resto") diz que a baseline só sobe por crescimento que não é de interface, e que o PR que o causa a sobe no mesmo PR; telas migradas, CSS, primitivos e infraestrutura de interface "nunca sobem a baseline". Quase todo o crescimento é desse tipo, então nenhum PR a subiu, como a regra manda. O resultado é um número que só cresce e que já era inútil para revisão na seção 4 (+214 222 B); hoje está +29 514 B pior.
4. **Desde a medida da seção 2 (`4ee22b40`, 05/11) a linha do resto subiu +29 514 B em 11 dias** (de +214 222 B para +243 736 B), cerca de 2,7 KB por dia, contra cerca de 13 KB por dia de 20/10 a 05/11 (+214 222 B em 16 dias). O ritmo caiu, mas a conta continua só subindo. O maior passo isolado que medi por commit (só o dia 08/11) foi um PR só: o contador animado dos cartões (PR 761), **+7 099 B**; o PR 838 tirou depois o chunk `figure-counter`.
5. **Proposta (não aplicada):** a baseline não deve ser regravada agora por quem mede, e sim, se for o caso, num PR à parte, por decisão do Arrascaeta com o usuário (detalhe no fim desta seção).

### Linha por linha, `main` atual contra a medida da seção 2 (runtime offline desligado)

| Linha | `4ee22b40` (05/11) | `48a621ec` (16/11) | Diferença |
| --- | ---: | ---: | ---: |
| Fontes | 52 528 | 52 528 | 0 |
| Primitivos do Base UI | 92 617 | 94 135 | +1 518 |
| Infraestrutura de interface | 35 155 | 40 025 | +4 870 |
| Tela e o resto | 1 197 394 | 1 222 038 | +24 644 |
| **Linha do resto** (infraestrutura mais tela e o resto) | 1 232 549 | 1 262 063 | **+29 514** |
| Chunk dos gráficos | 57 236 | 57 445 | +209 |
| Chunk do movimento | 49 639 | 49 639 | 0 |
| Chunk do calendário | 22 988 | 23 192 | +204 |
| Chunk do mapa | 10 182 | 10 472 | +290 |
| Total do precache (102 arquivos contra 96) | 1 517 739 | 1 549 474 | +31 735 |

Crescimento real do precache sobre o piso de 20/10: 1 549 474 − 1 018 327 = **+531 147 B**, contra os +243 736 B que o build imprime; os 287 411 B de diferença são as seis linhas que o verificador conta à parte (fontes 52 528, primitivos 94 135, gráficos 57 445, movimento 49 639, calendário 23 192 e mapa 10 472), a mesma conta da seção 1.

Runtime offline ligado, `27d47199`: baseline 1 096 252 B, linha do resto 1 336 789 B, `PRECACHE-GROWTH` +240 537 B (primitivos 99 467 B, infraestrutura 42 139 B, tela e o resto 1 294 650 B, que são +198 398 B sobre a baseline do build ligado).

### Série da `main`, último commit de cada dia, desligado

| Dia | Commit | `PRECACHE-GROWTH` | Passo |
| --- | --- | ---: | ---: |
| 05/11 | `4ee22b40` (seção 2) | +214 222 | |
| 05/11 | `49abdda4` | +214 905 | +683 |
| 06/11 | `d2be6c4a` | +220 940 | +6 035 |
| 07/11 | `d61ba62f` | +221 367 | +427 |
| 08/11 | `9c613d1f` | +235 967 | **+14 600** |
| 09/11 | `d4cda5b7` | +238 799 | +2 832 |
| 10/11 | `d5effa64` | +240 941 | +2 142 |
| 11/11 | `5ba54df2` | +235 302 | **−5 639** |
| 12/11 | `309a2f49` | +238 913 | +3 611 |
| 13/11 | `a0a4b6e9` | +238 913 | 0 |
| 15/11 | `b3f92548` | +243 805 | +4 892 |
| 16/11 | `48a621ec` | +243 736 | −69 |

O dia 14/11 não teve commit na `main`. A linha de 16/11 é o `48a621ec`; o `27d47199`, que veio depois, só mexe num script de banco e mede igual. A coluna é o mesmo `PRECACHE-GROWTH` que o CI imprime; o `4ee22b40` reproduz byte a byte o +214 222 B da seção 2.

### O que mais somou desde a medida da seção 2

Os números por arquivo comparam os dois builds pelo nome lógico do chunk (seção 6), e um chunk que some ou aparece só muda o total quando a soma muda. Os pedaços de código trocam de chunk entre builds, então a soma de um grupo é uma leitura, não uma atribuição por PR.

| Grupo | Arquivos (gzip, `4ee22b40` → `48a621ec`) | Soma |
| --- | --- | ---: |
| Resultado e Histórico | `sale-summary-panel` +10 850, `use-period-summary` +9 855, `filter-bar` +4 634, `result-period` +1 479, `sale-history-model` −9 724, `result-cards` −8 601, `dashboard-page` −3 003, `sale-history-page` −2 626 | +2 864 |
| Produtos, Estoque e aviso de limite | `products-link-model` +7 704, `products-page` +1 813, `limit-help-model` +857, `inventory-page` +566, `stock-command-model` −6 131 | +4 809 |
| Chunk compartilhado do catálogo | `catalog-shared` 81 141 → 87 372 | +6 231 |
| Início | `home-page` 14 443 → 17 324 | +2 881 |
| CSS | `index.css` 23 122 → 25 828 | +2 706 |
| Termos e aviso legal | `legal-page` 10 390 → 12 333 | +1 943 |
| Entrada | `index` 143 877 → 145 631, `boot-retry` +890 | +2 644 |
| Despesas e Configurações | `expenses-page` +887, `expense-fields` +1 407, `settings-screen` +968 | +3 262 |

(Fora da tabela ficam 72 arquivos, a maioria de menos de 500 B, que somam +4 395 B, e os oito grupos acima somam +27 340 B: juntos fecham os +31 735 B do total, que incluem as linhas à parte.)

Por PR, onde a série por commit isolou um passo (um build por commit do dia 08/11, de `d61ba62f` até `9c613d1f`, 23 commits que tocam `apps/web`):

| PR | Commit | Passo na linha do resto |
| --- | --- | ---: |
| 761, contador animado dos cartões (L1-8) | `7da4cd2f` | **+7 099** |
| 754, recarga única da página cujo módulo de entrada não rodou | `547cc1a8` | +953 |
| 753, lista agrupada de Configurações no celular | `6fe2659f` | +1 294 |
| 747, digitar as datas no seletor de período | `8fc823d7` | +1 267 |
| 757, Money e máscara no Histórico e nas Despesas | `926031fa` | −835 |
| os demais 18 commits do dia que tocam `apps/web` | | cada um entre −28 e +548, exceto `5f6a26ca` (+2 006): o texto novo da Política de privacidade, em `apps/web/src/legal/content/`, que vai no chunk `legal-page` (+1 947 B) |

O chunk `figure-counter` (6 759 B de gzip) existia em 10/11 e não existe mais em 11/11: o PR 838 (`c686fe90`, "o número principal entra com um fade curto, sem dígitos rolando") está entre os commits desse dia, que fecha em −5 639 B. Não separei o passo do PR 838 dos demais PRs do dia. O resto do período (09/11 em diante) soma entre +2 e +5 KB por dia e é de telas: período do Início (PR 819), Esconder valores no cabeçalho (PR 818), Despesas como destino (PR 795), aviso de limite, excluir produto arquivado (PRs 906 e 916). A atribuição PR a PR só foi feita no dia 08/11; para os outros dias vale a leitura por arquivo da tabela acima.

### O que a medida diz sobre a baseline

- **O número impresso cresce por herança.** Os +243 736 B de hoje são 27 dias de produto; um PR de tela custa de −800 B a +7 KB, dezenas de vezes menos que a herança. Quem revisa pelo excedente de 199 736 B sobre a referência de +44 000 B não consegue dizer se o PR está bem.
- **Regravar a baseline não é só atualizar dois números.** Zeraria o histórico e tornaria a referência de +44 000 B comparável de novo, mas contradiz a regra do ADR 0103 de que interface nunca sobe a baseline: pede uma emenda ao ADR, com quem decide por escrito (o Arrascaeta e o usuário, que também decidem `BUDGET_MODE`). Valores candidatos, medidos hoje e não aplicados: **1 262 063 B** (desligado, `rest line` de `48a621ec`) e **1 336 789 B** (ligado, `27d47199`); como as outras linhas só contam a parte nova delas, os dois números precisariam de nova medida no commit em que o PR de atualização entrar.
- **O jeito que não envelhece é o da seção 5, item 1:** imprimir o delta contra o SHA-base do PR, no mesmo job do CI, ao lado do `PRECACHE-GROWTH`. O PR 943 leria "+440 B sobre a base" em vez de "+244 245 B sobre o piso". Script feito na t1167; o passo no `ci.yml` está pendente (seção 5, item 1).
- **A etapa de corte antes do go-live é onde a baseline e o teto devem ser fixados juntos**, como diz a seção 5, item 3; fixá-los antes, num PR à parte, só vale se a revisão está sendo prejudicada agora, e isso é decisão do Arrascaeta.

### Como reproduzir (16/11/2026)

Mesmos pré-requisitos da seção 6 (Node 24, `bun install --frozen-lockfile`, sem `SENTRY_DSN`) e o mesmo `medir-precache.mjs`. Para a `main` atual:

```bash
export PATH=<caminho do Node 24>/bin:$PATH
git checkout --detach origin/main && bun install --frozen-lockfile
cd apps/web
unset SENTRY_DSN VITE_OFFLINE_RUNTIME_ENABLED
rm -rf dist
LEGAL_DRAFT_BUILD=1 node node_modules/vite/bin/vite.js build 2>&1 | grep -E "PRECACHE-GROWTH|precache \(offline"
node medir-precache.mjs dist/client > arquivos-off.json
export VITE_OFFLINE_RUNTIME_ENABLED=true
rm -rf dist
LEGAL_DRAFT_BUILD=1 node node_modules/vite/bin/vite.js build 2>&1 | grep -E "PRECACHE-GROWTH|precache \(offline"
```

A série diária e a do dia 08/11 repetem o primeiro bloco por commit (`git log --first-parent --format='%ad %h' --date=short origin/main`, o último de cada data; para o dia 08/11, `git log --first-parent --reverse --format=%h d61ba62f..9c613d1f`, só os commits em que `git diff --quiet <commit>^1 <commit> -- apps/web/src apps/web/index.html apps/web/package.json bun.lock apps/web/vite.config.ts` falha). Cada build levou de 7 a 20 s em Node 24, com a máquina carregada; sob Bun o gzip sai maior (seção 6). A tabela por arquivo vem da diferença por nome lógico de dois `arquivos-*.json`, como na seção 6. A data de cada commit é a do commit (`%cd`, fuso de Brasília).

### O que esta seção não fez

- Não construí o PR 943: o +440 B vem da conta do relato dele contra a medida da base.
- Não atribuí PR a PR fora do dia 08/11.
- Não medi o runtime offline ligado nos commits intermediários, só no atual.
- Não mudei `precache-budget.ts`, a baseline, a referência nem `BUDGET_MODE`.
