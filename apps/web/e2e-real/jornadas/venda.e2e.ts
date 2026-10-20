import { extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, moneyInput, numericCents, saleTotals } from "../oracle";
import { confirmSale, fillSale, termValue } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

/**
 * Journey 5: a cash sale with a percentage discount, against an oracle of integer cents (oracle.ts), on screen and
 * in the database. The organization is in the extreme zone of the run when the project is `online`.
 */

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

async function saleRows(sql: Sql, organizationId: string) {
  return (
    await sql.query<{ id: string; subtotal: string; discount: string; occurred_on: string }>(
      `SELECT s.id, s.occurred_on::text AS occurred_on,
              (SELECT sum(i.quantity * i.charged_unit_price) FROM sale_items i WHERE i.sale_id = s.id)::text AS subtotal,
              (SELECT coalesce(sum(a.amount), 0) FROM sale_adjustments a WHERE a.sale_id = s.id AND a.kind = 'discount')::text AS discount
         FROM sales s WHERE s.organization_id = $1 ORDER BY s.recorded_at`,
      [organizationId]
    )
  ).rows.map((row) => ({ ...row, discount: numericCents(row.discount), subtotal: numericCents(row.subtotal) }));
}

test("venda: itens, desconto percentual e dinheiro; tela e banco iguais ao oráculo, duplo toque gera uma venda", async ({ browser, sql }, testInfo) => {
  // the extreme zone of the run: the local date of the sale differs from its UTC date (calendar.ts)
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "venda", { organization: { timezone: zone } });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const shirt = await seedProduct(user.rpc, organizationId, "Camiseta lisa", "25.00");
  const cap = await seedProduct(user.rpc, organizationId, "Boné aba reta", "10.00");
  await seedStock(user.rpc, organizationId, shirt.variantId, 10, "12.50", today);
  await seedStock(user.rpc, organizationId, cap.variantId, 5, "4.00", today);

  const lines = [
    { charged: "24,90", option: /Camiseta lisa/, quantity: 2, search: "Camiseta" },
    { charged: "9,99", option: /Boné aba reta/, quantity: 1, search: "Boné" },
  ];
  const expected = saleTotals(lines.map((line) => ({ chargedCents: cents(line.charged), quantity: line.quantity })), ["7.5"]);

  await page.goto("/sales");
  await fillSale(page, lines, ["7,5"]);
  const confirmed = await confirmSale(page);
  expect(cents(await termValue(confirmed, "Subtotal").innerText())).toBe(expected.subtotal);
  expect(cents(await termValue(confirmed, "Total devido").innerText())).toBe(expected.total);
  expect(cents(await termValue(confirmed, /^Desconto/).innerText())).toBe(-expected.discount);

  await expect.poll(async () => (await saleRows(sql, organizationId)).length).toBe(1);
  const [sale] = await saleRows(sql, organizationId);
  expect(sale).toMatchObject({ discount: expected.discount, subtotal: expected.subtotal });
  // the calendar date of the sale is the organization's, computed here from the instant the server recorded
  const [{ occurred_at: occurredAt } = { occurred_at: "" }] = (
    await sql.query<{ occurred_at: string }>("SELECT occurred_at::text FROM sales WHERE id = $1", [sale?.id])
  ).rows;
  expect(sale?.occurred_on).toBe(localDate(Date.parse(occurredAt), zone));
  console.log(`venda em ${zone}: data local ${sale?.occurred_on}, data UTC ${localDate(Date.parse(occurredAt), "UTC")}`);

  // stock went down, one movement per item, and the cost snapshot is the moving average of the receipts
  const stock = (
    await sql.query<{ variant_id: string; quantity: number; unit_cost: string; sold: number; movements: number }>(
      `SELECT i.variant_id, b.quantity, i.unit_cost::text AS unit_cost,
              (SELECT sum(-m.quantity_delta)::int FROM stock_movements m WHERE m.variant_id = i.variant_id AND m.movement_type = 'sale') AS sold,
              (SELECT count(*)::int FROM stock_movements m WHERE m.variant_id = i.variant_id AND m.movement_type = 'sale') AS movements
         FROM sale_items i JOIN inventory_balances b ON b.variant_id = i.variant_id
        WHERE i.sale_id = $1 ORDER BY i.position`,
      [sale?.id]
    )
  ).rows;
  expect(stock).toEqual([
    { movements: 1, quantity: 8, sold: 2, unit_cost: expect.stringMatching(/^12\.50*$/), variant_id: shirt.variantId },
    { movements: 1, quantity: 4, sold: 1, unit_cost: expect.stringMatching(/^4\.0*$/), variant_id: cap.variantId },
  ]);
});

test("venda: arredondamento meia-alta uma vez por ajuste (casos a–e do oráculo)", async ({ browser, sql }, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "venda-arredondamento", { organization: { timezone: zone } });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const today = localDate(runT0(), zone);
  const pen = await seedProduct(user.rpc, organizationId, "Caneta azul", null);
  const pencil = await seedProduct(user.rpc, organizationId, "Lápis preto", null);
  await seedStock(user.rpc, organizationId, pen.variantId, 50, "0.01", today);
  await seedStock(user.rpc, organizationId, pencil.variantId, 50, "0.01", today);

  const cases = [
    { name: "(a) 10,4 centavos: para baixo", lines: [{ cents: 104, variant: "pen" }], percents: ["10"], discount: 10 },
    { name: "(b) 10,5 com piso par: sobe", lines: [{ cents: 105, variant: "pen" }], percents: ["10"], discount: 11 },
    { name: "(c) 11,5 com piso ímpar: sobe", lines: [{ cents: 115, variant: "pen" }], percents: ["10"], discount: 12 },
    { name: "(d) 10,6: sobe", lines: [{ cents: 106, variant: "pen" }], percents: ["10"], discount: 11 },
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
    const expected = saleTotals(sample.lines.map((line) => ({ chargedCents: line.cents, quantity: 1 })), sample.percents);
    expect(expected.discount, `oracle ${sample.name}`).toBe(sample.discount);
    // biome-ignore lint/performance/noAwaitInLoops: one sale after the other on the same screen
    await page.goto("/sales");
    await fillSale(
      page,
      sample.lines.map((line) =>
        line.variant === "pen"
          ? { charged: moneyInput(line.cents), listed: moneyInput(line.cents), option: /Caneta azul/, quantity: 1, search: "Caneta" }
          : { charged: moneyInput(line.cents), listed: moneyInput(line.cents), option: /Lápis preto/, quantity: 1, search: "Lápis" }
      ),
      sample.percents
    );
    const confirmed = await confirmSale(page);
    expect(cents(await termValue(confirmed, "Total devido").innerText()), sample.name).toBe(expected.total);
    await expect.poll(async () => (await saleRows(sql, organizationId)).length, sample.name).toBe(index + 1);
    const rows = await saleRows(sql, organizationId);
    expect(rows[index], sample.name).toMatchObject({ discount: expected.discount, subtotal: expected.subtotal });
  }
});
