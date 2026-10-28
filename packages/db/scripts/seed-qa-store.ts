import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { createDatabase } from "../src/client";
import {
  createExpense,
  listExpenseCategories,
} from "../src/expense-repository";
import { createGoal } from "../src/goal-repository";
import { inventoryCount, receiveStock } from "../src/inventory-repository";
import {
  archiveProduct,
  createProduct,
  deleteProduct,
} from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import { productVariants } from "../src/schema/product";
import {
  type TenantRequestIdentity,
  type TenantRequestTransaction,
  withAuthorizedTenantTransaction,
} from "../src/tenant-transaction";
import {
  declaredEnvironment,
  ENVIRONMENT_MARKER_SQL,
  type EnvironmentReadings,
  hasMarkerText,
  readsAsEnvironment,
} from "./environment-marker";
import {
  isCiEnvironment,
  isLocalGateHost,
  neonDisposableHostPattern,
} from "./gate-hosts";

/**
 * Operator script: fills a QA store
 * of staging with the data the Início needs to be measured and checked. It
 * runs ONLY on an organization whose name starts with `qa-`, ONLY on the
 * staging branch (marker `polaris.environment=staging`, ADR 0097, on a direct
 * Neon endpoint) or on the local PostgreSQL of the gates (`--local` with
 * `CI=true`), and writes nothing without `--apply`.
 *
 * What it writes, through the same repository commands the app uses (ledger,
 * snapshots and audit as in production):
 * - 8 products with a known cost and one without, with stock; one product
 *   sold and then archived, one sold out and then deleted;
 * - `--variants-without-stock` products with no stock (120 by default; use
 *   99, 100 and 101 on three stores for the borders of AC-13);
 * - `--sales-per-day` sales (20 or 50) on each of the last `--days` days (at
 *   most 60), one to three items each; every 25th sale has one unit returned
 *   and every 40th is cancelled;
 * - one rent expense per month of the period;
 * - with `--goals`: a goal already reached, one whose period ended without
 *   the target and an annual one (366 days) in progress. "Paused by the plan"
 *   needs the store to leave the paid plan with more goals than the Free
 *   allows: that is billing, which this script never touches.
 *
 * Before any of it, the store is marked as internal
 * (`platform_internal_organizations`, corte 2.4): a QA store never counts in
 * the activation funnel. The database owner writes the marker directly (no
 * operator, so `marked_by` stays null and no platform audit is written, as
 * when it registers a principal); the Admin's command unmarks it for a test,
 * and running the seed again on that store marks it again.
 *
 * The owner may date a sale at most 30 days back (ADR 0021). A sale of an
 * older day is confirmed 30 days later and then moved back by 30 days with
 * an UPDATE of `sales.occurred_at` and `sales.occurred_on` only (the stock
 * ledger is append-only and keeps the date of the confirmation). That is a
 * QA fixture of a `qa-` store, never something to do with real data.
 *
 * Usage (from packages/db):
 *   POLARIS_SEED_DATABASE_URL=<direct URL of the staging branch, owner role> \
 *   bun scripts/seed-qa-store.ts --organization <id> --user <owner user id> \
 *     [--sales-per-day 20] [--days 60] [--variants-without-stock 120] \
 *     [--goals] [--apply] [--local]
 *
 * Running it twice adds a second set (the names carry a run tag). A run
 * interrupted before the end leaves what it confirmed so far, and the older
 * sales it had not moved back yet stay dated 30 days later: start again on a
 * new `qa-` store rather than on the same one.
 */

const QA_PREFIX = "qa-";
const OWNER_WINDOW_DAYS = 30;
export const MAX_SEED_DAYS = 60;
/** Upper bounds that only catch a typo (the measure uses 330 sales a day for a long history). */
const MAX_SALES_PER_DAY = 400;
const MAX_VARIANTS_WITHOUT_STOCK = 500;

export interface SeedOptions {
  days: number;
  goals: boolean;
  organizationId: string;
  salesPerDay: number;
  userId: string;
  variantsWithoutStock: number;
}

export interface SeedReport {
  archivedProduct: string;
  cancelledSales: number;
  deletedProduct: string;
  goals: number;
  movedBack: number;
  productsWithoutStock: number;
  returnedSales: number;
  sales: number;
  sellableProducts: number;
}

/** The slice of `pg.Pool` the guard uses (a fake in the tests). */
export interface QueryClient {
  query: (
    text: string,
    values?: unknown[]
  ) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
}

/**
 * Refuses anything but a `qa-` store of staging (or, with `local`, of the
 * local PostgreSQL of the gates). Never writes.
 *
 * - Staging: the exact marker `polaris.environment=staging` (ADR 0097), no
 *   reading that names production or the restore drill, and a direct Neon
 *   endpoint in São Paulo (a copy of the marker on another host does not pass).
 * - Local: `CI=true`, a local host and no marker text at all (a sloppy or
 *   contradictory marker never reads as "no marker").
 * - Always: an active organization whose name starts with `qa-`, and the user
 *   is its active owner.
 */
export async function assertQaTarget(
  client: QueryClient,
  url: URL,
  options: {
    ci: boolean;
    local: boolean;
    organizationId: string;
    userId: string;
  }
): Promise<{ environment: string; organizationName: string }> {
  const {
    rows: [row],
  } = await client.query(ENVIRONMENT_MARKER_SQL);
  const readings: EnvironmentReadings = {
    comment: (row?.comment as string | null | undefined) ?? null,
    current: (row?.current as string | null | undefined) ?? null,
    stored: (row?.stored as string | null | undefined) ?? null,
  };
  const staging =
    !options.local &&
    declaredEnvironment(readings) === "staging" &&
    !readsAsEnvironment(readings, ["production", "restore-drill"]) &&
    neonDisposableHostPattern.test(url.hostname);
  const local =
    options.local &&
    isLocalGateHost(url.hostname, options.ci) &&
    !hasMarkerText(readings);
  if (!(staging || local)) {
    throw new Error(
      "seed refused: the database must be the staging branch (exact marker polaris.environment=staging, direct Neon endpoint) or, with --local and CI=true, the local PostgreSQL with no marker"
    );
  }
  const organization = await client.query(
    "SELECT name, status FROM public.organizations WHERE id = $1",
    [options.organizationId]
  );
  const [store] = organization.rows as { name: string; status: string }[];
  if (!store?.name.startsWith(QA_PREFIX) || store.status !== "active") {
    throw new Error(
      `seed refused: the organization must exist, be active and have a name that starts with "${QA_PREFIX}"`
    );
  }
  const owner = await client.query(
    "SELECT 1 FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'",
    [options.organizationId, options.userId]
  );
  if (owner.rowCount !== 1) {
    throw new Error(
      "seed refused: the user is not the active owner of the store"
    );
  }
  return {
    environment: staging ? "staging" : "local",
    organizationName: store.name,
  };
}

/**
 * Marks the QA store as internal, so the activation funnel leaves it out (corte 2.4, ADR 0071 amended). Run as
 * the database owner, who bypasses the forced row security of the marker (BYPASSRLS on Neon, a superuser
 * locally); no operator, so `marked_by` is null. Marking again changes nothing.
 */
export async function markQaStoreInternal(
  client: QueryClient,
  organizationId: string
): Promise<boolean> {
  const result = await client.query(
    "INSERT INTO public.platform_internal_organizations (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING",
    [organizationId]
  );
  return result.rowCount === 1;
}

/** A small deterministic generator (Park-Miller), so two runs with the same options make the same shape. */
function generator(seed: number) {
  let state = (seed % 2_147_483_646) + 1;
  return (below: number) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % below;
  };
}

function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant of the `index`-th sale of a day: 15:00 UTC plus `index` seconds
 * (10:00 to 12:00 in the Brazilian time zones), or a few minutes ago for today.
 */
function saleInstant(date: string, today: string, index: number): string {
  if (date === today) {
    return new Date(Date.now() - (index + 1) * 1000).toISOString();
  }
  return new Date(
    Date.parse(`${date}T15:00:00.000Z`) + index * 1000
  ).toISOString();
}

interface Sellable {
  price: string;
  productId: string;
  variantId: string;
}

type Database = ReturnType<typeof createDatabase>["db"];

type As = <T>(
  capability: string,
  operation: (
    transaction: TenantRequestTransaction,
    identity: TenantRequestIdentity
  ) => Promise<T>
) => Promise<T>;

interface SeededProduct extends Sellable {
  version: number;
}

export function assertOptions(options: SeedOptions): void {
  const whole = (value: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !(
      whole(options.days, 1, MAX_SEED_DAYS) &&
      whole(options.salesPerDay, 1, MAX_SALES_PER_DAY) &&
      whole(options.variantsWithoutStock, 0, MAX_VARIANTS_WITHOUT_STOCK)
    )
  ) {
    throw new Error("seed refused: invalid options");
  }
}

function catalogSeeder(as: As, today: string) {
  const product = async (
    name: string,
    price: string
  ): Promise<SeededProduct> => {
    const created = await as("product:create", (tx, identity) =>
      createProduct(tx, identity, { listPrice: price, name, requestId: null })
    );
    const [variant] = await as("catalog:read", (tx, identity) =>
      tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, identity.organizationId),
            eq(productVariants.productId, created.id)
          )
        )
        .limit(1)
    );
    if (!variant) {
      throw new Error("seed failed: the product has no variant");
    }
    return {
      price,
      productId: created.id,
      variantId: variant.id,
      version: created.version,
    };
  };
  const stock = (variantId: string, quantity: number, cost: string | null) =>
    as("inventory:adjust", (tx, identity) =>
      cost === null
        ? inventoryCount(tx, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            expectedVersion: 0,
            occurredOn: today,
            physicalQuantity: quantity,
            valuationUnitCost: null,
            variantId,
          })
        : receiveStock(tx, identity, {
            commandId: randomUUID(),
            commandVersion: 1,
            occurredOn: today,
            quantity,
            unitCost: cost,
            variantId,
          })
    );
  return { product, stock };
}

async function seedCatalog(
  as: As,
  today: string,
  tag: string,
  options: SeedOptions
) {
  const { product, stock } = catalogSeeder(as, today);
  // enough stock for every sale to take up to two units of the same product
  const perProduct = options.salesPerDay * options.days * 2;
  const sellable: Sellable[] = [];
  for (let index = 1; index <= 8; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one product at a time, in its own transaction
    const created = await product(
      `qa-${tag} produto ${index}`,
      `${(19 + index * 7).toString()}.90`
    );
    await stock(
      created.variantId,
      perProduct,
      `${(5 + index * 3).toString()}.00`
    );
    sellable.push(created);
  }
  const unknownCost = await product(`qa-${tag} sem custo`, "15.00");
  await stock(unknownCost.variantId, perProduct, null);
  sellable.push(unknownCost);
  const archived = await product(`qa-${tag} arquivado`, "33.00");
  await stock(archived.variantId, 50, "12.00");
  const deleted = await product(`qa-${tag} excluido`, "27.00");
  await stock(deleted.variantId, 3, "9.00");
  for (let index = 1; index <= options.variantsWithoutStock; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one product at a time, in its own transaction
    await product(
      `qa-${tag} sem saldo ${index.toString().padStart(3, "0")}`,
      "10.00"
    );
  }
  return { archived, deleted, sellable };
}

interface SaleCounts {
  cancelledSales: number;
  movedBack: number;
  returnedSales: number;
  sales: number;
}

/** One to three of the sellable products, one or two units each. */
function saleItems(
  sellable: readonly Sellable[],
  random: (below: number) => number
) {
  const chosen = new Map<number, Sellable>();
  const lines = 1 + random(3);
  for (let line = 0; line < lines; line += 1) {
    const pick = random(sellable.length);
    chosen.set(pick, sellable[pick] as Sellable);
  }
  return [...chosen.values()].map((entry) => ({
    chargedUnitPrice: entry.price,
    listedUnitPrice: entry.price,
    quantity: 1 + random(2),
    variantId: entry.variantId,
  }));
}

async function compensate(
  as: As,
  saleId: string,
  counter: number,
  counts: SaleCounts
) {
  if (counter % 40 === 0) {
    await as("sale:cancel", (tx, identity) =>
      cancelSale(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        saleId,
      })
    );
    counts.cancelledSales += 1;
  } else if (counter % 25 === 0) {
    await as("sale:return", (tx, identity) =>
      createSaleReturn(tx, identity, {
        commandId: randomUUID(),
        commandVersion: 1,
        items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
        saleId,
      })
    );
    counts.returnedSales += 1;
  }
}

async function seedSales(
  as: As,
  pool: pg.Pool,
  today: string,
  options: SeedOptions,
  catalog: Awaited<ReturnType<typeof seedCatalog>>
): Promise<SaleCounts> {
  const random = generator(options.salesPerDay * 1000 + options.days);
  const counts: SaleCounts = {
    cancelledSales: 0,
    movedBack: 0,
    returnedSales: 0,
    sales: 0,
  };
  const toMoveBack: string[] = [];
  const archivedDay = options.days - 1;
  const deletedDay = Math.min(10, options.days - 1);
  for (let back = options.days - 1; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    // an older day than the owner's window is confirmed 30 days later and moved back
    const moved = back >= OWNER_WINDOW_DAYS;
    const confirmOn = moved ? addDays(date, OWNER_WINDOW_DAYS) : date;
    for (let index = 0; index < options.salesPerDay; index += 1) {
      const items = saleItems(catalog.sellable, random);
      // the archived product sells on the first day; the deleted one sells out in three sales
      for (const [day, extra] of [
        [archivedDay, catalog.archived],
        [deletedDay, catalog.deleted],
      ] as const) {
        if (back === day && index < 3) {
          items.push({
            chargedUnitPrice: extra.price,
            listedUnitPrice: extra.price,
            quantity: 1,
            variantId: extra.variantId,
          });
        }
      }
      counts.sales += 1;
      const counter = counts.sales;
      // biome-ignore lint/performance/noAwaitInLoops: one sale per transaction, as the app confirms them
      const confirmed = await as("sale:create", (tx, identity) =>
        confirmSale(tx, identity, {
          adjustments:
            counter % 7 === 0
              ? [{ kind: "discount", value: { amount: "2.00", type: "fixed" } }]
              : [],
          commandId: randomUUID(),
          commandVersion: 1,
          items,
          occurredAt: saleInstant(confirmOn, today, index),
          payment: { anticipationRequested: false, method: "pix" },
          paymentProfile: null,
          requestId: null,
        })
      );
      if (moved) {
        toMoveBack.push(confirmed.sale.id);
      }
      await compensate(as, confirmed.sale.id, counter, counts);
    }
  }
  if (toMoveBack.length > 0) {
    const result = await pool.query(
      `UPDATE public.sales
          SET occurred_at = occurred_at - make_interval(days => $3),
              occurred_on = occurred_on - $3::int
        WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [options.organizationId, toMoveBack, OWNER_WINDOW_DAYS]
    );
    counts.movedBack = result.rowCount ?? 0;
    if (counts.movedBack !== toMoveBack.length) {
      throw new Error(
        `seed failed: ${counts.movedBack} of ${toMoveBack.length} older sales were moved back`
      );
    }
  }
  return counts;
}

async function seedExpenses(as: As, today: string, tag: string, days: number) {
  const categories = await as("expense:create", (tx, identity) =>
    listExpenseCategories(tx, identity)
  );
  const rent = categories.find((category) => category.systemKey === "rent");
  if (!rent) {
    return;
  }
  const first = addDays(today, -(days - 1));
  const months = new Set(
    Array.from({ length: days }, (_, back) => addDays(today, -back).slice(0, 7))
  );
  for (const month of months) {
    const competenceOn = `${month}-01` < first ? first : `${month}-01`;
    // biome-ignore lint/performance/noAwaitInLoops: one expense per month
    await as("expense:create", (tx, identity) =>
      createExpense(tx, identity, {
        amount: "800.00",
        categoryId: rent.id,
        competenceOn,
        description: `qa-${tag} aluguel`,
        saleId: null,
      })
    );
  }
}

async function seedGoals(as: As, today: string): Promise<number> {
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(firstOfMonth, -1);
  const goals = [
    // reached: settles as completed on the next read
    {
      endsOn: addDays(today, 5),
      name: "qa atingida",
      startsOn: firstOfMonth,
      target: "1.00",
    },
    // its period ended without the target: settles as missed on the next read
    {
      endsOn: lastMonthEnd,
      name: "qa encerrada",
      startsOn: `${lastMonthEnd.slice(0, 7)}-01`,
      target: "99999999.00",
    },
    // annual (366 days), in progress: the goal that reads the most days on each opening
    {
      endsOn: addDays(today, 65),
      name: "qa anual",
      startsOn: addDays(today, -300),
      target: "99999999.00",
    },
  ];
  for (const goal of goals) {
    // biome-ignore lint/performance/noAwaitInLoops: one goal at a time (the plan limit counts them)
    await as("goal:manage", (tx, identity) =>
      createGoal(tx, identity, { ...goal, kind: "net_sales" })
    );
  }
  return goals.length;
}

/**
 * Writes the store. It does NOT check the target: call `assertQaTarget` first
 * (the command line does; the local measure creates its own `qa-` stores).
 */
export async function seedQaStore(
  db: Database,
  pool: pg.Pool,
  options: SeedOptions
): Promise<SeedReport> {
  assertOptions(options);
  await markQaStoreInternal(
    pool as unknown as QueryClient,
    options.organizationId
  );
  const as: As = (capability, operation) =>
    withAuthorizedTenantTransaction(
      db,
      {
        authenticatedUserId: options.userId,
        capability,
        requestedOrganizationId: options.organizationId,
      },
      operation
    );
  const tag = Date.now().toString(36);
  const today = (
    await pool.query<{ today: string }>(
      "SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM public.organizations WHERE id = $1",
      [options.organizationId]
    )
  ).rows[0]?.today as string;

  const catalog = await seedCatalog(as, today, tag, options);
  const counts = await seedSales(as, pool, today, options, catalog);
  await as("product:update", (tx, identity) =>
    archiveProduct(tx, identity, {
      expectedVersion: catalog.archived.version,
      id: catalog.archived.productId,
      requestId: null,
    })
  );
  await as("product:update", (tx, identity) =>
    deleteProduct(tx, identity, {
      expectedVersion: catalog.deleted.version,
      id: catalog.deleted.productId,
      requestId: null,
    })
  );
  await seedExpenses(as, today, tag, options.days);
  const goals = options.goals ? await seedGoals(as, today) : 0;
  return {
    ...counts,
    archivedProduct: catalog.archived.productId,
    deletedProduct: catalog.deleted.productId,
    goals,
    productsWithoutStock: options.variantsWithoutStock,
    sellableProducts: catalog.sellable.length + 2,
  };
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value?.startsWith("--") ? undefined : value;
}

async function main() {
  const raw = process.env.POLARIS_SEED_DATABASE_URL;
  if (!raw) {
    throw new Error("POLARIS_SEED_DATABASE_URL is required");
  }
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.searchParams.has("host") ||
    url.searchParams.has("hostaddr")
  ) {
    throw new Error("seed refused: a plain postgres URL is required");
  }
  const options: SeedOptions = {
    days: Number(flag("days") ?? MAX_SEED_DAYS),
    goals: process.argv.includes("--goals"),
    organizationId: flag("organization") ?? "",
    salesPerDay: Number(flag("sales-per-day") ?? 20),
    userId: flag("user") ?? "",
    variantsWithoutStock: Number(flag("variants-without-stock") ?? 120),
  };
  assertOptions(options);
  const local = process.argv.includes("--local");
  const pool = new pg.Pool({ connectionString: raw, max: 2 });
  try {
    const target = await assertQaTarget(pool as unknown as QueryClient, url, {
      ...options,
      ci: isCiEnvironment(),
      local,
    });
    if (!process.argv.includes("--apply")) {
      console.log(JSON.stringify({ dryRun: true, options, target }, null, 2));
      return;
    }
    const database = createDatabase(raw, { maxConnections: 2 });
    try {
      const report = await seedQaStore(database.db, pool, options);
      console.log(JSON.stringify({ options, report, target }, null, 2));
    } finally {
      await database.pool.end();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "seed failed");
    process.exitCode = 1;
  });
}
