import { localDate } from "../calendar";
import {
  createJourneyUser,
  expect,
  refusedWith,
  runT0,
  test,
} from "../fixtures";
import { journeyName } from "../journey-names";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const REFUSAL_CODE = /^(FORBIDDEN|NOT_FOUND)$/;

/**
 * Isolation through the real `/rpc` (V5 of the review): user A asks for organization B's data with B's REAL ids.
 * The control case is B's owner reading the same data (without it the test would pass with a broken query). The SQL
 * oracle ignores RLS, so it is no proof here: only the Worker's answers count.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the object pattern as first argument
test("o usuário A não lê dados da organização B pela /rpc, com os ids reais de B; o dono de B lê", async ({}, testInfo) => {
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
    new Date().toISOString()
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
});
