/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  productionPolicy,
  serveUnderProductionCsp,
  watchCspViolations,
} from "./csp-fixture";
import {
  datePickerButton,
  FORM_VIEWPORTS,
  openDatePicker,
  touchDay,
} from "./date-pickers";
import { expectTabsKeyboard } from "./tabs-keyboard";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

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
  contentType: "application/json",
  headers: { ...WORKER_MARK },
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

interface OpenOptions {
  /** What the screen shows when it is ready (the count line). */
  count?: string;
  /** Appended to the address of the lab: `&filtro=sem-custo`. */
  search?: string;
}

/** The bodies of the reads the screen sent, in order (what each filter asked the server for). */
let listRequests: string[] = [];

async function openStockLab(
  page: Page,
  stored: string,
  { count = "2 variantes", search = "" }: OpenOptions = {}
) {
  listRequests = [];
  await page.addInitScript((theme) => {
    window.localStorage.setItem("polaris-tema", theme);
  }, stored);
  // the lab has no server: the list comes from here, and it answers by the filters the screen sent
  await page.route("**/rpc/inventory/listBalances", (route) => {
    const body = route.request().postData() ?? "";
    listRequests.push(body);
    if (body.includes('"cost":"unknown"')) {
      return route.fulfill(rpc({ entries: [SHIRT], nextCursor: null }));
    }
    if (body.includes('"stock":"without_stock"')) {
      return route.fulfill(rpc({ entries: [], nextCursor: null }));
    }
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
  await serveLabWorker(page);
  await page.goto(`/offline-screens-lab?screen=stock${search}`);
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Estoque" })
  ).toBeVisible();
  await expect(page.getByText(count)).toBeVisible();
}

async function useEveryControl(page: Page) {
  // the filters: the balance, the archived products (the mug has no balance and is archived) and the search
  const filter = page.getByRole("tablist", { name: "Filtrar por saldo" });
  await filter.getByRole("tab", { name: "Sem saldo" }).click();
  await expect(filter.getByRole("tab", { name: "Sem saldo" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await filter.getByRole("tab", { name: "Todas" }).click();
  await page
    .getByRole("checkbox", { name: "Incluir produtos arquivados" })
    .click();
  await expect(page.getByText("3 variantes")).toBeVisible();
  await expect(page.getByText("Arquivado", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("listitem").getByText("Sem saldo", { exact: true })
  ).toBeVisible();
  await page.getByLabel("Buscar no estoque").fill("camiseta");
  await page.getByRole("button", { name: "Limpar busca" }).click();
  await expect(page.getByLabel("Buscar no estoque")).toHaveValue("");
  await expect(page.getByLabel("Buscar no estoque")).toBeFocused();
  await page.getByLabel("Buscar no estoque").fill("camiseta");
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

const stockFilter = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "Filtrar por saldo" })
    .getByRole("tab", { name });
const unknownCostFilter = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Sem custo" });

test("as abas de saldo: setas trocam de aba, Tab sai do grupo e o leitor de tela lê aba selecionada", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "o teclado é o do desktop"
  );
  await openStockLab(page, "claro");
  await expectTabsKeyboard(page, "Filtrar por saldo", ["Todas", "Com saldo"]);
  // the arrows chose the tab: the list was asked again with the filter, and back to the plain one
  await expect.poll(() => listRequests.at(-1) ?? "").toContain('"stock":"all"');
  expect(
    listRequests.some((body) => body.includes('"stock":"with_stock"'))
  ).toBe(true);
});

/** What the person can read or a script of the page could read back: the body without its scripts. */
const bodyMarkup = (page: Page) =>
  page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const script of copy.querySelectorAll("script")) {
      script.remove();
    }
    return copy.innerHTML;
  });

test("?filtro=sem-custo abre a lista só com o que não tem custo, pedida ao servidor, e o botão aparece marcado", async ({
  page,
}) => {
  await openStockLab(page, "claro", {
    count: "1 variante",
    search: "&filtro=sem-custo",
  });
  await expect(unknownCostFilter(page)).toHaveAttribute("aria-pressed", "true");
  await expect(stockFilter(page, "Todas")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText("Camiseta do teste")).toBeVisible();
  await expect(page.getByText("Calça jeans")).toHaveCount(0);
  // the server filters: the first read already carries it, and the stock filter is left open
  expect(listRequests[0]).toContain('"cost":"unknown"');
  expect(listRequests[0]).toContain('"stock":"all"');
  // turning it off goes back to the plain list
  await unknownCostFilter(page).click();
  await expect(unknownCostFilter(page)).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(page.getByText("2 variantes")).toBeVisible();
  expect(listRequests.at(-1)).not.toContain('"cost"');
});

test("'Sem custo' combina com o filtro de saldo na mesma leitura", async ({
  page,
}) => {
  await openStockLab(page, "claro", {
    count: "1 variante",
    search: "&filtro=sem-custo",
  });
  await stockFilter(page, "Sem saldo").click();
  await expect(stockFilter(page, "Sem saldo")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(unknownCostFilter(page)).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => listRequests.at(-1) ?? "")
    .toContain('"stock":"without_stock"');
  expect(listRequests.at(-1)).toContain('"cost":"unknown"');
});

const COUNT_LINE = /^\d+ variantes?/;

test("sem internet com 'Sem custo' marcado: sem contagem e a lista diz que só carrega com conexão", async ({
  page,
}) => {
  await openStockLab(page, "claro", {
    count: "1 variante",
    search: "&filtro=sem-custo",
  });
  // the lab's own checkbox takes the network away; the screen then works from the device
  await page.getByLabel("Rede disponível").uncheck();
  await expect(page.getByText("Sem conexão.")).toBeVisible();
  await expect(unknownCostFilter(page)).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText(
      "Sem internet. A lista de variantes sem custo só carrega com conexão."
    )
  ).toBeVisible();
  // the device does not know how many variants lack a cost: no zero is written
  await expect(page.getByText(COUNT_LINE)).toHaveCount(0);
  await expect(page.getByText("Todas as variantes têm custo.")).toHaveCount(0);
  // with the filter off the device's own list (and its count) is back
  await unknownCostFilter(page).click();
  await expect(page.getByText(COUNT_LINE)).toBeVisible();
});

test("?filtro=sem-saldo abre a lista sem saldo, e a lista vazia diz que todas têm saldo", async ({
  page,
}) => {
  await openStockLab(page, "claro", {
    count: "0 variantes",
    search: "&filtro=sem-saldo",
  });
  await expect(stockFilter(page, "Sem saldo")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(unknownCostFilter(page)).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  expect(listRequests[0]).toContain('"stock":"without_stock"');
  expect(listRequests[0]).not.toContain('"cost"');
  await expect(page.getByText("Todas as variantes têm saldo.")).toBeVisible();
});

for (const value of [
  "",
  "SEM-CUSTO",
  "unknown_cost",
  "<script>alert(1)</script>",
  "valor-que-nao-existe-123",
]) {
  test(`?filtro=${value || "(vazio)"} abre a tela sem filtro e o valor não aparece na tela`, async ({
    page,
  }) => {
    await openStockLab(page, "claro", {
      search: `&filtro=${encodeURIComponent(value)}`,
    });
    await expect(stockFilter(page, "Todas")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(unknownCostFilter(page)).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(listRequests[0]).not.toContain('"cost"');
    expect(listRequests[0]).toContain('"stock":"all"');
    if (value !== "") {
      // not in the text, not in any attribute, not in the title of the tab
      expect(await bodyMarkup(page)).not.toContain(value);
      expect(await page.title()).not.toContain(value);
    }
  });
}

for (const width of [360, 320]) {
  test(`as abas do saldo e o botão 'Sem custo' têm a mesma altura e cabem em ${width} px, com a lista e com o painel aberto`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width });
    await openStockLab(page, "claro", {
      count: "1 variante",
      search: "&filtro=sem-custo",
    });
    const measured = await page.evaluate(() => {
      const group = document.querySelector('[aria-label="Filtrar por saldo"]');
      const own = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Sem custo"
      );
      const tabs = group?.querySelectorAll('[role="tab"]') ?? [];
      const boxes = [group, own].map((item) => item?.getBoundingClientRect());
      return {
        heights: boxes.map((box) => Math.round(box?.height ?? 0)),
        past: [
          ...boxes,
          ...[...tabs].map((tab) => tab.getBoundingClientRect()),
        ].filter(
          (box) => (box?.right ?? Number.POSITIVE_INFINITY) > window.innerWidth
        ).length,
        tabs: tabs.length,
      };
    });
    expect(measured.tabs).toBe(3);
    expect(measured.past).toBe(0);
    expect(new Set(measured.heights).size).toBe(1);
    // the state that opens from the filtered list: a panel on the row, nothing goes past the window
    // from a variant without cost the way forward is a count with the unit cost
    await page.getByRole("button", { name: COUNT_SHIRT }).click();
    await expect(
      page.getByLabel("Custo unitário para valoração (R$)")
    ).toBeVisible();
    const past = await page.evaluate(() => {
      const limit = window.innerWidth + 0.5;
      const heading = [...document.querySelectorAll("h1")].find(
        (item) => item.textContent === "Estoque"
      );
      const boxes = [
        ...(heading?.closest("header")?.parentElement?.querySelectorAll("*") ??
          []),
      ];
      return boxes.filter((box) => box.getBoundingClientRect().right > limit)
        .length;
    });
    expect(past).toBe(0);
  });
}

/** The instant the movement tests fix as "now" (noon of the 15th, UTC: the same day in every zone of the device). */
const FIXED_NOW = new Date("2026-10-15T12:00:00.000Z");

/** A day of the device's calendar, `AAAA-MM-DD`, `offset` days from the fixed "now". */
function deviceDay(offset: number): string {
  const day = new Date(FIXED_NOW);
  day.setDate(day.getDate() + offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

const brDay = (iso: string) => iso.split("-").reverse().join("/");

for (const viewport of FORM_VIEWPORTS) {
  test(`a data do movimento, a ${viewport.name} px: abre em hoje, não deixa escolher o futuro e o servidor recebe o dia escolhido`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(FIXED_NOW);
    await openStockLab(page, "claro");
    const sent: string[] = [];
    await page.route("**/rpc/inventory/receiveStock", (route) => {
      sent.push(route.request().postData() ?? "");
      return route.fallback();
    });
    const today = deviceDay(0);
    const yesterday = deviceDay(-1);
    await page.getByRole("button", { name: RECEIVE_JEANS }).click();
    await expect(datePickerButton(page, "Data")).toHaveAccessibleName(
      `Data, ${brDay(today)}`
    );

    const popup = await openDatePicker(page, "Data");
    // tomorrow cannot be chosen: it is aria-disabled and says why
    const tomorrow = popup.locator(`button[data-day="${deviceDay(1)}"]`);
    await expect(tomorrow).toHaveAttribute("aria-disabled", "true");
    await expect(tomorrow).toHaveAccessibleDescription("Só até hoje");
    await touchDay(popup, yesterday);
    await expect(popup).toBeHidden();
    await expect(datePickerButton(page, "Data")).toHaveAccessibleName(
      `Data, ${brDay(yesterday)}`
    );

    await page.getByLabel("Quantidade recebida").fill("10");
    await page.getByLabel("Custo unitário (R$)").fill("12,50");
    await page.getByRole("button", { exact: true, name: "Revisar" }).click();
    await page.getByRole("button", { name: "Confirmar recebimento" }).click();
    await expect(page.getByText("Saldo: 15 unidades")).toBeVisible();
    expect(sent.join("")).toContain(yesterday);
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
      // the root of the screen: the header with the title is its first child
      const root = [...document.querySelectorAll("h1")]
        .find((heading) => heading.textContent === "Estoque")
        ?.closest("header")?.parentElement;
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

test("sem resposta do servidor, o botão seguro vem primeiro e o descarte vem por último, de contorno (P-13)", async ({
  page,
}) => {
  await openStockLab(page, "claro");
  await page.route("**/rpc/inventory/receiveStock", (route) =>
    route.abort("failed")
  );
  await page.getByRole("button", { name: RECEIVE_JEANS }).click();
  await page.getByLabel("Quantidade recebida").fill("10");
  await page.getByLabel("Custo unitário (R$)").fill("12,50");
  await page.getByRole("button", { exact: true, name: "Revisar" }).click();
  await page.getByRole("button", { name: "Confirmar recebimento" }).click();

  const retry = page.getByRole("button", { name: "Tentar novamente (seguro)" });
  const discard = page.getByRole("button", {
    name: "Descartar esta tentativa",
  });
  await expect(retry).toBeVisible();
  await expect(discard).toBeVisible();
  // the discard is not in the notice any more: it is in the row of actions, after the safe retry
  await expect(
    page.getByRole("alert").getByRole("button", { name: "Descartar" })
  ).toHaveCount(0);
  const buttons = await page
    .locator("form")
    .getByRole("button")
    .allInnerTexts();
  const retryAt = buttons.indexOf("Tentar novamente (seguro)");
  expect(retryAt).toBeGreaterThanOrEqual(0);
  expect(buttons.indexOf("Descartar esta tentativa")).toBeGreaterThan(retryAt);
  expect(buttons.at(-1)).toBe("Descartar esta tentativa");
  // an outline button, not the ink of the safe one
  expect(
    await retry.evaluate((node) => getComputedStyle(node).backgroundColor)
  ).not.toBe(
    await discard.evaluate((node) => getComputedStyle(node).backgroundColor)
  );

  // the discard still asks twice: the question replaces the button, and the retry stays
  await discard.click();
  await expect(
    page.getByRole("button", { name: "Sim, descartar e recomeçar" })
  ).toBeVisible();
  await expect(discard).toHaveCount(0);
  await expect(retry).toBeVisible();
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
