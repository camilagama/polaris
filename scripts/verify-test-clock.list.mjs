/**
 * The reads of the wall clock each test file is allowed (`verify-test-clock.mjs`). The entries below were in
 * the main branch when the check started; each keeps its exact count, so the list only goes down. A new
 * entry says why the real clock is what the test needs (for example, a test of the clock setup itself).
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste teste, fixe o relógio e derive as datas dele";

export const TEST_CLOCK_LIST = {
  "apps/admin/src/support-routes.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/sale-draft.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/update-moments.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/update.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
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
  "apps/web/e2e/app-shell.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/close-store.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/closed-store-device.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/closed-store-sale.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/home.e2e.ts": { count: 4, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-devices.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
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
  "apps/web/src/lib/read-wait-text.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/offline/runtime/offline-runtime.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/pwa/sw.test.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/src/server/auth/access-log.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/auth/better-auth-characterization.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/auth/email.test.tsx": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/auth/get-session-single-read.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/authenticated-request-context.test.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/billing/asaas-adapter.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/billing/owner-commands.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/billing/woovi-adapter.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/account-router.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/billing-router.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/data-export-router.test.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/offline-router.test.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/organization-closure-router.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/product-import-router.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/report-router.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/sale-router.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/rpc/sync-push-router.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/server/tenant-request-context.test.ts": {
    count: 9,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/src/ui/date-values.test.ts": { count: 1, reason: BEFORE_THE_RULE },
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
  "packages/db/src/billing-store-command-lock.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "packages/domain/src/catalog/category.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/domain/src/catalog/product.test.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "packages/domain/src/customers/customer.test.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "packages/domain/src/privacy/retention.test.ts": {
    count: 4,
    reason: BEFORE_THE_RULE,
  },
  "packages/domain/src/scheduling/scheduled-jobs.test.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "scripts/test-clock/setup.test.mjs": { count: 10, reason: BEFORE_THE_RULE },
  "scripts/verify-deployed-sha.test.mjs": { count: 2, reason: BEFORE_THE_RULE },
};
