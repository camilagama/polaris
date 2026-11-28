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
const HAS_TWO = /2/;
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

const NOW = new Date("2026-10-01T12:00:00-03:00");
const STAMP = NOW.toISOString();

const PROFILE = {
  archivedAt: null,
  createdAt: STAMP,
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [],
  status: "active",
  updatedAt: STAMP,
  version: 1,
};

async function openSaleLab(page: Page, stored: string) {
  await page.clock.setFixedTime(NOW);
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
  const summary = page.getByRole("region", { exact: true, name: "Resumo" });
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
  await adjustment.getByLabel("Percentual", { exact: true }).fill("5");
  // the day on the DatePicker (no datetime-local), the time typed beside it
  const day = page.getByRole("button", { name: "Dia, Escolher data" });
  await day.click();
  await page.getByRole("button", { exact: true, name: "Hoje" }).click();
  const time = page.getByLabel("Hora");
  await expect(time).not.toHaveValue("");
  await time.fill("00:00");
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

test("Alterar data e ajustes: com a altura do painel ainda abrindo, levar um controle à vista não rola o conteúdo dentro do painel", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "no celular o painel abre sem animação de altura"
  );
  await openSaleLab(page, "claro");
  const extras = page.getByRole("button", { name: "Alterar data e ajustes" });
  await expect(extras).toBeVisible();
  // the timeline of the page stands still, so the opening stays at its first frame (height 0, clipped) for as long
  // as the check takes, however slow the machine
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  await extras.click();
  const close = page.getByRole("button", { name: "Fechar data e ajustes" });
  await expect(close).toHaveAttribute("aria-controls", ANY_ID);
  const panel = page.locator(
    `[id="${await close.getAttribute("aria-controls")}"]`
  );
  await expect
    .poll(() =>
      panel.evaluate((node) =>
        node.getAnimations().map((animation) => animation.playState)
      )
    )
    .toEqual(["running"]);
  const scrolled = await panel.evaluate((node) => {
    const add = [...node.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Adicionar ajuste"
    );
    add?.scrollIntoView({ block: "center" });
    return {
      found: add !== undefined,
      height: node.getBoundingClientRect().height,
      scrollTop: node.scrollTop,
    };
  });
  expect(scrolled).toEqual({ found: true, height: 0, scrollTop: 0 });
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await page.getByRole("button", { name: "Adicionar ajuste" }).click();
  await expect(
    page.getByRole("group", { exact: true, name: "Ajuste 1" })
  ).toBeVisible();
});

test("Alterar data e ajustes: com a altura do painel ainda fechando, o conteúdo dentro do painel não rola", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-desktop",
    "no celular o painel fecha sem animação de altura"
  );
  await openSaleLab(page, "claro");
  await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
  const close = page.getByRole("button", { name: "Fechar data e ajustes" });
  await expect(close).toHaveAttribute("aria-controls", ANY_ID);
  const panel = page.locator(
    `[id="${await close.getAttribute("aria-controls")}"]`
  );
  await expect
    .poll(() => panel.evaluate((node) => node.getAnimations().length))
    .toBe(0);
  const openHeight = await panel.evaluate(
    (node) => node.getBoundingClientRect().height
  );
  expect(openHeight).toBeGreaterThan(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  await close.click();
  await expect
    .poll(() =>
      panel.evaluate((node) =>
        node.getAnimations().map((animation) => animation.playState)
      )
    )
    .toEqual(["running"]);
  // the first frame has the full height, where nothing needs to scroll, so the check stands in the middle of the
  // closing: the animation is paused 100 ms in, with the panel shorter than its content
  const measured = await panel.evaluate((node) => {
    const [animation] = node.getAnimations();
    animation?.pause();
    if (animation) {
      animation.currentTime = 100;
    }
    const add = [...node.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Adicionar ajuste"
    );
    add?.scrollIntoView({ block: "center" });
    return {
      found: add !== undefined,
      height: node.getBoundingClientRect().height,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
  });
  expect(measured.found).toBe(true);
  expect(measured.height).toBeGreaterThan(0);
  expect(measured.height).toBeLessThan(openHeight);
  expect(measured.height).toBeLessThan(measured.scrollHeight);
  expect(measured.scrollTop).toBe(0);
});

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

/** The counter has the text on screen and the text a reader says: two spans, so each is checked on its own. */
async function expectCount(count: Locator, visible: string, spoken: string) {
  await expect(count.locator('[aria-hidden="true"]')).toHaveText(visible);
  await expect(count.locator(".sr-only")).toHaveText(spoken);
}

/**
 * Without a variant chosen the panel starts at its first field and draws no counter; the first choice brings the
 * counter in and must leave the heading row and the item exactly where they were.
 */
async function expectCounterDoesNotPushItem(page: Page) {
  const items = page.getByRole("group", { exact: true, name: "Item 1" });
  const addItem = page.getByRole("button", { name: "Adicionar item" });
  const region = page.getByRole("region", { exact: true, name: "Itens" });
  const count = region.locator("[data-slot=items-count]");
  await expect(items.getByLabel("Produto ou variante")).toBeVisible();
  await expect(addItem).toHaveCount(0);
  await expect(count).toHaveCount(0);

  // the "Venda em andamento" bar above the card appears with the first choice, so the gap to the card's own title
  // is what shows whether the counter pushed the item
  const title = page.getByRole("heading", { exact: true, name: "Itens" });
  const header = region.locator("[data-slot=block-header]");
  const top = async () =>
    ((await items.boundingBox())?.y ?? Number.NaN) -
    ((await title.boundingBox())?.y ?? Number.NaN);
  const headerHeight = async () =>
    (await header.boundingBox())?.height ?? Number.NaN;
  const before = await top();
  const headerBefore = await headerHeight();
  await pickShirt(page);
  const quantity = items.getByLabel("Quantidade");
  await expect(quantity).toBeVisible();
  await expectCount(count, "1 linha · 1 unidade", "1 linha, 1 unidade");
  await expect(addItem).toBeVisible();
  const fontSize = (target: Locator) =>
    target.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize)
    );
  const countSize = await fontSize(count);
  const titleSize = await fontSize(title);
  expect(
    countSize,
    "the counter is auxiliary text, smaller than the title it sits beside"
  ).toBeLessThan(titleSize);
  expect(Math.abs((await headerHeight()) - headerBefore)).toBeLessThanOrEqual(
    1
  );
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1);

  await addItem.click();
  await expect(
    page.getByRole("group", { exact: true, name: "Item 2" })
  ).toBeVisible();
  await expectCount(count, "1 linha · 1 unidade", "1 linha, 1 unidade");
}

test("a venda vazia não mostra o contador nem Adicionar item, e escolher o 1º produto não empurra o item", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  await expectCounterDoesNotPushItem(page);
});

test("a 360 px, escolher o 1º produto não muda a altura do cabeçalho de Itens nem empurra o item", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await openSaleLab(page, "claro");
  await expectCounterDoesNotPushItem(page);
});

test("Itens, Pagamento e Resumo são anunciados uma vez só pelo nome: região sem grupo nem complementar com o mesmo nome", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  const names = ["Itens", "Pagamento", "Resumo"];
  await Promise.all(
    names.flatMap((name) => [
      expect(page.getByRole("region", { exact: true, name })).toHaveCount(1),
      expect(page.getByRole("group", { exact: true, name })).toHaveCount(0),
      expect(
        page.getByRole("complementary", { exact: true, name })
      ).toHaveCount(0),
    ])
  );
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
  // in one column the notice is far above the bar that was tapped: the focus goes to it
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

for (const width of [360, 1280]) {
  test(`a ${width} px, Adicionar item (clique e Enter) leva o foco à busca de produto do item novo e a linha continua a última`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width });
    await openSaleLab(page, "claro");
    await pickShirt(page);
    const addItem = page.getByRole("button", { name: "Adicionar item" });
    for (const how of ["clique", "Enter"] as const) {
      const number = how === "clique" ? 2 : 3;
      if (how === "clique") {
        // biome-ignore lint/performance/noAwaitInLoops: the second add starts from the first one's result
        await addItem.click();
      } else {
        await addItem.focus();
        await page.keyboard.press("Enter");
      }
      const added = page.getByRole("group", {
        exact: true,
        name: `Item ${number}`,
      });
      const search = added.getByRole("combobox", {
        name: "Produto ou variante",
      });
      await expect(search).toBeFocused();
      await expect(search).toHaveAttribute("aria-expanded", "false");
      const itemBox = await added.boundingBox();
      const addBox = await addItem.boundingBox();
      expect(addBox?.y ?? 0).toBeGreaterThanOrEqual(
        (itemBox?.y ?? Number.POSITIVE_INFINITY) + (itemBox?.height ?? 0)
      );
    }
  });
}

const NON_BLANK = /\S/;
const SINGLE_PAYMENT_TEXT =
  "Um pagamento no valor total. Para receber de dois jeitos, use Dividir pagamento. O método não comprova o recebimento.";

/** Under "Pagamento" the two explanations are in the (i) of the title, whole, and not on the screen. */
async function expectPaymentTip(page: Page) {
  await expect(page.getByText(SINGLE_PAYMENT_TEXT)).toHaveCount(0);
  await expect(page.getByText("Um pagamento só")).toHaveCount(0);
  await page
    .getByRole("button", { exact: true, name: "Sobre Pagamento" })
    .click();
  const popup = page.getByRole("dialog", { name: "Pagamento" });
  await expect(popup).toBeVisible();
  expect((await popup.innerText()).replace(/\s+/g, " ")).toBe(
    `Pagamento ${SINGLE_PAYMENT_TEXT}`
  );
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
}

test("Vender: sem venda lembrada nada fica sob os métodos, e as duas frases do Pagamento estão no (i) do título", async ({
  page,
}) => {
  await openSaleLab(page, "claro");
  const methods = page.getByRole("radiogroup", { name: "Método de pagamento" });
  await expect(methods).not.toHaveAccessibleDescription(NON_BLANK);
  await expectPaymentTip(page);
});

test('um "Sem perfil" lembrado numa loja com perfil ativo: a venda seguinte vem com o método marcado e o perfil em branco, e não vira venda em andamento', async ({
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

  await expect(methods.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(methods.getByRole("radio", { name: "Dinheiro" })).toBeChecked();
  await expect(profile).not.toContainText("Sem perfil de pagamento");
  await expect(
    page.getByText("Igual à última venda neste aparelho.")
  ).toBeVisible();
  await expect(methods).toHaveAccessibleDescription(
    "Igual à última venda neste aparelho."
  );
  await expectPaymentTip(page);
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
});

const DESKTOP_ONLY = "o número e a tecla só existem com ponteiro fino";

function methodGroup(page: Page): Locator {
  return page.getByRole("radiogroup", { name: "Método de pagamento" });
}

test("Pagamento: com o foco no grupo a tecla do número escolhe a forma; fora do grupo e em campo de texto, não", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), DESKTOP_ONLY);
  await openSaleLab(page, "claro");
  const methods = methodGroup(page);
  const chosen = methods.locator('[role="radio"][aria-checked="true"]');
  const search = page.getByLabel("Produto ou variante");
  await search.focus();
  await page.keyboard.press("2");
  await expect(search).toHaveValue(HAS_TWO);
  await expect(chosen).toHaveCount(0);
  await search.fill("");
  await page.keyboard.press("Escape");
  const item = await pickShirt(page);
  const pix = methods.getByRole("radio", { name: "Pix" });
  const cash = methods.getByRole("radio", { name: "Dinheiro" });
  const debit = methods.getByRole("radio", { name: "Débito" });

  await pix.focus();
  await page.keyboard.press("2");
  await expect(cash).toBeChecked();
  await expect(cash).toBeFocused();
  await page.keyboard.press("4");
  await expect(debit).toBeChecked();
  await expect(debit).toBeFocused();

  const price = item.getByLabel("Preço cobrado");
  await price.fill("");
  await price.focus();
  await page.keyboard.press("2");
  await expect(price).toHaveValue("2");
  await expect(debit).toBeChecked();

  await page.getByRole("heading", { exact: true, name: "Nova venda" }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("2");
  await expect(debit).toBeChecked();
  await expect(cash).not.toBeChecked();

  await debit.focus();
  await page.keyboard.press("Control+2");
  await page.keyboard.press("Alt+2");
  await page.keyboard.press("0");
  await expect(debit).toBeChecked();
});

test("Pagamento: as setas e o espaço andam entre as formas como antes, e o grupo segue radiogroup com o mesmo nome", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), DESKTOP_ONLY);
  await openSaleLab(page, "claro");
  const methods = methodGroup(page);
  await expect(methods).toHaveAttribute("aria-label", "Método de pagamento");
  const pix = methods.getByRole("radio", { name: "Pix" });
  const cash = methods.getByRole("radio", { name: "Dinheiro" });
  await pix.focus();
  await page.keyboard.press("Space");
  await expect(pix).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(cash).toBeChecked();
  await expect(cash).toBeFocused();
});

test("Pagamento: cada forma traz o número decorativo e aria-keyshortcuts, o nome não muda e o cartão não cresce", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), DESKTOP_ONLY);
  await openSaleLab(page, "claro");
  const methods = methodGroup(page);
  const radios = methods.getByRole("radio");
  await expect(radios).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one option after the other
    await expect(radios.nth(index)).toHaveAttribute(
      "aria-keyshortcuts",
      String(index + 1)
    );
  }
  const names = [
    "Pix",
    "Dinheiro",
    "Crédito",
    "Débito",
    "Transferência",
    "Outro",
  ];
  for (const name of names) {
    // biome-ignore lint/performance/noAwaitInLoops: one name after the other
    await expect(methods.getByRole("radio", { exact: true, name })).toHaveCount(
      1
    );
  }
  const keys = methods.locator("[data-method-key]");
  await expect(keys).toHaveCount(6);
  await expect(keys.first()).toHaveAttribute("aria-hidden", "true");

  const card = page
    .locator('[data-slot="card-frame"]')
    .filter({ has: methods })
    .first();
  const heights = async () =>
    card.evaluate((node) => node.getBoundingClientRect().height);
  for (const width of [760, 900, 1024, 1280, 1536]) {
    // biome-ignore lint/performance/noAwaitInLoops: the layout is measured width by width
    await page.setViewportSize({ height: 900, width });
    if (width >= 1280) {
      await expect(keys.first()).toBeVisible();
    }
    const withKeys = await heights();
    await keys.evaluateAll((nodes) => {
      for (const node of nodes) {
        (node as HTMLElement).style.display = "none";
      }
    });
    const without = await heights();
    await keys.evaluateAll((nodes) => {
      for (const node of nodes) {
        (node as HTMLElement).style.display = "";
      }
    });
    expect(Math.abs(withKeys - without), `${width} px`).toBeLessThanOrEqual(1);
  }
});

test("Pagamento: abaixo de 760 px ou com toque não há número, aria-keyshortcuts nem tecla", async ({
  page,
}, testInfo) => {
  await openSaleLab(page, "claro");
  if (!testInfo.project.name.includes("mobile")) {
    await page.setViewportSize({ height: 800, width: 740 });
  }
  const methods = methodGroup(page);
  await expect(methods.getByRole("radio")).toHaveCount(6);
  await expect(methods.locator("[data-method-key]")).toHaveCount(0);
  await expect(methods.locator("[aria-keyshortcuts]")).toHaveCount(0);
  const pix = methods.getByRole("radio", { name: "Pix" });
  await pix.focus();
  await page.keyboard.press("2");
  await expect(methods.getByRole("radio", { checked: true })).toHaveCount(0);
});

const LAB_ROW_LABELS = [
  { option: SHIRT_OPTION, search: "camiseta azul" },
  { option: /Camiseta do laboratório · Vermelha/, search: "camiseta vermelha" },
  { option: SHIRT_OPTION, search: "camiseta azul" },
] as const;

async function pickLines(page: Page) {
  await page.getByLabel("Rede disponível").uncheck();
  for (const [index, row] of LAB_ROW_LABELS.entries()) {
    if (index > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: one line after the other, each opens from the one before
      await page.getByRole("button", { name: "Adicionar item" }).click();
    }
    const item = page.getByRole("group", {
      exact: true,
      name: `Item ${index + 1}`,
    });
    await item.getByLabel("Produto ou variante").fill(row.search);
    await page.getByRole("option", { name: row.option }).click();
    await expect(item.getByLabel("Quantidade")).toBeVisible();
  }
  await page.getByLabel("Rede disponível").check();
}

/** How far below the window the first screen of the sale leaves "Confirmar venda": zero or less means it shows. */
async function confirmOverflow(page: Page): Promise<number> {
  const confirm = page
    .getByRole("region", { exact: true, name: "Resumo" })
    .getByRole("button", { name: "Confirmar venda" });
  await expect(confirm).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  return confirm.evaluate(
    (node) => node.getBoundingClientRect().bottom - window.innerHeight
  );
}

/**
 * "Confirmar venda" sits 303 px above the bottom of the window in this lab on the main before the blocks (497 of 800 px):
 * it must show, and the blocks may push it down by 24 px at most.
 */
const CONFIRM_ROOM_BEFORE = 303;
const CONFIRM_ROOM_BUDGET = 24;

test("AC-7.1: a 1280 × 800, com 3 itens e o pagamento fechado, o botão Confirmar venda aparece sem rolar e desce no máximo 24 px", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "a janela é de mesa");
  await page.setViewportSize({ height: 800, width: 1280 });
  await openSaleLab(page, "claro");
  await pickLines(page);
  await expect(
    page.getByRole("group", { exact: true, name: "Item 3" })
  ).toBeVisible();
  const overflow = await confirmOverflow(page);
  testInfo.annotations.push({
    description: `${overflow.toFixed(1)} px`,
    type: "confirmar-abaixo-da-janela",
  });
  expect(overflow).toBeLessThanOrEqual(0);
  expect(-overflow).toBeGreaterThanOrEqual(
    CONFIRM_ROOM_BEFORE - CONFIRM_ROOM_BUDGET
  );
});
