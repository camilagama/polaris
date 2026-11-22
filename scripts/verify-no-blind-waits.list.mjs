/**
 * The blind waits each Playwright file is allowed (`verify-no-blind-waits.mjs`). The entries below were in
 * the tree before the rule; each keeps its exact count, so the list only goes down. A new
 * entry says why the fixed time is the behaviour under test (for example, the latency of a simulated answer).
 */
const BEFORE_THE_RULE =
  "anterior à checagem; ao mexer neste teste, troque a espera pelo sinal que ela aguardava";

const ONE_TURN_AFTER_THE_CLICK =
  "o tempo é o comportamento testado: olha a tela um turno depois do clique, quando a saída animada ainda está montada; um sinal de que ela saiu provaria o contrário";

const ABSENCE_IS_THE_TEST =
  "o tempo é o comportamento testado: a espera prova a ausência (nada se repete sozinho, nada muda antes do prazo); um sinal positivo não provaria isso";

const SIMULATED_LATENCY =
  "a espera é a latência de uma resposta simulada dentro de page.route: o tempo é o que o servidor falso leva para responder";

export const BLIND_WAITS_LIST = {
  "apps/web/e2e-pwa/motion-level.e2e.ts": {
    count: 1,
    reason: ONE_TURN_AFTER_THE_CLICK,
  },
  "apps/web/e2e-pwa/ui-charts.e2e.ts": {
    count: 1,
    reason: ABSENCE_IS_THE_TEST,
  },
  "apps/web/e2e-pwa/ui-date-pickers.e2e.ts": {
    count: 1,
    reason: ONE_TURN_AFTER_THE_CLICK,
  },
  "apps/web/e2e-pwa/ui-filter-bar-dialog.e2e.ts": {
    count: 1,
    reason: ONE_TURN_AFTER_THE_CLICK,
  },
  "apps/web/e2e-pwa/ui-filter-bar.e2e.ts": {
    count: 2,
    reason: ONE_TURN_AFTER_THE_CLICK,
  },
  "apps/web/e2e-pwa/ui-guardrails/controle-movimento.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
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
  "apps/web/e2e/closed-store-device.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/home/offline-e-leituras.e2e.ts": {
    count: 1,
    reason: BEFORE_THE_RULE,
  },
  "apps/web/e2e/home/shared.ts": { count: 2, reason: BEFORE_THE_RULE },
  "apps/web/e2e/offline-devices.e2e.ts": {
    count: 3,
    reason: ABSENCE_IS_THE_TEST,
  },
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
  "apps/web/e2e/sign-in.e2e.ts": { count: 1, reason: SIMULATED_LATENCY },
};
