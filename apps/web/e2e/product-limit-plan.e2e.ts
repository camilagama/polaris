/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Stage 2 of the corte 61b (AC-10), in the real route with the API answered by the test: the limit text of the new
 * product gains "Conhecer o Pro" (to the Assinatura) only for the owner (`billing:manage`) of a Free store; whom is
 * not the owner reads the way to the owner; the Pro and the trial read only the sentence; with the billing
 * self-service off, nothing changes from stage 1. The plan is `billing.readPlan`'s, never the error's.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const LIMIT_TEXT =
  "Seu plano chegou ao limite de variantes. Nada foi cadastrado.";
const ASK_OWNER = "Fale com o dono da loja para mudar o plano.";

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const planOf = (state: string) => ({
  accessEndsAt: state === "free" ? null : "2026-11-24T03:00:00.000Z",
  cycleMonths: state === "free" ? null : 1,
  kept: { historyMonths: 3, products: 50, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: state === "free" ? null : "card",
  nextCharge: null,
  offer: { methods: ["card"], prices: [{ amount: "24.90", cycleMonths: 1 }] },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state,
  trialAvailable: false,
  usage: { goals: 1, images: 0, variants: 50 },
});

interface Case {
  billingSelfService: boolean;
  role: string;
  state: string;
}

/** The products screen of a store at the limit: every create is refused for the plan's limit. */
async function openAtLimit(
  page: Page,
  { billingSelfService, role, state }: Case
) {
  const reads = { plan: 0 };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(
          rpc({
            billingSelfService,
            organizations: [{ ...ORGANIZATION, role }],
          })
        );
      case "category/list":
        return route.fulfill(rpc({ categories: [] }));
      case "product/list":
        return route.fulfill(rpc({ products: [] }));
      case "billing/readPlan":
        reads.plan += 1;
        return route.fulfill(rpc(planOf(state)));
      case "product/create":
        return route.fulfill(
          rpc(
            {
              code: "CONFLICT",
              data: { reason: "entitlement_limit_reached" },
              defined: false,
              message: "Conflict",
              status: 409,
            },
            409
          )
        );
      default:
        return route.abort("internetdisconnected");
    }
  });
  await page.goto("/products");
  await page.getByRole("button", { name: "Novo produto" }).first().click();
  await page.getByLabel("Nome do produto").fill("Camiseta");
  // the read of the plan before the refusal (the notice of grace of the shell, for the owner) does not count
  await page.waitForLoadState("networkidle");
  reads.plan = 0;
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByRole("alert")).toContainText(LIMIT_TEXT);
  return reads;
}

const upgrade = (page: Page) =>
  page.getByRole("alert").getByRole("link", { name: "Conhecer o Pro" });

test("dono: na loja Free, 'Conhecer o Pro' leva à Assinatura; no Pro e no teste, só a frase", async ({
  page,
}) => {
  const reads = await openAtLimit(page, {
    billingSelfService: true,
    role: "owner",
    state: "free",
  });
  await expect(upgrade(page)).toHaveAttribute(
    "href",
    "/configuracoes?aba=assinatura"
  );
  await expect(page.getByRole("alert")).not.toContainText(ASK_OWNER);
  // the plan is the server's: read for the refusal
  expect(reads.plan).toBe(1);

  for (const state of ["trialing", "active"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one plan after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openAtLimit(page, { billingSelfService: true, role: "owner", state });
    await expect(page.getByRole("alert")).toHaveText(LIMIT_TEXT);
    await expect(upgrade(page)).toHaveCount(0);
  }
});

test("quem não é dono lê o caminho até o dono, sem link, em qualquer plano, e nem lê o plano", async ({
  page,
}) => {
  for (const state of ["free", "trialing", "active"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one plan after the other, on the same page
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const reads = await openAtLimit(page, {
      billingSelfService: true,
      role: "cashier",
      state,
    });
    await expect(page.getByRole("alert")).toHaveText(
      `${LIMIT_TEXT}${ASK_OWNER}`
    );
    await expect(upgrade(page)).toHaveCount(0);
    expect(reads.plan).toBe(0);
  }
});

test("com a assinatura desligada, o texto é o da etapa 1 para todos: sem link e sem leitura do plano", async ({
  page,
}) => {
  for (const role of ["owner", "cashier"]) {
    for (const state of ["free", "trialing", "active"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one case after the other, on the same page
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const reads = await openAtLimit(page, {
        billingSelfService: false,
        role,
        state,
      });
      await expect(page.getByRole("alert")).toHaveText(LIMIT_TEXT);
      await expect(upgrade(page)).toHaveCount(0);
      expect(reads.plan).toBe(0);
    }
  }
});
