/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";

/**
 * The states of Resultado and Metas the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=dashboard`), with the summary of the month and the goals answered by the test
 * (`page.route`), synthetic data only. Four states: each one starts the runtime of the lab in every context of the
 * map, and the CI job has a limit of 30 minutes. The complete month, the loading, the saves and the cancellation
 * are proved in `e2e/dashboard.e2e.ts` and `e2e/goals.e2e.ts` and in the captures of the pull request. The lab's own
 * controls are hidden at the end of each state, so what is measured is the screen alone.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";
const NOW = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const RPC_PREFIX = /^\/rpc\//;
const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
});

/** A month with an unknown cost and a processing fee left out: the warning, the badges and the notes on the chain. */
const PARTIAL_SUMMARY = (from: string, to: string) => ({
  cards: {
    items: 4,
    marginPercent: "52.56",
    netSales: "245.00",
    operatingResult: "-6.35",
    salesCount: 3,
    ticket: "81.67",
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "96.00",
    commercialSurcharges: "0.00",
    contributionMargin: "128.75",
    discounts: "10.00",
    estimatedOperatingResult: "-6.35",
    grossProfit: "149.00",
    grossSales: "260.00",
    linkedExpenses: "11.55",
    netSales: "245.00",
    operatingExpenses: "135.10",
    processingFees: "8.70",
    returns: "5.00",
  },
  generatedAt: NOW,
  period: { from, to },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 4,
    itemLinesWithUnknownCost: 1,
    level: "partial",
    linkedExpenses: 1,
    missing: ["unknown_cost", "unknown_processing_fee"],
    operatingExpenses: 2,
    processingFeesUnknown: 1,
    salesCount: 3,
  },
});

const EMPTY_SUMMARY = (from: string, to: string) => ({
  cards: {
    items: 0,
    marginPercent: null,
    netSales: "0.00",
    operatingResult: "0.00",
    salesCount: 0,
    ticket: null,
  },
  chain: {
    anticipationFees: "0.00",
    cogs: "0.00",
    commercialSurcharges: "0.00",
    contributionMargin: "0.00",
    discounts: "0.00",
    estimatedOperatingResult: "0.00",
    grossProfit: "0.00",
    grossSales: "0.00",
    linkedExpenses: "0.00",
    netSales: "0.00",
    operatingExpenses: "0.00",
    processingFees: "0.00",
    returns: "0.00",
  },
  generatedAt: NOW,
  period: { from, to },
  quality: {
    anticipationFeesUnknown: 0,
    itemLines: 0,
    itemLinesWithUnknownCost: 0,
    level: "no_data",
    linkedExpenses: 0,
    missing: ["no_sales"],
    operatingExpenses: 0,
    processingFeesUnknown: 0,
    salesCount: 0,
  },
});

const goal = (n: number, extra: Record<string, unknown>) => ({
  achievedValue: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  endsOn: "2026-10-31",
  id: uuid(n),
  kind: "net_sales",
  name: null,
  organizationId: ORGANIZATION_ID,
  paused: false,
  progress: null,
  settledAt: null,
  startsOn: "2026-10-01",
  status: "active",
  target: "2000.00",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
  ...extra,
});

// in progress with a bar, one that has not started, and one of each way to end
const GOALS = [
  goal(1, {
    name: "Outubro forte",
    progress: {
      percent: "12.2",
      periodEnded: false,
      reached: false,
      value: "245.00",
    },
  }),
  goal(2, {
    endsOn: "2026-12-24",
    name: "Natal",
    progress: {
      percent: null,
      periodEnded: false,
      reached: false,
      value: "0.00",
    },
    startsOn: "2026-11-01",
    target: "8000.00",
  }),
  goal(3, {
    achievedValue: "1620.00",
    endsOn: "2026-09-30",
    name: "Setembro",
    settledAt: "2026-09-30T12:00:00.000Z",
    startsOn: "2026-09-01",
    status: "completed",
    target: "1500.00",
  }),
  goal(4, {
    achievedValue: "212.40",
    endsOn: "2026-08-31",
    kind: "operating_result",
    settledAt: "2026-08-31T12:00:00.000Z",
    startsOn: "2026-08-01",
    status: "missed",
    target: "400.00",
  }),
];

/** What the screen reads in the shell check (`ui-shell-isolation.e2e.ts`): an incomplete month, and the goals. */
export const resultAnswers = {
  "goal/list": { goals: GOALS },
  "report/periodSummary": PARTIAL_SUMMARY("2026-10-01", "2026-10-31"),
};

interface Served {
  empty?: boolean;
  /** The network is down: nothing is answered. */
  offline?: boolean;
}

async function serveResult(page: Page, served: Served) {
  await page.route("**/rpc/**", (route: Route) => {
    if (served.offline) {
      return route.abort("internetdisconnected");
    }
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    const input =
      (route.request().postDataJSON() as { json?: Record<string, unknown> })
        .json ?? {};
    if (procedure === "report/periodSummary") {
      const from = String(input.from);
      const to = String(input.to);
      return route.fulfill(
        rpc(served.empty ? EMPTY_SUMMARY(from, to) : PARTIAL_SUMMARY(from, to))
      );
    }
    if (procedure === "goal/list") {
      return route.fulfill(rpc({ goals: served.empty ? [] : GOALS }));
    }
    return route.abort("internetdisconnected");
  });
}

async function signIn(page: Page, user: string) {
  await page.goto("/offline-screens-lab?screen=dashboard");
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, level: 1, name: "Resultado" })
    .waitFor();
}

/** Starts the lab's runtime and waits for the screen with the month read. */
async function openResultLab(page: Page, served: Served = {}) {
  // the month the screen opens on is the organization's today: keep it October 2026
  await page.clock.setFixedTime(new Date(NOW));
  await serveResult(page, served);
  await signIn(page, `guardrails-${crypto.randomUUID()}`);
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

export const resultStates = {
  /** No sales, no expenses, no goals: the month's empty state and the empty goals. */
  async empty(page: Page) {
    await openResultLab(page, { empty: true });
    await page
      .getByText("Sem vendas nem despesas em outubro de 2026")
      .waitFor();
    await page.getByText("Nenhuma meta ainda").waitFor();
    await showScreenAlone(page);
  },

  /** The month read with an incomplete estimate, and the goals: in progress, not started, completed and missed. */
  async list(page: Page) {
    await openResultLab(page);
    await page.getByText("Estimativa incompleta").first().waitFor();
    await page.getByText("Outubro forte").waitFor();
    await showScreenAlone(page);
  },

  /** A new goal sent empty: the target says what is missing. */
  async newGoalErrors(page: Page) {
    await openResultLab(page);
    await page.getByText("Outubro forte").waitFor();
    await page.getByRole("button", { name: "Nova meta" }).click();
    await page.getByRole("button", { name: "Criar meta" }).click();
    await page.locator("#goal-create-target-error").waitFor();
    await showScreenAlone(page);
  },

  /** The server out of reach after a read: the copy the device kept, the notice, and the goals that could not load. */
  async offline(page: Page) {
    const served: Served = {};
    await page.clock.setFixedTime(new Date(NOW));
    await serveResult(page, served);
    const user = `guardrails-${crypto.randomUUID()}`;
    await signIn(page, user);
    await page.getByText("Estimativa incompleta").first().waitFor();
    served.offline = true;
    await signIn(page, user);
    await page.getByText("Sem conexão com o servidor.").waitFor();
    await showScreenAlone(page);
  },
};
