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

Com um id, baixa os artefatos da execução (precisa de `GITHUB_TOKEN`); com uma pasta, lê os `timings-*.json` dela. Soma a duração por arquivo, projeto e suíte (`pwa` ou `offline-poc`), contando todas as tentativas e dando cada teste ao arquivo da suíte de topo do relatório, o que o `--shard` reparte, e não ao `spec.file` onde o `test()` foi chamado (um auxiliar como `e2e/reflow.ts` cria testes de ~20 specs), e grava `ci/test-durations.json` ordenado e sem relógio, de modo que os mesmos relatórios dão sempre o mesmo arquivo. Use os relatórios de uma execução só: somar execuções diferentes soma o tempo delas.

O `ci/test-durations.json` versionado vem da execução 44819387058 do CI (head 68042d5f, 4 artefatos `playwright-timings-shard-N`, 254 linhas arquivo × projeto). Regere-o com o comando acima sobre uma execução verde mais recente quando a distribuição dos testes mudar.

## Mapa de cobertura dos e2e e seletor de specs

`e2e/coverage-map.mjs` diz que specs um diff pode quebrar; `scripts/ci-select-specs.mjs` lê a lista de arquivos do diff (argumentos ou entrada padrão) e imprime `{ "full": boolean, "specs": [...], "motivo": "..." }`. O seletor ainda não está ligado ao CI: a lista só vale como proposta até a suíte completa ser obrigatória no automerge.

```sh
git diff --name-only origin/main...HEAD | node scripts/ci-select-specs.mjs
```

Como decide, na ordem:

1. Diff vazio, ou qualquer arquivo que força a suíte toda, ou qualquer arquivo que nenhum par do mapa nomeia: `full: true` (falha segura). Forçam: `package.json`, `bun.lock`, os configs do Playwright, do Vite, do TypeScript e do Biome, `.github/`, `apps/web/src/{app-shell,lib,ui,offline,styles}/`, `apps/web/worker/`, `packages/{contracts,domain}/` e os helpers e fixtures das pastas `e2e*/` (um spec e a baseline do `ui-visual` não são helper).
2. Senão, cada arquivo escolhe os specs do primeiro par do mapa cujo glob o casa; um spec alterado entra na própria lista. Texto (`.md` de `docs/` e `doc/`, `*.md` da raiz, `.md` das skills), teste unitário de `src/` fora dos diretórios que forçam e spec apagado selecionam nenhum spec.

O mapa tem duas metades que o teste `scripts/ci-select-specs.test.mjs` confere contra o código: `SPEC_SCREENS` (as telas que cada spec abre, conferidas só contra os endereços escritos no arquivo e nos helpers dele: uma tela alcançada só por clique precisa ser declarada à mão) e `FILE_SCREENS` e `DIRECTORY_SCREENS` (as telas cujos imports alcançam o arquivo ou o diretório, conferidas contra o grafo de imports). O mesmo teste exige que todo spec que o `playwright test --list` dos três configs mostra esteja no mapa, que todo glob case um arquivo versionado e que todo spec citado exista. Spec novo: acrescente-o a `SPEC_SCREENS`. Arquivo de tela novo: sem entrada em `FILE_SCREENS` ele usa as telas do diretório, que é o lado seguro.
