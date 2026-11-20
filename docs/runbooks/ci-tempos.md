# Tempos do CI: Chromium do Playwright

Frente "CI rápido sem esconder falha", item CI-5a. Aqui ficam a variante testada nesta branch, o que ela muda no `ci.yml` e a base medida antes dela. A medição vem de [`scripts/ci-timing.mjs`](../../scripts/ci-timing.mjs) (ver [Medir o tempo do CI](./medir-o-ci.md)). Nenhuma checagem sai, nenhum timeout sobe, nenhum `skip`.

## Base (antes)

Últimas 25 execuções verdes de `pull_request` (ids 44773605888 a 44819387058) e 21 de `workflow_dispatch`, lidas em 20/11/2026. Tempos em segundos. A preparação vai do início do job ao fim do último passo de instalação (checkout, Node, Bun, cache, `bun install`, `playwright install`).

| Job de navegador | Evento | n | Preparação p50 | Preparação p95 | Execução p50 |
| --- | --- | ---: | ---: | ---: | ---: |
| Offline browser gate (4 shards) | pull_request | 80 | 60 | 110 | 1530 |
| Offline browser gate (4 shards) | workflow_dispatch | 80 | 41 | 70 | 1334 |
| Catalog CSP browser test | pull_request | 20 | 62 | 99 | 36 |
| Catalog CSP browser test | workflow_dispatch | 1 | 46 | 46 | 45 |
| Lighthouse (mobile, simulated) | pull_request | 20 | 58 | 759 | 122 |
| Lighthouse (mobile, simulated) | workflow_dispatch | 20 | 42 | 48 | 124 |
| e2e journeys on the real local stack | pull_request | 25 | 67 | 90 | 411 |
| e2e journeys on the real local stack | workflow_dispatch | 20 | 56 | 66 | 314 |

Passos dentro da preparação, em segundos (execuções de `pull_request`):

| Passo | p50 | p95 |
| --- | ---: | ---: |
| `playwright install --with-deps chromium`, shards do gate (n=80) | 39 | 78 |
| `playwright install --with-deps chromium`, CSP do catálogo (n=20) | 40 | 68 |
| `playwright install --with-deps chromium`, Lighthouse (n=20) | 38 | 735 |
| `playwright install --with-deps chromium`, e2e real (n=25) | 36 | 49 |
| `actions/cache` do cache do Bun (restauração) | 7 | 9 |
| `bun install --frozen-lockfile` | 2 a 3 | 4 a 5 |

A instalação do Chromium é cerca de dois terços da preparação. A meta de preparação p50 ≤ 15 s não se alcança só tirando essa instalação: o resto da abertura (checkout, Node, Bun, restauração do cache do Bun, `bun install`) soma uns 20 s. A meta vale como "o melhor medido"; a rodada de medição diz quanto cada variante entrega.

## Variante (i): cache do Chromium

O que muda nos jobs `lighthouse`, `offline-poc-browser-part`, `offline-catalog-csp-browser` e `e2e-real`:

- um passo lê a versão do `@playwright/test` no `bun.lock` (hoje 1.63.0) e falha se não achar;
- `actions/cache` (a mesma versão fixada por SHA que o `ci.yml` já usa) guarda `~/.cache/ms-playwright` com a chave `playwright-<SO>-<versão>-chromium`;
- no acerto, só `playwright install-deps chromium` (as bibliotecas do apt continuam sendo instaladas); na falta, o `playwright install --with-deps chromium` de hoje.

Pontos a medir e a vigiar:

- O cache de uma execução de pull request só vale para aquele pull request: um cache criado numa branch não é lido por outras, só o da `main` é compartilhado. Como o `ci.yml` não roda os jobs de navegador no `push` da `main`, o primeiro push de cada pull request ainda instala o Chromium e só os seguintes acertam. Aquecer o cache na `main` pede um job novo, fora deste corte.
- Os quatro shards do gate gravam a mesma chave na falta; os que chegam depois avisam que a chave já existe, sem falhar.
- A restauração do cache e o `install-deps` entram na preparação. O ganho esperado é a diferença entre o download do Chromium (e do headless shell e do ffmpeg) e a restauração do cache.
- `scripts/ci-timing.mjs` só conta como preparação os passos cujo nome casa com `INSTALL_STEP`. O passo que lê a versão (`Run version=...`) não casa e encerra a contagem antes do cache do Chromium e do install: a rodada de medição precisa estender essa expressão (ou nomear o passo) antes de comparar.

