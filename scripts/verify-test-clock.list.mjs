/**
 * The reads of the wall clock each test file is allowed (`verify-test-clock.mjs`). The entries below were in
 * the tree before the rule; each keeps its exact count, so the list only goes down. A new
 * entry says why the real clock is what the test needs (for example, a test of the clock setup itself).
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste teste, fixe o relógio e derive as datas dele";

export const TEST_CLOCK_LIST = {
  "apps/web/e2e-pwa/support.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/update-moments.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/update.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-real/global-setup.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-real/harness/relogio.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-real/jornadas/encerramento.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-real/pilha/limite-de-taxa.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/shell-server.ts": {
    count: 2,
    reason:
      "o servidor simulado das specs da casca assina o lease com a hora real (ou a do relógio fixado por serveFoot) e grava o comando recusado na hora do navegador, que roda no relógio real nas specs que não o fixam; são as leituras que saíram de app-shell.e2e.ts, sem leitura nova",
  },
  "apps/web/e2e/home/inicio-visao.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/offline-runtime-api.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/offline-sair.e2e.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-screens.e2e.ts": { count: 9, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-sync-cadence.e2e.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/pwa/sw.test.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/worker/index.workerd-db.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/billing/src/asaas/sandbox.integration.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/billing/src/woovi/sandbox.integration.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "scripts/test-clock/setup.test.mjs": { count: 10, reason: BEFORE_THE_RULE },
};
