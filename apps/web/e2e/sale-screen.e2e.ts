/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The sale screen on the components of src/ui (ADR 0103, PR 4), in the lab of the offline screens:
 * - condition 2 of the ADR repeated on the screen itself: every control of the sale opens and changes state
 *   under the production Content-Security-Policy with zero violations, in the light and in the dark theme;
 * - condition C-1: the quantity field is 64 px wide and leaves at least 48 px free between the touch areas of
 *   its − and + buttons.
 */
const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const LAB_PROFILE = /Maquininha do laboratório/;
const ANY_ID = /.+/;
const FIX_FIELDS = /Corrija \d+ campos?/;

const THEMES = [
  { dark: false, name: "claro", stored: "claro" },
  { dark: true, name: "escuro", stored: "escuro" },
] as const;

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
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
  await serveLabWorker(page);
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
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Rede disponível").check();
  return item;
}

async function useEveryControl(page: Page) {
  const summary = page.getByRole("complementary", { name: "Resumo" });
  // the summary shows only what was chosen: nothing yet, so no payment, profile or date line
  await expect(summary).not.toContainText("Perfil de pagamento");
  await expect(summary).not.toContainText("ainda não escolhido");
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
    .getByRole("combobox", { exact: true, name: "Quem parcela" })
    .click();
  await page.getByRole("option", { exact: true, name: "Lojista (eu)" }).click();
  const profile = page.getByRole("combobox", {
    exact: true,
    name: "Perfil de pagamento",
  });
  await profile.click();
  await page.getByRole("option", { name: LAB_PROFILE }).click();
  await expect(profile).toContainText("Maquininha do laboratório");

  // date and adjustments are closed in one line until "Alterar"
  const extras = page.getByRole("button", { name: "Alterar data e ajustes" });
  await expect(extras).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Agora · Sem ajuste")).toBeVisible();
  await extras.click();
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
  // the day on the DatePicker (no datetime-local), the time typed beside it
  const day = page.getByRole("button", { name: "Dia, Escolher data" });
  await day.click();
  await page.getByRole("button", { exact: true, name: "Hoje" }).click();
  const time = page.getByLabel("Hora");
  await expect(time).not.toHaveValue("");
  await time.fill("08:00");
  await expect(summary).toContainText("Data e hora da venda");
  await page.getByRole("button", { name: "Usar agora" }).click();
  await expect(time).toHaveValue("");
  await expect(day).toBeVisible();
  await expect(summary).not.toContainText("Data e hora da venda");
  await expect(summary).toContainText("Desconto (5");
  // two live regions, each read whole when it changes: the preview of fees (P-4) and the total due
  const live = summary.locator("[aria-live]");
  await expect(live).toHaveCount(2);
  await expect(live.first()).toHaveAttribute("aria-atomic", "true");
  await expect(live.last()).toHaveAttribute("aria-atomic", "true");
  await expect(live.last()).toContainText("Total devido");
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
    // with touch each button is 44 × 44 (as tall as the field beside it), so its area is its box
    expect(less.width).toBe(44);
    expect(more.height).toBe(44);
    expect(free).toBeLessThanOrEqual(64);
  }
  // the step itself, and − off at 1
  await item.getByRole("button", { name: "Mais uma unidade" }).click();
  await expect(field).toHaveValue("2");
  await field.fill("1");
  await expect(
    item.getByRole("button", { name: "Menos uma unidade" })
  ).toBeDisabled();
});

async function chooseNoProfile(page: Page) {
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await page
    .getByRole("option", { exact: true, name: "Sem perfil de pagamento" })
    .click();
}

/**
 * The sale screen never goes past the window sideways: no card, alert, button or the bar at the bottom ends
 * beyond its right edge (the page itself may hide the overflow, so the boxes are measured, not scrollWidth).
 */
async function expectNoSidewaysScroll(page: Page) {
  const found = await page.evaluate(() => {
    // the root of the screen: the title "Nova venda" is its first child
    const root = [...document.querySelectorAll("h1")].find(
      (heading) => heading.textContent === "Nova venda"
    )?.parentElement;
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
  expect(found.measured).toBeGreaterThan(100);
  expect(found.past).toEqual([]);
}

test("a 320 px nada transborda: venda guardada no aparelho, venda travada e falha em foco", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 320 });
  // the server reads answer; the sale itself never gets an answer
  await page.route("**/rpc/sale/confirm", (route) =>
    route.abort("connectionreset")
  );
  await openSaleLab(page, "claro");

  // without a network: the bar carries "Guardar venda neste aparelho"
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  const methods = page.getByRole("radiogroup", { name: "Método de pagamento" });
  await item.getByLabel("Quantidade").fill("1");
  await methods.getByRole("radio", { name: "Pix" }).check();
  await chooseNoProfile(page);
  await expectNoSidewaysScroll(page);
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  await expectNoSidewaysScroll(page);

  // with the network back the sale goes to the server, which never answers: locked
  await pickShirt(page);
  await page
    .getByRole("group", { exact: true, name: "Item 1" })
    .getByLabel("Quantidade")
    .fill("1");
  await methods.getByRole("radio", { name: "Pix" }).check();
  await chooseNoProfile(page);
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  const keep = page.getByRole("button", {
    name: "Guardar esta venda neste aparelho",
  });
  await expect(keep).toBeVisible();
  // below 900 px the notice is far above the bar that was tapped: the focus goes to it
  await expect(page.getByRole("alert").filter({ has: keep })).toBeVisible();
  await expect(page.locator(":focus").filter({ has: keep })).toHaveCount(1);
  await expectNoSidewaysScroll(page);
});

test("a busca fica fechada ao abrir, abre no foco como popup sobre o formulário, e o teclado escolhe sem enviar a venda", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  // the variants come from this device's collections, which the lab fills
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  const search = item.getByRole("combobox", { name: "Produto ou variante" });
  const list = page.getByRole("listbox", { name: "Variantes encontradas" });
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(list).toHaveCount(0);
  // quantity and prices only after the choice
  await expect(item.getByLabel("Quantidade")).toHaveCount(0);
  await expect(item.getByLabel("Preço cobrado")).toHaveCount(0);

  // by id: while the list is open, Base UI hides the rest of the page from the screen reader (aria-hidden)
  const payment = page.locator("#sale-payment-title");
  const before = await payment.boundingBox();
  // the focus alone (Tab) does not open it; a touch or click on the field does
  await search.focus();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await search.click();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("option").first()).toBeVisible();
  // the list floats over the form: nothing under the search moved
  expect(await payment.boundingBox()).toEqual(before);
  await expect(search).toHaveAttribute("aria-controls", ANY_ID);

  await search.fill("camiseta azul");
  const shirt = list.getByRole("option", { name: SHIRT_OPTION });
  await expect(shirt).toBeVisible();
  // Escape closes the list and keeps the text; typing opens it again
  await search.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  await expect(search).toHaveValue("camiseta azul");
  await search.press("ArrowDown");
  await expect(shirt).toBeVisible();
  // Enter chooses the highlighted option and never submits the sale
  await expect(shirt).toHaveAttribute("data-highlighted", "");
  await search.press("Enter");
  await expect(item.getByLabel("Quantidade")).toBeFocused();
  await expect(
    item.getByText("Camiseta do laboratório · Azul", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(FIX_FIELDS)).toHaveCount(0);
  await expect(
    item.getByRole("button", {
      name: "Mais uma unidade de Camiseta do laboratório · Azul",
    })
  ).toBeVisible();
});

test("Trocar abre a busca com a variante atual marcada; Escape volta à linha como estava", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  const item = await pickShirt(page);
  await page.getByLabel("Rede disponível").uncheck();
  await item.getByLabel("Quantidade").fill("3");
  const change = item.getByRole("button", {
    name: "Trocar variante de Camiseta do laboratório · Azul",
  });
  await change.click();
  const search = item.getByRole("combobox", { name: "Produto ou variante" });
  await expect(search).toBeFocused();
  const current = page
    .getByRole("listbox", { name: "Variantes encontradas" })
    .getByRole("option", { name: SHIRT_OPTION });
  await expect(current).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await expect(change).toBeFocused();
  await expect(item.getByLabel("Quantidade")).toHaveValue("3");
});

test("a venda seguinte começa com o método e o perfil da última deste aparelho, sem virar venda em andamento", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  const methods = page.getByRole("radiogroup", { name: "Método de pagamento" });
  const profile = page.getByRole("combobox", {
    exact: true,
    name: "Perfil de pagamento",
  });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  await item.getByLabel("Preço cobrado").fill("45,00");
  await methods.getByRole("radio", { name: "Dinheiro" }).check();
  await chooseNoProfile(page);
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();

  await expect(methods.getByRole("radio", { name: "Dinheiro" })).toBeChecked();
  await expect(profile).toContainText("Sem perfil de pagamento");
  await expect(
    page.getByText("Igual à última venda neste aparelho.")
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Venda em andamento" })
  ).toHaveCount(0);
  // the repeated sale: the product and the button
  await item.getByLabel("Produto ou variante").click();
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  const charged = item.getByLabel("Preço cobrado");
  if ((await charged.inputValue()) === "") {
    await charged.fill("45,00");
  }
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
});
