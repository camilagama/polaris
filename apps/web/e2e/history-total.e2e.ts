/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { FORM_VIEWPORTS } from "./date-pickers";
import { applyEditor } from "./filter-bar-editor";
import { expectMono } from "./mono-face";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The foot of the sales history, "Total na tela", in the lab of the screens over the real offline runtime with the
 * list answered by the test: the sum of the confirmed sales shown, the same height with and without sales (no more
 * than 1 px), and the figures in tabular numerals on the right edge.
 */
const NOW = "2026-10-14T12:00:00.000Z";
const TABULAR_NUMS = /tabular-nums/;
/** At 360 px the period footer of a list with rows differs by 18 px in height from the one with no rows: the height proof of the period is the two widths the plan asks, 320 px and 1280 px. */
const PERIOD_WRAP_WIDTH = 360;
const SITUATION_ITEM = /^Situação/;
const id = (n: number) =>
  `0199c2d0-0000-7000-8000-000000001${String(n).padStart(3, "0")}`;

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: id(n),
  itemCount: 2,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "219.90",
  ...overrides,
});

const SALES = [
  entry(1),
  entry(2, { totalDue: "12345.67" }),
  entry(3, { status: "cancelled", totalDue: "5000.00" }),
];

const VIEWPORTS = [
  ...FORM_VIEWPORTS,
  { height: 640, name: "320", width: 320 },
] as const;

interface HistoryOptions {
  /** The sales the list answers for the request; the default answers `sales` whatever was asked. */
  answer?: (asked: { occurredFrom?: string; status?: string }) => unknown[];
  gate?: Promise<void>;
  hasMore?: boolean;
  /** What the server reads for a period alone (the Resultado's figures). */
  period?: { netSales: string; salesCount: number };
  /** False for a store with no sale and no filter: the screen has the empty state, no frame and no total. */
  total?: boolean;
}

/** The list is answered when `gate` opens, so the loading state can be measured. */
async function openHistory(
  page: Page,
  sales: unknown[],
  options: HistoryOptions = {}
) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", async (route: Route) => {
    await options.gate;
    const asked = (
      route.request().postDataJSON() as {
        json: { occurredFrom?: string; status?: string };
      }
    ).json;
    await route.fulfill({
      body: JSON.stringify({
        json: {
          hasMore: options.hasMore ?? false,
          sales: options.answer ? options.answer(asked) : sales,
        },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  if (options.period) {
    await page.route("**/rpc/report/periodSummary", (route: Route) =>
      route.fulfill({
        body: JSON.stringify({
          json: { cards: options.period },
          meta: [],
        }),
        contentType: "application/json",
        headers: { ...WORKER_MARK },
      })
    );
  }
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible({ timeout: 20_000 });
  const footer = page.locator("[data-list-total]");
  if (options.total === false) {
    await expect(page.locator("[data-empty-state]")).toBeVisible();
  } else {
    await expect(footer).toBeVisible();
  }
  return footer;
}

/** The "Situação" pill with "Canceladas", added from the "Filtrar" menu of the bar. */
async function chooseCancelled(page: Page) {
  await page
    .getByRole("search", { exact: true, name: "Filtrar vendas" })
    .getByRole("button", { exact: true, name: "Filtrar" })
    .click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: SITUATION_ITEM })
    .click();
  const editor = page.getByRole("dialog", { name: "Situação" });
  await editor.getByRole("button", { exact: true, name: "Canceladas" }).click();
  await applyEditor(page, editor);
  await expect(editor).toBeHidden();
}

/** The period of the title line, the "7 dias" shortcut: a filter on, with no sale in it. */
async function chooseSevenDays(page: Page) {
  await page.locator('header button[aria-label^="Período"]').click();
  const popup = page.getByRole("dialog", { name: "Período" });
  await popup
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "7 dias" })
    .click();
  await expect(popup).toBeHidden();
}

const heightOf = async (footer: Locator) => {
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();
  return box?.height ?? 0;
};

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.name} px`, () => {
    test.use({ viewport });

    test("o rodapé soma as confirmadas, termina sob os valores das linhas e tem a mesma altura carregando e com vendas", async ({
      page,
    }) => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const footer = await openHistory(page, SALES, { gate, hasMore: true });
      await expect(footer).toContainText("…");
      const loading = await heightOf(footer);

      release?.();
      await expect(footer).toContainText("R$ 12.565,57");
      await expect(footer).toContainText("Total na tela");
      await expect(footer).toContainText("2 vendas · há mais");
      await expect(footer).toContainText("1 cancelada fica fora da soma.");
      const filled = await heightOf(footer);

      const total = footer.locator("div.tabular-nums");
      await expect(total).toHaveCSS("font-variant-numeric", TABULAR_NUMS);
      const rowValue = page
        .getByRole("list", { name: "Vendas" })
        .locator("li")
        .first()
        .locator("[data-money]");
      const totalBox = await total.boundingBox();
      const rowBox = await rowValue.boundingBox();
      expect(totalBox).not.toBeNull();
      expect(rowBox).not.toBeNull();
      // the total ends where the figure of a row ends, so the column reads down to it
      expect(
        Math.abs(
          (totalBox?.x ?? 0) +
            (totalBox?.width ?? 0) -
            ((rowBox?.x ?? 0) + (rowBox?.width ?? 0))
        )
      ).toBeLessThanOrEqual(1);

      expect(Math.abs(loading - filled)).toBeLessThanOrEqual(1);
    });

    test("a loja sem nenhuma venda e sem filtro é só o estado vazio, sem moldura nem total", async ({
      page,
    }) => {
      await openHistory(page, [], { total: false });
      const empty = page.locator("[data-empty-state]");
      await expect(empty).toContainText("Nenhuma venda ainda.");
      await expect(empty).toContainText(
        "Registre a primeira venda para vê-la aqui."
      );
      await expect(
        empty.getByRole("link", { name: "Registrar uma venda" })
      ).toBeVisible();
      await expect(page.locator("[data-list-block]")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { level: 2, name: "Vendas do período" })
      ).toHaveCount(0);
      await expect(page.locator("[data-list-total]")).toHaveCount(0);
    });

    test("o período sem vendas fica na moldura com a frase, Limpar filtros e o total R$ 0,00 da mesma altura do rodapé do período com vendas", async ({
      page,
    }) => {
      await openHistory(page, SALES, {
        period: { netSales: "123.40", salesCount: 3 },
      });
      await chooseSevenDays(page);
      await expect(page.locator("[data-list-total]")).toContainText(
        "R$ 123,40"
      );
      const filled = await heightOf(page.locator("[data-list-total]"));

      const footer = await openHistory(page, SALES, {
        answer: (asked) => (asked.occurredFrom ? [] : SALES),
        period: { netSales: "0.00", salesCount: 0 },
      });
      await chooseSevenDays(page);
      const block = page.locator("[data-list-block]");
      await expect(block).toContainText(
        "Nenhuma venda encontrada com estes filtros."
      );
      await expect(
        block.getByRole("button", { name: "Limpar filtros" })
      ).toBeVisible();
      await expect(footer).toContainText("R$ 0,00");
      await expect(footer).toContainText("0 vendas");
      await expect(page.locator("[data-empty-state]")).toHaveCount(0);
      if (viewport.width !== PERIOD_WRAP_WIDTH) {
        expect(Math.abs((await heightOf(footer)) - filled)).toBeLessThanOrEqual(
          1
        );
      }
    });

    test("o filtro sem resultado fica na moldura com o total na tela R$ 0,00 da mesma altura de com vendas", async ({
      page,
    }) => {
      const filled = await heightOf(await openHistory(page, SALES));
      const footer = await openHistory(page, SALES, {
        answer: (asked) => (asked.status === "cancelled" ? [] : SALES),
      });
      await chooseCancelled(page);
      await expect(page.locator("[data-list-block]")).toContainText(
        "Nenhuma venda encontrada com estes filtros."
      );
      await expect(footer).toContainText("Total na tela");
      await expect(footer).toContainText("R$ 0,00");
      await expect(footer).toContainText("0 vendas");
      expect(Math.abs((await heightOf(footer)) - filled)).toBeLessThanOrEqual(
        1
      );
    });
  });
}

test("o valor de cada linha e o total da lista estão em Geist Mono", async ({
  page,
}) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  const footer = await openHistory(page, SALES);
  await expect(footer).toContainText("R$ 12.565,57");
  await expectMono(
    page
      .getByRole("list", { name: "Vendas" })
      .locator("li")
      .first()
      .locator("[data-money]"),
    "o valor da linha do histórico"
  );
  await expectMono(footer.locator("span.font-mono"), "o total da lista");
});
