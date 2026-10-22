/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Correções de usabilidade do staging, lote 1, parte C (t213): percentual de taxa dos perfis de pagamento
 * (U-29 e U-30). U-14 (SKU repetido) está em products-screen.e2e.ts, junto da tela dele.
 */
const EDIT = /Editar/;
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  status,
});

const fee = (mode: string, percentage: string | null) => ({
  fixedAmount: null,
  mode,
  percentage,
});
const PROFILE = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha da loja",
  organizationId: ORGANIZATION.id,
  rules: [
    {
      anticipationFee: fee("none", null),
      expectedSettlementDays: 30,
      installmentPlan: "merchant",
      installments: 1,
      method: "credit_card",
      processingFee: fee("percentage", "3.000000"),
    },
    {
      anticipationFee: fee("none", null),
      expectedSettlementDays: 1,
      installmentPlan: null,
      installments: null,
      method: "pix",
      processingFee: fee("percentage", "2.500000"),
    },
  ],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

async function openProfiles(
  page: Page,
  profiles: unknown[],
  options: { createRefused?: boolean; listFails?: boolean } = {}
) {
  const calls = { creates: 0 };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "paymentProfile/list") {
      return options.listFails
        ? route.fulfill(
            rpc(
              {
                code: "SERVICE_UNAVAILABLE",
                data: undefined,
                defined: false,
                message: "Unavailable",
                status: 503,
              },
              503
            )
          )
        : route.fulfill(rpc({ profiles }));
    }
    if (procedure === "paymentProfile/create") {
      calls.creates += 1;
      return options.createRefused
        ? route.fulfill(
            rpc(
              {
                code: "BAD_REQUEST",
                data: undefined,
                defined: true,
                message: "BAD_REQUEST",
                status: 400,
              },
              400
            )
          )
        : route.fulfill(rpc(PROFILE));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/payment-profiles");
  await expect(
    page.getByRole("heading", { exact: true, name: "Perfis de pagamento" })
  ).toBeVisible();
  return calls;
}

test("U-30: a taxa aparece como 3% e 2,5%, e o campo de edição vem sem os zeros do servidor", async ({
  page,
}) => {
  await openProfiles(page, [PROFILE]);
  const card = page.locator("li", { hasText: "Maquininha da loja" });
  await expect(card).toContainText("3%");
  await expect(card).toContainText("2,5%");
  await expect(card).not.toContainText("3.000000");
  await expect(card).not.toContainText("2.500000");

  await page.getByRole("button", { name: EDIT }).first().click();
  await expect(
    page.getByLabel("Percentual efetivo sobre o total devido").first()
  ).toHaveValue("3");
});

test("U-29: percentual inválido é dito no campo, com o limite aceito, sem 'Tentar novamente' e sem chamar o servidor", async ({
  page,
}) => {
  const calls = await openProfiles(page, []);
  await page.getByLabel("Nome do perfil").fill("Perfil novo");
  await page
    .getByLabel("Como a taxa é informada")
    .first()
    .selectOption("percentage");
  const percentage = page.getByLabel("Percentual efetivo sobre o total devido");
  await percentage.fill("250");
  await page.getByRole("button", { name: "Criar perfil" }).click();

  const message = "Informe um percentual de 0 a 100, por exemplo 2,5.";
  await expect(page.getByText(message)).toBeVisible();
  await expect(percentage).toHaveAttribute("aria-invalid", "true");
  const describedBy = await percentage.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
  await expect(percentage).toBeFocused();
  // the 3 px focus ring plus its 3 px offset clear the message, so the ring does not strike its first line
  const margin = await page
    .locator(`[id="${describedBy}"]`)
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).marginTop)
    );
  expect(margin).toBeGreaterThanOrEqual(6);
  // nothing generic at the top of the page, and no retry for something the person has to fix
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Tentar novamente" })
  ).toHaveCount(0);
  // what was typed stays
  await expect(page.getByLabel("Nome do perfil")).toHaveValue("Perfil novo");
  await expect(percentage).toHaveValue("250");
  expect(calls.creates).toBe(0);

  // empty is said the same way, not by the browser's own balloon
  await percentage.fill("");
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect(page.getByText(message)).toBeVisible();

  // fixing it takes the message away and the save goes
  await percentage.fill("2,5");
  await expect(page.getByText(message)).toHaveCount(0);
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect.poll(() => calls.creates).toBe(1);
});

test("U-29: só a leitura que falhou oferece 'Tentar novamente'; o erro de salvar não", async ({
  page,
}) => {
  const calls = await openProfiles(page, [], {
    createRefused: true,
    listFails: true,
  });
  await expect(
    page.getByRole("button", { name: "Tentar novamente" })
  ).toBeVisible();
  await page.getByLabel("Nome do perfil").fill("Perfil novo");
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect.poll(() => calls.creates).toBe(1);
  await expect(page.getByRole("alert")).toContainText(
    "Revise o método, as parcelas, o prazo e os valores das taxas."
  );
  await expect(
    page.getByRole("button", { name: "Tentar novamente" })
  ).toHaveCount(0);
});
