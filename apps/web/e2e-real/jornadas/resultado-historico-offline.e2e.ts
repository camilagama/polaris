/// <reference lib="dom" />

import { expect, openJourney, test } from "../fixtures";
import {
  makePro,
  monthToToday,
  periodPill,
  salesCard,
  seedSales,
  ZONE,
} from "../pages/resultado-historico";

const SALES_LINK = /^Ver as \d+ vendas de /;
const RESULT_LINK = /^Ver o resultado deste período/;
const SYNC_STATUS = "Tudo sincronizado";
const OFFLINE_STATUS = "Sem conexão";

test("sem conexão os dois links somem e voltam com a conexão", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(120_000);
  const journey = await openJourney(
    browser,
    testInfo,
    "resultado-historico-offline",
    { organization: { timezone: ZONE } }
  );
  await seedSales(journey, 3);
  await makePro(sql, journey.organizationId as string);
  const { page } = journey;
  const { label } = monthToToday();
  const status = (text: string) =>
    page.getByRole("status").filter({ hasText: text }).first();

  await page.goto("/dashboard");
  await expect(status(SYNC_STATUS)).toBeVisible({ timeout: 60_000 });
  await expect(
    salesCard(page).getByRole("button", { name: SALES_LINK })
  ).toBeVisible({ timeout: 30_000 });

  await page.context().setOffline(true);
  await expect(status(OFFLINE_STATUS)).toBeVisible({ timeout: 15_000 });
  await expect(
    salesCard(page).getByRole("button", { name: SALES_LINK })
  ).toHaveCount(0);
  await expect(salesCard(page)).toContainText("3 vendas");

  await page.context().setOffline(false);
  await expect(
    salesCard(page).getByRole("button", { name: SALES_LINK })
  ).toBeVisible({ timeout: 30_000 });
  await salesCard(page).getByRole("button", { name: SALES_LINK }).click();
  await expect(periodPill(page, label)).toBeVisible();
  const toResult = page.getByRole("button", { name: RESULT_LINK });
  await expect(toResult).toBeVisible();

  await page.context().setOffline(true);
  await expect(status(OFFLINE_STATUS)).toBeVisible({ timeout: 15_000 });
  await expect(toResult).toHaveCount(0);
  await expect(periodPill(page, label)).toBeVisible();

  await page.context().setOffline(false);
  await expect(toResult).toBeVisible({ timeout: 30_000 });
});
