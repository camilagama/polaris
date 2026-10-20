import { randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import { localDate } from "../calendar";
import {
  createJourneyUser,
  expect,
  refusedWith,
  runT0,
  test,
} from "../fixtures";
import { journeyName } from "../journey-names";
import {
  ensureRunEnvironment,
  ownerDatabaseUrl,
  runConnectionString,
} from "../run-environment";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const REFUSAL_CODE = /^(FORBIDDEN|NOT_FOUND)$/;

/**
 * Isolation through the real `/rpc` (V5 of the review): user A asks for organization B's data with B's REAL ids.
 * The control case is B's owner reading the same data (without it the test would pass with a broken query). The SQL
 * oracle ignores RLS, so it is no proof here: only the Worker's answers count.
 */
test("o usuário A não lê dados da organização B pela /rpc, com os ids reais de B; o dono de B lê", async ({
  sql,
}, testInfo) => {
  const origin = String(testInfo.project.use.baseURL);
  const owner = await createJourneyUser(
    origin,
    journeyName("pilha", "isolamento-b", testInfo.retry)
  );
  const stranger = await createJourneyUser(
    origin,
    journeyName("pilha", "isolamento-a", testInfo.retry)
  );
  const b = (
    await owner.rpc.organization.createInitial({
      name: owner.name,
      timezone: "America/Sao_Paulo",
    })
  ).organization.id;
  const a = (
    await stranger.rpc.organization.createInitial({
      name: stranger.name,
      timezone: "America/Sao_Paulo",
    })
  ).organization.id;
  const product = await seedProduct(owner.rpc, b, "Produto de B", "10.00");
  await seedStock(
    owner.rpc,
    b,
    product.variantId,
    5,
    "1.00",
    localDate(runT0(), "America/Sao_Paulo")
  );
  const saleId = await seedCashSale(
    owner.rpc,
    b,
    [{ price: "10.00", quantity: 1, variantId: product.variantId }],
    new Date(runT0()).toISOString()
  );

  // control: the owner of B sees them
  expect(
    (await owner.rpc.product.list({ organizationId: b })).products.map(
      (p) => p.id
    )
  ).toEqual([product.productId]);
  expect(
    (
      await owner.rpc.product.getVariants({
        id: product.productId,
        organizationId: b,
      })
    ).variants
  ).toHaveLength(1);
  expect(
    (await owner.rpc.sale.get({ organizationId: b, saleId })).sale.sale.id
  ).toBe(saleId);

  // A, naming B as the organization: refused
  expect(
    await refusedWith(stranger.rpc.product.list({ organizationId: b }))
  ).toMatch(REFUSAL_CODE);
  expect(
    await refusedWith(
      stranger.rpc.product.getVariants({
        id: product.productId,
        organizationId: b,
      })
    )
  ).toMatch(REFUSAL_CODE);
  expect(
    await refusedWith(stranger.rpc.sale.get({ organizationId: b, saleId }))
  ).toMatch(REFUSAL_CODE);
  // A, in its own organization but with B's ids: nothing of B
  expect(
    (await stranger.rpc.product.list({ organizationId: a })).products
  ).toEqual([]);
  expect(
    await refusedWith(
      stranger.rpc.product.getVariants({
        id: product.productId,
        organizationId: a,
      })
    )
  ).toMatch(REFUSAL_CODE);
  expect(
    await refusedWith(stranger.rpc.sale.get({ organizationId: a, saleId }))
  ).toMatch(REFUSAL_CODE);
  // a write across tenants: A cancelling B's sale, naming B and naming itself; nothing changes in B
  for (const organizationId of [b, a]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: two refusals, one after the other
      await refusedWith(
        stranger.rpc.sale.cancel({
          commandId: randomUUID(),
          commandVersion: 1,
          organizationId,
          saleId,
        })
      )
    ).toMatch(REFUSAL_CODE);
  }
  expect(
    (
      await sql.query("SELECT 1 FROM sale_cancellations WHERE sale_id = $1", [
        saleId,
      ])
    ).rows
  ).toHaveLength(0);
});

/**
 * RLS itself, below the application: the run's tenant login, in a transaction with A's context, does not see B's
 * rows; with B's context it does (control). The /rpc test above passes even with RLS off, because the queries
 * also filter by organization (two walls); this one fails without the policy.
 */
test("a RLS do PostgreSQL esconde as linhas de B do login de tenant no contexto de A", async ({
  sql,
}, testInfo) => {
  const origin = String(testInfo.project.use.baseURL);
  const owner = await createJourneyUser(
    origin,
    journeyName("pilha", "rls-b", testInfo.retry)
  );
  const stranger = await createJourneyUser(
    origin,
    journeyName("pilha", "rls-a", testInfo.retry)
  );
  const b = (
    await owner.rpc.organization.createInitial({
      name: owner.name,
      timezone: "America/Sao_Paulo",
    })
  ).organization.id;
  const a = (
    await stranger.rpc.organization.createInitial({
      name: stranger.name,
      timezone: "America/Sao_Paulo",
    })
  ).organization.id;
  const product = await seedProduct(owner.rpc, b, "Produto de B", "10.00");
  const tenant = createDatabase(
    runConnectionString(
      ownerDatabaseUrl(),
      ensureRunEnvironment(),
      "HYPERDRIVE"
    ),
    {
      maxConnections: 1,
    }
  );
  const visible = async (organizationId: string, userId: string) => {
    const client = await tenant.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
        [organizationId, userId]
      );
      const products = await client.query(
        "SELECT id FROM products WHERE id = $1",
        [product.productId]
      );
      const variants = await client.query(
        "SELECT id FROM product_variants WHERE id = $1",
        [product.variantId]
      );
      return products.rows.length + variants.rows.length;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };
  try {
    expect(await visible(a, stranger.id)).toBe(0);
    expect(await visible(b, owner.id)).toBe(2);
    const [security] = (
      await sql.query<{ enabled: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.products'::regclass"
      )
    ).rows;
    expect(security?.enabled).toBe(true);
  } finally {
    await tenant.pool.end();
  }
});
