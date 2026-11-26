import type { Page } from "@playwright/test";
import { openDatePicker, touchDay } from "../../e2e/date-pickers";
import { addDays, extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import {
  adjustedTotals,
  cents,
  moneyInput,
  numericCents,
  type SaleAdjustment,
  saleTotals,
} from "../oracle";
import {
  confirmSale,
  fillSale,
  type SaleAdjustmentInput,
  termValue,
} from "../pages/venda";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const PENCIL = /Lápis preto/;
const PEN = /Caneta azul/;
const UNIT_COST_4 = /^4\.0*$/;
const UNIT_COST_12_50 = /^12\.50*$/;
const DISCOUNT_ROW = /^Desconto/;
const CAP = /Boné aba reta/;
const SHIRT = /Camiseta lisa/;
const SALE_CONFIRM_PATH = "/rpc/sale/confirm";
const SURCHARGE_ROW = /^Acréscimo/;
const FREIGHT_ROW = /^Frete/;
const DISCOUNT_ABOVE_SUBTOTAL =
  /O total de descontos não pode ser maior que o subtotal/;

/**
 * Journey 5: a cash sale with a percentage discount, against an oracle of integer cents (oracle.ts), on screen and
 * in the database. The organization is in the extreme zone of the run when the project is `online`.
 */

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

async function saleRows(sql: Sql, organizationId: string) {
  return (
    await sql.query<{
      id: string;
      subtotal: string;
      discount: string;
      occurred_on: string;
    }>(
      `SELECT s.id, s.occurred_on::text AS occurred_on,
              (SELECT sum(i.quantity * i.charged_unit_price) FROM sale_items i WHERE i.sale_id = s.id)::text AS subtotal,
              (SELECT coalesce(sum(a.amount), 0) FROM sale_adjustments a WHERE a.sale_id = s.id AND a.kind = 'discount')::text AS discount
         FROM sales s WHERE s.organization_id = $1 ORDER BY s.recorded_at`,
      [organizationId]
    )
  ).rows.map((row) => ({
    ...row,
    discount: numericCents(row.discount),
    subtotal: numericCents(row.subtotal),
  }));
}

test("venda: itens, desconto percentual e dinheiro; tela e banco iguais ao oráculo, duplo toque gera uma venda", async ({
  browser,
  sql,
}, testInfo) => {
  // the extreme zone of the run: the local date of the sale differs from its UTC date (calendar.ts)
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "venda", {
    organization: { timezone: zone },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const shirt = await seedProduct(
    user.rpc,
    organizationId,
    "Camiseta lisa",
    "25.00"
  );
  const cap = await seedProduct(
    user.rpc,
    organizationId,
    "Boné aba reta",
    "10.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    shirt.variantId,
    10,
    "12.50",
    today
  );
  await seedStock(user.rpc, organizationId, cap.variantId, 5, "4.00", today);

  const lines = [
    {
      charged: "24,90",
      option: SHIRT,
      quantity: 2,
      search: "Camiseta",
    },
    { charged: "9,99", option: CAP, quantity: 1, search: "Boné" },
  ];
  const expected = saleTotals(
    lines.map((line) => ({
      chargedCents: cents(line.charged),
      quantity: line.quantity,
    })),
    ["7.5"]
  );

  await page.goto("/sales");
  await fillSale(page, lines, ["7,5"]);
  const confirmed = await confirmSale(page);
  expect(cents(await termValue(confirmed, "Subtotal").innerText())).toBe(
    expected.subtotal
  );
  expect(cents(await termValue(confirmed, "Total devido").innerText())).toBe(
    expected.total
  );
  expect(cents(await termValue(confirmed, DISCOUNT_ROW).innerText())).toBe(
    -expected.discount
  );

  await expect
    .poll(async () => (await saleRows(sql, organizationId)).length)
    .toBe(1);
  const [sale] = await saleRows(sql, organizationId);
  expect(sale).toMatchObject({
    discount: expected.discount,
    subtotal: expected.subtotal,
  });
  // the calendar date of the sale is the organization's, computed here from the instant the server recorded
  const [{ occurred_at: occurredAt } = { occurred_at: "" }] = (
    await sql.query<{ occurred_at: string }>(
      "SELECT (extract(epoch FROM occurred_at) * 1000)::bigint::text AS occurred_at FROM sales WHERE id = $1",
      [sale?.id]
    )
  ).rows;
  expect(sale?.occurred_on).toBe(localDate(Number(occurredAt), zone));
  console.log(
    `venda em ${zone}: data local ${sale?.occurred_on}, data UTC ${localDate(Number(occurredAt), "UTC")}`
  );

  // stock went down, one movement per item, and the cost snapshot is the moving average of the receipts
  const stock = (
    await sql.query<{
      variant_id: string;
      quantity: number;
      unit_cost: string;
      sold: number;
      movements: number;
    }>(
      `SELECT i.variant_id, b.quantity, i.unit_cost::text AS unit_cost,
              (SELECT sum(-m.quantity_delta)::int FROM stock_movements m WHERE m.variant_id = i.variant_id AND m.movement_type = 'sale') AS sold,
              (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = i.variant_id AND m.movement_type = 'sale') AS movements
         FROM sale_items i JOIN inventory_balances b ON b.variant_id = i.variant_id
        WHERE i.sale_id = $1 ORDER BY i.position`,
      [sale?.id]
    )
  ).rows;
  expect(stock).toEqual([
    {
      movements: 1,
      quantity: 8,
      sold: 2,
      unit_cost: expect.stringMatching(UNIT_COST_12_50),
      variant_id: shirt.variantId,
    },
    {
      movements: 1,
      quantity: 4,
      sold: 1,
      unit_cost: expect.stringMatching(UNIT_COST_4),
      variant_id: cap.variantId,
    },
  ]);
});

test("venda: arredondamento meia-alta uma vez por ajuste (casos a–e do oráculo)", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "venda-arredondamento", {
    organization: { timezone: zone },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const pen = await seedProduct(user.rpc, organizationId, "Caneta azul", null);
  const pencil = await seedProduct(
    user.rpc,
    organizationId,
    "Lápis preto",
    null
  );
  await seedStock(user.rpc, organizationId, pen.variantId, 50, "0.01", today);
  await seedStock(
    user.rpc,
    organizationId,
    pencil.variantId,
    50,
    "0.01",
    today
  );

  const cases = [
    {
      name: "(a) 10,4 centavos: para baixo",
      lines: [{ cents: 104, variant: "pen" }],
      percents: ["10"],
      discount: 10,
    },
    {
      name: "(b) 10,5 com piso par: sobe",
      lines: [{ cents: 105, variant: "pen" }],
      percents: ["10"],
      discount: 11,
    },
    {
      name: "(c) 11,5 com piso ímpar: sobe",
      lines: [{ cents: 115, variant: "pen" }],
      percents: ["10"],
      discount: 12,
    },
    {
      name: "(d) 10,6: sobe",
      lines: [{ cents: 106, variant: "pen" }],
      percents: ["10"],
      discount: 11,
    },
    {
      name: "(e) dois itens, dois descontos de 10% sobre a mesma base: 2 + 2, não 3",
      lines: [
        { cents: 7, variant: "pen" },
        { cents: 8, variant: "pencil" },
      ],
      percents: ["10", "10"],
      discount: 4,
    },
  ];
  for (const [index, sample] of cases.entries()) {
    const expected = saleTotals(
      sample.lines.map((line) => ({ chargedCents: line.cents, quantity: 1 })),
      sample.percents
    );
    expect(expected.discount, `oracle ${sample.name}`).toBe(sample.discount);
    // biome-ignore lint/performance/noAwaitInLoops: one sale after the other on the same screen
    await page.goto("/sales");
    await fillSale(
      page,
      sample.lines.map((line) =>
        line.variant === "pen"
          ? {
              charged: moneyInput(line.cents),
              listed: moneyInput(line.cents),
              option: PEN,
              quantity: 1,
              search: "Caneta",
            }
          : {
              charged: moneyInput(line.cents),
              listed: moneyInput(line.cents),
              option: PENCIL,
              quantity: 1,
              search: "Lápis",
            }
      ),
      sample.percents
    );
    const confirmed = await confirmSale(page);
    expect(
      cents(await termValue(confirmed, "Total devido").innerText()),
      sample.name
    ).toBe(expected.total);
    await expect
      .poll(
        async () => (await saleRows(sql, organizationId)).length,
        sample.name
      )
      .toBe(index + 1);
    const rows = await saleRows(sql, organizationId);
    expect(rows[index], sample.name).toMatchObject({
      discount: expected.discount,
      subtotal: expected.subtotal,
    });
  }
  // after the last sale settled: still one sale per case (a double tap would have left one more)
  expect(await saleRows(sql, organizationId)).toHaveLength(cases.length);
});

async function adjustmentRows(sql: Sql, organizationId: string) {
  return (
    await sql.query<{
      kind: string;
      value_type: string;
      percentage: string | null;
      amount: string;
    }>(
      `SELECT a.kind, a.value_type, a.percentage::text AS percentage, a.amount::text AS amount
         FROM sale_adjustments a WHERE a.organization_id = $1 ORDER BY a.sale_id, a.position`,
      [organizationId]
    )
  ).rows.map((row) => ({
    amount: numericCents(row.amount),
    kind: row.kind,
    percentage: row.percentage === null ? null : Number(row.percentage),
    valueType: row.value_type,
  }));
}

async function stockOf(sql: Sql, variantId: string) {
  return (
    await sql.query<{ quantity: number }>(
      "SELECT quantity FROM inventory_balances WHERE variant_id = $1",
      [variantId]
    )
  ).rows[0]?.quantity;
}

function trackConfirmRequests(page: Page): string[] {
  const methods: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === SALE_CONFIRM_PATH) {
      methods.push(request.method());
    }
  });
  return methods;
}

const adjustedLines = [
  { charged: "24,90", option: SHIRT, quantity: 1, search: "Camiseta" },
  { charged: "9,99", option: CAP, quantity: 1, search: "Boné" },
];

async function seedAdjustedStore(
  journey: Awaited<ReturnType<typeof openJourney>>,
  zone: string
) {
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const shirt = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Camiseta lisa",
    "25.00"
  );
  const cap = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Boné aba reta",
    "10.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    shirt.variantId,
    10,
    "12.50",
    today
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    cap.variantId,
    10,
    "4.00",
    today
  );
  return { cap, organizationId, shirt };
}

const oracleLines = adjustedLines.map((line) => ({
  chargedCents: cents(line.charged),
  quantity: line.quantity,
}));

test("venda: desconto em valor, acréscimo percentual e frete somam ao total devido; tela e banco iguais ao oráculo", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "venda-ajustes", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const { organizationId } = await seedAdjustedStore(journey, zone);

  const typed: SaleAdjustmentInput[] = [
    { kind: "Desconto", mode: "fixed", value: "5,00" },
    { kind: "Acréscimo", mode: "percent", value: "10" },
    { kind: "Frete", mode: "fixed", value: "12,00" },
  ];
  const expected = adjustedTotals(oracleLines, [
    { cents: 500, kind: "discount" },
    { kind: "surcharge", percent: "10" },
    { cents: 1200, kind: "freight" },
  ]);
  // 3489 − 500 + 349 + 1200: the 10% (348,9) is rounded half-up, once
  expect(expected.total).toBe(4538);

  const confirmRequests = trackConfirmRequests(page);
  await page.goto("/sales");
  await fillSale(page, adjustedLines, [], typed);
  const confirmed = await confirmSale(page);
  // control of the refusal case: this is the path the confirmation takes, so an empty list there means something
  expect(confirmRequests.length).toBeGreaterThan(0);
  expect(cents(await termValue(confirmed, "Subtotal").innerText())).toBe(
    expected.subtotal
  );
  expect(cents(await termValue(confirmed, DISCOUNT_ROW).innerText())).toBe(
    -expected.discount
  );
  expect(cents(await termValue(confirmed, SURCHARGE_ROW).innerText())).toBe(
    expected.surcharge
  );
  expect(cents(await termValue(confirmed, FREIGHT_ROW).innerText())).toBe(
    expected.freight
  );
  expect(cents(await termValue(confirmed, "Total devido").innerText())).toBe(
    expected.total
  );

  await expect
    .poll(async () => (await saleRows(sql, organizationId)).length)
    .toBe(1);
  const [sale] = await saleRows(sql, organizationId);
  expect(sale).toMatchObject({
    discount: expected.discount,
    subtotal: expected.subtotal,
  });
  expect(await adjustmentRows(sql, organizationId)).toEqual([
    { amount: 500, kind: "discount", percentage: null, valueType: "fixed" },
    {
      amount: expected.surcharge,
      kind: "surcharge",
      percentage: 10,
      valueType: "percentage",
    },
    { amount: 1200, kind: "freight", percentage: null, valueType: "fixed" },
  ]);
});

test("venda: desconto de 10% e acréscimo de 10% saem do mesmo subtotal, sem compor", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "venda-ajustes-compor", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const { organizationId } = await seedAdjustedStore(journey, zone);

  const adjustments: SaleAdjustment[] = [
    { kind: "discount", percent: "10" },
    { kind: "surcharge", percent: "10" },
  ];
  const expected = adjustedTotals(oracleLines, adjustments);
  // both are 349 on 3489, so the total is the subtotal; composed it would be 3489 − 349 + 314 = 3454
  expect(expected.amounts).toEqual([349, 349]);
  expect(expected.total).toBe(3489);

  await page.goto("/sales");
  await fillSale(
    page,
    adjustedLines,
    ["10"],
    [{ kind: "Acréscimo", mode: "percent", value: "10" }]
  );
  const confirmed = await confirmSale(page);
  expect(cents(await termValue(confirmed, DISCOUNT_ROW).innerText())).toBe(
    -349
  );
  expect(cents(await termValue(confirmed, SURCHARGE_ROW).innerText())).toBe(
    349
  );
  expect(cents(await termValue(confirmed, "Total devido").innerText())).toBe(
    expected.total
  );

  await expect
    .poll(async () => (await adjustmentRows(sql, organizationId)).length)
    .toBe(2);
  expect(await adjustmentRows(sql, organizationId)).toEqual([
    { amount: 349, kind: "discount", percentage: 10, valueType: "percentage" },
    {
      amount: 349,
      kind: "surcharge",
      percentage: 10,
      valueType: "percentage",
    },
  ]);
  expect(await saleRows(sql, organizationId)).toHaveLength(1);
});

test("venda: desconto maior que o subtotal é recusado no formulário, nenhum comando sai, nada é gravado e o estoque não muda", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "venda-ajustes-recusa", {
    organization: { timezone: zone },
  });
  const { page } = journey;
  const { cap, organizationId, shirt } = await seedAdjustedStore(journey, zone);
  const movementsBefore = (
    await sql.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM stock_movements WHERE organization_id = $1",
      [organizationId]
    )
  ).rows[0]?.total;

  const above = adjustedTotals(oracleLines, [
    { cents: 3490, kind: "discount" },
  ]);
  expect(above.discountExceedsSubtotal).toBe(true);
  expect(
    adjustedTotals(oracleLines, [{ cents: 3489, kind: "discount" }])
      .discountExceedsSubtotal
  ).toBe(false);

  await page.goto("/sales");
  await fillSale(
    page,
    adjustedLines,
    [],
    [{ kind: "Desconto", mode: "fixed", value: moneyInput(3490) }]
  );
  const confirmRequests = trackConfirmRequests(page);
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByText(DISCOUNT_ABOVE_SUBTOTAL).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Venda confirmada" })
  ).toHaveCount(0);

  expect(confirmRequests).toEqual([]);
  expect(await saleRows(sql, organizationId)).toHaveLength(0);
  expect(await adjustmentRows(sql, organizationId)).toHaveLength(0);
  expect(await stockOf(sql, shirt.variantId)).toBe(10);
  expect(await stockOf(sql, cap.variantId)).toBe(10);
  expect(
    (
      await sql.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM stock_movements WHERE organization_id = $1",
        [organizationId]
      )
    ).rows[0]?.total
  ).toBe(movementsBefore);
});

const RETRO_LIMIT_MESSAGE = /limite retroativo de 30 dias/;
const FUTURE_TIME_MESSAGE = /A data e hora da venda não podem estar no futuro/;
const RETRO_TIME = "12:00";
const NOON_MINUTE = 12 * 60;
const LATE_TIME = "23:59";
const DAY_MS = 86_400_000;

/**
 * The store is in the zone of the device that runs the browser: the day comes from the store's calendar and the time
 * is typed in the device's clock, so with one zone for both the typed text is the store's local date and time on any
 * runner (a shopkeeper with the phone in the shop's city).
 */
const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const SHIRT_LINE = [
  { charged: "24,90", option: SHIRT, quantity: 1, search: "Camiseta" },
];

/**
 * The moving average now is 12,50 (5 at 10,00 twenty days ago, then 5 at 15,00 yesterday): a cost taken as of the day
 * of a retroactive sale would be 10,00, so the snapshot tells which of the two the server used.
 */
async function seedRetroStore(
  journey: Awaited<ReturnType<typeof openJourney>>
) {
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), DEVICE_ZONE);
  const shirt = await seedProduct(
    journey.user.rpc,
    organizationId,
    "Camiseta lisa",
    "25.00"
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    shirt.variantId,
    5,
    "10.00",
    addDays(today, -20)
  );
  await seedStock(
    journey.user.rpc,
    organizationId,
    shirt.variantId,
    5,
    "15.00",
    addDays(today, -1)
  );
  return { organizationId, shirt, today };
}

function minuteOfDay(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).formatToParts(new Date(instant));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

async function ledgerRows(sql: Sql, variantId: string) {
  return (
    await sql.query<{
      movement_type: string;
      quantity_delta: number;
      unit_cost: string | null;
    }>(
      `SELECT movement_type, quantity_delta, unit_cost::text AS unit_cost
         FROM stock_movements WHERE variant_id = $1 ORDER BY variant_sequence`,
      [variantId]
    )
  ).rows;
}

async function refusalReason(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return (error as { data?: { reason?: unknown } | null }).data?.reason;
  }
  throw new Error("The call was expected to be refused, and it answered.");
}

async function expectNothingWritten(
  sql: Sql,
  organizationId: string,
  variantId: string
) {
  expect(await saleRows(sql, organizationId)).toHaveLength(0);
  expect(await stockOf(sql, variantId)).toBe(10);
  expect(await ledgerRows(sql, variantId)).toHaveLength(2);
}

test("venda retroativa: 5 dias atrás na tela grava o dia escolhido e o custo médio de agora", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "venda-retroativa", {
    organization: { timezone: DEVICE_ZONE },
  });
  const { page } = journey;
  const { organizationId, shirt, today } = await seedRetroStore(journey);
  // far from the 30-day edge on purpose: the server counts with its real clock and the journey with T0, so the edge
  // would flake in a run that crosses midnight; the edge is proven in the database gate
  const day = addDays(today, -5);

  const confirmRequests = trackConfirmRequests(page);
  await page.goto("/sales");
  await fillSale(page, SHIRT_LINE, [], [], { day, time: RETRO_TIME });
  const confirmed = await confirmSale(page);
  expect(confirmRequests.length).toBeGreaterThan(0);
  expect(cents(await termValue(confirmed, "Total devido").innerText())).toBe(
    2490
  );

  await expect
    .poll(async () => (await saleRows(sql, organizationId)).length)
    .toBe(1);
  const [sale] = await saleRows(sql, organizationId);
  expect(sale?.occurred_on).toBe(day);
  expect(sale?.occurred_on).not.toBe(today);
  // the instant is the one the device reads from the typed text, in whatever zone the runner has
  const typedInstant = await page.evaluate(
    (text) => new Date(text).getTime(),
    `${day}T${RETRO_TIME}`
  );
  expect(
    Number(
      (
        await sql.query<{ occurred_at: string }>(
          "SELECT (extract(epoch FROM occurred_at) * 1000)::bigint::text AS occurred_at FROM sales WHERE id = $1",
          [sale?.id]
        )
      ).rows[0]?.occurred_at
    )
  ).toBe(typedInstant);

  const [item] = (
    await sql.query<{ unit_cost: string }>(
      "SELECT unit_cost::text AS unit_cost FROM sale_items WHERE sale_id = $1",
      [sale?.id]
    )
  ).rows;
  expect(item?.unit_cost).toMatch(UNIT_COST_12_50);
  expect(await stockOf(sql, shirt.variantId)).toBe(9);
  const ledger = await ledgerRows(sql, shirt.variantId);
  expect(ledger.map((row) => row.movement_type)).toEqual([
    "receipt",
    "receipt",
    "sale",
  ]);
  expect(ledger[2]).toMatchObject({ quantity_delta: -1 });
  expect(ledger[2]?.unit_cost).toMatch(UNIT_COST_12_50);
});

test("venda retroativa: 40 dias atrás mostra o limite de 30 dias e nada é gravado", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "venda-retroativa-antiga",
    { organization: { timezone: DEVICE_ZONE } }
  );
  const { page } = journey;
  const { organizationId, shirt, today } = await seedRetroStore(journey);

  const confirmRequests = trackConfirmRequests(page);
  await page.goto("/sales");
  await fillSale(page, SHIRT_LINE, [], [], {
    day: addDays(today, -40),
    time: RETRO_TIME,
  });
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByText(RETRO_LIMIT_MESSAGE).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Venda confirmada" })
  ).toHaveCount(0);

  // control: the refusal came from the server, so the command did leave the browser
  expect(confirmRequests.length).toBeGreaterThan(0);
  await expectNothingWritten(sql, organizationId, shirt.variantId);
});

test("venda retroativa: o calendário não deixa escolher dia à frente e o servidor recusa futuro e passado fora da janela", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "venda-retroativa-futuro",
    { organization: { timezone: DEVICE_ZONE } }
  );
  const { page, user } = journey;
  const { organizationId, shirt, today } = await seedRetroStore(journey);

  await page.goto("/sales");
  await fillSale(page, SHIRT_LINE, [], []);
  await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
  const popup = await openDatePicker(page, "Dia");
  const ahead = addDays(today, 2);
  await touchDay(popup, ahead, { force: true });
  const aheadButton = popup.locator(`button[data-day="${ahead}"]`);
  await expect(aheadButton).toHaveAttribute("aria-disabled", "true");
  await expect(aheadButton).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Dia, Escolher data" })
  ).toBeVisible();

  const item = [{ price: "24.90", quantity: 1, variantId: shirt.variantId }];
  expect(
    await refusalReason(
      seedCashSale(
        user.rpc,
        organizationId,
        item,
        new Date(runT0() + 2 * DAY_MS).toISOString()
      )
    )
  ).toBe("sale_occurred_in_future");
  expect(
    await refusalReason(
      seedCashSale(
        user.rpc,
        organizationId,
        item,
        new Date(runT0() - 40 * DAY_MS).toISOString()
      )
    )
  ).toBe("sale_occurred_too_old");
  await expectNothingWritten(sql, organizationId, shirt.variantId);
});

test("venda retroativa: hora de hoje depois de agora é recusada no formulário, sem comando e sem gravar", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(
    browser,
    testInfo,
    "venda-retroativa-hora-futura",
    { organization: { timezone: DEVICE_ZONE } }
  );
  const { page } = journey;
  const { organizationId, shirt, today } = await seedRetroStore(journey);

  // the page's clock goes to noon of the store's day of T0 before the screen loads: a time later today then exists
  // at any hour the run started, and noon is far from a daylight-saving gap
  await page.clock.setSystemTime(
    runT0() + (NOON_MINUTE - minuteOfDay(runT0(), DEVICE_ZONE)) * 60_000
  );

  const confirmRequests = trackConfirmRequests(page);
  await page.goto("/sales");
  await fillSale(page, SHIRT_LINE, [], [], {
    day: today,
    time: LATE_TIME,
  });
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByText(FUTURE_TIME_MESSAGE).first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Venda confirmada" })
  ).toHaveCount(0);

  expect(confirmRequests).toEqual([]);
  await expectNothingWritten(sql, organizationId, shirt.variantId);
});
