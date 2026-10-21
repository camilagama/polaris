/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";

/**
 * The sale screen on the components of src/ui (ADR 0103, PR 4), in the lab of the offline screens:
 * - condition 2 of the ADR repeated on the screen itself: every control of the sale opens and changes state
 *   under the production Content-Security-Policy with zero violations, in the light and in the dark theme;
 * - Petković C-1: the quantity field is 64 px wide and leaves at least 48 px free between the touch areas of
 *   its − and + buttons.
 */
const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const SHIRT_OPTION = /Camiseta do laboratório — Azul/;
const LAB_PROFILE = /Maquininha do laboratório/;

const THEMES = [
  { dark: false, name: "claro", stored: "claro" },
  { dark: true, name: "escuro", stored: "escuro" },
] as const;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
});

const PROFILE = {
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [],
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

async function openSaleLab(page: Page, stored: string) {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("polaris-tema", theme);
  }, stored);
  // the lab has no server: the profiles come from here, the items from the device (below)
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [PROFILE] }))
  );
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toBeVisible();
}

async function pickShirt(page: Page): Promise<Locator> {
  // the variants come from this device's collections, which the lab fills
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await item.getByRole("button", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Rede disponível").check();
  return item;
}

async function useEveryControl(page: Page) {
  const item = await pickShirt(page);
  await item.getByRole("button", { name: "Mais uma unidade" }).click();
  await expect(item.getByLabel("Quantidade")).toHaveValue("2");
  await item.getByRole("button", { name: "Menos uma unidade" }).click();
  await expect(item.getByLabel("Quantidade")).toHaveValue("1");
  await item.getByLabel("Preço cobrado").fill("45,00");

  const methods = page.getByRole("radiogroup", { name: "Método de pagamento" });
  await methods.getByRole("radio", { name: "Crédito" }).check();
  await expect(methods.getByRole("radio", { name: "Crédito" })).toBeChecked();
  const anticipation = page.getByRole("checkbox", {
    name: "Pretendo antecipar este recebimento",
  });
  await anticipation.click();
  await expect(anticipation).toBeChecked();
  await page
    .getByRole("combobox", { exact: true, name: "Modalidade do parcelamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Parcelado pelo lojista" })
    .click();
  const profile = page.getByRole("combobox", {
    exact: true,
    name: "Perfil de pagamento",
  });
  await profile.click();
  await page.getByRole("option", { name: LAB_PROFILE }).click();
  await expect(profile).toContainText("Maquininha do laboratório");

  await page.getByRole("button", { name: "Adicionar ajuste" }).click();
  const adjustment = page.getByRole("group", { exact: true, name: "Ajuste 1" });
  await adjustment
    .getByRole("combobox", { exact: true, name: "Tipo de ajuste" })
    .click();
  await page.getByRole("option", { exact: true, name: "Desconto" }).click();
  await adjustment
    .getByRole("combobox", { exact: true, name: "Como informar" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Percentual (%)" })
    .click();
  await adjustment.getByLabel("Percentual (%)").fill("5");
  const date = page.getByLabel("Data e hora da venda (opcional)");
  await date.fill("2026-10-14T10:30");
  await page.getByRole("button", { name: "Usar agora" }).click();
  await expect(date).toHaveValue("");
  await expect(
    page.getByRole("complementary", { name: "Resumo" })
  ).toContainText("Desconto (5");
}

for (const theme of THEMES) {
  test(`tema ${theme.name}: a Venda abre e cada controle muda de estado sob a CSP de produção sem nenhuma violação`, async ({
    page,
  }) => {
    // the policy really is the strict one: no inline style may slip through
    expect(productionPolicy).toContain("style-src 'self'");
    expect(productionPolicy).not.toContain("unsafe-inline");
    await serveUnderProductionCsp(page);
    const csp = await watchCspViolations(page);
    await openSaleLab(page, theme.stored);
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? DARK : NOT_DARK
    );
    await useEveryControl(page);
    expect(csp.violations()).toEqual([]);
  });
}

/**
 * The touch area of a button: the `::before` of `touch-hit` when it is on (it is positioned from the padding box,
 * inside the border), or the box itself.
 */
function touchArea(element: Locator) {
  return element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const before = getComputedStyle(node, "::before");
    if (before.content === "none" || before.position !== "absolute") {
      return {
        height: box.height,
        left: box.left,
        right: box.right,
        width: box.width,
      };
    }
    const px = (value: string) => Number.parseFloat(value);
    const left = box.left + px(style.borderLeftWidth) + px(before.left);
    const right = box.right - px(style.borderRightWidth) - px(before.right);
    const top = box.top + px(style.borderTopWidth) + px(before.top);
    const bottom = box.bottom - px(style.borderBottomWidth) - px(before.bottom);
    return { height: bottom - top, left, right, width: right - left };
  });
}

test("C-1: o campo da quantidade tem 64 px e deixa 48 px ou mais livres entre as áreas de toque do − e do +", async ({
  page,
}, testInfo) => {
  await openSaleLab(page, "claro");
  const item = await pickShirt(page);
  const field = item.getByLabel("Quantidade");
  const less = await touchArea(
    item.getByRole("button", { name: "Menos uma unidade" })
  );
  const more = await touchArea(
    item.getByRole("button", { name: "Mais uma unidade" })
  );
  const group = (await field.evaluate(
    (node) =>
      node.closest("[data-slot=input-group]")?.getBoundingClientRect().width
  )) as number;

  expect(group).toBe(64);
  const free = more.left - less.right;
  expect(free).toBeGreaterThanOrEqual(48);
  if (testInfo.project.name.includes("mobile")) {
    // with touch the area of each button is 48 × 48 around the 36 px button
    expect(less.width).toBe(48);
    expect(more.height).toBe(48);
    // 64 px of field minus the 6 to 6.5 px each area passes its button (the + has no left border)
    expect(free).toBeLessThanOrEqual(52);
  }
  // the step itself, and − off at 1
  await item.getByRole("button", { name: "Mais uma unidade" }).click();
  await expect(field).toHaveValue("2");
  await field.fill("1");
  await expect(
    item.getByRole("button", { name: "Menos uma unidade" })
  ).toBeDisabled();
});
