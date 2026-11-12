# Bug bash do fechamento do staging (item 2.18 do checklist), com o `e2e` na pilha local do e2e-real (t886)

**Não mesclar.** Mesma ferramenta, pilha e regras do piloto da t440 ([RELATORIO.md](./RELATORIO.md)). Esta rodada parte da branch `piloto/e2e-bug-bash` com a `origin/main` de 07/11/2026 (`30f3676d`) mesclada nela. Nada mudou no CI nem na `main`, e nenhum bug foi corrigido.

O `runbook-bug-bash.md` citado na tarefa não existe no repositório nem em `~/tasks`. Segui a forma da t440: chave, segurança, modelos e relatório.

## Resumo

- **4 sessões de explore**, uma por área, em sequência: Venda, Histórico e Detalhe, Estoque e Produtos, Início e Resultado. Cada sessão teve 2 passos com Claude Sonnet 5.5.
- **Admin pulado.** A pilha local do e2e-real serve só `apps/web`. O Admin (`apps/admin`) exige o token do Cloudflare Access (`cf-access-jwt-assertion`) nas telas, em `/ui/*` e em toda a API (`apps/admin/src/app.ts:332`, `:334` e `:344`). Sem o token, responde 401 (`:256`), e sem a configuração do Access, 503. A tarefa proíbe contornar isso.
- **4 achados, 4 testes:**
  - 1 **confirmado**, de exibição: o custo médio aparece com 6 casas na lista do Estoque;
  - 2 testes **falham, mas o comportamento é o desenhado**: o contador "N itens" e a leitura do mês no gráfico do Resultado;
  - 1 **falso positivo**: o valor apagado do ajuste fica vazio.
- **Total de tokens: 2.167.400**, dentro do teto de 5 milhões. Todos foram do explore. Os testes dos achados usam só locators, sem `agent.act`, e não chamaram o modelo.

## Preparação e segurança

- **Instalação sem a chave,** como na t440:
  - `env -u E2E_ANTHROPIC_API_KEY bun install --frozen-lockfile --ignore-scripts` em `apps/web/e2e-agent/`;
  - o mesmo `env -u` no `bun install --frozen-lockfile` da raiz.
  - Nenhum pacote precisou de script de instalação. O Chromium 1248 e o `gitleaks` 8.30.1 já estavam na máquina desde a t440.
- **A chave** entra só por `createAnthropic({ apiKey: process.env.E2E_ANTHROPIC_API_KEY })` em `e2e.config.ts`. `ANTHROPIC_API_KEY` nunca foi definida.
- **Telemetria:** o `com-pilha.sh` impõe `E2E_TELEMETRY_DISABLED=1`. Build, preview e `preparar.ts` rodam sem a chave (`env -i` e `env -u`).
- **PostgreSQL:** um cluster próprio e descartável, o PostgreSQL 18 do `~/pgtest` com `initdb` em `/tmp`, na porta 5442 e só no loopback. Não usei o `~/pgtest:5432` da área db.
- **Entrada:** pelo cookie do `testUtils` (sem senha e sem Google), guardado em `E2E_AGENT_STATE`, fora do repositório e com modo 0600. O cookie também é `secret` da config.

### Mudanças na pilha desde a t440

- **Lojas:** `tests/sessoes.setup.e2e.ts` lê as lojas de `E2E_AGENT_LOJAS`, em vez de uma lista fixa. Nesta rodada: `bb-venda`, `bb-historico`, `bb-estoque`, `bb-inicio`, `bb-achados-1` e `bb-achados-2`.
- **Semeadura:** cada loja ganhou uma 2ª venda (1 boné e 3 meias), para o Histórico ter mais de uma linha.
- **Inotify:** o preview roda com `CHOKIDAR_USEPOLLING=1`. Sem isso, o miniflare morre com `EMFILE` em `~/.config/.wrangler/registry`, porque as instâncias de inotify da máquina estão esgotadas por outras tarefas.
- **Fumaça:** confere o catálogo em Produtos (`Editar Camiseta básica`). A Venda passou a abrir só com a busca de produto, sem a lista.

## Por área

Explore com `--agent explorador` (Sonnet 5.5, até 20 ações, 16 chamadas e 28 mil tokens de entrada por chamada) e `--max-steps 2`. A área 4 usou o `--agent cetico`, que confere números entre telas. Os tempos são da pilha inteira (build, preview, setup e explore) e do explore sozinho, numa máquina de 2 núcleos com outra tarefa rodando.

| Área | Loja | Passos | Ações / chamadas | Tokens (cache) | Tempo (pilha; explore) | CPU usuário | Achados |
|---|---|---|---|---|---|---|---|
| 1. Venda | `bb-venda` | 2 de 2 | 27 / 31 | 573,4 mil (85%) | 2 min 27 s; 2 min 13 s | 67 s | 2 |
| 2. Histórico e Detalhe | `bb-historico` | 2 de 2 | 25 / 29 | 488,5 mil (85%) | 2 min 22 s; 2 min 2 s | 56 s | 0 |
| 3. Estoque e Produtos | `bb-estoque` | 2 de 2 | 30 / 29 | 534,8 mil (89%) | 2 min 22 s; 2 min 2 s | 57 s | 1 |
| 4. Início e Resultado | `bb-inicio` | 2 de 2 | 24 / 30 | 570,7 mil (83%) | 3 min 8 s; 2 min 46 s | 68 s | 1 |
| 5. Admin | — | pulado (Access) | — | 0 | — | — | — |

**Testes dos achados:** 0 tokens. Foram 6 execuções da suíte com a fumaça e 3 da sonda do achado 3, de 80 a 86 s cada execução da suíte, com cerca de 30 s de CPU de usuário. O maior processo das sessões ficou em cerca de 1,05 GB de RSS.

**Total: 2.167.400 tokens** (o explore, contando os lidos do cache de prompt), 43% do teto de 5 milhões.

### O que cada sessão cobriu e o que ficou de fora

- **Venda:**
  - Cobriu: carrinho com 3 itens, quantidades, os dois preços, desconto e acréscimo fixos, desconto maior que o subtotal e o Resumo em duas colunas. O explorador diz que linhas, Resumo e a conta dos ajustes bateram.
  - Ficou de fora: Trocar e Remover, a confirmação, a venda no Histórico e a baixa do estoque, porque os passos acabaram na montagem e nos ajustes.
- **Histórico e Detalhe:**
  - Cobriu: lista, contagem "3 vendas", "Total na tela" (R$ 247,20), totais do Detalhe e uma venda nova confirmada em Vender que chegou ao Histórico. Tudo bateu.
  - Ficou de fora: os filtros de Pagamento, Situação e Cliente, a busca e outros períodos.
  - Observação do explorador, que não registrou como achado: "os filtros zeram ao voltar do Detalhe". É consequência do desenho, que o DESIGN.md não promete nem proíbe: o § Filtros diz "o estado de filtros continua o da página, sem codec de endereço". Sem teste.
  - "Não há linha do tempo no Detalhe": as vendas da loja não tinham cancelamento nem devolução, que é o que a linha do tempo mostra.
- **Estoque e Produtos:**
  - Cobriu: Receber, Baixar e Contar, com as validações, e o custo médio da Meia, que ficou certo.
  - Ficou de fora: Produtos (editar, arquivar, desfazer) e o custo desconhecido, porque todos os produtos da semeadura têm custo.
- **Início e Resultado:**
  - Cobriu: Mais vendidos, Vendas do mês e a faixa de KPIs. Receita R$ 172,30, 2 vendas, ticket R$ 86,15, resultado R$ 101,00 e margem 58,62% batem com o Histórico.
  - Ficou de fora: os "Primeiros passos", que não apareceram. É o desenho: só aparecem em loja que nunca vendeu, e toda loja da semeadura tem vendas. Testar isso pede uma loja `bb-…-vazia`.

## Achados

Todos os testes estão em `tests/fechamento/`, com a tag `bugbash`. Todos usam só locators (`fill`, `tap`, `press`, `clear`) e asserções de locator, sem `agent.act`, então não dependem do modelo e não gastam tokens. Rodaram 6 vezes; os resultados abaixo são da última, com a fumaça junto (3 falham com `ASSERTION_FAILED`, 1 passa, a fumaça passa). **A suíte `tests/fechamento` fica vermelha de propósito:** os testes 2 e 3 afirmam o que o explorador esperava, e o desenho diz outra coisa. Não é para virar spec.

| # | Área | Achado do explorador | Teste | Resultado do teste | Veredito |
|---|---|---|---|---|---|
| 1 | 3 | Custo médio exibido com 6 casas ("R$ 19,391304") (issue média) | `estoque-custo-medio.e2e.ts` | **Falha**: `ASSERTION_FAILED`, observado "R$ 15,68421" | **Confirmado só na exibição** (baixa; o explorador disse média). A precisão de 6 casas é desenho; quantas casas a tela mostra é decisão de UX |
| 2 | 1 | Contador "3 itens" ignora as quantidades 2, 5 e 1 (warning baixo) | `venda-contador-itens.e2e.ts` | **Falha**: `ASSERTION_FAILED`, "3 itens" visível | **Por desenho**: o contador conta linhas com variante escolhida, como o Histórico |
| 3 | 4 | Com "Este ano", "1 de 7 dias sem custo" convive com "1 de 311 dias" (warning baixo) | `resultado-este-ano-dias.e2e.ts` | **Falha** (5 de 6 execuções; a que passou foi corrida do teste, já corrigida): `ASSERTION_FAILED`, observado "· 1 de 7 dias sem custo informado" | **Por desenho**: é a leitura do mês selecionado no gráfico (novembro) |
| 4 | 1 | Valor do desconto apagado vira "R$ 15,00" (issue média) | `venda-ajuste-vazio.e2e.ts` | **Passa** (6 de 6): o campo fica vazio | **Falso positivo**: "15,00" é o exemplo do campo |

### 1. Custo médio com 6 casas na lista do Estoque (confirmado, exibição)

- **Onde:** `/inventory`, linha da variante, "Custo médio", e a mensagem "Recebimento registrado. … Custo médio: R$ 19,391304."
- **Passos do teste:** Receber na Camiseta básica, quantidade 5, custo unitário 10,00, Revisar e Confirmar recebimento. Depois, o valor do "Custo médio" da linha precisa casar com `R$ n,nn`.
- **Observado:** "R$ 15,68421" na última execução. Como o teste recebe na mesma loja a cada execução, o valor muda de uma para outra: 19,391304, 17,714285, 16,545454 e depois 15,68421 (o zero do fim sai, e sobram 5 casas).
- **Limite do teste:** a prova depende do estado da loja. Se a média acumulada caísse em 2 casas exatas, o teste passaria sem correção nenhuma. Ao virar spec, ele precisa de uma loja nova a cada execução.
- **Causa:** `costText` (`apps/web/src/inventory/stock-target.ts:146`) chama `formatBrlAmount` (`apps/web/src/lib/format.ts:17`). Essa função tira só os zeros do fim e preserva as outras casas, de propósito: o teste dela espera `"12.345600"` → "R$ 12,3456".
- **O que é desenho:** o custo médio guarda até 6 casas, com half-up a cada recebimento ([ADR 0008](../../../docs/adr/0008-inventory-cost-precision.md), `docs/business-rules/inventory.md`).
- **O que não é:** a mesma tela mostra a prévia com 2 casas. "Custo médio previsto" passou a 2 casas e "aproximado" na pendência de UX E-1, já fechada. O DESIGN.md não diz quantas casas o custo médio da lista mostra. Lado a lado, a prévia diz "R$ 19,39" e o valor gravado diz "R$ 19,391304".
- **Já conhecido?** Não achei registro: nem em `ux-pendencias.md`, que só tem a E-1 da prévia, nem no DESIGN.md, nem nos testes.
- **Decisão pendente:** se a lista mostra 2 casas (com "aproximado", como a prévia) ou o valor exato. É de UX, não minha. Se for 2 casas, a mudança vale também para a mensagem do recebimento e para o "Custo médio" da linha do item na Venda (`sale-form-model.ts:869`, mesma função).

### 2. Contador "N itens" conta linhas, não unidades (por desenho)

- **Onde:** `/sales`, linha sob "Itens".
- **Passos do teste:** 3 itens (Camiseta, Boné e Meia, escolhidos na lista do combobox) com as quantidades 2, 5 e 1. O teste afirma "8 itens", como o explorador esperava.
- **Observado:** "3 itens".
- **Por que não é bug:** o código diz que N conta só as linhas com variante escolhida (`apps/web/src/sales/sale-item-editor.tsx:367`). O Histórico usa a mesma conta: o "N itens" de cada venda vem de `item_count`, gravado como `command.items.length` (`packages/db/src/sale-repository.ts:535`). As duas telas concordam.
- **O que o DESIGN.md diz:** ele desenha o contador junto com a escolha de cada variante (§ Venda), mas não diz se N conta linhas ou unidades. O que sustenta o veredito é o código e a coerência entre as duas telas, não o texto do DESIGN.md.
- **Para UX, se quiser:** "itens" pode ser lido como unidades. "3 produtos" ou "3 linhas · 8 unidades" tirariam a dúvida, mas isso é decisão de texto, fora daqui.

### 3. "1 de 7 dias sem custo" com "Este ano" (por desenho)

- **Onde:** `/dashboard`, chip "Este ano", cartão "Vendas × custos por mês".
- **Passos do teste:** "Este ano", ler o total de dias no texto de apoio do gráfico ("1 de 311 dias sem custo informado") e afirmar que a leitura ao lado diz o mesmo total.
- **Observado:** "· 1 de 7 dias sem custo informado".
- **Por que não é bug:** essa linha é a leitura do mês escolhido no gráfico. O slider "Mês" fica no último mês, novembro, que tem 7 dias até hoje. `readingNote` (`apps/web/src/dashboard/result-series.ts:342`, AC-11) diz, para um mês com dias sem custo, quantos dias **daquele mês** são.
- **Sonda:** um teste temporário, só com locators e fora do commit, leu todos os textos com "dias sem custo informado" em 3 execuções. Depois de "Este ano" carregar, a tela sempre trouxe o mesmo par: "1 de janeiro a 7 de novembro. 1 de 311 dias…" e "· 1 de 7 dias…".
  - Não houve leitura intermediária do período inteiro.
  - O cartão de KPI "Resultado estimado" não trouxe contagem de dias. O `ResultFooter` só a mostra quando cabe na linha (`result-cards.tsx:101`).
- **A execução que passou** (1 de 6) foi corrida do próprio teste. Antes de o ano chegar, o texto de "Este mês" ("1 a 30 de novembro. 1 de 7 dias sem custo informado. A diferença…") casava com o mesmo regex. O teste lia o total 7 e comparava com "· 1 de 7".
  - Corrigido: o teste espera o texto que começa por "1 de janeiro a".
  - Na execução seguinte, falhou como as outras.
- **Para UX, se quiser:** "1 de 311" e "1 de 7" lado a lado, sem dizer "em novembro", confundiram o explorador. A leitura poderia nomear o mês.

### 4. Valor do ajuste apagado (falso positivo)

- **Onde:** `/sales`, "Alterar data e ajustes", "Adicionar ajuste", "Valor (R$)".
- **Passos do teste:** escolher a Camiseta, digitar 10,00, depois 500 (maior que o subtotal), apagar e afirmar `toHaveValue("")`.
- **Resultado:** o teste passa, nas 5 execuções.
- **Por que o explorador errou:** ele leu na captura o `placeholder` do campo, "15,00" em cinza (`apps/web/src/sales/sale-payment-section.tsx:182`), como se fosse um valor.

## Achados da t440, para referência

Os 2 testes de `tests/bugbash/` (t440) não rodaram nesta rodada. As correções viraram as tarefas t444 e t445.

## O que vazou ou poderia vazar

- **Antes do push:** `gitleaks detect --no-git --source apps/web/e2e-agent` não achou nada (38 MB, com `.e2e/` e `node_modules`).
- **Varredura própria:** 23 valores (segredo do run, senhas dos logins, cookies inteiros e só o token, a chave inteira e os últimos 12 caracteres), sem imprimir nenhum. Varri o worktree (com `.e2e/`: relatórios, `trace.md`, capturas, vídeos e cache), os logs da pilha em `E2E_AGENT_STATE` e o `git log -p` e o diff da branch. Resultado: **0 ocorrências em 2.759 arquivos**.
- **Artefatos fora do git** (`.e2e/` no `.gitignore`): vídeos e capturas sem máscara, `report.json` e `trace.md` com a árvore da tela e os valores digitados. Só aparecem dados fictícios: "Loja bb-…", `qa-bb-…@e2e.invalid` e os produtos da semeadura.
- **O que foi para a Anthropic:** a instrução, a árvore de acessibilidade e capturas das telas locais com dados fictícios. O cookie não foi: o setup roda sem modelo e o valor é `secret`.
- **Risco, o mesmo da t440:** o explore não tem lista de origens permitidas. Aqui os únicos links externos são os textos legais.

## Para a próxima rodada

- **Profundidade:** com 2 passos, cada sessão parou no meio da área. Com 2,8 milhões sobrando no teto, 4 passos por área caberiam.
- **Lojas por área:** dar uma loja vazia (`bb-…-vazia`) à área do Início, para os Primeiros passos, e um produto sem custo à do Estoque.
- **Testes:** só com locators eles saem de graça e não dependem do Haiku. O `agent.act` fica para o passo que o locator não alcança.

## Como reproduzir

```sh
export PATH=<node 24>/bin:$PATH E2E_AGENT_STATE=<dir fora do repo, 0700> \
  POLARIS_E2E_DATABASE_URL=postgresql://<dono>@127.0.0.1:<porta>/postgres   # cluster local descartável
cd apps/web
env -u E2E_ANTHROPIC_API_KEY CI=true bun e2e-agent/pilha/preparar.ts banco
export E2E_AGENT_LOJAS="bb-venda bb-historico bb-estoque bb-inicio bb-achados-1 bb-achados-2"
e2e-agent/pilha/com-pilha.sh -- sh -c 'cd e2e-agent && bunx e2e run tests/fumaca.e2e.ts'
e2e-agent/pilha/com-pilha.sh -- sh -c 'cd e2e-agent && bunx e2e explore "$0" --session bb-venda --agent explorador --max-steps 2 --timeout 900000 --output .e2e/bugbash/venda --video on --reporter list,markdown' "<objetivo>"
e2e-agent/pilha/com-pilha.sh -- sh -c 'cd e2e-agent && bunx e2e run tests/fumaca.e2e.ts tests/fechamento'
env -u E2E_ANTHROPIC_API_KEY CI=true bun e2e-agent/pilha/preparar.ts limpar
```

Os objetivos das 4 sessões começam por "Explore como um lojista na primeira semana e reporte qualquer coisa errada.", seguido da área, e terminam com "Limites: não encerre a organização nem exporte dados." Os textos inteiros estão no corpo do PR.

## Rodada 2 (t1104): as áreas que a t886 não cobriu

Mesma ferramenta, pilha e regras da t886. Partiu da branch do PR 707 com a `origin/main` de 12/11/2026 (`920392a3`) mesclada nela. Nenhum bug foi corrigido, nada mudou no CI nem na `main`, e **o PR continua em rascunho, com `segurar`**. Alvo: só a pilha local do e2e-real com dados fictícios (nunca o staging, o Google ou dados reais). O Admin ficou fora, como na t886 (exige o Cloudflare Access).

### Resumo

- **4 sessões de explore** (Sonnet 5.5, `--agent explorador`), uma por área, em sequência. **Total: 2.666.700 tokens**, 89% do teto de 3 milhões; o teste dos achados não chamou o modelo.
- **Passos: 3 na área 1 e 2 nas áreas 2 a 4**, e não 3 em cada uma como a tarefa pedia. Um passo custou em média 296 mil tokens, então 12 passos dariam cerca de 3,6 milhões, acima do teto. Escolhi gastar os 3 passos na confirmação da venda (a área com mais bug) e cobrir o que sobrou das outras com testes de locators, que custam 0 token.
- **Achados dos exploradores: 3** (2 na Venda, 0 em Produtos, 0 no custo desconhecido e 1 nos Primeiros passos). Com teste: **1 confirmado, 1 não reproduz e 1 falha por desenho**. Os testes extras trouxeram controles e os passos que as sessões não alcançaram.
- A suíte `tests/rodada2` fica vermelha de propósito: 4 dos 17 testes (contando as 7 sessões do setup e a fumaça) falham, e só um é bug. Não é para virar spec.

### Mudanças na pilha desde a t886

- **Lojas desta rodada:** `bb-r2-venda`, `bb-r2-produtos`, `bb-r2-estoque-semcusto`, `bb-r2-primeiros-vazia` (a loja nova, sem produto, estoque nem venda), `bb-r2-pix-vazia` e `bb-achados-1` a `bb-achados-7`, uma loja por teste que muda dados.
- **Sufixo `-semcusto`** em `pilha/preparar.ts`: a loja ganha o "Chaveiro de metal", com 10 unidades abertas por contagem a partir do zero (custo desconhecido, como manda `docs/business-rules/inventory.md`) e uma venda de 2 dele. O `-vazia` já existia.
- **PostgreSQL:** o mesmo esquema da t886, um cluster 18 descartável na porta 5442 (`initdb` em `/tmp`).

### Por área

| Área | Loja | Passos | Ações / chamadas | Tokens (cache) | Tempo do explore | Achados do explorador |
|---|---|---|---|---|---|---|
| 1. Confirmação da venda | `bb-r2-venda` | 3 de 3 | — / 46 chamadas | 912,3 mil (85%) | 2 min 49 s | 2 |
| 2. Produtos | `bb-r2-produtos` | 2 de 2 | 31 ações / 32 chamadas | 688,2 mil (86%) | 1 min 53 s | 0 |
| 3. Custo desconhecido | `bb-r2-estoque-semcusto` | 2 de 2 | 19 ações / 26 chamadas | 525,8 mil (69%) | 1 min 56 s | 0 |
| 4. Primeiros passos | `bb-r2-primeiros-vazia` | 2 de 2 | 26 ações / 28 chamadas | 540,4 mil (76%) | 2 min 20 s | 1 |
| **Total** | | 9 passos | | **2.666,7 mil** | 9 min | 3 |

Os testes (locators, sem `agent.act`) custaram 0 token. Cada execução da pilha (build, preview, semeadura, testes e explore) levou de 3 a 4 minutos.

### O que cada sessão cobriu e o que ficou de fora

- **Confirmação da venda:** montou uma venda de 2 itens, trocou um, confirmou em dinheiro, conferiu a venda no Histórico (uma vez só, total certo) e o estoque que baixou e voltou ao cancelar. **Ficou de fora:** a tela de confirmação com a hora (o explorador viu o botão "Confirmando venda…" por mais tempo que o esperado, mas a venda saiu; os testes confirmam a venda em todas as execuções, sem espera longa) e a remoção de um item.
  - **"Desfazer" da venda:** o explorador não achou, porque não existe. Uma venda confirmada só se corrige por **Cancelar venda** no Detalhe (a regra do AGENTS.md: "Corrigir por cancelamento ou devolução"). É o desenho; sem teste.
- **Produtos:** editou nome e preço da Meia (conferiu em Vender), arquivou o Boné e viu que a venda antiga manteve o Boné e o total. **Ficou de fora:** desfazer o arquivamento; coberto pelos 2 testes abaixo.
- **Custo desconhecido:** viu "Custo desconhecido" no Estoque e na venda, "Margem indeterminada" (sem NaN nem R$ 0,00) e "1 variante sem custo" no Início. **Ficou de fora:** comparar os valores em R$ entre Início e Resultado ("Esconder valores" ligado tirou as leituras), o valor em estoque e o efeito de "Informar custo" nas vendas antigas. Não coberto por teste.
- **Primeiros passos:** cadastrou a Caneca (10 unidades a R$ 10,00), vendeu 2 no Pix e leu Início e Resultado. **Ficou de fora:** se "Primeiros passos" some ou fecha 3 de 3 depois da venda, o botão Atualizar, a aba Metas e os demais links.

## Achados

Todos os testes estão em `apps/web/e2e-agent/tests/rodada2/`, com a tag `rodada2`, só com locators. Resultado da última execução, do zero, com banco novo: 17 testes, 13 passam, 4 falham.

| # | Área | Achado | Teste | Resultado | Veredito |
|---|---|---|---|---|---|
| 1 | 1 | Trocar uma variante por outra deixa os preços da anterior | `venda-trocar-preco.e2e.ts` | **Falha** (em todas as execuções): preço cobrado "49,90" no lugar de "12,50" | **Confirmado** |
| 2 | 1 | O Detalhe da venda abre com "Algo deu errado nesta tela" vindo do Histórico | `venda-detalhe-do-historico.e2e.ts` | **Passa** (em todas as execuções): confirma em dinheiro, abre o Histórico, toca a venda e o Detalhe abre | **Não reproduz** |
| 3 | 4 | Com o custo do produto informado, o Resultado diz "1 de 12 dias sem custo informado" depois de uma venda no Pix | `primeiros-passos-pix-caneca.e2e.ts`, `resultado-pix-dia-sem-custo.e2e.ts` | **Falha** (em todas as execuções com o sinal certo) | **Desenhado**, com a ressalva de texto abaixo |
| controle | 4 | A mesma venda em dinheiro | `resultado-dinheiro-dia-com-custo.e2e.ts` | **Falha** igual | mostra que a causa não é o Pix |
| controle | 3 | Venda de item sem custo diz "sem custo informado" e "Não inclui 1 item sem custo conhecido" | `resultado-custo-desconhecido-controle.e2e.ts` | Passa | prova que as duas buscas de texto enxergam o aviso |
| — | 2 | (passo não alcançado) arquivar e Desfazer; arquivar, sumir de Vender e Restaurar | `produto-arquivar-e-desfazer.e2e.ts` (2 testes) | **Passam** | Produtos sem achado |

### 1. Trocar a variante mantém o preço da anterior (confirmado)

- **Onde:** `/sales`, linha do item, "Trocar".
- **Passos do teste:** escolher a Camiseta básica (preço cobrado e de tabela "49,90"), tocar em "Trocar variante de Camiseta…", escolher a Meia cano alto (tabela R$ 12,50) e ler o preço cobrado.
- **Observado:** "49,90" nos dois campos; o explorador viu o mesmo com Boné (35,00) trocado pela Meia, antes da correção do teste. Uma Meia adicionada como item novo vem com "12,50".
- **Causa:** `handlePickVariant` (`apps/web/src/sales/sale-page.tsx:592`) aplica `withSuggestedPrices` (`apps/web/src/sales/last-prices-model.ts:165`), que só preenche o campo **vazio** ("fills only prices the operator has not typed yet"). O preço que o app mesmo sugeriu para a variante anterior já ocupa o campo, então a troca não o toca e a venda sai com o preço de outra variante.
- **Risco:** o total e o que se cobra saem com o preço errado, sem aviso. A tela diz "Trocar" sem mencionar preço, e o DESIGN.md (§ Venda) só promete que sair sem escolher volta à linha como estava.
- **Já conhecido?** Não achei registro em `ux-pendencias.md`, no DESIGN.md nem nos testes de `last-prices-model.test.ts`, que cobrem o preço digitado à mão.
- **Decisão pendente:** o que fazer com o preço que o operador digitou antes de trocar (manter? perguntar?). O que o app sugeriu e ninguém tocou deveria seguir a variante nova. É de produto e fica para a correção.

### 2. Detalhe da venda com tela de erro (não reproduz)

- **Observado pelo explorador:** "Algo deu errado nesta tela" ao tocar a venda recém confirmada no Histórico.
- **Evidência no log da pilha:** um único `client_error` com `errorClass: ChunkLoadError`, `routeId: sale-detail`, no instante do erro. O chunk da tela já tinha sido baixado (200) antes na mesma sessão. Era a primeira sessão da rodada, com a máquina em carga e o vídeo ligado.
- **Teste:** passa em todas as execuções. Sem reprodução, sem veredito de bug; o `ChunkLoadError` isolado pode ser do download perdido em carga, mas **não está provado**. Se voltar a aparecer, o primeiro lugar a olhar é o carregamento do chunk com o service worker.

### 3. "1 de 12 dias sem custo informado" com o custo do produto informado (desenhado)

- **Observado:** o Resultado diz "1 de 12 dias sem custo informado", a linha do dia 12/11 diz "sem custo informado" em Custos e no Resultado do dia, e a cadeia "Como chegamos a este resultado" mostra CMV R$ 20,00. O explorador leu isso como contradição.
- **Teste e controle:** a venda no Pix **e** a mesma venda em dinheiro, as duas em loja sem perfil de pagamento, deixam o dia como "sem custo informado". O aviso da própria tela diz o motivo: "Estimativa incompleta: 3 vendas sem taxa e nenhuma despesa registrada". Antes de afirmar a ausência do aviso do dia, os três testes esperam a linha do CMV na tela e afirmam que "Não inclui N item sem custo conhecido" **não** aparece: o custo do item é todo conhecido e o dia continua marcado. O controle da loja com o Chaveiro mostra que as duas frases aparecem quando o que falta é o custo do item.
- **Por que não é bug:** `docs/business-rules/expenses-and-results.md` diz que "custo, taxa de processamento ou taxa de antecipação desconhecidos numa venda da data deixam custos e resultado do dia nulos, nunca zero". Sem perfil de pagamento, nenhuma venda tem taxa conhecida, e o dia fica nulo (o ADR 0054 cita só a taxa desconhecida num "caso de canto"). O CMV de R$ 20,00 na cadeia é a parte conhecida.
- **Para UX, se quiser:** "sem custo informado" é o nome do dia nulo e cobre "Custos (CMV, taxas e despesas)", mas o lojista lê "custo" como o do produto. "Sem taxa informada" quando só a taxa falta tiraria a dúvida; é decisão de texto.
- **Falso passe que corrigi:** a primeira versão passou por esperar só o título "Como chegamos a este resultado", que aparece antes do gráfico, e `toBeHidden` passa sem nó. Agora espera o gráfico ("Vendas líquidas e custos por dia") antes de afirmar a ausência.

### Produtos: sem achado

A sessão não achou defeito. Como ela não chegou a desfazer o arquivamento, escrevi os testes dos dois caminhos: arquivar e **Desfazer** no próprio aviso devolve o produto à lista e a Vender; arquivar tira o produto de Vender e **Restaurar** pela aba Arquivados o devolve. Os dois passam.

## O que vazou ou poderia vazar (rodada 2)

- **Chave:** `E2E_ANTHROPIC_API_KEY` só no comando do e2e (`com-pilha.sh` já tira do build, do preview e do preparar), nunca impressa, gravada ou commitada. Instalação com `env -u`.
- **Antes do push:** `gitleaks detect --no-git --source apps/web/e2e-agent` (40,7 MB, com `.e2e/` e `node_modules`): nenhum vazamento. Varredura própria de 35 valores (a chave inteira e os últimos 12 caracteres, o segredo do run, as senhas dos logins e os cookies inteiros e só o token), sem imprimir nenhum, no worktree com `.e2e/`, nos logs desta rodada e no `git log -p` da branch: **0 ocorrências**.
- **Para a Anthropic:** a instrução, a árvore de acessibilidade e capturas de telas locais com dados fictícios (lojas `Loja bb-…`, `qa-bb-…@e2e.invalid`).

## Para a próxima rodada

- **Profundidade:** o limite foi o teto de 3 milhões, não a ferramenta: 296 mil tokens por passo.
- **Ainda sem cobertura:** "Informar custo" depois de uma venda sem custo e o valor em estoque; Remover item da venda; "Primeiros passos" depois da primeira venda; comparação de valores entre Início e Resultado (o explorador deve desligar "Esconder valores" antes).
- **Lojas:** uma loja por teste que muda dados (a Caneca já existe depois da primeira execução e o cadastro dá CONFLICT).

## Total de tokens da rodada 2: 2.666.700
