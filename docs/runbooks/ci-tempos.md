# Tempos do CI: cache de `node_modules` e checkout parcial

Nota da frente "CI rápido sem esconder falha". A regra da frente: nenhuma checagem sai, nenhum timeout sobe, nenhum `skip`. A meta de preparação (p50 de até 15 s por job, ou o melhor medido) não é motivo para tirar passo. Como medir: [medir-o-ci.md](./medir-o-ci.md).

## O que muda no `ci.yml`

Em cada um dos 8 jobs que rodam `bun install --frozen-lockfile` (`checks`, `database`, `audit`, `lighthouse`, `shard-plan`, `offline-poc-browser-part`, `offline-catalog-csp-browser`, `e2e-real`; o `shard-plan` entrou depois, com o reparto dos shards por tempo, e não tem o passo 4, porque não roda em `push`):

1. **Restaura `node_modules`** (a raiz, `apps/*/node_modules` e `packages/*/node_modules`, que é onde o Bun cria a árvore e os vínculos dos workspaces) com `actions/cache/restore`, na mesma versão fixada por SHA do `actions/cache` que o arquivo já usava (v5.1.0).
2. **Acerto exato**: o passo de `bun install` continua no lugar (e com o mesmo `id: install` no job `checks`, de que as condições dos demais passos dependem), mas só instala quando não houve acerto. Um passo pulado teria `outcome: skipped` e derrubaria em silêncio as dez checagens do `checks`; por isso a decisão fica dentro do `run`.
3. **Falta**: restaura o cache de pacotes do Bun (`~/.bun/install/cache`) como hoje, instala como hoje. Esse restore, de ~7 s, deixa de existir no acerto.
4. **Grava** `node_modules` logo depois do `bun install` (`actions/cache/save`), só em `push` na `main`. Gravar no passo final do job guardaria o que os testes escreveram em `node_modules` (caches do Vite e do Vitest); gravar a partir de pull request enche a cota de 10 GB do repositório (já em ~10,1 GB) com cópias que só a própria PR enxerga.

Chave: `node-modules-<SO>-<arquitetura>-bun<hash de .bun-version>-<hash de bun.lock, bunfig.toml e dos package.json da raiz, de apps/* e de packages/*>`, **sem `restore-keys`**: um `node_modules` de outro lockfile nunca é usado. Os `package.json` e o `bunfig.toml` entram no hash porque o `--frozen-lockfile` também reprova um `package.json` que o lockfile não acompanha (e a idade mínima de 7 dias dos pacotes vem do `bunfig.toml`); com a chave só no `bun.lock`, esse erro passaria no acerto sem que ninguém o visse. Mudou `package.json`, lockfile ou versão do Bun: a chave muda, falta o cache e o job instala como antes.

### Risco de cache velho

O conteúdo de `node_modules` é função do `bun.lock`, da versão do Bun e do SO/arquitetura (pacotes nativos por plataforma); os três estão na chave, e os `package.json` e o `bunfig.toml` fecham o resto. `trustedDependencies` está vazio, então nenhum script de instalação deixa efeito fora do que o lockfile descreve. O que a chave não cobre: um pacote **republicado** com o mesmo número no registro (o lockfile fixa a integridade, e o `bun install` normal reprovaria; no acerto não há esse confronto). O cache expira em 7 dias sem uso, e o `audit` (que só roda quando dependência muda) continua instalando do zero na PR que muda dependência.

### Checkout parcial

Só o job `changes` (`fetch-depth: 2`, para o `git diff --name-only HEAD^1 HEAD` do `scripts/ci-changed.mjs`) ganha `filter: blob:none` e `sparse-checkout: scripts`: o diff de nomes lê árvores, não conteúdo, e o job só roda esse script. Medido neste computador contra o GitHub (3 repetições): clone raso de profundidade 2, 2,3–2,5 s; com `blob:none` e só `scripts/`, 1,4 s.

Os outros jobs ficam com o checkout de hoje (profundidade 1, sem filtro): nenhum lê histórico, mas todos precisam da árvore inteira, e com `blob:none` o `git` baixa os blobs numa segunda ida ao servidor. Medido do mesmo jeito: clone raso de profundidade 1, 2,4–2,8 s; com `blob:none`, 4,1–4,4 s, mais lento. Um job que não lê histórico não ganha com o filtro quando precisa de todos os arquivos.

## Base (antes do patch)

`node scripts/ci-timing.mjs --runs 25`, 25 execuções verdes de `pull_request` do `ci.yml` em 2026-11-20 (cabeça `0f152c22` da `main`); passos lidos da API de jobs das mesmas execuções. Segundos.

| Job | Preparação p50 | Preparação p95 | Checkout p50 | Restore do cache do Bun p50 (p95) | `bun install` p50 (p95) | Contém Chromium |
| --- | ---: | ---: | ---: | ---: | ---: | :---: |
| Changed areas | 8 | 11 | 5,0 | n/a | n/a | não |
| Checks (lint, types, knip, build, tests) | 20 | 34 | 5,0 | 6,0 (9,6) | 3,0 (7,4) | não |
| Dependency audit | 18,5 | 19,8 | 2,0 | 6,5 (7,8) | 2,0 (3,8) | não |
| PostgreSQL 18 gates | 38 | 45 | 5,0 | 7,0 (9,0) | 3,0 (4,0) | não (inclui o contêiner do PostgreSQL) |
| Catalog CSP browser test | 62 | 99 | 5,0 | 7,0 (9,1) | 3,0 (4,1) | sim |
| Lighthouse (mobile, simulated) | 57,5 | 759 | 3,5 | 7,0 (9,1) | 2,0 (5,0) | sim |
| Offline browser gate (4 shards) | 60 | 110 | 4,0 | 7,0 (9,0) | 2,0 (4,0) | sim |
| e2e journeys on the real local stack | 67 | 90 | 3,0 | 7,0 (9,0) | 2,0 (3,8) | sim |

A preparação dos jobs com Chromium inclui o `playwright install` (36–40 s no p50), que é da frente CI-5a e não muda aqui. Nos demais, o que se pode mexer é o cache do Bun mais o `bun install` (~9–10 s no p50) e o checkout (~5 s).

## O que esperar

Ganho pequeno, e não garantido. O arquivo de `node_modules` tem ~313 MB comprimido (1,4 GB, ~70 mil arquivos), do tamanho do cache do Bun de hoje (326 MB); extrair isso levou 4,5 s neste computador de 2 núcleos. Trocar "restaurar o cache do Bun + `bun install`" (~10 s) por "restaurar `node_modules`" deve poupar de 1 a 3 s por job, e não leva ao p50 de 15 s nos jobs com Chromium. O que não cabe ao cache de `node_modules` (setup do job, Node, Bun, checkout) fica como está.

A primeira execução depois de mesclado só grava (em `push` na `main`); as pull requests seguintes, com a mesma chave, acertam. A execução que mede o resultado tem de ser de uma PR aberta depois dessa gravação, e a medição compara o `bun install` + restore dos passos antes e depois, não só a preparação, que varia com o Chromium e a fila.

## Depois do patch

Resultado a preencher na medição da execução (tabela antes/depois):

| Job | Preparação p50 antes | Preparação p50 depois | Acerto do cache |
| --- | ---: | ---: | :---: |
| (a medir) | | | |
