# Medir o tempo do CI

`scripts/ci-timing.mjs` mostra onde os minutos do `ci.yml` vão. É Node puro, sem dependência, e usa a API REST do GitHub; mudança que mira o tempo do CI mede antes e depois com ele.

## Tempo por job

```sh
GITHUB_TOKEN=... node scripts/ci-timing.mjs [--runs 25] [--json saida.json] [--repo dono/nome]
```

Lê as últimas N execuções **verdes** (padrão 25) de `pull_request` e, à parte, de `workflow_dispatch`, no último `attempt` de cada uma. Cada job se divide em:

- **espera**: `created_at` até `started_at`, a fila por um runner;
- **preparação**: do início do job ao fim da última etapa da sequência de abertura: puxar a imagem do contêiner (`Initialize containers`), checkout, Node, Bun, restaurar e salvar o cache do `node_modules` e do Bun (`actions/cache`, `/restore` e `/save`), o `bun install` condicional (passo `Install dependencies (cache miss)`, que roda mesmo no acerto do cache e então não faz nada), `playwright install`, o restaurar do cache do Chromium, a leitura da versão do Playwright e a conferência dela contra a tag da imagem. O `Post Run actions/cache` e uma instalação que vêm depois dos testes não contam: ficam na execução;
- **execução**: o resto.

A saída traz p50 e p95 de cada parte (interpolação linear entre postos), os minutos faturados somados (cada job arredondado para cima) e a parede da execução (início da execução, `run_started_at`, até o fim do último job). Os shards do gate de navegador entram num só grupo, "Offline browser gate", com uma tabela à parte por shard. Job pulado não entra nos percentis e custa 0 minuto.

A parede aparece duas vezes: com todas as execuções e só com as que rodaram o gate de navegador. Pull request que não o aciona (`scripts/ci-changed.mjs`) termina em bem menos tempo e puxa o p50 para baixo; a conta que importa para o tempo de espera de quem mexe no app é a segunda.

## Orçamento de tempo por job

Regra para fixar o `timeout-minutes` de cada job do `ci.yml`: o p95 da duração do job (do início ao fim, preparação mais execução, shards agrupados) × 1,3, arredondado para cima ao minuto, medido nas 25 últimas execuções verdes de `pull_request` e nas 25 de `workflow_dispatch` (vale o maior p95 dos dois eventos). Job com menos de 10 execuções em qualquer um dos dois eventos (o `Dependency audit` não roda em PR sem mudança de dependência) fica como estava, e o orçamento só desce: um aumento exige uma medida nova e a decisão de quem revisa. Com isso, uma lentidão nova derruba o job em vez de passar despercebida. A conta é feita à mão com o `--json` da medição acima; o script confere o resultado, não o calcula.

```sh
GITHUB_TOKEN=... node scripts/ci-timing.mjs --budget [--workflow caminho/do/ci.yml] [--runs 25] [--repo dono/nome]
```

Lê o `timeout-minutes` de cada job (o grupo é o `name` do job sem o sufixo `(shard n/m)`; job sem `timeout-minutes` não tem orçamento) e, por evento, lista numa tabela o job cujo p95 passou de 1/1,3 do orçamento e que passou desse limite em 2 execuções ou mais (uma execução conta uma vez, mesmo com dois shards lentos; num job sem shards, com 25 execuções, o p95 só passa do limite quando as duas mais lentas passam, então as duas condições andam juntas; num job com shards, como o `Offline browser gate` (10 amostras por execução, cerca de 250 com 25 execuções), o p95 só passa do limite com 13 amostras acima dele, o que já pede 2 execuções, e a segunda condição só segura o caso de uma amostra pequena (`--runs` baixo), em que os shards lentos de uma só execução bastariam para o p95). Sai com 1 se houver algum e com 0 se não; erro de leitura ou de API também sai com 1, mas com a mensagem no erro padrão e sem tabela. Grupo com orçamento e nenhuma execução na amostra do evento aparece numa linha "sem vigia" e não reprova. Quando acusar, a causa é uma lentidão a investigar (ou, se a carga cresceu de propósito, uma medida nova e uma decisão de subir o orçamento), não um motivo para subir o número sem olhar.

## Tempo por arquivo de teste

Com `CI` definido, as duas configs do Playwright (`playwright.pwa.config.ts` e `playwright.offline-poc.config.ts`) acrescentam o reporter `json`, que grava `apps/web/test-timings/timings-<nome>.json`. A pasta não é `test-results/`: o Playwright a esvazia no começo de cada execução, e o segundo comando do shard apagaria o arquivo do primeiro. Cada shard do gate de navegador sobe a pasta como o artefato `playwright-timings-shard-<n>` (retenção de 3 dias), pelo passo `upload-artifact` do job `offline-poc-browser-part`, e o job `shard-coverage` baixa os mesmos artefatos (`pattern: playwright-timings-shard-*`) para conferir a cobertura dos shards. Uma execução anterior ao passo não tem o artefato, e `--durations <id>` não acha nada nela.

```sh
node scripts/ci-timing.mjs --durations <id-da-execucao | pasta> [--out ci/test-durations.json]
```

Com um id, baixa os artefatos da execução (precisa de `GITHUB_TOKEN`); com uma pasta, lê os `timings-*.json` dela. Soma a duração por arquivo, projeto e suíte (`pwa` ou `offline-poc`), contando todas as tentativas e dando cada teste ao arquivo da suíte de topo do relatório, a unidade que o plano dos shards reparte, e não ao `spec.file` onde o `test()` foi chamado (um auxiliar como `e2e/reflow.ts` cria testes de ~20 specs), e grava `ci/test-durations.json` ordenado e sem relógio, de modo que os mesmos relatórios dão sempre o mesmo arquivo. Use os relatórios de uma execução só: somar execuções diferentes soma o tempo delas.

O `ci/test-durations.json` versionado vem da execução 44835784977 do CI (head 1ed3a4ab, a última do PR que dividiu o `home.e2e.ts`, a primeira verde com os três arquivos grandes já divididos em `ui-guardrails/`, `dashboard/` e `home/`; 4 artefatos `playwright-timings-shard-N`, 274 linhas arquivo × projeto, 151 arquivos). Regere-o com o comando acima sobre uma execução verde mais recente quando a distribuição dos testes mudar: o plano dos shards lê esse arquivo.

## Reparto dos shards por tempo

O gate de navegador não usa mais o `--shard` do Playwright, que corta a lista de testes em fatias contíguas sem olhar o tempo (e põe o mesmo arquivo em dois shards). O job `shard-plan` (`Offline browser gate (plan)`) lista os testes de cada config com os mesmos projetos que os shards rodam e chama `scripts/ci-shard-plan.mjs`:

```sh
node scripts/ci-shard-plan.mjs --shards 10 --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json [--durations ci/test-durations.json] [--workers <suíte>=<n>] [--out plan.json]
node scripts/ci-shard-plan.mjs --filters plan.json --shard 2 --suite pwa
```

A unidade é o arquivo, com todos os projetos dele. O peso de um arquivo é a soma dos seus tempos nos projetos em que ele está listado, dividida pelos workers da sua config (`config.workers` do `--list`, que no CI é o mesmo número dos shards: 3 no `offline-poc`, 4 no `pwa`): no run 44835784977 a parede de cada suíte num shard foi a soma dos testes dividida por 2,85 a 2,91 com 3 workers e por 3,6 a 3,94 com 4. Os arquivos vão do mais pesado ao mais leve, cada um para o shard com menos peso até ali (LPT; empate vai para o shard de número menor). Arquivo listado sem tempo entra com a mediana dos tempos conhecidos e aparece em `untimed` no plano; arquivo do `test-durations.json` que a lista não tem mais fica de fora. A segunda forma imprime, uma por linha, os argumentos do `playwright test` do shard e da suíte: o CLI lê cada argumento como expressão regular sobre o caminho absoluto, então o filtro é ancorado na pasta de testes e no fim (`//e2e-pwa/home\.e2e\.ts$/`), e um `home.e2e.ts` solto pegaria também `dashboard-home.e2e.ts`. Suíte sem arquivo num shard não roda nele.

Para simular o plano fora do CI, rode o `--list` das duas configs com `CI=true` e passe `--workers offline-poc=3 --workers pwa=4` (a máquina local tem outro número de núcleos). O número de shards é o `SHARDS` do job `shard-plan` no `ci.yml` (10); o script não fixa o K. Com o `test-durations.json` acima, a parede estimada de cada shard é a mesma em todos (diferença de até 0,3% da mediana): 22,0 min com 4 shards, 14,7 com 6, 11,0 com 8 e 8,8 com 10, sobre 88,0 min de testes divididos pelos workers. A preparação e o pé do job (checkout, cache, Chromium, envio dos artefatos, cerca de 1,5 min por shard) não entram na estimativa e se somam em cada shard. Passou-se de 8 para 10 porque o ganho do shard mais lento foi de 2,2 min (limite combinado: 1,5 min); a estimativa por K e os minutos faturados estão na descrição do PR que fez a troca. Regra para mexer no K de novo: compare o ganho do shard mais lento com o custo de 1,5 min a mais por shard nos minutos somados. No run 44835784977, com o `--shard`, a soma das duas suítes por shard foi de 17,8 a 29,3 min.

O job `shard-coverage` (`Offline browser gate (shard coverage)`) roda `scripts/ci-shard-coverage.mjs` depois dos shards, mesmo quando um deles falhou, e entra no agregado `Offline persistence browser gate`:

```sh
node scripts/ci-shard-coverage.mjs --plan plan.json --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json --reports <pasta com playwright-timings-shard-<n>/timings-<suíte>.json>
```

Se o plano tem um shard só (PR que seleciona um spec), o `download-artifact` por padrão grava o `timings-<suíte>.json` direto na pasta, sem o nível `playwright-timings-shard-<n>/`: a guarda lê esses arquivos soltos como o shard único do plano. Com mais de um shard, arquivo solto não diz de qual é e fica de fora (o relatório que falta é acusado).

Ele reprova, com uma linha que diz o arquivo ou a contagem (num PR com seleção, compara com os arquivos selecionados: [o PR roda só o selecionado](#o-pr-roda-só-o-selecionado)): arquivo do `--list` fora do plano, arquivo do plano fora do `--list`, arquivo em dois shards, shard sem o `timings-<suíte>.json` de uma suíte que tinha arquivos, shard que rodou arquivo de outro, e diferença entre os testes executados (com ao menos um resultado no relatório; o pulado por modificador conta, o que a execução não alcançou não) e os do `--list`, por suíte, arquivo e projeto. O plano, as listas e os relatórios ficam nos artefatos `shard-plan` e `playwright-timings-shard-<n>` do run.

## Mapa de cobertura dos e2e e seletor de specs

`e2e/coverage-map.mjs` diz que specs um diff pode quebrar; `scripts/ci-select-specs.mjs` lê a lista de arquivos do diff (argumentos ou entrada padrão) e imprime `{ "full": boolean, "specs": [...], "motivo": "..." }`. O job `shard-plan` o chama em todo pull request ([o PR roda só o selecionado](#o-pr-roda-só-o-selecionado)).

```sh
git diff --name-only origin/main...HEAD | node scripts/ci-select-specs.mjs
node scripts/ci-select-specs.mjs --diff HEAD^1 HEAD --out selection.json
```

A segunda forma é a do CI: lê o diff no git e sai sempre com 0 e uma seleção. `CI_FULL=true`, `workflow_dispatch`, `push`, falha do `git diff` e falha do seletor dão `full: true`.

Como decide, na ordem:

1. Diff vazio, ou qualquer arquivo que força a suíte toda, ou qualquer arquivo que nenhum par do mapa nomeia: `full: true` (falha segura). Forçam: `package.json`, `bun.lock`, os configs do Playwright, do Vite, do TypeScript e do Biome, `.github/`, `apps/web/src/{app-shell,lib,ui,offline,styles}/`, `apps/web/worker/`, `packages/{contracts,domain}/` e os helpers e fixtures das pastas `e2e*/` (um spec e a baseline do `ui-visual` não são helper).
2. Senão, cada arquivo escolhe os specs do primeiro par do mapa cujo glob o casa; um spec alterado entra na própria lista. Texto (`.md` de `docs/` e `doc/`, `*.md` da raiz, `.md` das skills), teste unitário de `src/` fora dos diretórios que forçam e spec apagado selecionam nenhum spec.

O mapa tem duas metades que o teste `scripts/ci-select-specs.test.mjs` confere contra o código: `SPEC_SCREENS` (as telas que cada spec abre, conferidas só contra os endereços escritos no arquivo e nos helpers dele: uma tela alcançada só por clique precisa ser declarada à mão) e `FILE_SCREENS` e `DIRECTORY_SCREENS` (as telas cujos imports alcançam o arquivo ou o diretório, conferidas contra o grafo de imports). O mesmo teste exige que todo spec que o `playwright test --list` dos três configs mostra esteja no mapa, que todo glob case um arquivo versionado e que todo spec citado exista. Spec novo: acrescente-o a `SPEC_SCREENS`. Arquivo de tela novo: sem entrada em `FILE_SCREENS` ele usa as telas do diretório, que é o lado seguro.

## O PR roda só o selecionado

No pull request, o job `shard-plan` faz o checkout com `fetch-depth: 2`, roda `node scripts/ci-select-specs.mjs --diff HEAD^1 HEAD --out apps/web/shard-plan/selection.json` (o commit testado contra o primeiro pai, a base do merge) e passa o arquivo ao plano: `scripts/ci-shard-plan.mjs --selection selection.json`. O plano reparte pelo tempo (LPT) só os arquivos que a seleção nomeia, pelo caminho do repositório (`apps/web/e2e/…`, `apps/web/e2e-pwa/…`), e usa no máximo um shard por arquivo, para nenhum shard subir só para não rodar nada. Os specs do `e2e-real` não entram no gate de navegador: o job `e2e-real` segue as suas próprias regras.

| Situação | O que roda no gate de navegador |
| --- | --- |
| PR cujo diff o mapa alcança | só os specs da seleção, repartidos em até 10 shards |
| PR que força a suíte toda (código compartilhado, helper de e2e, `.github/`, dependências) ou que toca caminho fora do mapa | tudo, como antes |
| `workflow_dispatch`, `inputs.full` ou etiqueta `suite-completa` (`CI_FULL=true`) | tudo |
| push na `main` | o gate não roda (como antes) |
| seleção ilegível, `git diff` ou seletor com falha | tudo (falha segura: arquivo ausente, quebrado ou de formato desconhecido é `full`) |
| seleção sem nenhum arquivo do gate (só texto, teste unitário, spec do `e2e-real` ou spec apagado) | os shards pulam de propósito |

O plano guarda a seleção (`selection`) e a pasta de cada suíte no repositório (`repoDirs`). A guarda `shard-coverage` compara com isso: todo arquivo selecionado está em exatamente um shard e todo teste dele executou; arquivo planejado que a seleção não pede, ou que o `--list` não tem, reprova; spec selecionado numa pasta de suíte que nenhuma lista tem (caminho que o plano não soube pôr, ou arquivo sem nenhum teste) reprova em vez de a seleção encolher para nada: o conserto é do spec ou do mapa. Com a etiqueta `suite-completa` (`CI_FULL=true`) a seleção é `full`, o plano leva todos os arquivos e `unlisted` fica vazio, então a guarda passa: a execução completa não tem seleção a conferir. O agregado `Offline persistence browser gate` aceita os shards pulados só quando o evento é `pull_request`, `CI_FULL` não é `true`, o plano e o `shard-coverage` passaram e o plano selecionou 0 arquivos; a regra de `CI_FULL` (só `success`) vem antes e continua valendo.

**A suíte completa antes do merge é do automerge, não do workflow.** Nada no `ci.yml` a dispara sozinho. Com a chave ligada, o PR parcial verde não basta para mesclar: o automerge dispara o `workflow_dispatch` com `full` no head atualizado com a `main` e só mescla com ele verde (a chave `SUITE-COMPLETA` do script do automerge, fora do repositório). Sem a chave ligada, o PR mescla só com a suíte parcial: não aplique o `ci.yml` desta mudança com a chave desligada.

**Forçar tudo num PR.** Ponha a etiqueta `suite-completa` antes do push (o `CI_FULL` é lido do evento do run; um run já feito não relê a etiqueta) ou dispare `Actions › CI › Run workflow` com `full` marcado.

**Guarda por endereço literal.** O mapa só sabe que um spec abre uma tela pelos endereços escritos nele (`SCREEN_ROUTES`); uma tela alcançada só por clique, sem endereço escrito, passa sem guarda. Nenhum spec está assim hoje, e não há guarda por `page.url()`: quem mescla pelo automerge é a suíte completa (fora dele, ver [ADR 0060](../adr/0060-ci-economico-em-minutos.md)), então uma seleção que erra custa uma rodada vermelha no dispatch (o tempo de uma suíte completa), e não um defeito na `main`. Se aparecer spec assim, declare a tela à mão em `SPEC_SCREENS`.

**Medida (execução local, `ci/test-durations.json`, 10 shards, o mapa e as listas da `main` de 21/11).** A "parede" é a soma dos testes de cada arquivo dividida pelos workers da suíte, somada nos shards, sem os ~1,5 min de preparo por shard.

| PR mesclado em 20/11 | Diff | Arquivos de spec | Soma das paredes | Shard mais lento |
| --- | --- | ---: | ---: | ---: |
| suíte toda | | 151 | 228,1 min | 22,8 min |
| #1218, foco do Tentar novamente (Histórico, Estoque) | 4 arquivos de `inventory/` e `sales/` | 70 | 120,0 min | 12,0 min |
| #1139, faixa sem conexão de Formas de receber | `payment-profiles/` e `DESIGN.md` | 61 | 104,1 min | 10,5 min |
| #1206, aviso de venda de ontem | `sales/sale-draft-bar` | 56 | 101,7 min | 10,4 min |

Uma tela só alcança metade da suíte: os specs que andam por todas as telas (guardas de interface, reflow, regressão visual) entram em qualquer mudança de tela. Reduzir isso é mudar o mapa, não a ligação.

## O job de gates de PostgreSQL pula quando o PR não alcança o banco

`scripts/ci-changed.mjs` imprime também `database=true|false`, a saída `database` do job `changes`. É falsa só quando todo caminho do diff está na lista `DATABASE_IRRELEVANT`: prosa (`docs/`, `doc/`, `*.md`, menos os de `.github/`) e o código de cliente de `apps/web/src/` que nenhum gate importa (fora de `server/`, `offline/`, `lib/`, `home/home-inventory.ts`, `catalog/thumbnail-*` e `pwa/update-model.ts`, que os gates, o Worker e o servidor importam; o teste `scripts/ci-changed.test.mjs` lê o grafo de imports desses pontos de partida, os `*.workerd-db.test.*` incluídos, e reprova se um deles alcançar um arquivo da lista). Todo o resto roda: `packages/db/**`, `packages/domain/**`, `apps/*/src/server/**`, `apps/web/worker/**`, `package.json`, `bun.lock`, `.github/**` e **qualquer caminho que o script não classifica** (desconhecido = roda). Lista de arquivos desconhecida (`git diff` falhou), `workflow_dispatch` e `CI_FULL=true` (etiqueta `suite-completa` ou `full` marcado) imprimem `database=true`.

Os jobs `PostgreSQL 18 gates (main)`, `PostgreSQL 18 gates (definer-hardening)` e o coletor `PostgreSQL 18 gates` (ver [os gates em dois jobs](#os-gates-de-postgresql-em-dois-jobs)) só pulam com `event_name == 'pull_request'` e `database == 'false'` (qualquer outro valor, inclusive vazio, roda); em `push` na `main`, `workflow_dispatch` e `full=true` roda sempre, e a suíte completa antes do merge roda todos os jobs. Job pulado por condição aparece como `skipped` e o GitHub o conta como satisfeito num check obrigatório: o pulo é a decisão do `changes`, não uma aprovação do job. O motivo fica no resumo do run (o passo `Why the PostgreSQL gates were skipped` do job `changes`, com o motivo e a lista de arquivos lidos) e no log do `ci-changed`. O `changes` falhar não pula o job (`needs.changes.result != 'success'` roda), como nos outros jobs condicionados.

Ensaio sem CI: com a lista de arquivos de um PR (`gh pr view <n> --json files -q '.files[].path'`), importe `classifyChanges` de `scripts/ci-changed.mjs` e leia `.database`; `CI_FULL=true node scripts/ci-changed.mjs` mostra o caso da suíte completa.

## Os gates de PostgreSQL em dois jobs

O piso do job de gates era a série: o fuzz de 240 grafos do `definer-hardening` (~45 s mais 16 a 60 s) depois da fase paralela. O `definer-hardening` roda agora no job `PostgreSQL 18 gates (definer-hardening)`, com um PostgreSQL 18 próprio e em paralelo ao `PostgreSQL 18 gates (main)`, que fica com o resto da suíte `ci` (a fase paralela em 4 cópias e as outras séries). O job `PostgreSQL 18 gates` é o coletor: verde só com os dois, e é o nome que os deploys exigem. Nada saiu: o fuzz tem os mesmos 240 grafos, nenhum timeout subiu (hoje, pela regra do `timeout-minutes` acima, `PostgreSQL 18 gates (definer-hardening)` tem 4 min e `PostgreSQL 18 gates (main)` tem 6 min) e nenhum teste foi pulado.

```sh
bun run --filter @polaris/db gates:ci                    # a suíte inteira, num job só (local e a prova de liberação em Neon; o CI roda as duas metades abaixo)
bun run --filter @polaris/db gates:ci-database           # o job principal
bun run --filter @polaris/db gates:ci-definer-hardening  # o job do definer-hardening
```

As suítes saem de `CI_SEPARATE_JOBS` (`packages/db/scripts/gate-runs.ts`): um gate entra ali para sair do job principal; gate novo em `ci` cai no principal. A guarda de `gate-runs.test.ts` lê os comandos `gates:ci*` do `ci.yml` e reprova se a união dos jobs não for exatamente a lista `ci` (gate sem job ou em dois). A primeira linha da saída do executor, `--- N gates selected (<suítes>): <nomes>`, e o resumo final listam o que cada job rodou: a união das duas listas é a lista da `ci`.

**Parede dos gates de PostgreSQL.** `node scripts/ci-timing.mjs` imprime `Parede dos gates de PostgreSQL`: do início do primeiro job `PostgreSQL 18 gates (...)` ao fim do último, sem a espera do primeiro job (a espera do segundo entra na parede; antes da divisão, o tempo do job único). Uma execução com um dos jobs cancelado entra só com o outro e subestima a parede. A espera por runner aparece na coluna `Espera` de cada job: o `ci.yml` pede cerca de 15 dos 20 jobs simultâneos do plano Free (PRX-1257a), e o job novo e o coletor entram nessa conta, então com a fila cheia o segundo job começa mais tarde e o ganho some.
