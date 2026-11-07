# Bug bash do fechamento do staging (item 2.18 do checklist), com o `e2e` na pilha local do e2e-real (t886)

**Não mesclar.** Mesma ferramenta, pilha e regras do piloto da t440 ([RELATORIO.md](./RELATORIO.md)). Esta rodada parte da branch `piloto/e2e-bug-bash` com a `origin/main` de 07/11/2026 (`30f3676d`) mesclada nela. Nada mudou no CI nem na `main`, e nenhum bug foi corrigido.

O `runbook-bug-bash.md` citado na tarefa não existe no repositório nem em `~/tasks`. Segui a forma da t440: chave, segurança, modelos e relatório.

## Resumo

- **4 sessões de explore**, uma por área, em sequência: Venda, Histórico e Detalhe, Estoque e Produtos, Início e Resultado. Cada sessão teve 2 passos com Claude Sonnet 5.5.
- **Admin pulado.** A pilha local do e2e-real serve só `apps/web`. O Admin (`apps/admin`) exige o token do Cloudflare Access em toda rota (`cf-access-jwt-assertion`, `apps/admin/src/app.ts:121`), e a tarefa proíbe contornar isso.
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

**Testes dos achados:** 0 tokens. Foram 5 execuções da suíte com a fumaça, de 80 a 86 s cada, com cerca de 30 s de CPU de usuário. O maior processo das sessões ficou em cerca de 1,05 GB de RSS.

**Total: 2.167.400 tokens** (o explore, contando os lidos do cache de prompt), 43% do teto de 5 milhões.

### O que cada sessão cobriu e o que ficou de fora

- **Venda:**
  - Cobriu: carrinho com 3 itens, quantidades, os dois preços, desconto e acréscimo fixos, desconto maior que o subtotal e o Resumo em duas colunas. O explorador diz que linhas, Resumo e a conta dos ajustes bateram.
  - Ficou de fora: Trocar e Remover, a confirmação, a venda no Histórico e a baixa do estoque, porque os passos acabaram na montagem e nos ajustes.
- **Histórico e Detalhe:**
  - Cobriu: lista, contagem "3 vendas", "Total na tela" (R$ 247,20), totais do Detalhe e uma venda nova confirmada em Vender que chegou ao Histórico. Tudo bateu.
  - Ficou de fora: os filtros de Pagamento, Situação e Cliente, a busca e outros períodos.
  - Observação do explorador, que não registrou como achado: "os filtros zeram ao voltar do Detalhe". É o desenho (`DESIGN.md`, § Filtros: "o estado de filtros continua o da página, sem codec de endereço"). Sem teste.
  - "Não há linha do tempo no Detalhe": as vendas da loja não tinham cancelamento nem devolução, que é o que a linha do tempo mostra.
- **Estoque e Produtos:**
  - Cobriu: Receber, Baixar e Contar, com as validações, e o custo médio da Meia, que ficou certo.
  - Ficou de fora: Produtos (editar, arquivar, desfazer) e o custo desconhecido, porque nenhum produto da semeadura não tinha custo.
- **Início e Resultado:**
  - Cobriu: Mais vendidos, Vendas do mês e a faixa de KPIs. Receita R$ 172,30, 2 vendas, ticket R$ 86,15, resultado R$ 101,00 e margem 58,62% batem com o Histórico.
  - Ficou de fora: os "Primeiros passos", que não apareceram. É o desenho: só aparecem em loja que nunca vendeu, e toda loja da semeadura tem vendas. Testar isso pede uma loja `bb-…-vazia`.

## Achados

Todos os testes estão em `tests/fechamento/`, com a tag `bugbash`. Todos usam só locators (`fill`, `tap`, `press`, `clear`) e asserções de locator, sem `agent.act`, então não dependem do modelo e não gastam tokens. Rodaram 5 vezes; os resultados abaixo são da última, com a fumaça junto (3 falham com `ASSERTION_FAILED`, 1 passa, a fumaça passa).

| # | Área | Achado do explorador | Teste | Resultado do teste | Veredito |
|---|---|---|---|---|---|
| 1 | 3 | Custo médio exibido com 6 casas ("R$ 19,391304") (issue média) | `estoque-custo-medio.e2e.ts` | **Falha**: `ASSERTION_FAILED`, observado "R$ 16,545454" | **Confirmado** (exibição, baixa). A precisão de 6 casas é desenho; a falta das 2 casas na tela é decisão de UX |
| 2 | 1 | Contador "3 itens" ignora as quantidades 2, 5 e 1 (warning baixo) | `venda-contador-itens.e2e.ts` | **Falha**: `ASSERTION_FAILED`, "3 itens" visível | **Por desenho**: o contador conta linhas com variante escolhida |
| 3 | 4 | Com "Este ano", "1 de 7 dias sem custo" convive com "1 de 311 dias" (warning baixo) | `resultado-este-ano-dias.e2e.ts` | **Falha** (4 de 5 execuções): `ASSERTION_FAILED`, observado "· 1 de 7 dias sem custo informado" | **Por desenho**: é a leitura do mês selecionado no gráfico (novembro) |
| 4 | 1 | Valor do desconto apagado vira "R$ 15,00" (issue média) | `venda-ajuste-vazio.e2e.ts` | **Passa**: o campo fica vazio | **Falso positivo**: "15,00" é o exemplo do campo |

### 1. Custo médio com 6 casas na lista do Estoque (confirmado, exibição)

- **Onde:** `/inventory`, linha da variante, "Custo médio", e a mensagem "Recebimento registrado. … Custo médio: R$ 19,391304."
- **Passos do teste:** Receber na Camiseta básica, quantidade 5, custo unitário 10,00, Revisar e Confirmar recebimento. Depois, o valor do "Custo médio" da linha precisa casar com `R$ n,nn`.
- **Observado:** "R$ 16,545454" na última execução. Como o teste recebe na mesma loja a cada execução, o valor muda de uma para outra: 19,391304, depois 17,714285, depois 16,545454.
- **Causa:** `costText` (`apps/web/src/inventory/stock-target.ts:146`) chama `formatBrlAmount` (`apps/web/src/lib/format.ts:17`). Essa função tira só os zeros do fim e preserva as outras casas, de propósito: o teste dela espera `"12.345600"` → "R$ 12,3456".
- **O que é desenho:** o custo médio guarda até 6 casas, com half-up a cada recebimento ([ADR 0008](../../../docs/adr/0008-inventory-cost-precision.md), `docs/business-rules/inventory.md`).
- **O que não é:** a mesma tela mostra a prévia com 2 casas. "Custo médio previsto" passou a 2 casas e "aproximado" na pendência de UX E-1, já fechada. O DESIGN.md não diz quantas casas o custo médio da lista mostra. Lado a lado, a prévia diz "R$ 19,39" e o valor gravado diz "R$ 19,391304".
- **Já conhecido?** Não achei registro: nem em `ux-pendencias.md`, que só tem a E-1 da prévia, nem no DESIGN.md, nem nos testes.
- **Decisão pendente:** se a lista mostra 2 casas (com "aproximado", como a prévia) ou o valor exato. É de UX, não minha. Se for 2 casas, a mudança vale também para a mensagem do recebimento e para o "Custo médio" da linha do item na Venda (`sale-form-model.ts:869`, mesma função).

### 2. Contador "N itens" conta linhas, não unidades (por desenho)

- **Onde:** `/sales`, linha sob "Itens".
- **Passos do teste:** 3 itens (Camiseta, Boné e Meia, escolhidos na lista do combobox) com as quantidades 2, 5 e 1. O teste afirma "8 itens", como o explorador esperava.
- **Observado:** "3 itens".
- **Por que não é bug:** o código diz que N conta só as linhas com variante escolhida (`apps/web/src/sales/sale-item-editor.tsx:367`), e o DESIGN.md (§ Venda) desenha o contador junto com a escolha de cada variante.
- **Para UX, se quiser:** "itens" pode ser lido como unidades. "3 produtos" ou "3 linhas · 8 unidades" tirariam a dúvida, mas isso é decisão de texto, fora daqui.

### 3. "1 de 7 dias sem custo" com "Este ano" (por desenho)

- **Onde:** `/dashboard`, chip "Este ano", cartão "Vendas × custos por mês".
- **Passos do teste:** "Este ano", ler o total de dias no texto de apoio do gráfico ("1 de 311 dias sem custo informado") e afirmar que a leitura ao lado diz o mesmo total.
- **Observado:** "· 1 de 7 dias sem custo informado".
- **Por que não é bug:** essa linha é a leitura do mês escolhido no gráfico (o slider "Mês" fica no último mês, novembro, que tem 7 dias até hoje). `readingNote` (`apps/web/src/dashboard/result-series.ts:342`, AC-11) diz, para um mês com dias sem custo, quantos dias **daquele mês** são. O cartão de KPI "Resultado estimado" não mostrou contagem de dias nas execuções.
- **Ressalva:** uma das 5 execuções passou. Não investiguei. A hipótese é que a leitura mostra o período inteiro até o gráfico escolher o último mês, e a asserção leu antes da troca. Isso merece um olhar de quem for mexer no gráfico: um texto que troca de período sozinho também confunde quem está olhando.

### 4. Valor do ajuste apagado (falso positivo)

- **Onde:** `/sales`, "Alterar data e ajustes", "Adicionar ajuste", "Valor (R$)".
- **Passos do teste:** escolher a Camiseta, digitar 10,00, depois 500 (maior que o subtotal), apagar e afirmar `toHaveValue("")`.
- **Resultado:** o teste passa, nas 5 execuções.
- **Por que o explorador errou:** ele leu na captura o `placeholder` do campo, "15,00" em cinza (`apps/web/src/sales/sale-payment-section.tsx:182`), como se fosse um valor.

## Achados da t440, para referência

Os 2 testes de `tests/bugbash/` (t440) não rodaram nesta rodada. As correções viraram as tarefas t444 e t445.

## O que vazou ou poderia vazar

- **Antes do push:** `gitleaks detect --no-git --source apps/web/e2e-agent` e a varredura própria (segredo do run, senhas dos logins, cookies e a chave, sem imprimir valores) sobre `.e2e/`, os logs da pilha em `E2E_AGENT_STATE`, o worktree e o diff da branch. O resultado está no PR.
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
