/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";
import { WORKER_MARK } from "./worker-mark";

/**
 * The stock screen on the components of src/ui (ADR 0103, t194), in the lab of the offline screens:
 * - condition 2 of the ADR repeated on the screen itself: every control of the screen opens and changes state
 *   under the production Content-Security-Policy with zero violations, in the light and in the dark theme;
 * - the focus: the first field when a command opens, the first invalid one after "Revisar", the status after the
 *   movement is recorded, and the row's button when the panel closes;
 * - at 320 px nothing goes past the window sideways, in the list and with a panel open.
 */
const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const RECEIVE_JEANS = "Receber estoque de Calça jeans, 42";
const WRITE_OFF_JEANS = "Baixar estoque de Calça jeans, 42";
const COUNT_SHIRT = "Contar estoque de Camiseta do teste, Azul";

const THEMES = [
  { dark: false, name: "claro", stored: "claro" },
  { dark: true, name: "escuro", stored: "escuro" },
] as const;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  headers: { ...WORKER_MARK },
  contentType: "application/json",
});

const SHIRT = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId: "0199c2d0-0000-7000-8000-0000000000f1",
  productName: "Camiseta do teste",
  productStatus: "active",
  quantity: 5,
  sku: "CAM-AZ-M",
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: [{ optionName: "cor", optionValueName: "Azul" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  version: 1,
};
const JEANS = {
  ...SHIRT,
  movingAverageCost: "62.400000",
  productId: "0199c2d0-0000-7000-8000-0000000000f3",
  productName: "Calça jeans",
  quantity: 3,
  sku: null,
  values: [{ optionName: "tamanho", optionValueName: "42" }],
  variantId: "0199c2d0-0000-7000-8000-0000000000b3",
};
const MUG = {
  ...SHIRT,
  productId: "0199c2d0-0000-7000-8000-0000000000f2",
  productName: "Caneca esmaltada",
  productStatus: "archived",
  quantity: 0,
  sku: null,
  values: [],
  variantId: "0199c2d0-0000-7000-8000-0000000000b2",
};

async function openStockLab(page: Page, stored: string) {
  await page.addInitScript((theme) => {
    window.localStorage.setItem("polaris-tema", theme);
  }, stored);
  // the lab has no server: the list comes from here, and it answers by the filters the screen sent
  await page.route("**/rpc/inventory/listBalances", (route) => {
    const body = route.request().postData() ?? "";
    const all = body.includes('"productStatus":"all"');
    const entries = all ? [SHIRT, JEANS, MUG] : [SHIRT, JEANS];
    return route.fulfill(rpc({ entries, nextCursor: null }));
  });
  await page.route("**/rpc/inventory/receiveStock", (route) =>
    route.fulfill(
      rpc({
        balance: {
          movingAverageCost: "12.500000",
          quantity: 15,
          variantId: JEANS.variantId,
          version: 2,
        },
        movement: { createdAt: "2026-10-15T15:00:01.000Z" },
        replayed: false,
      })
    )
  );
  await page.goto("/offline-screens-lab?screen=stock");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Estoque" })
  ).toBeVisible();
  await expect(page.getByText("2 variantes")).toBeVisible();
}

async function useEveryControl(page: Page) {
  // the filters: the balance, the archived products (the mug has no balance and is archived) and the search
  const filter = page.getByRole("group", { name: "Filtrar por saldo" });
  await filter.getByRole("button", { name: "Sem saldo" }).click();
  await expect(
    filter.getByRole("button", { name: "Sem saldo" })
  ).toHaveAttribute("aria-pressed", "true");
  await filter.getByRole("button", { name: "Todas" }).click();
  await page
    .getByRole("checkbox", { name: "Incluir produtos arquivados" })
    .click();
  await expect(page.getByText("3 variantes")).toBeVisible();
  await expect(page.getByText("Arquivado", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("listitem").getByText("Sem saldo", { exact: true })
  ).toBeVisible();
  await page.getByLabel("Buscar").fill("camiseta");
  await page.getByRole("button", { name: "Atualizar" }).click();

  // a receipt: the stepper, the review, the confirmation, the record
  await page.getByRole("button", { name: RECEIVE_JEANS }).click();
  const quantity = page.getByLabel("Quantidade recebida");
  await expect(quantity).toBeFocused();
  await page.getByRole("button", { name: "Mais uma unidade" }).click();
  await expect(quantity).toHaveValue("1");
  await quantity.fill("10");
  await page.getByLabel("Custo unitário (R$)").fill("12,50");
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await expect(
    page.getByText("muda o custo médio", { exact: false })
  ).toBeVisible();
  await page.getByRole("button", { name: "Voltar" }).click();
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();
  await expect(page.getByText("Saldo: 15 unidades")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Receber estoque" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Fechar" }).click();
  await expect(page.getByRole("button", { name: RECEIVE_JEANS })).toBeFocused();

  // a count (the valuation field, as the cost is unknown) and a write-off (the choice list and the note)
  await page.getByRole("button", { name: COUNT_SHIRT }).click();
  await expect(
    page.getByLabel("Custo unitário para valoração (R$)")
  ).toBeVisible();
  await page.getByRole("button", { name: "Fechar" }).click();
  await page.getByRole("button", { name: WRITE_OFF_JEANS }).click();
  await page
    .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Outro (descreva)" })
    .click();
  await expect(
    page.getByLabel("Observação (obrigatória para “Outro”)")
  ).toBeVisible();
  await page
    .getByLabel("Observação (obrigatória para “Outro”)")
    .fill("Caiu da prateleira");
  await page.getByRole("button", { name: "Fechar" }).click();
}

for (const theme of THEMES) {
  test(`tema ${theme.name}: o Estoque abre e cada controle muda de estado sob a CSP de produção sem nenhuma violação`, async ({
    page,
  }) => {
    // the policy really is the strict one: no inline style may slip through
    expect(productionPolicy).toContain("style-src 'self'");
    expect(productionPolicy).not.toContain("unsafe-inline");
    await serveUnderProductionCsp(page);
    const csp = await watchCspViolations(page);
    await openStockLab(page, theme.stored);
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? DARK : NOT_DARK
    );
    await useEveryControl(page);
    expect(csp.violations()).toEqual([]);
  });
}

test("a revisão vazia leva o foco ao primeiro campo inválido, e o campo diz o erro", async ({
  page,
}) => {
  await openStockLab(page, "claro");
  await page.getByRole("button", { name: RECEIVE_JEANS }).click();
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  const quantity = page.getByLabel("Quantidade recebida");
  await expect(quantity).toBeFocused();
  await expect(quantity).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Informe a quantidade recebida.")).toBeVisible();
  // the − is off while the field is empty, and the + starts at 1
  await expect(
    page.getByRole("button", { name: "Menos uma unidade" })
  ).toBeDisabled();
});

test("a 320 px nada transborda: a lista, o painel aberto e a revisão", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 320 });
  await openStockLab(page, "claro");
  const sideways = async () => {
    const found = await page.evaluate(() => {
      const root = document.querySelector("[data-ui]");
      const limit = window.innerWidth + 0.5;
      const boxes = [...(root?.querySelectorAll("*") ?? [])].map((element) => ({
        right: element.getBoundingClientRect().right,
        text: (element.textContent ?? "").trim().slice(0, 40),
      }));
      return {
        measured: boxes.length,
        past: boxes.filter((box) => box.right > limit),
      };
    });
    // nothing passes vacuously: the screen is there and was measured
    expect(found.measured).toBeGreaterThan(40);
    expect(found.past).toEqual([]);
  };
  await sideways();
  await page.getByRole("button", { name: WRITE_OFF_JEANS }).click();
  await sideways();
  await page.getByLabel("Quantidade a baixar").fill("2");
  await page
    .getByRole("combobox", { exact: true, name: "Motivo da baixa" })
    .click();
  await page.getByRole("option", { exact: true, name: "Avariado" }).click();
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await expect(
    page.getByRole("button", { name: "Confirmar baixa" })
  ).toBeVisible();
  await sideways();
});

test("a baixa sem motivo leva o foco à lista de motivos", async ({ page }) => {
  await openStockLab(page, "claro");
  await page.getByRole("button", { name: WRITE_OFF_JEANS }).click();
  await page.getByLabel("Quantidade a baixar").fill("1");
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  const reason = page.getByRole("combobox", {
    exact: true,
    name: "Motivo da baixa",
  });
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Escolha o motivo da baixa.")).toBeVisible();
});
