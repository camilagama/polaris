/**
 * The blind waits each Playwright file is allowed (`verify-no-blind-waits.mjs`). The entries below were in
 * the tree before the rule; each keeps its exact count, so the list only goes down. A new
 * entry says why the fixed time is the behaviour under test (for example, the latency of a simulated answer).
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste teste, troque a espera pelo sinal que ela aguardava";

export const BLIND_WAITS_LIST = {
  "apps/web/e2e-pwa/lazy-retry.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/motion-level.e2e.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/sale-detail-operations.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-charts.e2e.ts": { count: 6, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-date-pickers.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-device-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-entry-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-expense-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-filter-bar.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-guardrails.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-help-tip.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-history-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-home-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-lot2-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-payment-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-product-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-result-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-sale-detail-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-sale-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-screens.ts": { count: 5, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-stock-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/update-moments.e2e.ts": {
    count: 7,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/update.e2e.ts": { count: 11, reason: BEFORE_THE_RULE },
  "apps/web/e2e-real/harness/relogio.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-real/jornadas/despesa.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-real/jornadas/inicio.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-real/pilha/limite-de-taxa.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/app-shell.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/close-store.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/closed-store-device.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/closed-store.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/dashboard.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/expenses.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/home.e2e.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e/lote-2-telas.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-devices.e2e.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-runtime-api.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/offline-sair.e2e.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-screens.e2e.ts": { count: 6, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-sync-cadence.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/password-screens.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/payment-profiles-screen.e2e.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/products-screen.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/sign-in.e2e.ts": { count: 4, reason: BEFORE_THE_RULE },
};
