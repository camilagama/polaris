/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, type Journey, openJourney, runT0, test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const SALES_OF_PERIOD = /^Vendas /;
const SALES_OF_MONTH = /^Vendas em /;
const PERIOD_BUTTON_NAME = /^Período: .+, editar$/;
const ENTRANCE_MS = 200;

interface Started {
  changed: boolean;
  duration: string;
  name: string;
  value: string;
}

declare global {
  interface Window {
    started?: Started[];
  }
}

/** Records every CSS animation that starts on a main number of a card, once per start event: nothing is polled. */
function recordEntrances() {
  window.started = [];
  document.addEventListener(
    "animationstart",
    (event) => {
      const { target } = event;
      if (!(target instanceof Element)) {
        return;
      }
      const value = target.closest("[data-kpi-value]");
      if (!value) {
        return;
      }
      window.started?.push({
        changed: target.hasAttribute("data-figure-changed"),
        duration: getComputedStyle(target).animationDuration,
        name: (event as AnimationEvent).animationName,
        value: value.textContent?.trim() ?? "",
      });
    },
    true
  );
}

/**
 * A shop with a sale of 2 candles today (R$ 90,00) and one of a candle on the last day of the previous month (R$ 45,00).
 * With `comparable`, one more 30 days ago, the oldest day a sale can be dated: it is in the 30 days before "Últimos 30
 * dias", the period those chips compare with, and the month's own comparison range has no sale in it on most days.
 */
async function seedStore(journey: Journey, comparable = false): Promise<void> {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const lastMonthDay = addDays(monthStart(today), -1);
  const oldest = addDays(today, -30);
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
    10,
    "12.00",
    comparable && oldest < lastMonthDay ? oldest : lastMonthDay
  );
  if (comparable) {
    await seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
      `${oldest}T15:00:00.000Z`
    );
  }
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
    `${lastMonthDay}T15:00:00.000Z`
  );
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.00", quantity: 2, variantId: candle.variantId }],
    new Date(runT0()).toISOString()
  );
}

async function startedOnFigures(page: Page): Promise<Started[]> {
  return await page.evaluate(() => window.started ?? []);
}

async function openPeriod(page: Page): Promise<void> {
  await page.getByRole("button", { name: PERIOD_BUTTON_NAME }).click();
  await expect(page.getByRole("dialog", { name: "Período" })).toBeVisible();
}

async function lastMonth(page: Page): Promise<void> {
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "Mês passado" })
    .click();
}

/** The Resultado with the month read, ready to switch to the previous one (R$ 90,00 becomes R$ 45,00). */
async function openResultado(page: Page): Promise<void> {
  await page.addInitScript(recordEntrances);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("region", { name: SALES_OF_MONTH })
  ).toContainText("R$ 90,00");
}

test("desktop: o valor novo entra inteiro com um fade de 200 ms, sem contador de dígitos e sem entrada na primeira vez", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "valor-kpi", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await openResultado(page);
  expect(await startedOnFigures(page), "o valor nasce pronto").toEqual([]);
  await expect(page.locator("[data-figure-changed]")).toHaveCount(0);

  await openPeriod(page);
  await lastMonth(page);
  const sales = page.getByRole("region", { name: SALES_OF_PERIOD }).first();
  await expect(sales).toContainText("R$ 45,00");
  await expect
    .poll(async () => (await startedOnFigures(page)).length)
    .toBeGreaterThan(0);
  const started = await startedOnFigures(page);
  expect(
    started.every((entry) => entry.changed),
    "só o valor que mudou entra"
  ).toBe(true);
  expect(started.map((entry) => entry.name)).toContain("enter");
  for (const entry of started) {
    expect(entry.duration, `${entry.value}: duração`).toBe(
      `${ENTRANCE_MS / 1000}s`
    );
  }
  expect(
    started.some((entry) => entry.value === "R$ 45,00"),
    "o valor que entra já é o final"
  ).toBe(true);

  // nothing counts digit by digit: no custom element of a counter, no second copy of the figure for a reader
  expect(await page.locator("number-flow-react").count()).toBe(0);
  expect(await page.locator("[data-animated-figure]").count()).toBe(0);
  expect(await page.locator("[data-figure-counting]").count()).toBe(0);
  const value = sales.locator("[data-kpi-value]");
  await expect(value).toHaveText("R$ 45,00");
  await expect(value.locator("[aria-hidden=true]")).toHaveCount(0);
});

test("celular (< 760 px): o valor troca na hora, sem animação", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "valor-kpi-toque", {
    device: {
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      viewport: { height: 740, width: 360 },
    },
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await openResultado(page);
  await openPeriod(page);
  await lastMonth(page);
  await expect(
    page.getByRole("region", { name: SALES_OF_PERIOD }).first()
  ).toContainText("R$ 45,00");
  await expect(
    page
      .getByRole("region", { name: SALES_OF_PERIOD })
      .first()
      .locator("[data-kpi-value]")
  ).toHaveText("R$ 45,00");
  expect(await startedOnFigures(page)).toEqual([]);
});

test("movimento reduzido: o valor troca na hora, sem animação", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "valor-kpi-reduzido", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openResultado(page);
  await openPeriod(page);
  await lastMonth(page);
  await expect(
    page
      .getByRole("region", { name: SALES_OF_PERIOD })
      .first()
      .locator("[data-kpi-value]")
  ).toHaveText("R$ 45,00");
  expect(await startedOnFigures(page)).toEqual([]);
});

test("valores escondidos: a troca não anima e mostrar de novo não toca a entrada", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "valor-kpi-escondido", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await page.addInitScript(() => {
    window.localStorage.setItem("polaris-valores", "escondidos");
  });
  await page.addInitScript(recordEntrances);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("button", { name: "Esconder valores" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-kpi-value]").first()).toContainText("R$");
  await openPeriod(page);
  await lastMonth(page);
  await expect(
    page.getByRole("region", { name: SALES_OF_PERIOD }).first()
  ).toBeVisible();
  await page.getByRole("button", { name: "Esconder valores" }).click();
  await expect(
    page.getByRole("region", { name: SALES_OF_PERIOD }).first()
  ).toContainText("R$ 45,00");
  await expect(page.locator("[data-figure-changed]")).toHaveCount(0);
  expect(await startedOnFigures(page)).toEqual([]);
});
