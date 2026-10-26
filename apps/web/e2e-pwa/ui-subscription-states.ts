/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { json, settle } from "./ui-entry-states";
import { serveHealth } from "./worker-mark";

/**
 * The states of the Assinatura the interface guardrails measure (t328): the real route `/subscription` in the shell,
 * with the session and `billing.readPlan` answered by the test (`page.route`), synthetic data only. Five states, as
 * few as the other screens (each one loads in every context of the map, and the CI job has a limit of 30 minutes):
 * the offer of a Free store with the form of Pix Automático open, the Pix waiting for the bank, the Pro in force in
 * the window of the refund, the dialog of cancelling the renewal (t372), and the grace with the notice at the top and
 * the page of the charge that failed. Each state of the plan, the refusals, the return of the card and the owner's
 * commands are proved in `e2e/subscription-screen.e2e.ts`, `e2e/subscription-commands.e2e.ts` and in the captures
 * of the pull requests.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-23T15:00:00.000Z");
const PIX_CODE =
  "00020126580014br.gov.bcb.pix0136a1b2c3d4-0000-4000-8000-0000000000075204000053039865802BR5909POLARIS6009SANTAREM62070503***6304A1B2";

const rpc = (body: unknown) => json(200, { json: body, meta: [] });
const RPC_PREFIX = /^.*\/rpc\//;
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");

const plan = (overrides: Record<string, unknown> = {}) => ({
  accessEndsAt: null,
  cycleMonths: null,
  kept: { historyMonths: 3, products: 18, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  offer: {
    methods: ["card", "pix_automatic"],
    prices: [
      { amount: "24.90", cycleMonths: 1 },
      { amount: "249.00", cycleMonths: 12 },
    ],
  },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "free",
  trialAvailable: true,
  usage: { goals: 1, images: 12, variants: 38 },
  ...overrides,
});

async function serveSubscription(
  page: Page,
  plans: readonly Record<string, unknown>[]
) {
  let reads = 0;
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(200, {
        session: { id: "s" },
        user: { email: "ana@lojadaana.com.br", id: "u", name: "Ana" },
      })
    )
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({ billingSelfService: true, organizations: [ORGANIZATION] })
      );
    }
    if (procedure === "billing/readPlan") {
      const answer = plans[Math.min(reads, plans.length - 1)];
      reads += 1;
      return route.fulfill(rpc(answer));
    }
    if (procedure === "billing/startCheckout") {
      return route.fulfill(
        rpc({
          handoff: {
            emv: PIX_CODE,
            kind: "pix_authorization",
            url: "https://app.woovi-sandbox.com/pay/e2e",
          },
        })
      );
    }
    return route.abort("internetdisconnected");
  });
}

async function openSubscription(
  page: Page,
  plans: readonly Record<string, unknown>[],
  ready: (page: Page) => Promise<void>
) {
  await serveSubscription(page, plans);
  await page.goto("/subscription");
  await page.getByRole("heading", { level: 1, name: "Assinatura" }).waitFor();
  await ready(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await settle(page);
}

const ACTIVE_IN_WINDOW = plan({
  accessEndsAt: "2026-11-24T03:00:00.000Z",
  cycleMonths: 1,
  method: "card",
  nextCharge: { amount: "24.90", on: "2026-11-23" },
  refund: { amount: "24.90", until: "2026-10-31T02:59:59.999Z", via: "app" },
  state: "active",
});

const PIX_RADIO = /Pix Automático/;

async function choosePix(page: Page) {
  await page
    .getByRole("radiogroup", { name: "Como pagar" })
    .getByRole("radio", { name: PIX_RADIO })
    .click();
  await page.getByLabel("CPF ou CNPJ").waitFor();
}

export const subscriptionStates = {
  /** The Pro in force, in the window of the right of withdrawal: the plan, the use, how it pays, its two actions. */
  active: (page: Page) =>
    openSubscription(page, [ACTIVE_IN_WINDOW], (current) =>
      current.getByText("Próxima cobrança em").first().waitFor()
    ),
  /** "Cancelar a renovação" open: the loss, what stays, the reason and the two buttons (t372). */
  cancelDialog: (page: Page) =>
    openSubscription(page, [ACTIVE_IN_WINDOW], async (current) => {
      await current
        .getByRole("button", { exact: true, name: "Cancelar a renovação" })
        .click();
      await current
        .getByRole("dialog")
        .getByLabel("Por que está cancelando? (opcional)")
        .waitFor();
    }),
  /** The grace: the notice at the top, the plan's own title and the page of the charge that failed. */
  grace: (page: Page) =>
    openSubscription(
      page,
      [
        plan({
          accessEndsAt: "2026-10-31T03:00:00.000Z",
          cycleMonths: 1,
          method: "card",
          recovery: "provider_page",
          state: "grace",
        }),
      ],
      (current) =>
        current.getByText("O último pagamento não foi confirmado.").waitFor()
    ),
  /** A Free store with the trial: the offer, with the payer of Pix Automático. */
  offer: (page: Page) =>
    openSubscription(page, [plan()], async (current) => {
      await current.getByRole("radiogroup", { name: "Ciclo" }).waitFor();
      await choosePix(current);
    }),
  /** The code of Pix Automático waiting for the bank (no QR, R-4). */
  pixWaiting: (page: Page) =>
    openSubscription(
      page,
      [plan(), plan({ method: "pix_automatic", state: "trial_setup" })],
      async (current) => {
        await choosePix(current);
        await current.getByLabel("CPF ou CNPJ").fill("529.982.247-25");
        await current
          .getByRole("button", { name: "Começar o teste grátis" })
          .click();
        await current.getByLabel("Código Pix (copia e cola)").waitFor();
      }
    ),
};
