/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

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
  headers: { ...WORKER_MARK },
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
      headers: { ...WORKER_MARK },
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
  const card = page.locator("li[data-profile-id]", {
    hasText: "Maquininha da loja",
  });
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
    .getByRole("combobox", { name: "Como a taxa é informada" })
    .first()
    .click();
  await page.getByRole("option", { exact: true, name: "Percentual" }).click();
  const percentage = page.getByLabel("Percentual efetivo sobre o total devido");
  await percentage.fill("250");
  await page.getByRole("button", { name: "Criar perfil" }).click();

  const message = "Informe um percentual de 0 a 100, por exemplo 2,5.";
  await expect(page.getByText(message)).toBeVisible();
  await expect(percentage).toHaveAttribute("aria-invalid", "true");
  const describedBy = await percentage.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(message);
  await expect(percentage).toBeFocused();
  // the 3 px ring of the field clears the message, so the ring does not strike its first line (U-28)
  const gap = await percentage.evaluate((input) => {
    const group = input.closest("[data-slot=input-group]");
    const error = document.getElementById(
      input.getAttribute("aria-describedby") ?? ""
    );
    return (
      (error?.getBoundingClientRect().top ?? 0) -
      (group?.getBoundingClientRect().bottom ?? 0)
    );
  });
  expect(gap).toBeGreaterThanOrEqual(6);
  // nothing generic at the top of the page: the only alert is the one of the field, and no retry for what the
  // person has to fix
  await expect(page.getByRole("alert")).toHaveCount(1);
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
  // the read tries three times (~1.5 s and ~4 s between them) before the screen says it failed
  await expect(
    page.getByRole("button", { name: "Tentar novamente" })
  ).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Nome do perfil").fill("Perfil novo");
  await page.getByRole("button", { name: "Criar perfil" }).click();
  await expect.poll(() => calls.creates).toBe(1);
  const refused = page.getByRole("alert").filter({
    hasText: "Revise o método, as parcelas, o prazo e os valores das taxas.",
  });
  await expect(refused).toBeVisible();
  await expect(refused.locator("xpath=..")).toBeFocused();
  await expect(refused.getByRole("button")).toHaveCount(0);
  // the list still could not be read, and it still offers to read it again; it never shows as an empty list
  await expect(page.getByText("Nenhum perfil cadastrado")).toHaveCount(0);
});
