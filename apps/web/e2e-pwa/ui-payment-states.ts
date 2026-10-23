/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";

/**
 * The states of the payment profiles screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=payment-profiles`), with the profiles answered by the test (`page.route`) and synthetic
 * data only. Only three states, as for the products: each one starts the runtime of the lab in every context of the map,
 * and the CI job has a limit of 30 minutes. The empty list, the list that could not be read, the loading and the saves
 * are proved in `e2e/usabilidade-formularios.e2e.ts` and in the captures of the pull request. The lab's own controls
 * are hidden at the end of each state, so what is measured is the screen alone.
 */
const ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
});

const fee = (
  mode: string,
  percentage: string | null,
  fixedAmount?: string
) => ({
  fixedAmount: fixedAmount ?? null,
  mode,
  percentage,
});

const profile = (
  n: number,
  name: string,
  status: "active" | "archived",
  rules: unknown[]
) => ({
  archivedAt: status === "archived" ? "2026-10-02T12:00:00.000Z" : null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: `0199c2d0-0000-7000-8000-0000000000c${n}`,
  name,
  organizationId: ORGANIZATION_ID,
  rules: rules.map((rule, index) => ({
    id: `rule-${n}-${index}`,
    ...(rule as object),
  })),
  status,
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
});

// a credit rule with a known fee and a fee that is not known, a Pix rule with a fixed and a percentage fee, and an
// archived profile with a name too long for the line: every shape a row has
const PROFILES = [
  profile(1, "Maquininha da loja", "active", [
    {
      anticipationFee: fee("unknown", null),
      expectedSettlementDays: 30,
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
      processingFee: fee("percentage", "3.000000"),
    },
    {
      anticipationFee: fee("none", null),
      expectedSettlementDays: 1,
      installmentPlan: null,
      installments: null,
      method: "pix",
      processingFee: fee("fixed_and_percentage", "0.990000", "0.50"),
    },
  ]),
  profile(
    2,
    "Link de pagamento da loja antiga com um nome bem comprido para a linha",
    "archived",
    [
      {
        anticipationFee: fee("none", null),
        expectedSettlementDays: null,
        installmentPlan: null,
        installments: null,
        method: "bank_transfer",
        processingFee: fee("none", null),
      },
    ]
  ),
];

/** Starts the lab's runtime and waits for the screen with the list read. */
async function openProfilesLab(page: Page) {
  await page.route("**/rpc/paymentProfile/list", (route: Route) =>
    route.fulfill(rpc({ profiles: PROFILES }))
  );
  await page.goto("/offline-screens-lab?screen=payment-profiles");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", {
      exact: true,
      level: 1,
      name: "Perfis de pagamento",
    })
    .waitFor();
  await page.getByText("Maquininha da loja").first().waitFor();
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

export const paymentStates = {
  /** The edit of the profile with the credit rule: the form filled with both fees of each rule. */
  async edit(page: Page) {
    await openProfilesLab(page);
    await page
      .getByRole("button", { name: "Editar perfil Maquininha da loja" })
      .click();
    await page.getByRole("heading", { name: "Editar perfil" }).waitFor();
    await page.getByLabel("Valor fixo por pagamento").waitFor();
    await showScreenAlone(page);
  },

  /** A new profile sent with no name and a percentage of 150: both problems are said at the field. */
  async errors(page: Page) {
    await openProfilesLab(page);
    await page
      .getByRole("combobox", { name: "Como a taxa é informada" })
      .first()
      .click();
    await page.getByRole("option", { exact: true, name: "Percentual" }).click();
    await page.getByRole("listbox").waitFor({ state: "detached" });
    await page
      .getByLabel("Percentual efetivo sobre o total devido")
      .fill("150");
    await page.getByRole("button", { name: "Criar perfil" }).click();
    await page.getByText("Informe o nome do perfil.").waitFor();
    await page.getByText("Informe um percentual de 0 a 100").waitFor();
    await showScreenAlone(page);
  },

  /** The list with the archived profiles shown: every shape of a row. */
  async list(page: Page) {
    await openProfilesLab(page);
    await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
    await page.getByText("Arquivado").first().waitFor();
    await showScreenAlone(page);
  },
};
