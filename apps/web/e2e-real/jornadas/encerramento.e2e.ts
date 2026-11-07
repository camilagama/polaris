import { addDays, localDate } from "../calendar";
import {
  createJourneyUser,
  expect,
  openJourney,
  runT0,
  test,
} from "../fixtures";
import { journeyName } from "../journey-names";
import { cents, numericCents, saleTotals } from "../oracle";
import { nextCommandId, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const DAY_MS = 86_400_000;
const RECOVERY_DAYS = 30;
const DELETABLE_AFTER_DAYS = 90;
const CLOSED_PANEL = /\/loja-encerrada\?/;
const REOPENED = /\/\?reaberta=1$/;
const OFFSET = /GMT([+-]\d{2}):(\d{2})/;
const CLOSE_BUTTON = "Encerrar a loja";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

interface Refusal {
  code: string;
  reason: unknown;
}

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (error) {
    const { code, data } = error as {
      code?: unknown;
      data?: { reason?: unknown } | null;
    };
    return { code: String(code), reason: data?.reason };
  }
  throw new Error("The call was expected to be refused, and it answered.");
}

/** The first instant of a local date in a zone (the offset of that very day, so a zone with DST is right too). */
function localMidnight(date: string, timeZone: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(noon)
    .find((candidate) => candidate.type === "timeZoneName")?.value;
  const match = OFFSET.exec(part ?? "");
  if (!match) {
    throw new Error(`No offset for ${date} in ${timeZone}`);
  }
  const sign = match[1]?.startsWith("-") ? -1 : 1;
  const minutes = Math.abs(Number(match[1])) * 60 + Number(match[2]);
  return new Date(
    Date.parse(`${date}T00:00:00Z`) - sign * minutes * 60_000
  ).toISOString();
}

/**
 * Every row of every table that carries an `organization_id`, counted by table. The owner connection ignores RLS, so
 * this sees what the application roles could not (audit, notices, grants): a refused call must change none of them.
 */
async function rowCounts(
  sql: Sql,
  organizationId: string
): Promise<Record<string, number>> {
  const tables = (
    await sql.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`
    )
  ).rows.map((row) => row.table_name);
  expect(tables.length, "tables with organization_id").toBeGreaterThan(30);
  expect(tables).toEqual(
    expect.arrayContaining([
      "customers",
      "inventory_balances",
      "products",
      "sales",
      "stock_movements",
      "sync_commands",
    ])
  );
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // biome-ignore lint/performance/noAwaitInLoops: one table after the other, on one connection
    const { rows } = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public."${table}" WHERE organization_id = $1`,
      [organizationId]
    );
    counts[table] = rows[0]?.count ?? 0;
  }
  return counts;
}

async function organizationState(sql: Sql, organizationId: string) {
  const [row] = (
    await sql.query<{
      recover_seconds: string | null;
      recovered: boolean | null;
      requested_at: string | null;
      status: string;
    }>(
      `SELECT o.status,
              (extract(epoch FROM c.recover_until - c.requested_at))::text AS recover_seconds,
              floor(extract(epoch FROM c.requested_at) * 1000)::bigint::text AS requested_at,
              (c.recovered_at IS NOT NULL) AS recovered
         FROM organizations o
         LEFT JOIN organization_closures c ON c.organization_id = o.id
        WHERE o.id = $1`,
      [organizationId]
    )
  ).rows;
  return row;
}

/**
 * Offline writes are a Pro capability and the stack has no provider, checkout or webhook: the same billing record an
 * active subscription leaves, written straight into the run database (as the verify-polaris skill does).
 */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

/**
 * The closure on the real stack (corte jornada-e2e-real-do-encerramento): the owner closes the store on screen; the
 * dates in the database are the domain's; every write the server could still take is refused with
 * `organization_closed` and leaves no row; undoing inside the window gives the store back and the same sale then
 * passes. The offline runtime project is the one with the keys `sync.push` and the lease need (run-environment.ts).
 */
test("encerramento: encerra pela tela com os prazos do domínio, recusa tudo no servidor sem gravar linha, desfaz e a mesma venda passa", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "encerramento", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const { rpc } = journey.user;
  const organizationId = journey.organizationId as string;
  const storeName = journey.name;
  const today = localDate(runT0(), ZONE);

  const product = await seedProduct(rpc, organizationId, "Caneca", "35.00");
  await seedStock(rpc, organizationId, product.variantId, 10, "12.00", today);
  await makePro(sql, organizationId);
  const sale = {
    adjustments: [],
    commandId: nextCommandId(),
    commandVersion: 1 as const,
    items: [
      {
        chargedUnitPrice: "35.00",
        listedUnitPrice: "35.00",
        quantity: 3,
        variantId: product.variantId,
      },
    ],
    occurredAt: new Date(runT0()).toISOString(),
    organizationId,
    payment: {
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: "cash" as const,
    },
    paymentProfile: null,
  };
  // the lease and the device exist before the closure, as on a device that was working when the store closed
  const { device } = await rpc.device.register({ label: "Caixa do teste" });
  const { lease } = await rpc.offline.issueLease({
    deviceId: device.id,
    organizationId,
  });
  const offlineCustomer = (
    customerId: string,
    name: string,
    phone: string
  ) => ({
    baseVersion: null,
    commandId: nextCommandId(),
    createdAt: new Date(runT0()).toISOString(),
    deviceId: device.id,
    lease,
    payload: { customerId, email: null, name, notes: null, phone },
    type: "customer.create",
  });
  // control: the same push, before the closure, is accepted, so the refusal below is the closure's and nothing else
  const accepted = await rpc.sync.push({
    commands: [
      offlineCustomer(
        "0199c2d0-0000-7000-8000-0000000000c1",
        "Cliente offline de antes",
        "11966665555"
      ),
    ],
    organizationId,
  });
  expect(accepted.results.map((result) => result.status)).toEqual(["accepted"]);
  const billingBefore = (
    await sql.query<{ access_ends_at: string; state: string }>(
      "SELECT state, access_ends_at::text FROM organization_billing WHERE organization_id = $1",
      [organizationId]
    )
  ).rows;

  // AC-1: closed on screen, by typing the name
  await page.goto("/configuracoes?aba=seus-dados");
  await page.getByRole("button", { exact: true, name: CLOSE_BUTTON }).click();
  const dialog = page.getByRole("dialog", {
    name: `Encerrar a loja ${storeName}`,
  });
  await dialog
    .getByLabel(`Para confirmar, digite o nome da loja: ${storeName}`)
    .fill(storeName);
  const confirm = dialog.getByRole("button", {
    exact: true,
    name: CLOSE_BUTTON,
  });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  const clickedAt = Date.now();
  await confirm.click();
  await page.waitForURL(CLOSED_PANEL);
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: `${storeName} está encerrada`,
    })
  ).toBeVisible();

  const closed = await organizationState(sql, organizationId);
  expect(closed?.status).toBe("closing");
  expect(closed?.recovered).toBe(false);
  expect(Number(closed?.recover_seconds)).toBe((RECOVERY_DAYS * DAY_MS) / 1000);
  const requestedAt = Number(closed?.requested_at);
  expect(requestedAt).toBeGreaterThanOrEqual(clickedAt);
  expect(requestedAt).toBeLessThanOrEqual(Date.now());
  const status = (await rpc.organization.closedStatus({ organizationId }))
    .organization;
  const deletionDate = addDays(
    localDate(requestedAt, ZONE),
    DELETABLE_AFTER_DAYS
  );
  expect(status).toMatchObject({
    canRecover: true,
    deletableFrom: localMidnight(deletionDate, ZONE),
    deletionDate,
    phase: "closing",
    recoverUntil: new Date(requestedAt + RECOVERY_DAYS * DAY_MS).toISOString(),
    renewal: "not_handled",
    requestedAt: new Date(requestedAt).toISOString(),
    timezone: ZONE,
  });
  expect(
    (
      await sql.query<{ access_ends_at: string; state: string }>(
        "SELECT state, access_ends_at::text FROM organization_billing WHERE organization_id = $1",
        [organizationId]
      )
    ).rows,
    "the renewal record is not touched (billing is off on the stack)"
  ).toEqual(billingBefore);

  // AC-2: the five refusals, and not one row
  const before = await rowCounts(sql, organizationId);
  const closedRefusal = { code: "FORBIDDEN", reason: "organization_closed" };
  const refusals = {
    cadastroCliente: await refusal(
      rpc.customer.create({
        email: null,
        name: "Cliente que não entra",
        notes: null,
        organizationId,
        phone: "11988887777",
      })
    ),
    cadastroProduto: await refusal(
      rpc.product.create({ name: "Produto que não entra", organizationId })
    ),
    concessao: await refusal(
      rpc.offline.issueLease({ deviceId: device.id, organizationId })
    ),
    estoque: await refusal(
      rpc.inventory.receiveStock({
        commandId: nextCommandId(),
        commandVersion: 1,
        occurredOn: today,
        organizationId,
        quantity: 5,
        unitCost: "12.00",
        variantId: product.variantId,
      })
    ),
    syncPush: await refusal(
      rpc.sync.push({
        commands: [
          offlineCustomer(
            "0199c2d0-0000-7000-8000-0000000000c2",
            "Cliente offline que não entra",
            "11977776666"
          ),
        ],
        organizationId,
      })
    ),
    venda: await refusal(rpc.sale.confirm(sale)),
  };
  expect(refusals).toEqual({
    cadastroCliente: closedRefusal,
    cadastroProduto: closedRefusal,
    concessao: closedRefusal,
    estoque: closedRefusal,
    syncPush: closedRefusal,
    venda: closedRefusal,
  });
  expect(await rowCounts(sql, organizationId)).toEqual(before);
  // the read of the panel still answers
  expect(
    (await rpc.organization.closedStatus({ organizationId })).organization?.id
  ).toBe(organizationId);

  // AC-3: undone on screen, inside the window
  await page.reload();
  await page
    .getByRole("button", { exact: true, name: "Desfazer encerramento" })
    .click();
  await page
    .getByRole("dialog", { name: "Desfazer o encerramento?" })
    .getByRole("button", { name: "Sim, desfazer" })
    .click();
  await page.waitForURL(REOPENED);
  const reopened = await organizationState(sql, organizationId);
  expect(reopened?.status).toBe("active");
  expect(reopened?.recovered).toBe(true);

  // the same sale, with the same command id, now passes; the balance is the oracle's
  const confirmed = await rpc.sale.confirm(sale);
  expect(confirmed.replayed).toBe(false);
  const expected = saleTotals(
    [{ chargedCents: cents("35.00"), quantity: 3 }],
    []
  );
  const [books] = (
    await sql.query<{
      balance: number;
      movements: number;
      sales: number;
      total: string;
    }>(
      `SELECT (SELECT quantity FROM inventory_balances WHERE variant_id = $1) AS balance,
              (SELECT sum(quantity_delta)::int FROM stock_movements WHERE variant_id = $1) AS movements,
              (SELECT count(*)::int FROM sales WHERE organization_id = $2) AS sales,
              (SELECT sum(i.quantity * i.charged_unit_price) FROM sale_items i WHERE i.sale_id = $3)::text AS total`,
      [product.variantId, organizationId, confirmed.sale.id]
    )
  ).rows;
  expect(books).toMatchObject({ balance: 7, movements: 7, sales: 1 });
  expect(numericCents(books?.total as string)).toBe(expected.total);
  const remaining = (await rowCounts(sql, organizationId)) as Record<
    string,
    number
  >;
  expect(remaining.customers, "only the customer of before the closure").toBe(
    1
  );
  expect(remaining.products).toBe(1);
});

/** AC-3 (the other store): with another active store on the account, undoing is refused and nothing changes. */
test("encerramento: com outra loja ativa na conta, o desfazer é recusado e nada muda", async ({
  sql,
}, testInfo) => {
  const origin = String(testInfo.project.use.baseURL);
  const owner = await createJourneyUser(
    origin,
    journeyName(testInfo.project.name, "encerramento-outra", testInfo.retry)
  );
  const first = (
    await owner.rpc.organization.createInitial({
      name: owner.name,
      timezone: ZONE,
    })
  ).organization.id;
  await owner.rpc.organization.requestClosure({
    confirmation: owner.name,
    organizationId: first,
  });
  const second = (
    await owner.rpc.organization.createInitial({
      name: `${owner.name}-b`,
      timezone: ZONE,
    })
  ).organization.id;
  const before = await organizationState(sql, first);
  expect(before?.status).toBe("closing");
  const counts = await rowCounts(sql, first);

  expect(
    await refusal(
      owner.rpc.organization.recoverClosure({ organizationId: first })
    )
  ).toEqual({ code: "CONFLICT", reason: "another_organization_active" });

  expect(await organizationState(sql, first)).toEqual(before);
  expect((await organizationState(sql, second))?.status).toBe("active");
  expect(await rowCounts(sql, first)).toEqual(counts);
});
