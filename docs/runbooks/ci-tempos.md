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

## Variante (ii): contêiner da Microsoft

A variante vale para 2 jobs: `lighthouse` e `offline-catalog-csp-browser`. O que muda neles:

- `container: mcr.microsoft.com/playwright:v1.63.0-noble` com `options: --init --ipc=host` (as recomendações da imagem para o Chromium);
- o Bun entra por `npm install --global "bun@$(cat .bun-version)"` no lugar de `oven-sh/setup-bun`: a imagem parte do `ubuntu:noble` sem `unzip`, e o `setup-bun` desempacota com ele;
- sem `playwright install`: os navegadores e as bibliotecas vêm na imagem (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`);
- um passo confere que `bunx playwright --version` é `Version 1.63.0`, para a imagem e o `bun.lock` não divergirem sem aviso. Ao subir o Playwright, a tag da imagem e esse número mudam juntos no mesmo PR.

O que fica de fora e por quê:

- Os shards do gate offline (`offline-poc-browser-part`) continuam no runner, com `setup-bun` e `playwright install` de hoje. O `test:pwa` liga o projeto `chromium-visual` e chama o `docker` (`apps/web/scripts/pwa-browser-tests.ts`, linhas 41-43 e 187-192): a imagem do Playwright não traz o CLI do Docker nem o socket, e o `docker run --network host` não acharia o servidor estático do job. Mudar esse script pede revisão de código própria.
- O job `e2e-real` continua no runner. Em job de contêiner o serviço do PostgreSQL deixa de ser `localhost` e passa a ser `postgres`, e `packages/db/scripts/gate-hosts.ts` e `apps/web/e2e-real/run-environment.ts` recusam esse host de propósito. Incluí-lo pede uma mudança de código revisada (a própria lista documenta isso), não só do workflow.

Pontos a medir e a vigiar:

- A preparação nos jobs de contêiner termina no `bun install` (o passo de conferência da versão não casa com `INSTALL_STEP`), e o puxar da imagem (passo "Initialize containers") já está na preparação, porque `scripts/ci-timing.mjs` conta a preparação desde o início do job: não some nada à mão. A rodada 2 lê esse tempo em separado, pelo tempo do passo "Initialize containers" nos passos do job. O tempo de puxar a imagem é a parte que só a execução mostra.
- Chromium como root dentro do Docker, `HOME=/github/home`, o cache do Bun e o `actions/checkout` no contêiner não foram exercidos antes de rodar no CI; a primeira execução é a prova.

