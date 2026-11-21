# Medir o tempo do CI

`scripts/ci-timing.mjs` mostra onde os minutos do `ci.yml` vão. É Node puro, sem dependência, e usa a API REST do GitHub; mudança que mira o tempo do CI mede antes e depois com ele.

## Tempo por job

```sh
GITHUB_TOKEN=... node scripts/ci-timing.mjs [--runs 25] [--json saida.json] [--repo dono/nome]
```

Lê as últimas N execuções **verdes** (padrão 25) de `pull_request` e, à parte, de `workflow_dispatch`, no último `attempt` de cada uma. Cada job se divide em:

- **espera**: `created_at` até `started_at`, a fila por um runner;
- **preparação**: do início do job ao fim da última etapa da sequência de abertura: puxar a imagem do contêiner (`Initialize containers`), checkout, Node, Bun, cache, `bun install`, `playwright install`, o restaurar do cache do Chromium, a leitura da versão do Playwright e a conferência dela contra a tag da imagem. O salvar do cache (`Post Run actions/cache`) e uma instalação que vêm depois dos testes não contam: ficam na execução;
- **execução**: o resto.

A saída traz p50 e p95 de cada parte (interpolação linear entre postos), os minutos faturados somados (cada job arredondado para cima) e a parede da execução (início da execução, `run_started_at`, até o fim do último job). Os shards do gate de navegador entram num só grupo, "Offline browser gate", com uma tabela à parte por shard. Job pulado não entra nos percentis e custa 0 minuto.

A parede aparece duas vezes: com todas as execuções e só com as que rodaram o gate de navegador. Pull request que não o aciona (`scripts/ci-changed.mjs`) termina em bem menos tempo e puxa o p50 para baixo; a conta que importa para o tempo de espera de quem mexe no app é a segunda.

## Tempo por arquivo de teste

Com `CI` definido, as duas configs do Playwright (`playwright.pwa.config.ts` e `playwright.offline-poc.config.ts`) acrescentam o reporter `json`, que grava `apps/web/test-timings/timings-<nome>.json`. A pasta não é `test-results/`: o Playwright a esvazia no começo de cada execução, e o segundo comando do shard apagaria o arquivo do primeiro. Cada shard do gate de navegador sobe a pasta como o artefato `playwright-timings-shard-<n>` (retenção de 3 dias), pelo passo `upload-artifact` do job `offline-poc-browser-part`; esse passo só existe depois que o patch do workflow que acompanha o PR do script é aplicado ao `ci.yml`, e antes disso `--durations <id>` não acha artefato.

```sh
node scripts/ci-timing.mjs --durations <id-da-execucao | pasta> [--out ci/test-durations.json]
```

Com um id, baixa os artefatos da execução (precisa de `GITHUB_TOKEN`); com uma pasta, lê os `timings-*.json` dela. Soma a duração por arquivo, projeto e suíte (`pwa` ou `offline-poc`), contando todas as tentativas e dando cada teste ao arquivo da suíte de topo do relatório, a unidade que o plano dos shards reparte, e não ao `spec.file` onde o `test()` foi chamado (um auxiliar como `e2e/reflow.ts` cria testes de ~20 specs), e grava `ci/test-durations.json` ordenado e sem relógio, de modo que os mesmos relatórios dão sempre o mesmo arquivo. Use os relatórios de uma execução só: somar execuções diferentes soma o tempo delas.

O `ci/test-durations.json` versionado vem da execução 44835784977 do CI (head 1ed3a4ab, a última do PR que dividiu o `home.e2e.ts`, a primeira verde com os três arquivos grandes já divididos em `ui-guardrails/`, `dashboard/` e `home/`; 4 artefatos `playwright-timings-shard-N`, 274 linhas arquivo × projeto, 151 arquivos). Regere-o com o comando acima sobre uma execução verde mais recente quando a distribuição dos testes mudar: o plano dos shards lê esse arquivo.

## Reparto dos shards por tempo

O gate de navegador não usa mais o `--shard` do Playwright, que corta a lista de testes em fatias contíguas sem olhar o tempo (e põe o mesmo arquivo em dois shards). O job `shard-plan` (`Offline browser gate (plan)`) lista os testes de cada config com os mesmos projetos que os shards rodam e chama `scripts/ci-shard-plan.mjs`:

```sh
node scripts/ci-shard-plan.mjs --shards 4 --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json [--durations ci/test-durations.json] [--workers <suíte>=<n>] [--out plan.json]
node scripts/ci-shard-plan.mjs --filters plan.json --shard 2 --suite pwa
```

A unidade é o arquivo, com todos os projetos dele. O peso de um arquivo é a soma dos seus tempos nos projetos em que ele está listado, dividida pelos workers da sua config (`config.workers` do `--list`, que no CI é o mesmo número dos shards: 3 no `offline-poc`, 4 no `pwa`): no run 44835784977 a parede de cada suíte num shard foi a soma dos testes dividida por 2,85 a 2,91 com 3 workers e por 3,6 a 3,94 com 4. Os arquivos vão do mais pesado ao mais leve, cada um para o shard com menos peso até ali (LPT; empate vai para o shard de número menor). Arquivo listado sem tempo entra com a mediana dos tempos conhecidos e aparece em `untimed` no plano; arquivo do `test-durations.json` que a lista não tem mais fica de fora. A segunda forma imprime, uma por linha, os argumentos do `playwright test` do shard e da suíte: o CLI lê cada argumento como expressão regular sobre o caminho absoluto, então o filtro é ancorado na pasta de testes e no fim (`//e2e-pwa/home\.e2e\.ts$/`), e um `home.e2e.ts` solto pegaria também `dashboard-home.e2e.ts`. Suíte sem arquivo num shard não roda nele.

Para simular o plano fora do CI, rode o `--list` das duas configs com `CI=true` e passe `--workers offline-poc=3 --workers pwa=4` (a máquina local tem outro número de núcleos). Com o `test-durations.json` acima, 4 shards dão 22,0 min estimados cada (diferença de 0,1% da mediana); no mesmo run, com o `--shard`, a soma das duas suítes por shard foi de 17,8 a 29,3 min.

O job `shard-coverage` (`Offline browser gate (shard coverage)`) roda `scripts/ci-shard-coverage.mjs` depois dos shards, mesmo quando um deles falhou, e entra no agregado `Offline persistence browser gate`:

```sh
node scripts/ci-shard-coverage.mjs --plan plan.json --list offline-poc=list-offline-poc.json --list pwa=list-pwa.json --reports <pasta com playwright-timings-shard-<n>/timings-<suíte>.json>
```

Ele reprova, com uma linha que diz o arquivo ou a contagem: arquivo do `--list` fora do plano, arquivo do plano fora do `--list`, arquivo em dois shards, shard sem o `timings-<suíte>.json` de uma suíte que tinha arquivos, shard que rodou arquivo de outro, e diferença entre os testes executados (com ao menos um resultado no relatório; o pulado por modificador conta, o que a execução não alcançou não) e os do `--list`, por suíte, arquivo e projeto. O plano, as listas e os relatórios ficam nos artefatos `shard-plan` e `playwright-timings-shard-<n>` do run.

## Mapa de cobertura dos e2e e seletor de specs

`e2e/coverage-map.mjs` diz que specs um diff pode quebrar; `scripts/ci-select-specs.mjs` lê a lista de arquivos do diff (argumentos ou entrada padrão) e imprime `{ "full": boolean, "specs": [...], "motivo": "..." }`. O seletor ainda não está ligado ao CI: a lista só vale como proposta até a suíte completa ser obrigatória no automerge.

```sh
git diff --name-only origin/main...HEAD | node scripts/ci-select-specs.mjs
```

Como decide, na ordem:

1. Diff vazio, ou qualquer arquivo que força a suíte toda, ou qualquer arquivo que nenhum par do mapa nomeia: `full: true` (falha segura). Forçam: `package.json`, `bun.lock`, os configs do Playwright, do Vite, do TypeScript e do Biome, `.github/`, `apps/web/src/{app-shell,lib,ui,offline,styles}/`, `apps/web/worker/`, `packages/{contracts,domain}/` e os helpers e fixtures das pastas `e2e*/` (um spec e a baseline do `ui-visual` não são helper).
2. Senão, cada arquivo escolhe os specs do primeiro par do mapa cujo glob o casa; um spec alterado entra na própria lista. Texto (`.md` de `docs/` e `doc/`, `*.md` da raiz, `.md` das skills), teste unitário de `src/` fora dos diretórios que forçam e spec apagado selecionam nenhum spec.

O mapa tem duas metades que o teste `scripts/ci-select-specs.test.mjs` confere contra o código: `SPEC_SCREENS` (as telas que cada spec abre, conferidas só contra os endereços escritos no arquivo e nos helpers dele: uma tela alcançada só por clique precisa ser declarada à mão) e `FILE_SCREENS` e `DIRECTORY_SCREENS` (as telas cujos imports alcançam o arquivo ou o diretório, conferidas contra o grafo de imports). O mesmo teste exige que todo spec que o `playwright test --list` dos três configs mostra esteja no mapa, que todo glob case um arquivo versionado e que todo spec citado exista. Spec novo: acrescente-o a `SPEC_SCREENS`. Arquivo de tela novo: sem entrada em `FILE_SCREENS` ele usa as telas do diretório, que é o lado seguro.
