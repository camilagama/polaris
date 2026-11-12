import type { Locator, Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, type Journey, runT0, type test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";

export const ZONE = "America/Sao_Paulo";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/** Offline needs the Pro plan and the stack has no provider: the billing record of an active subscription. */
export async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

/** "dd/mm" of a "AAAA-MM-DD". */
function shortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** The days the sales card counts on the first screen of the Resultado: from the 1st of the month to today. */
export function monthToToday(): { from: string; label: string; to: string } {
  const to = localDate(runT0(), ZONE);
  const from = monthStart(to);
  return { from, label: `${shortDate(from)} a ${shortDate(to)}`, to };
}

/**
 * A shop with `today` sales of one candle each, today, and one on the last day of the previous month (outside the
 * period the sales card links to, so the Histórico without a pill lists one more than the card counts).
 */
export async function seedSales(
  journey: Journey,
  today: number,
  withLastMonth = true
): Promise<void> {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const day = localDate(runT0(), ZONE);
  const lastMonthDay = addDays(monthStart(day), -1);
  const candle = await seedProduct(
    rpc,
    organizationId,
    "Vela aromática",
    "45.00"
  );
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    today + 2,
    "12.00",
    lastMonthDay
  );
  const sell = (occurredAt: string) =>
    seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
      occurredAt
    );
  if (withLastMonth) {
    await sell(`${lastMonthDay}T15:00:00.000Z`);
  }
  for (let sale = 0; sale < today; sale += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one sale at a time, each with its own command id
    await sell(new Date(runT0()).toISOString());
  }
}

export const salesCard = (page: Page): Locator =>
  page.locator('[data-kpi="sales"]');

export const sidebar = (page: Page): Locator =>
  page.getByRole("navigation", { exact: true, name: "Principal" });

export const historyRows = (page: Page): Locator =>
  page.getByRole("list", { name: "Vendas" }).getByRole("listitem");

export const periodPill = (page: Page, label: string): Locator =>
  page.getByRole("button", { exact: true, name: `Período: ${label}, editar` });

/** The Histórico by the menu, as the person opens it with no period in hand. */
export async function openHistoryFromMenu(page: Page): Promise<void> {
  await sidebar(page)
    .getByRole("link", { exact: true, name: "Histórico" })
    .click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible();
}

export async function openResultadoFromMenu(page: Page): Promise<void> {
  await sidebar(page)
    .getByRole("link", { exact: true, name: "Resultado" })
    .click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Resultado" })
  ).toBeVisible();
}
