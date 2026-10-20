import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fc from "fast-check";
import { createDatabase } from "../src/client";
import {
  getInventoryBalance,
  inventoryCount,
  receiveStock,
  writeOffStock,
} from "../src/inventory-repository";
import { createProduct } from "../src/product-repository";
import { cancelSale } from "../src/sale-cancellation-repository";
import { getSale } from "../src/sale-query-repository";
import { confirmSale } from "../src/sale-repository";
import { createSaleReturn } from "../src/sale-return-repository";
import {
  createTenantFixture,
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  recentInstant,
  redactedFailure,
  requiredEnvironment,
  runtimeRole,
  sqlState,
  type TenantFixture,
  temporaryRuntimeUrl,
  withTenantAs,
} from "./sales-gate-support";

/**
 * Model × PostgreSQL property for the stock ledger and the sale returns (T-124b).
 *
 * fast-check generates sequences of named commands (receipt, sale, write-off,
 * count, return and cancellation, the reversal of a whole sale) over two
 * variants of one fresh organization. Each command goes through the real
 * repository functions as the runtime role (FORCE RLS, the deferred triggers of
 * the commit) and through an in-memory model written here, which does not import
 * the domain: its average cost is its own bigint arithmetic. After each command
 * the outcome (accepted or the error code) and the balances must match; at the
 * end, the ledger, the returnable quantities and the cancellations must match.
 *
 * Invariants (docs/runbooks/gate-4-sales-core.md#propriedade-modelo--postgresql-estoque-e-devolução):
 *   I1 balance quantity, moving average cost and version per variant equal the model;
 *   I2 the ledger of each variant, in its sequence, equals the model's (type, delta, unit cost);
 *   I3 the balance quantity is the sum of the ledger deltas and never negative;
 *   I4 the returnable quantity of each sale item is sold minus returned;
 *   I5 a sale is either cancelled or has returns, never both, and a cancelled sale is cancelled once;
 *   I6 a rejected command (stock, version, cost, availability) leaves no trace and fails with the model's code.
 *
 * Runs: POLARIS_PROPERTY_RUNS drawn sequences (default 20, the `ci` budget) after
 * the fixed examples; POLARIS_PROPERTY_SEED and POLARIS_PROPERTY_PATH replay a
 * printed failure.
 */

const expectedDatabase = process.env.POLARIS_SALES_GATE_DATABASE ?? "neondb";
const DEFAULT_RUNS = 20;
// the runner stops a gate after 30 minutes; at up to 0.7 s a sequence this fits
const MAX_RUNS = 2000;
const VARIANTS = 2;
const OCCURRED_ON = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
}).format(new Date());
const SCALE = 1_000_000n;
const costPattern = /^(\d+)(?:\.(\d{1,6}))?$/;
const domainCodePattern = /^[a-z][a-z_]+$/;
const failingCommandPattern = /command #(\d+)/;

type RuntimeDatabase = ReturnType<typeof createDatabase>;

/* ------------------------------------------------------------------ commands */

/** A concrete command, as the repository receives it. */
type Command =
  | { cost: string; kind: "receive"; quantity: number; variant: number }
  | { kind: "write_off"; quantity: number; variant: number }
  | {
      kind: "count";
      physical: number;
      stale: boolean;
      valuation: string | null;
      variant: number;
    }
  | { kind: "sale"; lines: { quantity: number; variant: number }[] }
  | {
      kind: "return";
      lines: { position: number; restocked: number; returned: number }[];
      sale: number;
    }
  | { kind: "cancel"; sale: number };

/**
 * What fast-check draws. Quantities are drawn relative to the state the command
 * meets (`resolve`), so most commands are valid; `overdraw` (one in eight) asks
 * for more than there is on purpose, and the model must predict the rejection.
 * Sales and positions are indices taken modulo what exists at that point.
 */
type Draw =
  | { cost: string; kind: "receive"; quantity: number; variant: number }
  | { amount: number; kind: "write_off"; overdraw: boolean; variant: number }
  | {
      kind: "count";
      physical: number;
      stale: boolean;
      valuation: string | null;
      variant: number;
    }
  | {
      kind: "sale";
      lines: { amount: number; variant: number }[];
      overdraw: boolean;
    }
  | {
      kind: "return";
      lines: { amount: number; position: number; restockedPart: number }[];
      overdraw: boolean;
      sale: number;
    }
  | { kind: "cancel"; sale: number };

// a few costs whose weighted averages need the half-up rounding at 6 places
const costArb = fc.constantFrom(
  "0",
  "1",
  "1.5",
  "2.333333",
  "7.10",
  "10.000001"
);
const variantArb = fc.integer({ max: VARIANTS - 1, min: 0 });
const amountArb = fc.nat({ max: 5 });
const oneInArb = (odds: number) =>
  // shrinks toward 0, the common case
  fc.nat({ max: odds - 1 }).map((draw) => draw === odds - 1);

const drawArb: fc.Arbitrary<Draw> = fc.oneof(
  {
    arbitrary: fc.record({
      cost: costArb,
      kind: fc.constant("receive" as const),
      quantity: fc.integer({ max: 6, min: 1 }),
      variant: variantArb,
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("sale" as const),
      lines: fc.array(fc.record({ amount: amountArb, variant: variantArb }), {
        maxLength: 2,
        minLength: 1,
      }),
      overdraw: oneInArb(8),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      amount: amountArb,
      kind: fc.constant("write_off" as const),
      overdraw: oneInArb(8),
      variant: variantArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("count" as const),
      // a count to zero empties the variant, the state the restock rules turn on
      physical: fc.oneof(
        { arbitrary: fc.constant(0), weight: 1 },
        { arbitrary: fc.integer({ max: 8, min: 1 }), weight: 3 }
      ),
      // one count in seven sends a version that is no longer current
      stale: oneInArb(7),
      valuation: fc.option(costArb, { freq: 3 }),
      variant: variantArb,
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("return" as const),
      lines: fc.array(
        fc.record({
          amount: amountArb,
          position: fc.nat({ max: 1 }),
          restockedPart: fc.nat({ max: 3 }),
        }),
        { maxLength: 2, minLength: 1 }
      ),
      overdraw: oneInArb(8),
      sale: fc.nat({ max: 7 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("cancel" as const),
      sale: fc.nat({ max: 7 }),
    }),
    weight: 2,
  }
);

/**
 * A quantity from 1 up to what there is (`available`), or past it when
 * overdrawing. Amount 0 takes all of it, so balances often reach zero (and a
 * shrunk sequence says "all").
 */
function within(amount: number, available: number, overdraw: boolean): number {
  if (overdraw) {
    return available + 1 + (amount % 3);
  }
  return amount === 0 || available === 0
    ? Math.max(available, 1)
    : 1 + (amount % available);
}

/**
 * Sequences that always run before the random ones. The restock rules turn on a
 * sale whose cost was unknown coming back to an empty balance whose average is
 * known again, about six commands in one order, which the random draws did not
 * reach in 400 runs; and the lines of a return restock in position order, not in
 * the order they were sent. Each one is still checked step by step against the model.
 */
const unknownCostSale: Draw[] = [
  { kind: "count", physical: 3, stale: false, valuation: null, variant: 0 },
  { kind: "sale", lines: [{ amount: 1, variant: 0 }], overdraw: false },
  { kind: "count", physical: 0, stale: false, valuation: null, variant: 0 },
  { cost: "1.5", kind: "receive", quantity: 2, variant: 0 },
  { amount: 0, kind: "write_off", overdraw: false, variant: 0 },
];
const fixedExamples: [Draw[]][] = [
  // one sale with two lines of the same variant, returned in the opposite order
  [
    [
      { cost: "1.5", kind: "receive", quantity: 5, variant: 0 },
      {
        kind: "sale",
        lines: [
          { amount: 2, variant: 0 },
          { amount: 1, variant: 0 },
        ],
        overdraw: false,
      },
      {
        kind: "return",
        lines: [
          { amount: 1, position: 1, restockedPart: 2 },
          { amount: 0, position: 0, restockedPart: 1 },
        ],
        overdraw: false,
        sale: 0,
      },
    ],
  ],
  [[...unknownCostSale, { kind: "cancel", sale: 0 }]],
  [
    [
      ...unknownCostSale,
      {
        kind: "return",
        lines: [{ amount: 0, position: 0, restockedPart: 1 }],
        overdraw: false,
        sale: 0,
      },
    ],
  ],
];

/* --------------------------------------------------------------------- model */

interface LedgerEntry {
  delta: number;
  type: string;
  unitCost: bigint | null;
}

interface VariantState {
  average: bigint | null;
  ledger: LedgerEntry[];
  quantity: number;
  version: number;
}

interface SaleItem {
  quantity: number;
  returned: number;
  unitCost: bigint | null;
  variant: number;
}

interface SaleState {
  cancelled: boolean;
  hasReturns: boolean;
  id: string;
  items: SaleItem[];
}

interface Model {
  sales: SaleState[];
  variants: VariantState[];
}

/** Outcome of one command: accepted, or the code of the expected rejection. */
type Outcome = "ok" | string;

function micro(value: string): bigint {
  const match = costPattern.exec(value);
  assert.ok(match, `cost ${value}`);
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

function microOrNull(value: string | null): bigint | null {
  return value === null ? null : micro(value);
}

function showCost(value: bigint | null): string {
  if (value === null) {
    return "null";
  }
  return `${value / SCALE}.${(value % SCALE).toString().padStart(6, "0")}`;
}

/** Weighted average, half-up at 6 places (inventory.md, "Custo médio"). */
function weighted(
  average: bigint,
  quantity: number,
  cost: bigint,
  added: number
): bigint {
  const numerator = average * BigInt(quantity) + cost * BigInt(added);
  const denominator = BigInt(quantity + added);
  const quotient = numerator / denominator;
  return (numerator % denominator) * 2n >= denominator
    ? quotient + 1n
    : quotient;
}

/** Units of a confirmed sale coming back (inventory.md, "Reposição por cancelamento ou devolução"). */
function restock(
  state: VariantState,
  added: number,
  cost: bigint | null,
  type: string
) {
  let average: bigint | null;
  if (cost === null) {
    average = state.quantity > 0 ? state.average : null;
  } else if (state.quantity === 0) {
    average = cost;
  } else {
    average =
      state.average === null
        ? null
        : weighted(state.average, state.quantity, cost, added);
  }
  state.average = average;
  state.quantity += added;
  state.version += 1;
  state.ledger.push({ delta: added, type, unitCost: cost });
}

function emptyModel(): Model {
  return {
    sales: [],
    variants: Array.from({ length: VARIANTS }, () => ({
      average: null,
      ledger: [],
      quantity: 0,
      version: 0,
    })),
  };
}

function variantOf(model: Model, index: number): VariantState {
  const state = model.variants[index];
  assert.ok(state);
  return state;
}

/** Predicts the outcome and, when accepted, applies the command to the model. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one switch with the rule of each command, kept together on purpose
function applyToModel(
  model: Model,
  command: Command,
  saleId?: () => string
): Outcome {
  switch (command.kind) {
    case "receive": {
      const state = variantOf(model, command.variant);
      if (state.quantity > 0 && state.average === null) {
        return "inventory_cost_unavailable";
      }
      const cost = micro(command.cost);
      state.average =
        state.quantity === 0 || state.average === null
          ? cost
          : weighted(state.average, state.quantity, cost, command.quantity);
      state.quantity += command.quantity;
      state.version += 1;
      state.ledger.push({
        delta: command.quantity,
        type: "receipt",
        unitCost: cost,
      });
      return "ok";
    }
    case "write_off": {
      const state = variantOf(model, command.variant);
      if (command.quantity > state.quantity) {
        return "insufficient_stock";
      }
      state.quantity -= command.quantity;
      state.version += 1;
      state.ledger.push({
        delta: -command.quantity,
        type: "write_off",
        unitCost: state.average,
      });
      return "ok";
    }
    case "count": {
      const state = variantOf(model, command.variant);
      const valuation = microOrNull(command.valuation);
      // the input is checked first, then the version under the lock, then the valuation against the balance
      if (valuation !== null && command.physical === 0) {
        return "invalid_inventory_count_input";
      }
      if (command.stale) {
        return "inventory_version_conflict";
      }
      if (valuation !== null && state.average !== null) {
        return "invalid_inventory_count_input";
      }
      const delta = command.physical - state.quantity;
      state.average = valuation ?? state.average;
      state.quantity = command.physical;
      state.version += 1;
      state.ledger.push({
        delta,
        type: "inventory_count",
        unitCost: state.average,
      });
      return "ok";
    }
    case "sale": {
      const wanted = new Map<number, number>();
      for (const line of command.lines) {
        wanted.set(
          line.variant,
          (wanted.get(line.variant) ?? 0) + line.quantity
        );
      }
      for (const [variant, quantity] of wanted) {
        if (quantity > variantOf(model, variant).quantity) {
          return "insufficient_stock";
        }
      }
      const items = command.lines.map((line) => {
        const state = variantOf(model, line.variant);
        state.quantity -= line.quantity;
        state.version += 1;
        state.ledger.push({
          delta: -line.quantity,
          type: "sale",
          unitCost: state.average,
        });
        return {
          quantity: line.quantity,
          returned: 0,
          unitCost: state.average,
          variant: line.variant,
        };
      });
      model.sales.push({
        cancelled: false,
        hasReturns: false,
        id: saleId ? saleId() : "",
        items,
      });
      return "ok";
    }
    case "return": {
      const sale = model.sales[command.sale];
      assert.ok(sale);
      // the server restocks in position order, whatever order the lines were sent in
      const lines = [...command.lines].sort(
        (left, right) => left.position - right.position
      );
      if (sale.cancelled) {
        return "sale_not_returnable";
      }
      for (const line of lines) {
        const item = sale.items[line.position];
        assert.ok(item);
        if (line.returned > item.quantity - item.returned) {
          return "sale_return_exceeds_available";
        }
      }
      for (const line of lines) {
        const item = sale.items[line.position];
        assert.ok(item);
        item.returned += line.returned;
        if (line.restocked > 0) {
          restock(
            variantOf(model, item.variant),
            line.restocked,
            item.unitCost,
            "sale_return"
          );
        }
      }
      sale.hasReturns = true;
      return "ok";
    }
    case "cancel": {
      const sale = model.sales[command.sale];
      assert.ok(sale);
      if (sale.cancelled) {
        return "sale_already_cancelled";
      }
      if (sale.hasReturns) {
        return "sale_has_returns";
      }
      for (const item of sale.items) {
        restock(
          variantOf(model, item.variant),
          item.quantity,
          item.unitCost,
          "sale_cancellation"
        );
      }
      sale.cancelled = true;
      return "ok";
    }
    default:
      throw new Error("unknown command");
  }
}

/** A return of the drawn sale: each position once, up to what is still returnable (or past it when overdrawing). */
function resolveReturn(
  model: Model,
  draw: Extract<Draw, { kind: "return" }>
): Command | null {
  if (model.sales.length === 0) {
    return null;
  }
  const index = draw.sale % model.sales.length;
  const sale = model.sales[index];
  assert.ok(sale);
  const seen = new Set<number>();
  const lines: { position: number; restocked: number; returned: number }[] = [];
  for (const line of draw.lines) {
    const position = line.position % sale.items.length;
    const item = sale.items[position];
    assert.ok(item);
    if (!seen.has(position)) {
      seen.add(position);
      const returned = within(
        line.amount,
        item.quantity - item.returned,
        draw.overdraw && lines.length === 0
      );
      lines.push({
        position,
        restocked: line.restockedPart % (returned + 1),
        returned,
      });
    }
  }
  return { kind: "return", lines, sale: index };
}

/**
 * Turns a draw into a concrete command against the state it meets; null when it
 * has no target: no sale yet, or stock to take from an empty variant without
 * `overdraw` (the probe of an empty balance is the overdraw's job, so it does
 * not crowd out the valid commands).
 */
function resolve(model: Model, draw: Draw): Command | null {
  switch (draw.kind) {
    case "receive":
    case "count":
      return draw;
    case "write_off": {
      const { quantity } = variantOf(model, draw.variant);
      if (quantity === 0 && !draw.overdraw) {
        return null;
      }
      return {
        kind: "write_off",
        quantity: within(draw.amount, quantity, draw.overdraw),
        variant: draw.variant,
      };
    }
    case "sale": {
      const left = model.variants.map((state) => state.quantity);
      const lines: { quantity: number; variant: number }[] = [];
      for (const line of draw.lines) {
        const available = left[line.variant] ?? 0;
        const overdraw = draw.overdraw && lines.length === 0;
        if (available > 0 || overdraw) {
          const quantity = within(line.amount, available, overdraw);
          left[line.variant] = available - quantity;
          lines.push({ quantity, variant: line.variant });
        }
      }
      return lines.length > 0 ? { kind: "sale", lines } : null;
    }
    case "return":
      return resolveReturn(model, draw);
    case "cancel":
      return model.sales.length === 0
        ? null
        : { kind: "cancel", sale: draw.sale % model.sales.length };
    default:
      throw new Error("unknown draw");
  }
}

/** The concrete commands of a drawn sequence, replayed on the model alone (for the failure log). */
function concreteSequence(draws: readonly Draw[]): Command[] {
  const model = emptyModel();
  const commands: Command[] = [];
  for (const draw of draws) {
    const command = resolve(model, draw);
    if (command) {
      applyToModel(model, command);
      commands.push(command);
    }
  }
  return commands;
}

/* ------------------------------------------------------------- the real path */

/** The domain code of a rejected command, or `sql:<state>` for a database error. */
function outcomeOf(error: unknown): string {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && domainCodePattern.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  const state = sqlState(error);
  return state
    ? `sql:${state}`
    : `error:${error instanceof Error ? error.name : "unknown"}`;
}

interface World {
  database: RuntimeDatabase;
  tenant: TenantFixture;
  variants: string[];
}

async function runOnDatabase(
  world: World,
  model: Model,
  command: Command
): Promise<{ outcome: Outcome; saleId?: string }> {
  const { database, tenant, variants } = world;
  const variantId = (index: number) => {
    const id = variants[index];
    assert.ok(id);
    return id;
  };
  try {
    switch (command.kind) {
      case "receive":
        await withTenantAs(
          database.db,
          tenant,
          "inventory:adjust",
          (transaction, identity) =>
            receiveStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: OCCURRED_ON,
              quantity: command.quantity,
              unitCost: command.cost,
              variantId: variantId(command.variant),
            })
        );
        return { outcome: "ok" };
      case "write_off":
        await withTenantAs(
          database.db,
          tenant,
          "inventory:adjust",
          (transaction, identity) =>
            writeOffStock(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              occurredOn: OCCURRED_ON,
              quantity: command.quantity,
              reasonCode: "damaged",
              variantId: variantId(command.variant),
            })
        );
        return { outcome: "ok" };
      case "count": {
        // the client reads the version first; a stale count sends one that is no longer current
        const { version } = variantOf(model, command.variant);
        await withTenantAs(
          database.db,
          tenant,
          "inventory:adjust",
          (transaction, identity) =>
            inventoryCount(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              expectedVersion: command.stale ? version + 1 : version,
              occurredOn: OCCURRED_ON,
              physicalQuantity: command.physical,
              valuationUnitCost: command.valuation,
              variantId: variantId(command.variant),
            })
        );
        return { outcome: "ok" };
      }
      case "sale": {
        const sale = await withTenantAs(
          database.db,
          tenant,
          "sale:create",
          (transaction, identity) =>
            confirmSale(transaction, identity, {
              adjustments: [],
              commandId: randomUUID(),
              commandVersion: 1,
              items: command.lines.map((line) => ({
                chargedUnitPrice: "19.90",
                listedUnitPrice: "20.00",
                quantity: line.quantity,
                variantId: variantId(line.variant),
              })),
              occurredAt: recentInstant(),
              payment: { anticipationRequested: false, method: "pix" },
              paymentProfile: null,
              requestId: randomUUID(),
            })
        );
        return { outcome: "ok", saleId: sale.sale.id };
      }
      case "return": {
        const sale = model.sales[command.sale];
        assert.ok(sale);
        await withTenantAs(
          database.db,
          tenant,
          "sale:return",
          (transaction, identity) =>
            createSaleReturn(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              items: command.lines.map((line) => ({
                position: line.position,
                restockedQuantity: line.restocked,
                returnedQuantity: line.returned,
              })),
              saleId: sale.id,
            })
        );
        return { outcome: "ok" };
      }
      case "cancel": {
        const sale = model.sales[command.sale];
        assert.ok(sale);
        await withTenantAs(
          database.db,
          tenant,
          "sale:cancel",
          (transaction, identity) =>
            cancelSale(transaction, identity, {
              commandId: randomUUID(),
              commandVersion: 1,
              saleId: sale.id,
            })
        );
        return { outcome: "ok" };
      }
      default:
        throw new Error("unknown command");
    }
  } catch (error) {
    return { outcome: outcomeOf(error) };
  }
}

async function assertBalances(world: World, model: Model, step: string) {
  for (const [index, variantId] of world.variants.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: two reads, one per variant
    const balance = await withTenantAs(
      world.database.db,
      world.tenant,
      "inventory:read",
      (transaction, identity) =>
        getInventoryBalance(transaction, identity, variantId)
    );
    const expected = variantOf(model, index);
    assert.deepEqual(
      {
        average: showCost(microOrNull(balance.movingAverageCost)),
        quantity: balance.quantity,
        version: balance.version,
      },
      {
        average: showCost(expected.average),
        quantity: expected.quantity,
        version: expected.version,
      },
      `I1 balance of variant ${index} after ${step}`
    );
  }
}

async function assertFinalState(
  world: World,
  admin: RuntimeDatabase,
  model: Model
) {
  for (const [index, variantId] of world.variants.entries()) {
    // the owner reads the ledger of this organization only, in the per-variant sequence
    // biome-ignore lint/performance/noAwaitInLoops: one read per variant
    const ledger = await admin.pool.query<{
      movement_type: string;
      quantity_delta: number;
      unit_cost: string | null;
    }>(
      "SELECT movement_type, quantity_delta, unit_cost::text FROM public.stock_movements WHERE organization_id = $1 AND variant_id = $2 ORDER BY variant_sequence",
      [world.tenant.organizationId, variantId]
    );
    const expected = variantOf(model, index);
    assert.deepEqual(
      ledger.rows.map(
        (row) =>
          `${row.movement_type} ${row.quantity_delta} @ ${showCost(microOrNull(row.unit_cost))}`
      ),
      expected.ledger.map(
        (entry) => `${entry.type} ${entry.delta} @ ${showCost(entry.unitCost)}`
      ),
      `I2 ledger of variant ${index}`
    );
    const balance = await admin.pool.query<{ quantity: number }>(
      "SELECT quantity FROM public.inventory_balances WHERE organization_id = $1 AND variant_id = $2",
      [world.tenant.organizationId, variantId]
    );
    const quantity = balance.rows[0]?.quantity ?? 0;
    const total = ledger.rows.reduce((sum, row) => sum + row.quantity_delta, 0);
    assert.equal(quantity, total, `I3 sum of the ledger of variant ${index}`);
    assert.ok(quantity >= 0, `I3 nonnegative balance of variant ${index}`);
  }
  for (const [index, sale] of model.sales.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one read per sale
    const detail = await withTenantAs(
      world.database.db,
      world.tenant,
      "sale:read",
      (transaction, identity) => getSale(transaction, identity, sale.id)
    );
    assert.deepEqual(
      detail.returnSummary.map((line) => line.availableToReturn),
      sale.items.map((item) => item.quantity - item.returned),
      `I4 returnable quantities of sale ${index}`
    );
    assert.equal(
      detail.cancellation !== null,
      sale.cancelled,
      `I5 cancellation of sale ${index}`
    );
    assert.equal(
      detail.returns.length > 0,
      sale.hasReturns,
      `I5 returns of sale ${index}`
    );
    assert.ok(
      !(detail.cancellation && detail.returns.length > 0),
      `I5 sale ${index} cancelled and returned`
    );
  }
}

/* ----------------------------------------------------------------------- run */

function describe(command: Command): string {
  return JSON.stringify(command);
}

function runsFromEnvironment(): number {
  const raw = process.env.POLARIS_PROPERTY_RUNS;
  if (raw === undefined || raw === "") {
    return DEFAULT_RUNS;
  }
  const runs = Number(raw);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(
      `POLARIS_PROPERTY_RUNS must be an integer from 1 to ${MAX_RUNS}.`
    );
  }
  return runs;
}

function seedFromEnvironment(): number {
  const raw = process.env.POLARIS_PROPERTY_SEED;
  if (raw === undefined || raw === "") {
    // a fresh seed each run: the CI explores new sequences and prints the one it used
    return randomBytes(4).readInt32LE(0);
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error("POLARIS_PROPERTY_SEED must be an integer.");
  }
  return seed;
}

/** A fresh organization with its variants, one per sequence (and per shrink attempt). */
async function createWorld(
  admin: RuntimeDatabase,
  database: RuntimeDatabase,
  label: string
): Promise<World> {
  const tenant = await createTenantFixture(admin.pool, label);
  const variants: string[] = [];
  for (let index = 0; index < VARIANTS; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: products are created one at a time
    const product = await withTenantAs(
      database.db,
      tenant,
      "product:create",
      (transaction, identity) =>
        createProduct(transaction, identity, {
          name: `Produto ${index}`,
          requestId: randomUUID(),
        })
    );
    const variant = await admin.pool.query<{ id: string }>(
      "SELECT id FROM public.product_variants WHERE organization_id = $1 AND product_id = $2",
      [tenant.organizationId, product.id]
    );
    assert.ok(variant.rows[0]);
    variants.push(variant.rows[0].id);
  }
  return { database, tenant, variants };
}

/**
 * Prints the failure for the runner, which keeps only the last 14 lines of a
 * failed gate, each cut at 220 characters: the smallest sequence (up to the
 * failing command) first, then the reason, and the replay command last.
 */
function reportFailure(details: fc.RunDetails<[Draw[]]>) {
  const message =
    details.errorInstance instanceof Error
      ? details.errorInstance.message
      : String(details.errorInstance);
  const failing = failingCommandPattern.exec(message);
  const smallest = concreteSequence(details.counterexample?.[0] ?? []);
  const shown = failing ? smallest.slice(0, Number(failing[1]) + 1) : smallest;
  for (const [index, command] of shown.entries()) {
    console.error(`  #${index} ${describe(command)}`);
  }
  console.error(
    `property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks; the smallest sequence is above (${smallest.length} commands)`
  );
  // the label, then only the diverging lines of the diff, so the cut at 220 characters keeps them
  const [label = "", ...rest] = message.split("\n").map((line) => line.trim());
  const diverging = rest.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+ actual - expected")
  );
  console.error(`reason: ${[label, ...diverging].join(" | ")}`);
  console.error(
    `replay: CI=true POLARIS_PROPERTY_SEED=${details.seed} POLARIS_PROPERTY_PATH=${details.counterexamplePath ?? ""} bun scripts/run-gates.ts stock-property`
  );
}

interface Tally {
  commands: number;
  rejected: number;
  rejectedBy: Record<string, number>;
}

async function checkProperty(
  admin: RuntimeDatabase,
  database: RuntimeDatabase,
  options: { path: string | undefined; runs: number; seed: number },
  tally: Tally
) {
  let organizations = 0;
  // a broken database is not a counterexample: once setup fails, every later
  // run (and shrink attempt) passes at once and the error is rethrown below
  let infrastructureFailure: { error: unknown } | undefined;
  const property = fc.asyncProperty(
    fc.array(drawArb, { maxLength: 16, minLength: 1, size: "max" }),
    async (sequence) => {
      if (infrastructureFailure) {
        return;
      }
      organizations += 1;
      let world: World;
      try {
        world = await createWorld(admin, database, `property ${organizations}`);
      } catch (error) {
        infrastructureFailure = { error };
        return;
      }
      const model = emptyModel();
      let index = 0;
      for (const draw of sequence) {
        const command = resolve(model, draw);
        if (!command) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: the commands of a sequence run in order
        const real = await runOnDatabase(world, model, command);
        const expected = applyToModel(model, command, () => real.saleId ?? "");
        const label = `command #${index} (${command.kind})`;
        assert.equal(real.outcome, expected, `I6 outcome of ${label}`);
        tally.commands += 1;
        if (expected !== "ok") {
          tally.rejected += 1;
          tally.rejectedBy[expected] = (tally.rejectedBy[expected] ?? 0) + 1;
        }
        await assertBalances(world, model, label);
        index += 1;
      }
      await assertFinalState(world, admin, model);
    }
  );

  const details = await fc.check(property, {
    examples: fixedExamples,
    // the fixed examples count as runs: add them so the drawn ones stay `runs`
    numRuns: options.runs + fixedExamples.length,
    seed: options.seed,
    ...(options.path ? { path: options.path } : {}),
  });
  if (infrastructureFailure) {
    // a counterexample found before the database broke is still worth printing
    if (details.failed) {
      reportFailure(details);
    }
    throw infrastructureFailure.error;
  }
  return details;
}

async function assertGateDatabase(admin: RuntimeDatabase) {
  const server = await admin.pool.query<{
    database_name: string;
    server_version_num: string;
  }>(
    "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
  );
  const [serverRow] = server.rows;
  assert.ok(serverRow);
  assert.equal(serverRow.database_name, expectedDatabase);
  assert.ok(Number(serverRow.server_version_num) >= 180_000);
  const migrations = await admin.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
  );
  assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  const runs = runsFromEnvironment();
  const seed = seedFromEnvironment();
  const path = process.env.POLARIS_PROPERTY_PATH || undefined;
  console.log(`seed=${seed} runs=${runs}${path ? ` path=${path}` : ""}`);

  const admin = createDatabase(adminUrl, { maxConnections: 2 });
  const loginRole = `polaris_property_gate_${randomUUID().replaceAll("-", "")}`;
  let loginRoleCreated = false;
  try {
    await assertGateDatabase(admin);
    const loginPassword = randomBytes(24).toString("hex");
    await admin.pool.query(
      `CREATE ROLE "${loginRole}" WITH LOGIN INHERIT PASSWORD '${loginPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    loginRoleCreated = true;
    await admin.pool.query(`GRANT "${runtimeRole}" TO "${loginRole}"`);
    const database = createDatabase(
      temporaryRuntimeUrl(adminUrl, loginRole, loginPassword),
      { maxConnections: 1 }
    );
    const tally: Tally = { commands: 0, rejected: 0, rejectedBy: {} };
    let details: fc.RunDetails<[Draw[]]>;
    try {
      details = await checkProperty(
        admin,
        database,
        { path, runs, seed },
        tally
      );
    } finally {
      await database.pool.end();
    }
    if (details.failed) {
      reportFailure(details);
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          branch,
          gate: "stock-property",
          ...tally,
          seed,
          status: "passed",
          tests: [
            "PostgreSQL 18 with every migration replayed from scratch",
            `${runs} drawn and ${fixedExamples.length} fixed sequences (${tally.commands} commands, ${tally.rejected} rejected as the model predicted) matched the model: balance, average cost, version, ledger, returnable quantities, cancellations`,
          ],
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (loginRoleCreated) {
        // dropping the role also drops its membership in the runtime role
        await admin.pool.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      }
    } finally {
      await admin.pool.end();
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Stock property gate failed: ${redactedFailure(error).split("\n").slice(0, 3).join("\n")}`
  );
  process.exitCode = 1;
});
