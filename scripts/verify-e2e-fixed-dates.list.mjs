/**
 * The ISO dates each Playwright file may carry without fixing the browser clock
 * (`verify-e2e-fixed-dates.mjs`). Each entry was in the tree before the rule and keeps its exact count, so the
 * list only goes down: a file that fixes its clock, or derives its dates from a fixed `NOW`, leaves it in
 * the same change. A new entry says why no screen compares that date with the real clock.
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste arquivo, fixe o relógio e derive as datas dele";

export const E2E_FIXED_DATES_LIST = {
  "apps/web/e2e-pwa/sale-detail-fixture.ts": {
    count: 7,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-account-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-date-pickers-digitar.e2e.ts": {
    count: 8,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-date-pickers-leitor-de-tela.e2e.ts": {
    count: 22,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-date-pickers.e2e.ts": {
    count: 38,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-device-states.ts": { count: 5, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-lot2-states.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-payment-states.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-sale-draft-states.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-sale-states.ts": { count: 6, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/ui-shell-isolation.e2e.ts": {
    count: 17,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e-pwa/ui-stock-states.ts": { count: 3, reason: BEFORE_THE_RULE },
  "apps/web/e2e-pwa/update.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e-real/calendar.test.ts": { count: 7, reason: BEFORE_THE_RULE },
  "apps/web/e2e/estoque-reflow.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/legal-acceptance.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/media-fixtures.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/money-nowrap-reflow.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/offline-screens.e2e.ts": { count: 12, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-sync-cadence.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/payment-profiles-screen.e2e.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/product-import.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/product-media-screen.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/product-opening-stock.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/product-thumbnails-screens.e2e.ts": {
    count: 3,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/products-screen.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/sale-columns.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/sale-item-reflow.e2e.ts": { count: 1, reason: BEFORE_THE_RULE },
  "apps/web/e2e/sale-screen.e2e.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/session-ended-screens.e2e.ts": {
    count: 5,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/stock-panel-mount.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/usabilidade-formularios.e2e.ts": {
    count: 2,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/venda-trocar-preco.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
};
