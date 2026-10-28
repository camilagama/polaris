import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  dailyEconomics,
  topProducts,
} from "@polaris/domain/economics/period-series";
import {
  dashboardCards,
  resultQuality,
} from "@polaris/domain/economics/period-summary";
import {
  periodResult,
  saleEconomics,
} from "@polaris/domain/economics/sale-economics";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";
import { createDatabase } from "../src/client";
import {
  type EconomicsPeriod,
  MAX_ECONOMICS_PERIOD_DAYS,
  type PeriodSummaryRead,
  periodSummaryQuery,
  readPeriodFacts,
  readPeriodSummary,
} from "../src/economics-repository";
import {
  createExpense,
  listExpenseCategories,
  voidExpense,
} from "../src/expense-repository";
import { createPaymentProfile } from "../src/payment-profile-repository";
import { deleteProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import { products } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import { runClock, shiftDay, storeDay } from "./gate-clock";
import {
  createSellableProduct,
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * The period summary aggregated by PostgreSQL 18 (`readPeriodSummary`, one
 * statement, ADR 0054) against its definition: the engine over the facts
 * (`readPeriodFacts`, then `periodResult`, `dailyEconomics` and `topProducts`,
 * with the names read as the summary read them before). Both run as a login of
 * the runtime role under RLS, in the same repeatable-read snapshot, and every
 * field must be equal: the chain, the cards, the daily series date by date, the
 * quality account and the ranking, and the answer of `report.periodSummary`
 * byte by byte (the same JSON text, keys in the same order).
 *
 * The scenarios are made with the real commands (confirmations, returns,
 * cancellations, expenses, payment profiles, a deleted product), in stores of
 * three time zones; then a property test draws facts at random (a fixed seed,
 * `POLARIS_PERIOD_SUMMARY_SEED` and `POLARIS_PERIOD_SUMMARY_PATH` replay a
 * printed failure; `POLARIS_PERIOD_SUMMARY_RUNS`, at least 200) and writes them
 * straight into the tables, with the triggers that demand the stock movements
 * of a command switched off while they go in: a gate fixture, never done with
 * real data. The database time of the statement (`EXPLAIN ANALYZE`) on the
 * largest window is printed as a `gate-note`.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const DEFAULT_SEED = 4_792_026;
const MIN_RUNS = 200;
/** Each drawn case lives in its own slot of days, far in the past, so the cases never meet. */
const SLOT_DAYS = 45;
const SLOT_ORIGIN = "2001-01-01";
/** The owner dates a sale at most 30 days back (ADR 0021). */
const GENERATED_DAYS = 26;
const GENERATED_SALES_PER_STORE = 24;
/** Sales moved back by an UPDATE of their dates, so that a year has something at its far end. */
const MOVED_BACK_DAYS = 300;
const MOVED_BACK_PER_STORE = 6;
const ZONES = ["America/Sao_Paulo", "Asia/Tokyo", "Pacific/Auckland"];
/** The triggers that check a command's own rows (stock movements included): off only while the drawn facts go in. */
const COMMAND_TRIGGERS: [string, string][] = [
  ["sales", "sales_confirmation_complete"],
  ["sale_items", "sale_items_confirmation_complete"],
  ["sale_adjustments", "sale_adjustments_confirmation_complete"],
  ["sale_payments", "sale_payments_confirmation_complete"],
  ["sale_cancellations", "sale_cancellations_complete"],
  ["sale_returns", "sale_returns_complete"],
  ["sale_return_items", "sale_return_items_complete"],
];

type AdminPool = ReturnType<typeof createDatabase>["pool"];
type RuntimeDb = ReturnType<typeof createDatabase>["db"];
type Adjustments = Parameters<typeof confirmSale>[2]["adjustments"];
type Payment = Parameters<typeof confirmSale>[2]["payment"];

interface Product {
  productId: string;
  variantId: string;
  version: number;
}

interface Store {
  tenant: TenantFixture;
  timezone: string;
  today: string;
}

/** What `report.periodSummary` answers, built from a read as its handler builds it (no clock, no period). */
function answerOf(
  read: Pick<PeriodSummaryRead, "daily" | "result"> & {
    topProducts?: PeriodSummaryRead["topProducts"];
  }
) {
  const { result } = read;
  return {
    cards: dashboardCards(result),
    chain: {
      anticipationFees: result.anticipationFees,
      cogs: result.cogs,
      commercialSurcharges: result.commercialSurcharges,
      contributionMargin: result.contributionMargin,
      discounts: result.discounts,
      estimatedOperatingResult: result.estimatedOperatingResult,
      grossProfit: result.grossProfit,
      grossSales: result.grossSales,
      linkedExpenses: result.linkedExpenses,
      netSales: result.netSales,
      operatingExpenses: result.operatingExpenses,
      processingFees: result.processingFees,
      returns: result.returns,
    },
    daily: read.daily,
    quality: resultQuality(result),
    ...(read.topProducts
      ? {
          topProducts: read.topProducts.map((entry) => ({
            deleted: entry.deleted,
            name: entry.name,
            netSales: entry.netSales,
            productId: entry.productId,
            quantity: entry.quantity,
          })),
        }
      : {}),
  };
}

/**
 * The definition: the facts of the period through the engine, sale by sale,
 * and the names of the ranked products read in the same snapshot.
 */
async function engineSummary(
  tx: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  period: EconomicsPeriod,
  limit: number | undefined
) {
  const facts = await readPeriodFacts(tx, identity, period);
  const economics = facts.sales.map(saleEconomics);
  const result = periodResult(facts.sales, facts.operatingExpenses, economics);
  const daily = dailyEconomics(
    facts.sales,
    facts.operatingExpenseDays,
    period.from,
    period.to,
    economics
  );
  if (limit === undefined) {
    return { daily, result };
  }
  const ranked = topProducts(facts.sales, limit);
  const named =
    ranked.length === 0
      ? []
      : await tx
          .select({
            deletedAt: products.deletedAt,
            id: products.id,
            name: products.name,
          })
          .from(products)
          .where(
            and(
              eq(products.organizationId, identity.organizationId),
              inArray(
                products.id,
                ranked.map((entry) => entry.productId)
              )
            )
          );
  const byId = new Map(named.map((row) => [row.id, row]));
  return {
    daily,
    result,
    topProducts: ranked.map((entry) => {
      const product = byId.get(entry.productId);
      assert.ok(product, "a ranked product has its row");
      return {
        ...entry,
        deleted: product.deletedAt !== null,
        name: product.name,
      };
    }),
  };
}

/** What the comparisons covered, to prove the fixture holds what the rules handle. */
class Tally {
  comparisons = 0;
  days = 0;
  daysWithSales = 0;
  rankedProducts = 0;
  readonly seen = {
    anticipationUnknown: false,
    costUnknown: false,
    deletedRanked: false,
    discounts: false,
    linkedExpenses: false,
    nullCosts: false,
    operatingExpenses: false,
    processingUnknown: false,
    returns: false,
    surcharges: false,
  };

  add(read: PeriodSummaryRead) {
    this.comparisons += 1;
    this.days += read.daily.length;
    this.daysWithSales += read.daily.filter((day) => day.salesCount > 0).length;
    this.rankedProducts += read.topProducts?.length ?? 0;
    const { result } = read;
    const { seen } = this;
    seen.anticipationUnknown ||= result.unknown.anticipationFees > 0;
    seen.costUnknown ||= result.unknown.costItems > 0;
    seen.processingUnknown ||= result.unknown.processingFees > 0;
    seen.deletedRanked ||= (read.topProducts ?? []).some(
      (entry) => entry.deleted
    );
    seen.discounts ||= result.discounts !== "0.00";
    seen.linkedExpenses ||= result.linkedExpenseCount > 0;
    seen.nullCosts ||= read.daily.some((day) => day.costs === null);
    seen.operatingExpenses ||= result.operatingExpenseCount > 0;
    seen.returns ||= result.returns !== "0.00";
    seen.surcharges ||= result.commercialSurcharges !== "0.00";
  }
}

/** The SQL summary equals the engine's in every field, in one snapshot, as the runtime role under RLS. */
async function assertSame(
  db: RuntimeDb,
  tenant: TenantFixture,
  period: EconomicsPeriod,
  limit: number | undefined,
  label: string,
  tally: Tally
) {
  const [aggregated, engine] = await withAuthorizedTenantTransaction(
    db,
    {
      authenticatedUserId: tenant.userId,
      capability: "report:read",
      isolationLevel: "repeatable read",
      requestedOrganizationId: tenant.organizationId,
    },
    async (tx, identity) => [
      await readPeriodSummary(tx, identity, period, { topProducts: limit }),
      await engineSummary(tx, identity, period, limit),
    ]
  );
  const where = `${label} ${period.from}..${period.to} top ${limit ?? "-"}`;
  assert.deepEqual(aggregated.result, engine.result, `${where}: result`);
  assert.deepEqual(aggregated.daily, engine.daily, `${where}: daily`);
  assert.deepEqual(
    aggregated.topProducts,
    engine.topProducts,
    `${where}: ranking`
  );
  assert.equal(
    JSON.stringify(answerOf(aggregated)),
    JSON.stringify(answerOf(engine)),
    `${where}: the answer, byte by byte`
  );
  assert.deepEqual(aggregated.reads, {
    days: aggregated.daily.length,
    products: aggregated.topProducts?.length ?? 0,
  });
  tally.add(aggregated);
  return aggregated;
}

function centsText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** A small deterministic generator (a linear congruential one, in plain arithmetic). */
function generator(seed: number) {
  const modulus = 2 ** 32;
  let state = Math.abs(Math.trunc(seed)) % modulus;
  return (n: number) => {
    state = (state * 1_664_525 + 1_013_904_223) % modulus;
    return Math.floor((state / modulus) * n);
  };
}

/* ------------------------------------------------------------- scenarios */

interface ProfileRules {
  /** Credit card, two installments by the merchant: the anticipation fee is unknown. */
  anticipationUnknown: Payment;
  /** Credit card, three installments by the issuer: both fees known. */
  feesKnown: Payment;
  id: string;
  /** Pix: a known processing fee. */
  pix: Payment;
  version: number;
}

class Scenarios {
  readonly admin: AdminPool;
  readonly db: RuntimeDb;
  private readonly pick: (n: number) => number;

  constructor(admin: AdminPool, db: RuntimeDb, seed: number) {
    this.admin = admin;
    this.db = db;
    this.pick = generator(seed);
  }

  as<T>(
    tenant: TenantFixture,
    capability: string,
    operation: Parameters<typeof withTenantAs<T>>[3]
  ) {
    return withTenantAs(this.db, tenant, capability, operation);
  }

  /** A time of a store date in the store's zone, as the instant a sale carries. */
  async instantOf(timezone: string, day: string, seconds: number) {
    const result = await this.admin.query<{ instant: string }>(
      `SELECT to_char((($1::date::timestamp + make_interval(secs => $2)) AT TIME ZONE $3) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant`,
      [day, seconds, timezone]
    );
    return result.rows[0]?.instant as string;
  }

  async store(label: string, timezone: string): Promise<Store> {
    const tenant = await createTenantFixture(
      this.admin,
      `period summary ${label}`,
      timezone
    );
    return { tenant, timezone, today: storeDay(runClock, 0, timezone) };
  }

  async products(store: Store, costs: (string | null)[]) {
    const made: Product[] = [];
    for (const [index, cost] of costs.entries()) {
      made.push(
        // biome-ignore lint/performance/noAwaitInLoops: one product after the other, as a store creates them
        await createSellableProduct(
          { adminPool: this.admin, db: this.db },
          store.tenant,
          `PS-${index}`,
          { cost, quantity: 100_000 }
        )
      );
    }
    return made;
  }

  async profile(store: Store): Promise<ProfileRules> {
    const profile = await this.as(
      store.tenant,
      "organization:manage",
      (tx, identity) =>
        createPaymentProfile(tx, identity, {
          name: "Maquininha do resumo",
          rules: [
            {
              anticipationFee: { mode: "none" as const },
              expectedSettlementDays: 1,
              method: "pix",
              processingFee: {
                mode: "percentage" as const,
                percentage: "1.990000",
              },
            },
            {
              anticipationFee: { mode: "unknown" as const },
              expectedSettlementDays: null,
              installmentPlan: "merchant" as const,
              installments: 2,
              method: "credit_card",
              processingFee: {
                mode: "percentage" as const,
                percentage: "3.150000",
              },
            },
            {
              anticipationFee: {
                fixedAmount: "0.25",
                mode: "fixed_and_percentage" as const,
                percentage: "0.500000",
              },
              expectedSettlementDays: 45,
              installmentPlan: "issuer" as const,
              installments: 3,
              method: "credit_card",
              processingFee: {
                fixedAmount: "0.10",
                mode: "fixed_and_percentage" as const,
                percentage: "2.495600",
              },
            },
          ],
        })
    );
    return {
      anticipationUnknown: {
        anticipationRequested: true,
        installmentPlan: "merchant",
        installments: 2,
        method: "credit_card",
      },
      feesKnown: {
        anticipationRequested: true,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
      },
      id: profile.id,
      pix: { anticipationRequested: false, method: "pix" },
      version: profile.version,
    };
  }

  sell(
    store: Store,
    occurredAt: string,
    items: { cents: number; product: Product; quantity: number }[],
    adjustments: Adjustments,
    payment: { payment: Payment; profile: ProfileRules | null } = {
      payment: { anticipationRequested: false, method: "pix" },
      profile: null,
    }
  ) {
    return this.as(store.tenant, "sale:create", (tx, identity) =>
      confirmSale(tx, identity, {
        adjustments,
        commandId: randomUUID(),
        commandVersion: 1,
        items: items.map((item) => ({
          chargedUnitPrice: centsText(item.cents),
          listedUnitPrice: centsText(item.cents),
          quantity: item.quantity,
          variantId: item.product.variantId,
        })),
        occurredAt,
        payment: payment.payment,
        paymentProfile: payment.profile
          ? { expectedVersion: payment.profile.version, id: payment.profile.id }
          : null,
        requestId: randomUUID(),
      })
    );
  }

  giveBack(
    store: Store,
    saleId: string,
    items: {
      position: number;
      restockedQuantity: number;
      returnedQuantity: number;
    }[]
  ) {
    return this.as(store.tenant, "sale:return", (tx, identity) =>
      createSaleReturn(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items,
        saleId,
      })
    );
  }

  cancel(store: Store, saleId: string) {
    return this.as(store.tenant, "sale:cancel", (tx, identity) =>
      cancelSale(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        saleId,
      })
    );
  }

  async expense(
    store: Store,
    amount: string,
    competenceOn: string,
    saleId: string | null,
    voided = false
  ) {
    const created = await this.as(
      store.tenant,
      "expense:create",
      async (tx, identity) => {
        const [category] = await listExpenseCategories(tx, identity);
        assert.ok(category);
        return createExpense(tx, identity, {
          amount,
          categoryId: category.id,
          competenceOn,
          description: `despesa ${amount}`,
          saleId,
        });
      }
    );
    if (voided) {
      await this.as(store.tenant, "expense:create", (tx, identity) =>
        voidExpense(tx, identity, {
          expectedVersion: created.version,
          id: created.id,
        })
      );
    }
  }

  /** A generated sale on one of the last days: discounts, additions, payments of every kind, and a fate. */
  async generatedSale(store: Store, catalog: Product[], profile: ProfileRules) {
    const day = shiftDay(store.today, -1 - this.pick(GENERATED_DAYS));
    const items = Array.from({ length: 1 + this.pick(4) }, () => ({
      cents: 1 + this.pick(30_000),
      product: catalog[this.pick(catalog.length)] as Product,
      quantity: 1 + this.pick(5),
    }));
    const subtotal = items.reduce(
      (total, item) => total + item.cents * item.quantity,
      0
    );
    const adjustments: Adjustments[number][] = [];
    const discount = this.pick(3);
    if (discount === 1 && subtotal > 3) {
      adjustments.push({
        kind: "discount",
        value: {
          amount: centsText(1 + this.pick(Math.floor(subtotal / 3))),
          type: "fixed",
        },
      });
    } else if (discount === 2) {
      adjustments.push({
        kind: "discount",
        value: { percentage: `${1 + this.pick(30)}.5`, type: "percentage" },
      });
    }
    const addition = this.pick(6);
    if (addition < 3) {
      adjustments.push({
        kind: (["freight", "surcharge", "payment_surcharge"] as const)[
          addition
        ] as "freight",
        value: { amount: centsText(1 + this.pick(2000)), type: "fixed" },
      });
    }
    const payments = [
      { payment: profile.pix, profile: null },
      { payment: profile.pix, profile },
      { payment: profile.anticipationUnknown, profile },
      { payment: profile.feesKnown, profile },
    ];
    const confirmed = await this.sell(
      store,
      await this.instantOf(store.timezone, day, this.pick(86_400)),
      items,
      adjustments,
      payments[this.pick(payments.length)]
    );
    await this.fate(store, confirmed.sale.id, items, day);
  }

  /** Returned in part (once or twice), returned in full, cancelled (with a linked expense), linked or kept. */
  private async fate(
    store: Store,
    saleId: string,
    items: { quantity: number }[],
    day: string
  ) {
    const fate = this.pick(10);
    if (fate < 3) {
      const left = items.map((item) => item.quantity);
      for (let round = 0; round < 1 + this.pick(2); round += 1) {
        const position = this.pick(items.length);
        const available = left[position] ?? 0;
        if (available > 0) {
          const returnedQuantity = 1 + this.pick(available);
          left[position] = available - returnedQuantity;
          // biome-ignore lint/performance/noAwaitInLoops: a second return sees the first one
          await this.giveBack(store, saleId, [
            {
              position,
              restockedQuantity: this.pick(returnedQuantity + 1),
              returnedQuantity,
            },
          ]);
        }
      }
    } else if (fate === 3) {
      await this.giveBack(
        store,
        saleId,
        items.map((item, position) => ({
          position,
          restockedQuantity: position % 2 === 0 ? item.quantity : 0,
          returnedQuantity: item.quantity,
        }))
      );
    } else if (fate === 4) {
      await this.expense(store, centsText(1 + this.pick(5000)), day, saleId);
      await this.cancel(store, saleId);
    } else if (fate === 5) {
      await this.expense(store, centsText(1 + this.pick(5000)), day, saleId);
    }
  }
}

/** Sales of the main store, each worked out on its own date, with every rule of the chain. */
async function seedMainStore(scenarios: Scenarios): Promise<Store> {
  const store = await scenarios.store("main", "America/Sao_Paulo");
  const [known, unknown, sixPlaces, dime, sevens] = (await scenarios.products(
    store,
    ["10.00", null, "3.333333", "0.10", "7.777777"]
  )) as [Product, Product, Product, Product, Product];
  const profile = await scenarios.profile(store);
  const at = (daysBack: number) =>
    scenarios.instantOf(
      store.timezone,
      shiftDay(store.today, daysBack),
      43_200
    );

  // three items of 1.00 and a discount of 0.10: 0.03 each, the cent left goes to the first position (a tie)
  const tie = await scenarios.sell(
    store,
    await at(-28),
    [known, sixPlaces, dime].map((product) => ({
      cents: 100,
      product,
      quantity: 1,
    })),
    [{ kind: "discount", value: { amount: "0.10", type: "fixed" } }]
  );
  await scenarios.giveBack(store, tie.sale.id, [
    { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
  ]);
  // a percentage discount, freight and a surcharge, a known processing fee; one unit back twice, restocked once
  const repeated = await scenarios.sell(
    store,
    await at(-27),
    [
      { cents: 3333, product: known, quantity: 3 },
      { cents: 1001, product: sixPlaces, quantity: 1 },
    ],
    [
      { kind: "discount", value: { percentage: "12.5", type: "percentage" } },
      { kind: "freight", value: { amount: "5.00", type: "fixed" } },
      { kind: "surcharge", value: { amount: "1.50", type: "fixed" } },
    ],
    { payment: profile.pix, profile }
  );
  await scenarios.giveBack(store, repeated.sale.id, [
    { position: 0, restockedQuantity: 1, returnedQuantity: 1 },
  ]);
  await scenarios.giveBack(store, repeated.sale.id, [
    { position: 0, restockedQuantity: 0, returnedQuantity: 1 },
  ]);
  // returned in full, everything back on the shelf
  const full = await scenarios.sell(
    store,
    await at(-26),
    [
      { cents: 999, product: known, quantity: 2 },
      { cents: 1999, product: sevens, quantity: 1 },
    ],
    [{ kind: "discount", value: { amount: "0.07", type: "fixed" } }]
  );
  await scenarios.giveBack(store, full.sale.id, [
    { position: 0, restockedQuantity: 2, returnedQuantity: 2 },
    { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
  ]);
  // the cost unknown in part of the items, then in all of them
  await scenarios.sell(
    store,
    await at(-25),
    [
      { cents: 2500, product: unknown, quantity: 1 },
      { cents: 4000, product: known, quantity: 2 },
    ],
    []
  );
  await scenarios.sell(
    store,
    await at(-24),
    [{ cents: 1234, product: unknown, quantity: 2 }],
    []
  );
  // costs of six places, rounded once for the sale: 3 x 3.333333 + 7 x 7.777777 - 1 x 7.777777 back on the shelf
  const sixths = await scenarios.sell(
    store,
    await at(-23),
    [
      { cents: 500, product: sixPlaces, quantity: 3 },
      { cents: 900, product: sevens, quantity: 7 },
    ],
    [{ kind: "payment_surcharge", value: { amount: "2.00", type: "fixed" } }],
    { payment: profile.feesKnown, profile }
  );
  await scenarios.giveBack(store, sixths.sale.id, [
    { position: 1, restockedQuantity: 1, returnedQuantity: 1 },
  ]);
  // the anticipation fee unknown
  await scenarios.sell(
    store,
    await at(-22),
    [{ cents: 15_000, product: known, quantity: 1 }],
    [],
    { payment: profile.anticipationUnknown, profile }
  );
  // an expense linked to a live sale, one voided, and one of a sale cancelled afterwards (operating by competence)
  const linked = await scenarios.sell(
    store,
    await at(-21),
    [{ cents: 8000, product: known, quantity: 1 }],
    [],
    { payment: profile.pix, profile }
  );
  await scenarios.expense(
    store,
    "12.00",
    shiftDay(store.today, -21),
    linked.sale.id
  );
  await scenarios.expense(
    store,
    "99.00",
    shiftDay(store.today, -21),
    linked.sale.id,
    true
  );
  const cancelled = await scenarios.sell(
    store,
    await at(-20),
    [{ cents: 7000, product: known, quantity: 1 }],
    []
  );
  await scenarios.expense(
    store,
    "40.00",
    shiftDay(store.today, -19),
    cancelled.sale.id
  );
  await scenarios.cancel(store, cancelled.sale.id);
  // operating expenses: one in the window, one voided, one long before
  await scenarios.expense(store, "200.00", shiftDay(store.today, -18), null);
  await scenarios.expense(
    store,
    "500.00",
    shiftDay(store.today, -18),
    null,
    true
  );
  await scenarios.expense(store, "1000.00", shiftDay(store.today, -200), null);
  for (let index = 0; index < GENERATED_SALES_PER_STORE; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the generator is sequential, so the seed replays the same sales
    await scenarios.generatedSale(
      store,
      [known, unknown, sixPlaces, dime, sevens],
      profile
    );
  }
  return store;
}

/** A store of another zone: a sale a second before and one a second after its midnight, and generated ones. */
async function seedZoneStore(
  scenarios: Scenarios,
  timezone: string
): Promise<Store> {
  const store = await scenarios.store(timezone, timezone);
  const catalog = await scenarios.products(store, ["2.50", null, "1.000001"]);
  const profile = await scenarios.profile(store);
  const [first] = catalog as [Product];
  const before = await scenarios.sell(
    store,
    await scenarios.instantOf(timezone, shiftDay(store.today, -2), 86_399),
    [{ cents: 1000, product: first, quantity: 1 }],
    []
  );
  const after = await scenarios.sell(
    store,
    await scenarios.instantOf(timezone, shiftDay(store.today, -1), 1),
    [{ cents: 2000, product: first, quantity: 1 }],
    []
  );
  assert.equal(before.sale.occurredOn, shiftDay(store.today, -2));
  assert.equal(after.sale.occurredOn, shiftDay(store.today, -1));
  for (let index = 0; index < GENERATED_SALES_PER_STORE; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the generator is sequential, so the seed replays the same sales
    await scenarios.generatedSale(store, catalog, profile);
  }
  return store;
}

/**
 * The ranking: two products tied on units and net sales (the product ID breaks the tie), one with fewer units and
 * more net sales, one whose units all came back (left out), and one deleted after it sold (kept, marked).
 */
async function seedRankingStore(scenarios: Scenarios): Promise<Store> {
  const store = await scenarios.store("ranking", "America/Sao_Paulo");
  const [a, b, c, d, e] = (await scenarios.products(store, [
    "1.00",
    "1.00",
    "1.00",
    "1.00",
    null,
  ])) as [Product, Product, Product, Product, Product];
  const deletedProduct = await createSellableProduct(
    { adminPool: scenarios.admin, db: scenarios.db },
    store.tenant,
    "PS-excluido",
    { cost: "1.00", quantity: 3 }
  );
  const day = await scenarios.instantOf(
    store.timezone,
    shiftDay(store.today, -3),
    43_200
  );
  await scenarios.sell(
    store,
    day,
    [
      { cents: 500, product: a, quantity: 2 },
      { cents: 500, product: b, quantity: 2 },
      { cents: 1500, product: c, quantity: 1 },
      { cents: 100, product: d, quantity: 4 },
    ],
    [{ kind: "discount", value: { amount: "1.00", type: "fixed" } }]
  );
  const allBack = await scenarios.sell(
    store,
    day,
    [{ cents: 9900, product: e, quantity: 3 }],
    []
  );
  await scenarios.giveBack(store, allBack.sale.id, [
    { position: 0, restockedQuantity: 3, returnedQuantity: 3 },
  ]);
  await scenarios.sell(
    store,
    day,
    [{ cents: 700, product: deletedProduct, quantity: 3 }],
    []
  );
  await scenarios.as(store.tenant, "product:update", (tx, identity) =>
    deleteProduct(tx, identity, {
      expectedVersion: deletedProduct.version,
      id: deletedProduct.productId,
      requestId: randomUUID(),
    })
  );
  return store;
}

/** Some sales of each store moved to the far end of a year by an UPDATE of the sale's dates only. */
async function moveSomeBack(admin: AdminPool, stores: Store[]) {
  const moved = await admin.query(
    `UPDATE public.sales
        SET occurred_at = occurred_at - make_interval(days => $2),
            occurred_on = occurred_on - $2::int
      WHERE id IN (
        SELECT ranked.id FROM (
          SELECT sale.id,
            row_number() OVER (PARTITION BY sale.organization_id ORDER BY sale.id DESC) AS latest
          FROM public.sales AS sale
          WHERE sale.organization_id = ANY($1)
        ) AS ranked
        WHERE ranked.latest <= $3
      )`,
    [
      stores.map((store) => store.tenant.organizationId),
      MOVED_BACK_DAYS,
      MOVED_BACK_PER_STORE,
    ]
  );
  assert.equal(moved.rowCount, MOVED_BACK_PER_STORE * stores.length);
}

/** The windows of a store: a year, a month, single days (each day with sales of the last weeks), and the far end. */
function windowsOf(store: Store): EconomicsPeriod[] {
  const { today } = store;
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = shiftDay(today, -1 - index);
    return { from: day, to: day };
  });
  return [
    { from: shiftDay(today, 1 - MAX_ECONOMICS_PERIOD_DAYS), to: today },
    { from: shiftDay(today, -30), to: today },
    { from: shiftDay(today, -30), to: shiftDay(today, -1) },
    ...days,
    {
      from: shiftDay(today, -MOVED_BACK_DAYS - GENERATED_DAYS - 3),
      to: shiftDay(today, -MOVED_BACK_DAYS),
    },
  ];
}

async function assertScenarios(db: RuntimeDb, stores: Store[], tally: Tally) {
  for (const store of stores) {
    for (const [index, period] of windowsOf(store).entries()) {
      const limit = index % 3 === 0 ? undefined : 1 + (index % 10);
      // biome-ignore lint/performance/noAwaitInLoops: each window is its own pair of reads
      await assertSame(db, store.tenant, period, limit, store.timezone, tally);
    }
  }
}

async function assertRanking(db: RuntimeDb, store: Store, tally: Tally) {
  const day = shiftDay(store.today, -3);
  for (const limit of [1, 2, 3, 4, 5, 10]) {
    // biome-ignore lint/performance/noAwaitInLoops: one limit after the other
    const read = await assertSame(
      db,
      store.tenant,
      { from: day, to: day },
      limit,
      "ranking",
      tally
    );
    if (limit === 10) {
      const ranked = read.topProducts ?? [];
      assert.equal(
        ranked.length,
        5,
        "the product whose units all came back is left out"
      );
      assert.equal(ranked[0]?.quantity, 4);
      assert.equal(ranked[1]?.quantity, 3);
      assert.equal(ranked[1]?.deleted, true);
      assert.equal(ranked[2]?.netSales, ranked[3]?.netSales, "a tie");
      assert.ok(
        (ranked[2]?.productId ?? "") < (ranked[3]?.productId ?? ""),
        "the tie is broken by the product ID"
      );
    }
  }
}

/** An organization without sales, one with only expenses, and the statement of one store read in another's context. */
async function assertEmptyAndIsolated(
  admin: AdminPool,
  scenarios: Scenarios,
  db: RuntimeDb,
  [main, other]: Store[],
  tally: Tally
) {
  assert.ok(main && other);
  const empty = await scenarios.store("empty", "America/Sao_Paulo");
  const onlyExpenses = await scenarios.store("expenses", "America/Sao_Paulo");
  await scenarios.expense(
    onlyExpenses,
    "80.00",
    shiftDay(onlyExpenses.today, -2),
    null
  );
  for (const store of [empty, onlyExpenses]) {
    for (const period of [
      { from: store.today, to: store.today },
      { from: shiftDay(store.today, -30), to: store.today },
      {
        from: shiftDay(store.today, 1 - MAX_ECONOMICS_PERIOD_DAYS),
        to: store.today,
      },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each window is its own pair of reads
      const read = await assertSame(
        db,
        store.tenant,
        period,
        3,
        "empty",
        tally
      );
      assert.equal(read.result.salesCount, 0);
      assert.deepEqual(read.topProducts, []);
    }
  }
  const year = {
    from: shiftDay(main.today, 1 - MAX_ECONOMICS_PERIOD_DAYS),
    to: main.today,
  };
  // the statement asked for the main store inside another store's context finds nothing (RLS)
  const crossed = await scenarios.as(other.tenant, "report:read", (tx) =>
    tx.execute(periodSummaryQuery(main.tenant.organizationId, year, 10))
  );
  const rows = crossed.rows as {
    gross: string;
    operating: string;
    sales: number;
    top_products: string | null;
  }[];
  assert.equal(rows.length, MAX_ECONOMICS_PERIOD_DAYS);
  assert.ok(
    rows.every(
      (row) =>
        Number(row.sales) === 0 && row.gross === "0" && row.operating === "0"
    )
  );
  assert.equal(rows[0]?.top_products, "[]");
  const own = await admin.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM public.sales WHERE organization_id = $1",
    [main.tenant.organizationId]
  );
  assert.ok(Number(own.rows[0]?.count) > 0, "the main store has sales to hide");
}

/**
 * The rows of a store of `VOLUME_SALES` sales in one month, written by the owner
 * in bulk (the drawn kinds of the property, in the same proportions as a busy
 * store: a third discounted, some freight and surcharges, a fifth without a
 * known fee, returns, cancellations and linked expenses), with named values
 * bound by `bindNamed`.
 */
const VOLUME_STATEMENTS = [
  `CREATE TEMP TABLE volume_sale ON COMMIT DROP AS
   SELECT g, uuidv7() AS id,
     :first_day::date + (g * 31 / (:sales::int + 1)) AS day,
     1 + mod(abs(hashint8(g * 11)), 4) AS items,
     mod(abs(hashint8(g * 19)), 100) AS fate
   FROM generate_series(1, :sales::int) AS g`,
  `INSERT INTO public.sales (adjustment_count, command_id, id, item_count, occurred_at, occurred_on, organization_id)
   SELECT 0, gen_random_uuid(), id, items, day + time '12:00', day, :organization::text FROM volume_sale`,
  `CREATE TEMP TABLE volume_item ON COMMIT DROP AS
   SELECT sale.id AS sale_id, sale.g, line.position,
     1 + mod(abs(hashint8(sale.g * 29 + line.position * 31)), array_length(:products::uuid[], 1)) AS product,
     round(1 + mod(abs(hashint8(sale.g * 17 + line.position)), 29_500) / 100.0, 2) AS price,
     1 + mod(abs(hashint8(sale.g * 23 + line.position * 5)), 3) AS quantity,
     CASE WHEN mod(abs(hashint8(sale.g * 13 + line.position)), 10) = 0 THEN NULL
       ELSE round(mod(abs(hashint8(sale.g * 7 + line.position)), 100_000_000) / 1000000.0, 6) END AS cost
   FROM volume_sale AS sale
   CROSS JOIN LATERAL generate_series(0, sale.items - 1) AS line (position)`,
  `INSERT INTO public.sale_items (charged_unit_price, listed_unit_price, organization_id, position, product_id, product_label,
     quantity, sale_id, unit_cost, variant_id)
   SELECT price, price, :organization::text, position, (:products::uuid[])[product], 'Produto', quantity, sale_id, cost, (:variants::uuid[])[product]
   FROM volume_item`,
  `INSERT INTO public.sale_adjustments (amount, kind, organization_id, position, sale_id, value_type)
   SELECT greatest(0.01, round(total * (1 + mod(abs(hashint8(g * 37)), 10)) / 100.0, 2)), 'discount', :organization::text, 0, sale_id, 'fixed'
     FROM (SELECT sale_id, g, sum(price * quantity) AS total FROM volume_item GROUP BY sale_id, g) AS sale
    WHERE mod(abs(hashint8(g * 41)), 3) = 0
   UNION ALL
   SELECT round(5 + mod(abs(hashint8(g * 43)), 2500) / 100.0, 2), 'freight', :organization::text, 1, id, 'fixed'
     FROM volume_sale WHERE mod(abs(hashint8(g * 47)), 10) = 0
   UNION ALL
   SELECT 2.50, 'surcharge', :organization::text, 2, id, 'fixed' FROM volume_sale WHERE mod(abs(hashint8(g * 53)), 30) = 0`,
  `INSERT INTO public.sale_payments (amount, method, organization_id, payment_profile_id, payment_profile_name_snapshot,
     payment_profile_rule_id_snapshot, payment_profile_version_snapshot, processing_fee_amount_snapshot,
     processing_fee_fixed_amount_snapshot, processing_fee_mode_snapshot, sale_id)
   SELECT 0, 'pix', :organization::text,
     CASE WHEN known THEN :profile::uuid END, CASE WHEN known THEN 'Maquininha' END, CASE WHEN known THEN :rule::uuid END,
     CASE WHEN known THEN 1 END, CASE WHEN known THEN 1.99 END, CASE WHEN known THEN 1.99 END,
     CASE WHEN known THEN 'fixed' ELSE 'unknown' END, id
   FROM (SELECT id, mod(abs(hashint8(g * 61)), 5) <> 0 AS known FROM volume_sale) AS sale`,
  `CREATE TEMP TABLE volume_return ON COMMIT DROP AS
   SELECT uuidv7() AS id, sale.id AS sale_id, sale.g FROM volume_sale AS sale WHERE sale.fate < 4`,
  `INSERT INTO public.sale_returns (command_id, id, organization_id, returned_by, sale_id)
   SELECT gen_random_uuid(), id, :organization::text, :user_id::text, sale_id FROM volume_return`,
  `INSERT INTO public.sale_return_items (item_position, organization_id, restocked_quantity, return_id, returned_quantity, sale_id)
   SELECT 0, :organization::text, mod(g, 2), id, 1, sale_id FROM volume_return`,
  `INSERT INTO public.sale_cancellations (cancelled_by, command_id, organization_id, sale_id)
   SELECT :user_id::text, gen_random_uuid(), :organization::text, id FROM volume_sale WHERE fate BETWEEN 4 AND 5`,
  `INSERT INTO public.expenses (amount, category_id, competence_on, description, organization_id, sale_id)
   SELECT round(1 + mod(abs(hashint8(g * 67)), 1900) / 100.0, 2), :category::uuid, day, 'Taxa', :organization::text, id
     FROM volume_sale WHERE fate BETWEEN 6 AND 10
   UNION ALL
   SELECT round(50 + mod(abs(hashint8(e * 71)), 50_000) / 100.0, 2), :category::uuid, :first_day::date + mod(e, 31), 'Aluguel', :organization::text, NULL
     FROM generate_series(1, 40) AS e`,
];

const NAMED_VALUE = /(?<!:):([a-z_]+)/g;

/** A statement with `:name` values as `$n` placeholders and its parameters, only the ones it uses. */
function bindNamed(text: string, values: Readonly<Record<string, unknown>>) {
  const order: string[] = [];
  const bound = text.replace(NAMED_VALUE, (_match, name: string) => {
    assert.ok(name in values, `no value for :${name}`);
    if (!order.includes(name)) {
      order.push(name);
    }
    return `$${order.indexOf(name) + 1}`;
  });
  return { params: order.map((name) => values[name]), text: bound };
}

/** The plan of the statement in the volume store, as the runtime role under RLS: the database's own time. */
async function explainVolume(
  scenarios: Scenarios,
  tenant: TenantFixture,
  period: EconomicsPeriod,
  limit: number | undefined
) {
  const plan = await scenarios.as(tenant, "report:read", (tx, identity) =>
    tx.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${periodSummaryQuery(identity.organizationId, period, limit)}`
    )
  );
  const [row] = plan.rows as {
    "QUERY PLAN": [{ "Execution Time": number; "Planning Time": number }];
  }[];
  assert.ok(row);
  const [explained] = row["QUERY PLAN"];
  return `execution ${explained["Execution Time"]} ms, planning ${explained["Planning Time"]} ms`;
}

/**
 * A month of `VOLUME_SALES` sales: the SQL summary equals the engine there too,
 * and the database time of the statement (EXPLAIN ANALYZE, BUFFERS) is printed
 * for the hardware of the run. A gate fixture written in bulk with the command
 * triggers off, in its own organization and a month no other proof reads.
 */
async function assertVolume(
  admin: AdminPool,
  scenarios: Scenarios,
  db: RuntimeDb,
  tally: Tally
) {
  const store = await propertyStore(scenarios, "volume");
  const client = await admin.connect();
  await setCommandTriggers(admin, false);
  try {
    await client.query("BEGIN");
    const values = {
      category: store.categoryId,
      first_day: VOLUME_FROM,
      organization: store.tenant.organizationId,
      products: store.catalog.map((product) => product.productId),
      profile: store.profileId,
      rule: store.ruleId,
      sales: VOLUME_SALES,
      user_id: store.tenant.userId,
      variants: store.catalog.map((product) => product.variantId),
    };
    for (const statement of VOLUME_STATEMENTS) {
      const bound = bindNamed(statement, values);
      // biome-ignore lint/performance/noAwaitInLoops: the tables go in after the ones they reference
      await client.query(bound.text, bound.params);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await setCommandTriggers(admin, true);
  }
  await admin.query(
    "ANALYZE public.sales, public.sale_items, public.sale_adjustments, public.sale_payments, public.sale_return_items, public.sale_cancellations, public.expenses"
  );
  const period = { from: VOLUME_FROM, to: shiftDay(VOLUME_FROM, 30) };
  const read = await assertSame(db, store.tenant, period, 3, "volume", tally);
  assert.ok(read.result.salesCount > VOLUME_SALES * 0.95);
  const ranked = await explainVolume(scenarios, store.tenant, period, 3);
  const plain = await explainVolume(scenarios, store.tenant, period, undefined);
  console.log(
    `gate-note: period-summary-sql EXPLAIN (ANALYZE, BUFFERS) under RLS of a month of ${VOLUME_SALES} sales: with the ranking ${ranked}; without ${plain}`
  );
  return read.result.salesCount;
}

/* -------------------------------------------------------------- property */

interface DrawnItem {
  cents: number;
  /** Micro-units (six places), or null when unknown. */
  cost: number | null;
  product: number;
  quantity: number;
}

interface DrawnSale {
  additions: {
    cents: number;
    kind: "freight" | "payment_surcharge" | "surcharge";
  }[];
  day: number;
  /** Percent of the subtotal (0 to 100) per discount adjustment. */
  discounts: number[];
  fate: "cancel" | "keep" | "returns";
  items: DrawnItem[];
  linked: { cents: number; day: number; voided: boolean }[];
  payment:
    | { kind: "missing" }
    | { kind: "unknown" }
    | { anticipation: number | null; kind: "card"; processing: number }
    | { kind: "pix"; processing: number };
  returns: { position: number; restockedPart: number; units: number }[];
}

interface DrawnCase {
  limit: number | null;
  operating: { cents: number; day: number; voided: boolean }[];
  period: { length: number; start: number };
  sales: DrawnSale[];
}

const PROPERTY_PRODUCTS = 6;
/** A month of this many sales, the largest store of the bench, before slot 0 of the property. */
const VOLUME_SALES = 9100;
const VOLUME_FROM = "2000-02-01";

const saleArb: fc.Arbitrary<DrawnSale> = fc.record({
  additions: fc.array(
    fc.record({
      cents: fc.integer({ max: 5000, min: 0 }),
      kind: fc.constantFrom("freight", "payment_surcharge", "surcharge"),
    }),
    { maxLength: 2 }
  ),
  day: fc.nat({ max: SLOT_DAYS - 1 }),
  discounts: fc.array(fc.integer({ max: 100, min: 0 }), { maxLength: 2 }),
  fate: fc.constantFrom("keep", "keep", "returns", "returns", "cancel"),
  items: fc.array(
    fc.record({
      cents: fc.oneof(
        { arbitrary: fc.constant(0), weight: 1 },
        { arbitrary: fc.integer({ max: 50_000, min: 1 }), weight: 9 }
      ),
      cost: fc.option(fc.integer({ max: 30_000_000, min: 0 }), { freq: 4 }),
      product: fc.nat({ max: PROPERTY_PRODUCTS - 1 }),
      quantity: fc.integer({ max: 7, min: 1 }),
    }),
    { maxLength: 5, minLength: 1 }
  ),
  linked: fc.array(
    fc.record({
      cents: fc.integer({ max: 10_000, min: 1 }),
      day: fc.nat({ max: SLOT_DAYS - 1 }),
      voided: fc.boolean(),
    }),
    { maxLength: 2 }
  ),
  payment: fc.oneof(
    { arbitrary: fc.constant({ kind: "missing" as const }), weight: 1 },
    { arbitrary: fc.constant({ kind: "unknown" as const }), weight: 3 },
    {
      arbitrary: fc.record({
        kind: fc.constant("pix" as const),
        processing: fc.integer({ max: 2000, min: 0 }),
      }),
      weight: 3,
    },
    {
      arbitrary: fc.record({
        anticipation: fc.option(fc.integer({ max: 2000, min: 0 }), { freq: 3 }),
        kind: fc.constant("card" as const),
        processing: fc.integer({ max: 2000, min: 0 }),
      }),
      weight: 3,
    }
  ),
  returns: fc.array(
    fc.record({
      position: fc.nat({ max: 4 }),
      restockedPart: fc.nat({ max: 3 }),
      units: fc.integer({ max: 7, min: 1 }),
    }),
    { maxLength: 3 }
  ),
});

const caseArb: fc.Arbitrary<DrawnCase> = fc.record({
  limit: fc.option(fc.integer({ max: 10, min: 1 }), { freq: 3 }),
  operating: fc.array(
    fc.record({
      cents: fc.integer({ max: 100_000, min: 1 }),
      day: fc.nat({ max: SLOT_DAYS - 1 }),
      voided: fc.boolean(),
    }),
    { maxLength: 4 }
  ),
  period: fc.record({
    length: fc.nat({ max: 30 }),
    start: fc.nat({ max: SLOT_DAYS - 1 }),
  }),
  sales: fc.array(saleArb, { maxLength: 8 }),
});

function microText(micro: number): string {
  return `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`;
}

/** The return lines a drawn sale can hold: never more units back than sold, never more restocked than returned. */
function returnLines(sale: DrawnSale) {
  const left = sale.items.map((item) => item.quantity);
  const lines: { position: number; restocked: number; returned: number }[] = [];
  for (const draw of sale.returns) {
    const position = draw.position % sale.items.length;
    const available = left[position] ?? 0;
    const returned = Math.min(draw.units, available);
    if (returned > 0) {
      left[position] = available - returned;
      lines.push({
        position,
        restocked: Math.floor((returned * draw.restockedPart) / 3),
        returned,
      });
    }
  }
  return lines;
}

interface PropertyStore {
  catalog: Product[];
  categoryId: string;
  profileId: string;
  ruleId: string;
  tenant: TenantFixture;
}

type Row = Record<string, unknown>;

type Table =
  | "adjustments"
  | "cancellations"
  | "expenses"
  | "items"
  | "payments"
  | "returnItems"
  | "returns"
  | "sales";

type Rows = Record<Table, Row[]>;

/** The rows of a drawn sale, table by table. */
function saleRows(
  store: PropertyStore,
  sale: DrawnSale,
  slotStart: string,
  rows: Rows
) {
  const organization = store.tenant.organizationId;
  const saleId = randomUUID();
  const occurredOn = shiftDay(slotStart, sale.day);
  const additions = sale.additions.length;
  const subtotal = sale.items.reduce(
    (total, item) => total + item.cents * item.quantity,
    0
  );
  rows.sales.push({
    adjustment_count: sale.discounts.length + additions,
    command_id: randomUUID(),
    id: saleId,
    item_count: sale.items.length,
    occurred_at: `${occurredOn}T15:00:00.000Z`,
    occurred_on: occurredOn,
    organization_id: organization,
  });
  for (const [position, item] of sale.items.entries()) {
    const product = store.catalog[
      item.product % store.catalog.length
    ] as Product;
    rows.items.push({
      charged_unit_price: centsText(item.cents),
      listed_unit_price: centsText(item.cents),
      organization_id: organization,
      position,
      product_id: product.productId,
      product_label: "Produto sorteado",
      quantity: item.quantity,
      sale_id: saleId,
      unit_cost: item.cost === null ? null : microText(item.cost),
      variant_id: product.variantId,
    });
  }
  const adjustments = [
    ...sale.discounts.map((percent) => ({
      cents: Math.floor((subtotal * percent) / 100),
      kind: "discount",
    })),
    ...sale.additions,
  ];
  for (const [position, adjustment] of adjustments.entries()) {
    rows.adjustments.push({
      amount: centsText(adjustment.cents),
      kind: adjustment.kind,
      organization_id: organization,
      position,
      sale_id: saleId,
      value_type: "fixed",
    });
  }
  const payment = paymentRow(store, sale, saleId, subtotal);
  if (payment) {
    rows.payments.push(payment);
  }
  if (sale.fate === "cancel") {
    rows.cancellations.push({
      cancelled_by: store.tenant.userId,
      command_id: randomUUID(),
      organization_id: organization,
      sale_id: saleId,
    });
  } else if (sale.fate === "returns") {
    for (const line of returnLines(sale)) {
      const returnId = randomUUID();
      rows.returns.push({
        command_id: randomUUID(),
        id: returnId,
        organization_id: organization,
        returned_by: store.tenant.userId,
        sale_id: saleId,
      });
      rows.returnItems.push({
        item_position: line.position,
        organization_id: organization,
        restocked_quantity: line.restocked,
        return_id: returnId,
        returned_quantity: line.returned,
        sale_id: saleId,
      });
    }
  }
  for (const expense of sale.linked) {
    rows.expenses.push(expenseRow(store, slotStart, expense, saleId));
  }
}

function paymentRow(
  store: PropertyStore,
  sale: DrawnSale,
  saleId: string,
  subtotal: number
): Row | null {
  const base = {
    amount: centsText(subtotal),
    anticipation_fee_amount_snapshot: "0.00",
    anticipation_fee_fixed_amount_snapshot: null,
    anticipation_fee_mode_snapshot: "not_applicable",
    anticipation_requested: false,
    installment_plan: null,
    installments: null,
    method: "pix",
    organization_id: store.tenant.organizationId,
    payment_profile_id: null,
    payment_profile_name_snapshot: null,
    payment_profile_rule_id_snapshot: null,
    payment_profile_version_snapshot: null,
    processing_fee_amount_snapshot: null,
    processing_fee_fixed_amount_snapshot: null,
    processing_fee_mode_snapshot: "unknown",
    sale_id: saleId,
  };
  const { payment } = sale;
  if (payment.kind === "missing") {
    return null;
  }
  if (payment.kind === "unknown") {
    return base;
  }
  const profile = {
    payment_profile_id: store.profileId,
    payment_profile_name_snapshot: "Maquininha sorteada",
    payment_profile_rule_id_snapshot: store.ruleId,
    payment_profile_version_snapshot: 1,
    processing_fee_amount_snapshot: centsText(payment.processing),
    processing_fee_fixed_amount_snapshot: centsText(payment.processing),
    processing_fee_mode_snapshot: "fixed",
  };
  if (payment.kind === "pix") {
    return { ...base, ...profile };
  }
  return {
    ...base,
    ...profile,
    anticipation_fee_amount_snapshot:
      payment.anticipation === null ? null : centsText(payment.anticipation),
    anticipation_fee_fixed_amount_snapshot:
      payment.anticipation === null ? null : centsText(payment.anticipation),
    anticipation_fee_mode_snapshot:
      payment.anticipation === null ? "unknown" : "fixed",
    anticipation_requested: true,
    installment_plan: "merchant",
    installments: 2,
    method: "credit_card",
  };
}

function expenseRow(
  store: PropertyStore,
  slotStart: string,
  expense: { cents: number; day: number; voided: boolean },
  saleId: string | null
): Row {
  return {
    amount: centsText(expense.cents),
    category_id: store.categoryId,
    competence_on: shiftDay(slotStart, expense.day),
    description: "despesa sorteada",
    organization_id: store.tenant.organizationId,
    sale_id: saleId,
    voided: expense.voided,
  };
}

const INSERTS: [Table, string][] = [
  [
    "sales",
    `INSERT INTO public.sales (adjustment_count, command_id, id, item_count, occurred_at, occurred_on, organization_id)
     SELECT adjustment_count, command_id, id, item_count, occurred_at, occurred_on, organization_id
       FROM jsonb_to_recordset($1::jsonb) AS row (adjustment_count int, command_id uuid, id uuid, item_count int,
         occurred_at timestamptz, occurred_on date, organization_id text)`,
  ],
  [
    "items",
    `INSERT INTO public.sale_items (charged_unit_price, listed_unit_price, organization_id, position, product_id, product_label,
       quantity, sale_id, unit_cost, variant_id)
     SELECT charged_unit_price, listed_unit_price, organization_id, position, product_id, product_label, quantity, sale_id,
       unit_cost, variant_id
       FROM jsonb_to_recordset($1::jsonb) AS row (charged_unit_price numeric, listed_unit_price numeric, organization_id text,
         position int, product_id uuid, product_label text, quantity int, sale_id uuid, unit_cost numeric, variant_id uuid)`,
  ],
  [
    "adjustments",
    `INSERT INTO public.sale_adjustments (amount, kind, organization_id, position, sale_id, value_type)
     SELECT amount, kind, organization_id, position, sale_id, value_type
       FROM jsonb_to_recordset($1::jsonb) AS row (amount numeric, kind text, organization_id text, position int, sale_id uuid,
         value_type text)`,
  ],
  [
    "payments",
    `INSERT INTO public.sale_payments (amount, anticipation_fee_amount_snapshot, anticipation_fee_fixed_amount_snapshot,
       anticipation_fee_mode_snapshot, anticipation_requested, installment_plan, installments, method, organization_id,
       payment_profile_id, payment_profile_name_snapshot, payment_profile_rule_id_snapshot, payment_profile_version_snapshot,
       processing_fee_amount_snapshot, processing_fee_fixed_amount_snapshot, processing_fee_mode_snapshot, sale_id)
     SELECT amount, anticipation_fee_amount_snapshot, anticipation_fee_fixed_amount_snapshot, anticipation_fee_mode_snapshot,
       anticipation_requested, installment_plan, installments, method, organization_id, payment_profile_id,
       payment_profile_name_snapshot, payment_profile_rule_id_snapshot, payment_profile_version_snapshot,
       processing_fee_amount_snapshot, processing_fee_fixed_amount_snapshot, processing_fee_mode_snapshot, sale_id
       FROM jsonb_to_recordset($1::jsonb) AS row (amount numeric, anticipation_fee_amount_snapshot numeric,
         anticipation_fee_fixed_amount_snapshot numeric, anticipation_fee_mode_snapshot text, anticipation_requested boolean,
         installment_plan text, installments int, method text, organization_id text, payment_profile_id uuid,
         payment_profile_name_snapshot text, payment_profile_rule_id_snapshot uuid, payment_profile_version_snapshot int,
         processing_fee_amount_snapshot numeric, processing_fee_fixed_amount_snapshot numeric,
         processing_fee_mode_snapshot text, sale_id uuid)`,
  ],
  [
    "cancellations",
    `INSERT INTO public.sale_cancellations (cancelled_by, command_id, organization_id, sale_id)
     SELECT cancelled_by, command_id, organization_id, sale_id
       FROM jsonb_to_recordset($1::jsonb) AS row (cancelled_by text, command_id uuid, organization_id text, sale_id uuid)`,
  ],
  [
    "returns",
    `INSERT INTO public.sale_returns (command_id, id, organization_id, returned_by, sale_id)
     SELECT command_id, id, organization_id, returned_by, sale_id
       FROM jsonb_to_recordset($1::jsonb) AS row (command_id uuid, id uuid, organization_id text, returned_by text, sale_id uuid)`,
  ],
  [
    "returnItems",
    `INSERT INTO public.sale_return_items (item_position, organization_id, restocked_quantity, return_id, returned_quantity,
       sale_id)
     SELECT item_position, organization_id, restocked_quantity, return_id, returned_quantity, sale_id
       FROM jsonb_to_recordset($1::jsonb) AS row (item_position int, organization_id text, restocked_quantity int,
         return_id uuid, returned_quantity int, sale_id uuid)`,
  ],
  [
    "expenses",
    `INSERT INTO public.expenses (amount, category_id, competence_on, description, organization_id, sale_id, voided_at)
     SELECT amount, category_id, competence_on, description, organization_id, sale_id,
       CASE WHEN voided THEN statement_timestamp() END
       FROM jsonb_to_recordset($1::jsonb) AS row (amount numeric, category_id uuid, competence_on date, description text,
         organization_id text, sale_id uuid, voided boolean)`,
  ],
];

/** Writes a drawn case into its slot, in one transaction of the owner. */
async function writeCase(
  admin: AdminPool,
  store: PropertyStore,
  drawn: DrawnCase,
  slotStart: string
) {
  const rows: Rows = {
    adjustments: [],
    cancellations: [],
    expenses: [],
    items: [],
    payments: [],
    returnItems: [],
    returns: [],
    sales: [],
  };
  for (const sale of drawn.sales) {
    saleRows(store, sale, slotStart, rows);
  }
  for (const expense of drawn.operating) {
    rows.expenses.push(expenseRow(store, slotStart, expense, null));
  }
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    for (const [table, statement] of INSERTS) {
      if (rows[table].length > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: the tables go in after the ones they reference
        await client.query(statement, [JSON.stringify(rows[table])]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function propertyStore(
  scenarios: Scenarios,
  label = "property"
): Promise<PropertyStore> {
  const store = await scenarios.store(label, "America/Sao_Paulo");
  const catalog = await scenarios.products(store, [
    "1.00",
    "2.00",
    "3.00",
    "4.00",
    "5.00",
  ]);
  const doomed = await createSellableProduct(
    { adminPool: scenarios.admin, db: scenarios.db },
    store.tenant,
    "PS-sorteado-excluido",
    { cost: "1.00", quantity: 1 }
  );
  // a product is deleted only with no stock: its one unit is sold first, on a date outside every slot
  await scenarios.sell(
    store,
    await scenarios.instantOf(
      store.timezone,
      shiftDay(store.today, -1),
      43_200
    ),
    [{ cents: 100, product: doomed, quantity: 1 }],
    []
  );
  await scenarios.as(store.tenant, "product:update", (tx, identity) =>
    deleteProduct(tx, identity, {
      expectedVersion: doomed.version,
      id: doomed.productId,
      requestId: randomUUID(),
    })
  );
  const profile = await scenarios.profile(store);
  const rule = await scenarios.admin.query<{ id: string }>(
    "SELECT id FROM public.payment_profile_rules WHERE organization_id = $1 LIMIT 1",
    [store.tenant.organizationId]
  );
  const categoryId = await scenarios.as(
    store.tenant,
    "expense:create",
    async (tx, identity) => {
      const [category] = await listExpenseCategories(tx, identity);
      assert.ok(category);
      return category.id;
    }
  );
  assert.ok(rule.rows[0]);
  return {
    catalog: [...catalog, doomed],
    categoryId,
    profileId: profile.id,
    ruleId: rule.rows[0].id,
    tenant: store.tenant,
  };
}

async function setCommandTriggers(admin: AdminPool, enabled: boolean) {
  for (const [table, trigger] of COMMAND_TRIGGERS) {
    // biome-ignore lint/performance/noAwaitInLoops: one table at a time
    await admin.query(
      `ALTER TABLE public.${table} ${enabled ? "ENABLE" : "DISABLE"} TRIGGER ${trigger}`
    );
  }
}

async function assertProperty(
  admin: AdminPool,
  scenarios: Scenarios,
  db: RuntimeDb,
  options: { path: string | undefined; runs: number; seed: number },
  tally: Tally
) {
  const store = await propertyStore(scenarios);
  let slot = 0;
  const property = fc.asyncProperty(caseArb, async (drawn) => {
    const slotStart = shiftDay(SLOT_ORIGIN, slot * SLOT_DAYS);
    slot += 1;
    await setCommandTriggers(admin, false);
    try {
      await writeCase(admin, store, drawn, slotStart);
    } finally {
      await setCommandTriggers(admin, true);
    }
    const from = shiftDay(slotStart, drawn.period.start);
    const last = shiftDay(slotStart, SLOT_DAYS - 1);
    const end = shiftDay(from, drawn.period.length);
    await assertSame(
      db,
      store.tenant,
      { from, to: end < last ? end : last },
      drawn.limit ?? undefined,
      `property slot ${slot}`,
      tally
    );
  });
  await fc.assert(property, {
    endOnFailure: true,
    numRuns: options.runs,
    seed: options.seed,
    ...(options.path ? { path: options.path } : {}),
  });
  return slot;
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let loginRole: string | undefined;
  const tests: string[] = [];
  const seed = Number(process.env.POLARIS_PERIOD_SUMMARY_SEED ?? DEFAULT_SEED);
  const runs = Number(process.env.POLARIS_PERIOD_SUMMARY_RUNS ?? MIN_RUNS);
  const path = process.env.POLARIS_PERIOD_SUMMARY_PATH;
  assert.ok(
    Number.isInteger(runs) && runs >= MIN_RUNS,
    `at least ${MIN_RUNS} runs`
  );
  console.log(`gate-note: period-summary-sql seed ${seed} runs ${runs}`);

  try {
    const server = await admin.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await admin.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    loginRole = `polaris_period_summary_gate_${randomUUID().replaceAll("-", "")}`;
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    runtime = createDatabase(
      temporaryRuntimeUrl(adminUrl, loginRole, loginPassword),
      { maxConnections: 10 }
    );
    const { db } = runtime;
    const scenarios = new Scenarios(admin.pool, db, seed);
    const tally = new Tally();

    const main = await seedMainStore(scenarios);
    const zones: Store[] = [main];
    for (const timezone of ZONES.slice(1)) {
      // biome-ignore lint/performance/noAwaitInLoops: one store after the other keeps the seed's sales in order
      zones.push(await seedZoneStore(scenarios, timezone));
    }
    await moveSomeBack(admin.pool, zones);
    await assertScenarios(db, zones, tally);
    tests.push(
      `the SQL summary equals the engine in every field (result, cards, quality, daily date by date, ranking, the answer byte by byte) in ${tally.comparisons} windows of 1 to 366 days of stores in São Paulo, Tokyo and Auckland: a discount split with a tie, a percentage discount, returns partial, repeated and full with and without restocking, costs unknown in part and in all of the items, costs of six places, the processing and the anticipation fee unknown and known, surcharge, freight and payment surcharge, an expense linked to a live sale, one voided, one of a cancelled sale (operating by competence), cancellations, sales a second before and after midnight, sales at the far end of the year`
    );

    const ranking = await seedRankingStore(scenarios);
    await assertRanking(db, ranking, tally);
    tests.push(
      "the ranking equals the engine's for limits 1 to 10: the units first, then net sales, a tie broken by the product ID, a product whose units all came back left out, a deleted product kept and marked"
    );

    await assertEmptyAndIsolated(admin.pool, scenarios, db, zones, tally);
    tests.push(
      "a store without sales and one with only expenses equal the engine for 1, 31 and 366 days; the statement for one store run in another's context finds nothing (RLS)"
    );
    const scenarioComparisons = tally.comparisons;

    const cases = await assertProperty(
      admin.pool,
      scenarios,
      db,
      { path, runs, seed },
      tally
    );
    assert.ok(cases >= runs, `only ${cases} drawn cases ran`);
    tests.push(
      `property: ${cases} drawn cases (seed ${seed}) of up to 8 sales with zero and positive prices, costs of six places or unknown, up to two discounts and two additions, payments missing, unknown, known and with the anticipation fee unknown, partial and repeated returns, cancellations, linked and voided expenses and operating ones, a period of 1 to 31 days and a ranking or none, equal the engine in every field`
    );

    for (const [name, value] of Object.entries(tally.seen)) {
      assert.ok(value, `the fixture never had ${name}`);
    }
    assert.ok(
      tally.daysWithSales >= 60,
      `only ${tally.daysWithSales} dates had sales`
    );
    assert.ok(tally.rankedProducts > 0, "nothing was ranked");
    console.log(
      `gate-note: period-summary-sql compared ${tally.comparisons} summaries (${scenarioComparisons} of scenarios), ${tally.days} dates, ${tally.daysWithSales} with sales, ${tally.rankedProducts} ranked products`
    );
    const volumeSales = await assertVolume(admin.pool, scenarios, db, tally);
    tests.push(
      `a month of ${volumeSales} counted sales written in bulk equals the engine in every field, and the database time of the statement under RLS is printed (gate-note)`
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          seed,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } finally {
    if (runtime) {
      await runtime.pool.end();
    }
    if (loginRole) {
      await admin.pool.query(`REVOKE "${runtimeRole}" FROM "${loginRole}"`);
      await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
    }
    await admin.pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    `Period summary SQL PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
