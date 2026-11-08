/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { FORM_VIEWPORTS } from "./date-pickers";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The foot of the sales history, "Total na tela", in the lab of the screens over the real offline runtime with the
 * list answered by the test: the sum of the confirmed sales shown, the same height with and without sales (no more
 * than 1 px), and the figures in tabular numerals on the right edge.
 */
const NOW = "2026-10-14T12:00:00.000Z";
const TABULAR_NUMS = /tabular-nums/;
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

/** The list is answered when `gate` opens, so the loading state can be measured. */
async function openHistory(
  page: Page,
  sales: unknown[],
  options: { gate?: Promise<void>; hasMore?: boolean } = {}
) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", async (route: Route) => {
    await options.gate;
    await route.fulfill({
      body: JSON.stringify({
        json: { hasMore: options.hasMore ?? false, sales },
        meta: [],
      }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    });
  });
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible({ timeout: 20_000 });
  const footer = page.locator("[data-list-total]");
  await expect(footer).toBeVisible();
  return footer;
}

const heightOf = async (footer: Locator) => {
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();
  return box?.height ?? 0;
};

for (const viewport of VIEWPORTS) {
  test.describe(`a ${viewport.name} px`, () => {
    test.use({ viewport });

    test("o rodapé soma as confirmadas, termina sob os valores das linhas e tem a mesma altura carregando, com e sem vendas", async ({
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

      const total = footer.locator(".tabular-nums");
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

      const empty = await heightOf(await openHistory(page, []));
      await expect(page.locator("[data-list-total]")).toContainText("R$ 0,00");
      await expect(page.locator("[data-list-total]")).toContainText("0 vendas");
      expect(Math.abs(empty - filled)).toBeLessThanOrEqual(1);
      expect(Math.abs(loading - filled)).toBeLessThanOrEqual(1);
    });
  });
}
