import { DecimalAmount, Money } from "../money/money";

/**
 * The economics of one sale and of a period (plan PR66 and PR67): pure
 * calculations over the facts a confirmed sale and its compensations already
 * hold. Nothing here reads a clock, a database or a framework, and no value is
 * ever a floating-point number.
 *
 * The chain (docs/business-rules/expenses-and-results.md):
 *
 *   gross sales          sum of charged unit price x quantity
 *   - discounts          the sale's discount adjustments
 *   - returns            returned units at their charged price, minus their
 *                        share of the sale's discounts (see below)
 *   = net sales
 *   - COGS               item cost snapshot x quantity, minus the units that
 *                        went back to stock
 *   = gross profit
 *   + commercial surcharges   surcharge, freight and payment surcharge
 *   - variable costs     the payment's processing and anticipation fees, and
 *                        the expenses linked to the sale
 *   = contribution margin
 *   - operating expenses expenses with no sale, by competence in the period
 *   = estimated operating result (an estimate, never "net profit" or cash)
 *
 * Decisions (ADR 0053):
 * - a cancelled sale contributes nothing at all;
 * - a returned unit gives back its charged price minus its proportional share
 *   of the sale's discounts (discount x line value / subtotal, rounded
 *   half-up to the cent once per return line); surcharges, freight and the
 *   payment surcharge are NOT given back (they are not about the unit);
 * - an unknown cost, processing fee or anticipation fee is never zero: it is
 *   left out of the amount and counted in `unknown`, so the result says it is
 *   incomplete instead of pretending to be exact;
 * - COGS is computed in exact decimals from the six-place unit cost and
 *   rounded half-up to the cent once per sale;
 * - a fee comes only from the payment snapshot and an expense only from the
 *   expense table: the same economic fact has a single source.
 */
export type SaleAdjustmentKind =
  | "discount"
  | "freight"
  | "payment_surcharge"
  | "surcharge";

export interface SaleItemFact {
  /** Charged (negotiated) unit price, BRL decimal text. */
  chargedUnitPrice: string;
  position: number;
  quantity: number;
  /** Cost snapshot (up to six places) or null when it was unknown. */
  unitCost: string | null;
}

export interface SaleAdjustmentFact {
  /** The adjustment's amount in BRL, already rounded (never a percentage). */
  amount: string;
  kind: SaleAdjustmentKind;
}

export interface SaleReturnLineFact {
  itemPosition: number;
  restockedQuantity: number;
  returnedQuantity: number;
}

export interface SaleFact {
  adjustments: SaleAdjustmentFact[];
  /** Fee snapshot; null means unknown (never zero). */
  anticipationFee: string | null;
  cancelled: boolean;
  /** Amounts of the active expenses linked to this sale. */
  linkedExpenses: string[];
  items: SaleItemFact[];
  processingFee: string | null;
  /** Every line of every return of the sale. */
  returnLines: SaleReturnLineFact[];
}

export interface UnknownInputs {
  /** Items whose cost was unknown (their COGS is left out). */
  costItems: number;
  /** Sales whose processing fee was unknown (it is left out). */
  processingFees: number;
  /** Sales whose anticipation fee was unknown (it is left out). */
  anticipationFees: number;
}

export interface SaleEconomics {
  anticipationFee: string;
  /** False for a cancelled sale: every amount is zero. */
  counted: boolean;
  cogs: string;
  commercialSurcharges: string;
  contributionMargin: string;
  discounts: string;
  grossProfit: string;
  grossSales: string;
  linkedExpenses: string;
  netSales: string;
  processingFee: string;
  returns: string;
  /** Units sold minus units returned. */
  unitsSold: number;
  unknown: UnknownInputs;
}

export class InvalidSaleFactError extends Error {
  readonly code = "invalid_sale_fact";

  constructor(options?: ErrorOptions) {
    super("invalid_sale_fact", options);
    this.name = "InvalidSaleFactError";
  }
}

const ZERO = Money.fromMinorUnits(0n);

function money(value: string): Money {
  try {
    return Money.from(value);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new InvalidSaleFactError({ cause: error });
  }
}

function sum(values: readonly Money[]): Money {
  return values.reduce((total, value) => total.add(value), ZERO);
}

/** round-half-up(numerator x factor / denominator) for non-negative integers. */
function proportion(
  numerator: bigint,
  factor: bigint,
  denominator: bigint
): bigint {
  if (denominator === 0n) {
    return 0n;
  }
  const product = numerator * factor;
  return (product * 2n + denominator) / (denominator * 2n);
}

/**
 * The sale's discount split among its items in proportion to their value, in
 * whole cents that add up to the discount exactly (largest remainder; ties by
 * position). So an item returned in full gives back exactly its price minus
 * its allocation, and a sale returned in full gives back exactly gross sales
 * minus discounts.
 */
function allocateDiscount(
  items: readonly SaleItemFact[],
  discount: bigint,
  subtotal: bigint
): Map<number, bigint> {
  const allocation = new Map<number, bigint>();
  if (subtotal === 0n || discount === 0n) {
    for (const item of items) {
      allocation.set(item.position, 0n);
    }
    return allocation;
  }
  const parts = items
    .map((item) => {
      const numerator = discount * lineValue(item).minorUnits;
      return {
        floor: numerator / subtotal,
        position: item.position,
        remainder: numerator % subtotal,
      };
    })
    .sort((a, b) => {
      if (a.remainder !== b.remainder) {
        return a.remainder > b.remainder ? -1 : 1;
      }
      return a.position - b.position;
    });
  let leftover =
    discount - parts.reduce((total, part) => total + part.floor, 0n);
  for (const part of parts) {
    const extra = leftover > 0n ? 1n : 0n;
    allocation.set(part.position, part.floor + extra);
    leftover -= extra;
  }
  return allocation;
}

function lineValue(item: SaleItemFact): Money {
  return money(item.chargedUnitPrice).multiplyByQuantity(item.quantity);
}

const emptyUnknown = (): UnknownInputs => ({
  anticipationFees: 0,
  costItems: 0,
  processingFees: 0,
});

const emptySale = (): SaleEconomics => ({
  anticipationFee: "0.00",
  cogs: "0.00",
  commercialSurcharges: "0.00",
  contributionMargin: "0.00",
  counted: false,
  discounts: "0.00",
  grossProfit: "0.00",
  grossSales: "0.00",
  linkedExpenses: "0.00",
  netSales: "0.00",
  processingFee: "0.00",
  returns: "0.00",
  unitsSold: 0,
  unknown: emptyUnknown(),
});

function validateFact(sale: SaleFact): void {
  const positions = new Set<number>();
  for (const item of sale.items) {
    if (
      !(Number.isInteger(item.quantity) && item.quantity > 0) ||
      positions.has(item.position)
    ) {
      throw new InvalidSaleFactError();
    }
    positions.add(item.position);
  }
  const returned = new Map<number, number>();
  for (const line of sale.returnLines) {
    const item = sale.items.find(
      (entry) => entry.position === line.itemPosition
    );
    const total =
      (returned.get(line.itemPosition) ?? 0) + line.returnedQuantity;
    const valid =
      item !== undefined &&
      Number.isInteger(line.returnedQuantity) &&
      line.returnedQuantity > 0 &&
      line.restockedQuantity >= 0 &&
      line.restockedQuantity <= line.returnedQuantity &&
      total <= item.quantity;
    if (!valid) {
      throw new InvalidSaleFactError();
    }
    returned.set(line.itemPosition, total);
  }
}

/** The economics of one sale. A cancelled sale is all zeros and not counted. */
export function saleEconomics(sale: SaleFact): SaleEconomics {
  validateFact(sale);
  if (sale.cancelled) {
    return emptySale();
  }
  const unknown = emptyUnknown();
  const items = new Map(sale.items.map((item) => [item.position, item]));

  const grossSales = sum(sale.items.map(lineValue));
  const discounts = sum(
    sale.adjustments
      .filter((adjustment) => adjustment.kind === "discount")
      .map((adjustment) => money(adjustment.amount))
  );
  const commercialSurcharges = sum(
    sale.adjustments
      .filter((adjustment) => adjustment.kind !== "discount")
      .map((adjustment) => money(adjustment.amount))
  );

  // Returned units give back their price minus their share of the discounts.
  // The share is taken on the item's total returned quantity (not line by line),
  // so splitting a return into several never changes what is given back.
  const allocation = allocateDiscount(
    sale.items,
    discounts.minorUnits,
    grossSales.minorUnits
  );
  const returnedByItem = new Map<number, number>();
  for (const line of sale.returnLines) {
    returnedByItem.set(
      line.itemPosition,
      (returnedByItem.get(line.itemPosition) ?? 0) + line.returnedQuantity
    );
  }
  let returns = ZERO;
  let unitsReturned = 0;
  for (const [position, returned] of returnedByItem) {
    const item = items.get(position) as SaleItemFact;
    const value = money(item.chargedUnitPrice).multiplyByQuantity(returned);
    const discountShare = Money.fromMinorUnits(
      proportion(
        allocation.get(position) ?? 0n,
        BigInt(returned),
        BigInt(item.quantity)
      )
    );
    returns = returns.add(value.subtract(discountShare));
    unitsReturned += returned;
  }

  // COGS in exact decimals, rounded half-up once for the sale.
  let cost = DecimalAmount.from("0");
  for (const item of sale.items) {
    if (item.unitCost === null) {
      unknown.costItems += 1;
      continue;
    }
    cost = cost.add(
      DecimalAmount.from(item.unitCost).multiplyByQuantity(item.quantity)
    );
  }
  for (const line of sale.returnLines) {
    const item = items.get(line.itemPosition) as SaleItemFact;
    if (item.unitCost !== null && line.restockedQuantity > 0) {
      // the restocked units went back at the item's cost: they were not consumed
      cost = cost.subtract(
        DecimalAmount.from(item.unitCost).multiplyByQuantity(
          line.restockedQuantity
        )
      );
    }
  }
  const cogs = cost.toMoneyHalfUp();

  let processingFee = ZERO;
  if (sale.processingFee === null) {
    unknown.processingFees += 1;
  } else {
    processingFee = money(sale.processingFee);
  }
  let anticipationFee = ZERO;
  if (sale.anticipationFee === null) {
    unknown.anticipationFees += 1;
  } else {
    anticipationFee = money(sale.anticipationFee);
  }
  const linkedExpenses = sum(sale.linkedExpenses.map(money));

  const netSales = grossSales.subtract(discounts).subtract(returns);
  const grossProfit = netSales.subtract(cogs);
  const contributionMargin = grossProfit
    .add(commercialSurcharges)
    .subtract(processingFee)
    .subtract(anticipationFee)
    .subtract(linkedExpenses);
  const unitsSold =
    sale.items.reduce((total, item) => total + item.quantity, 0) -
    unitsReturned;

  return {
    anticipationFee: anticipationFee.toString(),
    cogs: cogs.toString(),
    commercialSurcharges: commercialSurcharges.toString(),
    contributionMargin: contributionMargin.toString(),
    counted: true,
    discounts: discounts.toString(),
    grossProfit: grossProfit.toString(),
    grossSales: grossSales.toString(),
    linkedExpenses: linkedExpenses.toString(),
    netSales: netSales.toString(),
    processingFee: processingFee.toString(),
    returns: returns.toString(),
    unitsSold,
    unknown,
  };
}

export interface PeriodResult {
  anticipationFees: string;
  cogs: string;
  commercialSurcharges: string;
  contributionMargin: string;
  discounts: string;
  /** Estimated operating result: contribution margin minus operating expenses. */
  estimatedOperatingResult: string;
  grossProfit: string;
  grossSales: string;
  linkedExpenses: string;
  netSales: string;
  /** Expenses of the period that are not linked to a sale. */
  operatingExpenses: string;
  processingFees: string;
  returns: string;
  /** Confirmed, not cancelled sales. */
  salesCount: number;
  unitsSold: number;
  /** Inputs that were unknown and left out: the result is incomplete if any is above zero. */
  unknown: UnknownInputs;
}

const AMOUNT_FIELDS = [
  "anticipationFee",
  "cogs",
  "commercialSurcharges",
  "contributionMargin",
  "discounts",
  "grossProfit",
  "grossSales",
  "linkedExpenses",
  "netSales",
  "processingFee",
  "returns",
] as const;

/**
 * The result of a set of sales and the expenses of the same period. The sales
 * are the ones that belong to the period (their commercial date is in it) and
 * carry their own linked expenses; `operatingExpenses` are the active expenses
 * with no sale whose competence is in the period. Cancelled sales are ignored.
 */
export function periodResult(
  sales: readonly SaleFact[],
  operatingExpenses: readonly string[]
): PeriodResult {
  const economics = sales.map(saleEconomics);
  const total = (field: (typeof AMOUNT_FIELDS)[number]) =>
    sum(economics.map((entry) => money(entry[field])));
  const contributionMargin = total("contributionMargin");
  const operating = sum(operatingExpenses.map(money));
  const unknown = emptyUnknown();
  for (const entry of economics) {
    unknown.anticipationFees += entry.unknown.anticipationFees;
    unknown.costItems += entry.unknown.costItems;
    unknown.processingFees += entry.unknown.processingFees;
  }
  return {
    anticipationFees: total("anticipationFee").toString(),
    cogs: total("cogs").toString(),
    commercialSurcharges: total("commercialSurcharges").toString(),
    contributionMargin: contributionMargin.toString(),
    discounts: total("discounts").toString(),
    estimatedOperatingResult: contributionMargin.subtract(operating).toString(),
    grossProfit: total("grossProfit").toString(),
    grossSales: total("grossSales").toString(),
    linkedExpenses: total("linkedExpenses").toString(),
    netSales: total("netSales").toString(),
    operatingExpenses: operating.toString(),
    processingFees: total("processingFee").toString(),
    returns: total("returns").toString(),
    salesCount: economics.filter((entry) => entry.counted).length,
    unitsSold: economics.reduce((units, entry) => units + entry.unitsSold, 0),
    unknown,
  };
}
