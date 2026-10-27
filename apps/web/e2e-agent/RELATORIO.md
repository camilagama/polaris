# Piloto do `e2e` (tester-army) com bug bash na pilha local do e2e-real (t440)

**Não mesclar.** Piloto para decidir se o `e2e` (github.com/tester-army/e2e, Apache-2.0) vale para o Polaris. Nenhum spec de Playwright foi migrado, nada mudou no CI, e nenhuma dependência entrou na `main`: o pacote vive em `apps/web/e2e-agent/`, com `package.json` e `bun.lock` próprios, fora dos workspaces.

Data: 27/10/2026. Versões fixadas: `e2e` 0.21.3, `@e2e-dev/web` 0.15.3 (`playwright-core` 1.64.1, Chromium headless shell 156, revisão 1248), `ai` 7.0.155 e `@ai-sdk/anthropic` 4.0.90.

## Resumo

- **3 sessões de explore** (Vender, Produtos e estoque, Despesas e Resultado): 1 a 2 passos cada, com Claude Sonnet 5.5.
- **2 bugs confirmados**, cada um com um teste que falha com `ASSERTION_FAILED` na asserção de locator que descreve o bug:
  - (alta) o Resultado não mostra a despesa registrada na aba ao lado;
  - (baixa, texto) a mensagem de um desconto de 150% não fala do limite.
- **Custo:** cerca de **2,41 milhões de tokens**, abaixo do teto de 3 milhões. Contei todos os tokens, inclusive os lidos do cache de prompt, que são 85 a 93% do total. Pelo preço de tabela, isso dá **cerca de US$ 0,84**.
- **Cache de replay:** na 2ª execução da suíte de achados, as chamadas de `act` caíram de 14 para 1 e os tokens de 169 mil para 11,6 mil. Não zerou: 1 passo foi devolvido ao agente porque o estado final mudou (cada execução acrescenta uma despesa).
- **Recomendação:** adotar **só o explore**, como bug bash manual antes de cada liberação de fase/corte, na pilha local com dados fictícios. **Não** adotar no CI noturno por enquanto. Detalhes no fim.

## Preparação (ajuste 3 do Rodrigo)

- Instalado sem a chave: `env -u E2E_ANTHROPIC_API_KEY bun install --ignore-scripts` em `apps/web/e2e-agent/`. Nenhum pacote precisou de script de instalação.
- O passo extra foi o download do navegador do `playwright-core` 1.64.1 (Chromium 1248, ~120 MiB), também com `env -u E2E_ANTHROPIC_API_KEY`: `node node_modules/playwright-core/cli.js install chromium`.
- Também baixei o `gitleaks` 8.30.1, que não havia na máquina, do release oficial do GitHub, com o checksum conferido e sem a chave. Fica em `~/tools`, fora do repositório.
- Li `docs/security.mdx`, `telemetry.mdx` e `reference/security.mdx#outbound-connections` e conferi no código instalado:
  - `dist/telemetry/telemetry.js:99`: `E2E_TELEMETRY_DISABLED` desliga o PostHog (`eu.i.posthog.com`) em todo passo.
  - `dist/cli/update-check.js:78`: a mesma variável desliga a checagem diária em `registry.npmjs.org`, que de todo modo só roda num terminal.
  - Os outros destinos da lista só existem em comandos e integrações que o piloto não usa (`e2e login`, `models`, `feedback`, `upgrade`, `init`, Kernel, Limrun, EAS, smol, TestMu, o reporter do GitHub e `decisionFilter`).
- **Conclusão:** com `E2E_TELEMETRY_DISABLED=1`, a única saída de rede do `e2e`, além da pilha local, é a API da Anthropic. O download do navegador acontece uma vez, sem a chave.
- Ressalva 1: a pilha local tem uma saída que não é do `e2e`. O `workerd` do preview busca o `Request.cf` em `workers.cloudflare.com`, sem dado do run (runbook do e2e-real).
- Ressalva 2: confirmei pela documentação e pelo código, não por captura de rede.
- Todo comando do `e2e` rodou como `E2E_TELEMETRY_DISABLED=1 bunx e2e ...`. `ANTHROPIC_API_KEY` nunca foi definida: a chave entra só por `createAnthropic({ apiKey: process.env.E2E_ANTHROPIC_API_KEY })` em `e2e.config.ts`.

## A pilha

`pilha/com-pilha.sh` monta a pilha do e2e-real (runbook `docs/runbooks/e2e-real.md`) sem o Playwright:

1. `vite build` num diretório próprio (`dist-e2e/agente`) e `vite preview` (workerd), com o **ambiente fechado** de `previewEnvironment` (`env -i`).
2. `pilha/preparar.ts` cria o banco do run, os 7 logins por binding e as lojas fictícias:
   - uma por área (`bb-venda`, `bb-estoque`, `bb-despesas`) e duas para os testes de achado (`bb-achados-1` e `-2`);
   - cada uma tem Camiseta básica, Boné aba curva e Meia cano alto com estoque, mais uma venda de 2 camisetas;
   - os dados entram pela própria `/rpc` (`e2e-real/seed.ts`).
3. Roda o comando dado e derruba o preview.

O preview e o `preparar.ts` rodam **sem a chave** (`env -i` e `env -u`); só o comando do `e2e` a recebe.

- **PostgreSQL:** um cluster próprio e descartável, o PostgreSQL 18 do `~/pgtest` com `initdb` em `/tmp`, na porta 5442 e só no loopback. **Não** usei o `~/pgtest` da porta 5432, que é da área db (a t435 rodava em paralelo). O harness cria e apaga papéis no cluster (`polaris_pr11_runtime`), e isso poderia derrubar os gates de outra tarefa.
- **Entrada:** nem senha nem Google. Uso o cookie de sessão do `testUtils` do Better Auth, feito no Node com o segredo do run, como as fixtures do e2e-real.
  - `tests/sessoes.setup.e2e.ts` põe o cookie com `browser.setCookies` e salva a sessão (`session.save`). O explore usa `--session <loja>`.
  - O valor do cookie também está em `secrets` da config, que o `e2e` troca por `<secret:...>` em relatório e saída.
  - O modelo nunca digita credencial, então as capturas seguem ligadas.
  - Segredos do run, senhas dos logins e cookies ficam em `E2E_AGENT_STATE`, fora do repositório, com modo 0600.

## Por área

Preço de tabela por milhão de tokens: Sonnet 5.5 a US$ 2 (entrada), US$ 10 (saída) e US$ 0,20 (leitura de cache); Haiku 5.5 a US$ 0,10, US$ 0,50 e US$ 0,01. Escrita de cache a 1,25× a entrada.

| Área (sessão de explore, Sonnet 5.5) | Passos | Ações / chamadas | Tokens (lidos do cache) | Custo | Tempo (pilha inteira; explore) |
|---|---|---|---|---|---|
| (a) Vender: carrinho, desconto, pagamento e confirmação | 1 de 1 | 29 / 29 | 644,8 mil (602,7 mil) | US$ 0,25 | 1 min 58 s; 1 min 51 s |
| (b) Produtos e estoque: cadastro, variantes, preço e ajuste | 2 de 2 (1 falhou, ver "Ferramenta") | até 18 por passo / 29 | 467,7 mil (406,1 mil) | US$ 0,27 | 1 min 59 s; 1 min 53 s |
| (c) Despesas e Resultado | 2 de 2 | — / 27 | 513,4 mil (441,9 mil) | US$ 0,30 | 1 min 46 s; 1 min 40 s |

A tentativa anterior da (c) parou na 1ª chamada (`thinking.type: Field required`), com 0 tokens contados.

Testes dos achados (Haiku 5.5, com `agent.act` e asserções de locator), em 7 execuções somadas: cerca de 783 mil tokens (85 a 93% do cache) e cerca de US$ 0,02.

**Total do piloto:** 2,41 milhões de tokens (1,63 milhão no explore e 0,78 milhão nos testes), cerca de US$ 0,84.

Sobre a cobertura:

- **"40 passos":** o `--max-steps` do explore vai de 1 a 12. Os 40 do enunciado batem com o orçamento de ações e chamadas **por passo** que o guia do bug bash recomenda.
  - A calibração (1 passo, 30 ações e 30 chamadas) gastou 645 mil tokens. Ela virou a sessão da área (a).
  - Para caber no teto, as sessões (b) e (c) usaram 2 passos com até 20 ações, 16 chamadas e 28 mil tokens de entrada por chamada.
- **(a)** não chegou a "Confirmar venda": a confirmação, o Histórico e a baixa de estoque ficaram sem exploração (o próprio explorador diz isso na avaliação).
- **(b)** perdeu o passo de cadastro por erro do provedor.
- **(b)** A importação de planilha não está na `main`; não foi explorada.

## Achados

| # | Área | Achado do explorador | Veredito | Teste |
|---|---|---|---|---|
| 1 | (c) | Resultado não reflete despesas novas até clicar em Atualizar (o explorador classificou como issue alta) | **Confirmado**: o teste falha | `tests/bugbash/resultado-despesa-nova.e2e.ts` |
| 2 | (a) | Desconto de 150% mostra mensagem genérica e enganosa (warning baixo) | **Confirmado** (texto): o teste falha | `tests/bugbash/venda-desconto-150.e2e.ts` |
| 3 | (a) | "Mensagens pouco claras (… −5)", só na avaliação | Falso positivo: para −5, "os valores devem ser positivos" está certo | sem teste |
| 4 | (b) | "A lista SKU das variantes ainda mostra só Variante padrão após salvar as combinações", só na avaliação, não registrado como achado | Não verificado (orçamento) | sem teste |

### 1. O Resultado não mostra a despesa registrada na aba Despesas (confirmado)

- **Onde:** `/dashboard`, aba Despesas → aba Resultado.
- **Esperado:** ao voltar para a aba Resultado, "(−) Despesas do período (sem venda)" inclui a despesa nova.
- **Observado:** o valor de antes, até o toque em "Atualizar".
- **Prova:** `ASSERTION_FAILED` em `expect.toContainText`. O teste registra R$ 100,00 a cada execução sobre a mesma loja, por isso os pares abaixo crescem:

| Execução | Esperado | Observado |
|---|---|---|
| 1ª | "100,00" | "R$ 0,00" |
| 2ª | "300,00" | "R$ 200,00" |
| 3ª | "400,00" | "R$ 300,00" |
| 4ª | "500,00" | "R$ 400,00" |

  O passo do agente é provado antes, pela descrição da despesa visível na lista.
- **Causa provável:** `apps/web/src/dashboard/use-period-summary.ts` lê o período só quando a tela monta ou quando o período muda (`useEffect` sobre `load`). `dashboard-page.tsx` mantém o hook fora dos painéis das abas, então trocar de aba não relê, e registrar despesa não invalida a leitura.
- **Já coberto?** Não. `e2e-real/jornadas/despesa.e2e.ts` registra em `/expenses` e depois faz `page.goto("/dashboard")`, uma carga nova da tela.
- **Documentado?** Não: o DESIGN.md (§ Despesas e § Resultado) descreve o "Atualizar", não a leitura antiga ao trocar de aba.
- **Severidade:** é o mesmo fluxo que o DESIGN.md desenha (Despesas é aba do Resultado). O lojista vê "Nenhuma despesa registrada neste período" logo depois de registrar uma.

### 2. A mensagem do desconto de 150% não fala do limite (confirmado, texto)

- **Onde:** `/sales`, ajuste Desconto em Percentual (%) = 150.
- **Observado:** "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo." O valor é positivo e o tipo é desconto: a frase não explica o erro.
- **Prova:** `ASSERTION_FAILED` em `getByText(/100\s?%/)`, com 0 nós. O passo do agente é provado antes por `toHaveValue("150")` no campo.
- **Causa:** `apps/web/src/sales/sale-form-model.ts:1278` (`calculationIssue`). Todo `InvalidSaleAdjustmentError` vira a mensagem genérica, inclusive o teto de percentual do domínio (`InvalidPercentageError`, em `packages/domain/src/sales/sale-adjustments.ts`). O teto foi decidido em `docs/business-rules/sales.md`.
- **Ressalva:** "dizer 100%" é a minha leitura do esperado. O texto certo é decisão de UX ou produto.

Nenhuma correção foi feita (fora do escopo). Os dois testes têm a tag `bugbash` e falham até a correção.

## Cache de replay (mesma suíte, 2 execuções seguidas, cache apagado antes da 1ª)

| | 1ª execução | 2ª execução |
|---|---|---|
| Chamadas de `act` | 14 | 1 |
| Tokens | 169,4 mil (155,2 mil do cache) | 11,6 mil (7,9 mil do cache) |
| Custo | US$ 0,004 | US$ 0,001 |
| Duração do run | 70,7 s | 60,1 s |
| Passos de `act` | 3 sem gravação → 3 gravados | 2 reaproveitados; 1 devolvido ao agente (`end-mismatch`), regravado |

- **O replay quase zera o modelo, mas não o tempo.** O tempo é do app e do navegador (o preview com workerd), não do modelo.
- **O passo devolvido** é o que registra a despesa. A lista muda a cada execução (contagem e total), e a checagem final do replay exige que "uma contagem que nomeia o que conta" leia igual. Para zerar, o teste precisaria de uma loja nova a cada execução.
- **Antes dessa medida houve 2 rodadas descartadas,** porque o Haiku usou o **título do teste** como intenção (ver "Ferramenta").

## CPU e RAM (máquina de 2 núcleos, carga 2 a 3,4 com outra tarefa rodando)

- **Sessão de explore** (pilha inteira: `vite preview` + workerd, Chromium e o runner do `e2e`): cerca de 46 s de CPU de usuário e 6 s de sistema em cerca de 2 min de relógio, uns 43% de um núcleo. O maior processo ficou em cerca de 540 MB de RSS.
- **Suíte de 2 testes de achado:** cerca de 15 s de CPU e 3 s de sistema em cerca de 1 min. O maior processo ficou em cerca de 350 MB.
- O modelo roda fora: o custo local é o da pilha e do navegador, perto do de um spec de Playwright da pilha real.
- Medido com `/usr/bin/time -v` sobre o script, que conta os filhos que ele espera. A RAM é a do maior processo, não a soma.

## O que vazou ou poderia vazar

Varredura feita, sem imprimir valores: segredo do run, senhas dos 7 logins, cookies de sessão (inteiros e só o token) e a chave do modelo (inteira e os últimos 12 caracteres). Varri `.e2e/` (relatórios, `trace.md`, capturas, vídeos e cache de replay), os logs da pilha e o worktree inteiro. Resultado: **0 ocorrências em 2.335 arquivos**. O `gitleaks detect --no-git --source .` também não achou nada.

O que os artefatos guardam, todos fora do git (`.e2e/` está no `.gitignore`):

- **Vídeos (`--video on`) e capturas:** a tela inteira, **sem máscara** (o `e2e` só mascara campo de senha). Aqui só aparece o que é fictício: "Loja bb-…", `qa-bb-…@e2e.invalid` e os produtos da semeadura. O cookie não aparece em tela. Com dados reais, os vídeos mostrariam nomes de clientes, valores e e-mails.
- **`report.json` e `trace.md`:** a árvore de acessibilidade da tela, as URLs (com ids de organização), os valores digitados e os textos de achado.
- **`.e2e/cache/*.json` (replay):** os valores digitados, sem mudança ("Despesa QA …", "150", "100,00"). Se um dia entrar no git, revisar como código: o `e2e` avisa que o cache não é assinado e é reproduzido com as permissões de quem roda.
- **O que foi para a Anthropic:** a instrução, a árvore de acessibilidade e as capturas pedidas das telas locais, com dados fictícios. O cookie não foi: o setup roda sem modelo e o valor é `secret`.
- **Risco a vigiar:** o explore **não tem lista de origens permitidas**. O agente pode seguir um link para fora e levar os segredos do passo. Aqui a pilha é local e os links externos são só os textos legais.

## Ferramenta: o que atrapalhou

1. **Sonnet 5.5 e o thinking:** um passo da sessão (b) morreu com `MODEL_PROVIDER_FAILED`, porque a API recusou a assinatura de um bloco de thinking ("The `tools` list differs from the one this block was created with"). A documentação do `e2e` diz que trata o caso, mas não tratou.
   - Contorno em `e2e.config.ts`: `providerOptions.anthropic.thinking = { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } }`, sob o beta `thinking-binding-controls-2026-08-01`, que o provider liga sozinho. O `type` é obrigatório; sem ele a API recusa.
   - Com o contorno, a sessão (c) rodou sem erro. O `toolChoice: required` cai para `auto` com aviso, como a documentação prevê.
2. **O título do teste vira instrução para o Haiku:**
   - Com o título "…diz o limite, não a mensagem genérica", o próprio `agent.act` reprovou o passo em vez de só preencher.
   - Com "…entra no Resultado ao voltar para a aba", o agente trocou de aba por conta própria, e a verificação intermediária falhou.
   - A saída foi título neutro e "Só preencha: não avalie…" na instrução. Para quem escreve teste, isso é uma armadilha: o bug precisa ser provado pela asserção de locator, nunca pelo `act`.
3. **Profundidade por orçamento:** um passo de explore com 29 chamadas custa de 250 a 650 mil tokens. Com um teto de 3 milhões, cada área teve 1 ou 2 passos.
4. **O `json` reporter não convive com o `list`** na mesma execução; o `report.json` sai mesmo assim.

## Recomendação

**Adotar só o explore, como bug bash manual antes de cada liberação de fase ou corte, na pilha local do e2e-real com dados fictícios.** Os testes de reprodução viram specs de Playwright do e2e-real quando o bug for corrigido; não manter uma segunda suíte de `agent.act`.

**Por que sim:**

- Em cerca de US$ 0,84 e menos de 10 min de relógio de exploração, achou um bug de comportamento que a suíte de 75 specs não cobre. O explorador cruza números entre telas, e o e2e-real recarrega a página entre os passos.
- O custo por sessão (US$ 0,25 a 0,30) é baixo.
- A pilha local não muda: o `com-pilha.sh` reaproveita o harness do e2e-real.

**Por que não no CI noturno, por enquanto:**

- **Não determinístico:** o agente reprovou passos por causa do título, extrapolou a instrução e a cobertura muda de execução para execução.
- **Erro de provedor:** com o Sonnet 5.5 houve erro de provedor que o `e2e` 0.21.3 não trata.
- **Chave no CI:** pediria a chave da API no CI, e o guia do próprio `e2e` manda não dá-la a builds não confiáveis.
- **Triagem humana:** o achado só vale depois de virar teste que falha, e isso exige ler o código. É trabalho de quem escreve o teste, não de um job que roda sozinho.
- **Testes com `agent.act`:** são mais lentos e menos estáveis que os nossos specs de locator. O replay ajuda, mas o tempo é dominado pela pilha.

**Se adotar:**

- Fixar as versões e manter `E2E_TELEMETRY_DISABLED=1`.
- Manter o contorno do thinking.
- Uma loja por charter.
- Orçamento de cerca de 1 milhão de tokens por área, para chegar a 4 ou 5 passos.
- Revisar vídeos antes de compartilhar.
- Nunca apontar para staging, Google ou dados reais.

## Como reproduzir

```sh
export PATH=<node 24>/bin:$PATH E2E_AGENT_STATE=<dir fora do repo, 0700> \
  POLARIS_E2E_DATABASE_URL=postgres://<dono>@127.0.0.1:<porta>/postgres   # cluster local descartável
cd apps/web
env -u E2E_ANTHROPIC_API_KEY CI=true bun e2e-agent/pilha/preparar.ts banco
E2E_AGENT_LOJAS="bb-venda bb-estoque bb-despesas bb-achados-1 bb-achados-2" \
  e2e-agent/pilha/com-pilha.sh --construir -- sh -c 'cd e2e-agent && E2E_TELEMETRY_DISABLED=1 bunx e2e run tests/fumaca.e2e.ts'
e2e-agent/pilha/com-pilha.sh -- sh -c 'cd e2e-agent && E2E_TELEMETRY_DISABLED=1 bunx e2e explore "<objetivo>" --session bb-despesas --agent explorador --max-steps 2 --timeout 900000 --output .e2e/bugbash/despesas --video on --reporter list,markdown'
e2e-agent/pilha/com-pilha.sh -- sh -c 'cd e2e-agent && E2E_TELEMETRY_DISABLED=1 bunx e2e run tests/bugbash'
env -u E2E_ANTHROPIC_API_KEY CI=true bun e2e-agent/pilha/preparar.ts limpar
```
