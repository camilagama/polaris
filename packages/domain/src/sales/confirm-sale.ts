import { MAX_INVENTORY_QUANTITY } from "../inventory/inventory";
import { Money } from "../money/money";
import {
  calculateSaleAdjustments,
  type NormalizedSaleAdjustment,
  type SaleAdjustmentCalculation,
  type SaleAdjustmentInput,
} from "./sale-adjustments";
import {
  type PaymentProfileForSale,
  type SalePaymentProfileSnapshot,
  snapshotPaymentProfileForSale,
} from "./payment-profile";
import {
  normalizeSalePayment,
  type SalePaymentInput,
  type SalePaymentSnapshot,
} from "./sale-payment";
import {
  type ConfirmedSaleSnapshot,
  normalizeBrlAmount,
  normalizeConfirmedSaleSnapshot,
} from "./sale";

export const CONFIRM_SALE_COMMAND_VERSION = 1;

const MAX_SALE_PAYMENT_PARTS = 2;

/** Tolerated difference between a device clock and the server clock. */
export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_INSTANT_YEAR = 1900;
const MAX_INSTANT_YEAR = 2200;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ConfirmSaleItemInput {
  chargedUnitPrice: string;
  listedUnitPrice: string;
  quantity: number;
  variantId: string;
}

/**
 * The operator always makes an explicit choice: a profile (with the version
 * they saw) or `null` for "no profile". Omitting the field is invalid.
 */
export interface ConfirmSalePaymentProfileSelection {
  expectedVersion: number;
  id: string;
}

/** One part of a split payment: its own amount, method, plan and profile. */
export interface ConfirmSalePaymentPartInput extends SalePaymentInput {
  amount: string;
  paymentProfile: ConfirmSalePaymentProfileSelection | null;
}

export interface ConfirmSaleCommandInput {
  adjustments: readonly SaleAdjustmentInput[];
  /** Local creation evidence for offline commands; never an authoritative time. */
  recordedAt?: string | null;
  commandId: string;
  commandVersion: number;
  items: readonly ConfirmSaleItemInput[];
  /** Commercial time of the sale, as an instant with offset. */
  occurredAt: string;
  /**
   * Exactly one of `payment` or `payments` is present. The first form pays the
   * whole total with one method and takes its profile from `paymentProfile`;
   * the second carries the profile inside each part and leaves
   * `paymentProfile` absent. Repository code extends this interface, which
   * rules out a discriminated union, so the runtime check is the guard.
   */
  payment?: SalePaymentInput;
  paymentProfile?: ConfirmSalePaymentProfileSelection | null;
  payments?: readonly ConfirmSalePaymentPartInput[];
}

export interface NormalizedConfirmSaleItem {
  chargedUnitPrice: string;
  listedUnitPrice: string;
  position: number;
  quantity: number;
  variantId: string;
}

export interface NormalizedConfirmSalePart {
  payment: SalePaymentSnapshot;
  paymentProfile: ConfirmSalePaymentProfileSelection | null;
}

export interface NormalizedConfirmSaleCommand {
  adjustments: readonly NormalizedSaleAdjustment[];
  calculation: SaleAdjustmentCalculation;
  recordedAt: Date | null;
  commandId: string;
  items: readonly NormalizedConfirmSaleItem[];
  occurredAt: Date;
  /** The first part, kept for readers that still handle a single payment. */
  payment: SalePaymentSnapshot;
  paymentProfile: ConfirmSalePaymentProfileSelection | null;
  /** Parts in the order the operator typed them; amounts sum to the total due. */
  payments: readonly NormalizedConfirmSalePart[];
}

/** Server-resolved facts for each requested item, keyed by position. */
export interface ResolvedConfirmSaleItem {
  position: number;
  productId: string;
  productLabel: string;
  /** Moving-average cost captured under the stock lock; null when unknown. */
  unitCost: string | null;
}

export interface ConfirmedSalePart {
  payment: SalePaymentSnapshot;
  paymentProfile: SalePaymentProfileSnapshot;
}

export interface ConfirmedSaleComposition {
  calculation: SaleAdjustmentCalculation;
  /** The first part, kept for readers that still handle a single payment. */
  payment: SalePaymentSnapshot;
  paymentProfile: SalePaymentProfileSnapshot;
  payments: readonly ConfirmedSalePart[];
  sale: ConfirmedSaleSnapshot;
}

export class InvalidConfirmSaleCommandError extends Error {
  readonly code = "invalid_confirm_sale_command";

  constructor(options?: ErrorOptions) {
    super("invalid_confirm_sale_command", options);
    this.name = "InvalidConfirmSaleCommandError";
  }
}

/** The commercial time is later than the server clock plus the skew allowance. */
export class SaleOccurredInFutureError extends Error {
  readonly code = "sale_occurred_in_future";

  constructor() {
    super("sale_occurred_in_future");
    this.name = "SaleOccurredInFutureError";
  }
}

/** The parts of a split payment do not add up to the sale's total due. */
export class SalePaymentSplitMismatchError extends Error {
  readonly code = "sale_payment_split_mismatch";

  constructor() {
    super("sale_payment_split_mismatch");
    this.name = "SalePaymentSplitMismatchError";
  }
}

export class UnsupportedConfirmSaleCommandVersionError extends Error {
  readonly code = "unsupported_confirm_sale_command_version";

  constructor() {
    super("unsupported_confirm_sale_command_version");
    this.name = "UnsupportedConfirmSaleCommandVersionError";
  }
}

/** The same command ID was already used with a different sale payload. */
export class SaleCommandConflictError extends Error {
  readonly code = "sale_command_conflict";

  constructor() {
    super("sale_command_conflict");
    this.name = "SaleCommandConflictError";
  }
}

/** Archived or removed products leave normal operations, including sales. */
export class SaleProductUnavailableError extends Error {
  readonly code = "sale_product_unavailable";

  constructor() {
    super("sale_product_unavailable");
    this.name = "SaleProductUnavailableError";
  }
}

function parseInstant(value: unknown): Date {
  if (typeof value !== "string" || !instantPattern.test(value)) {
    throw new InvalidConfirmSaleCommandError();
  }
  const date = new Date(value);
  // Technical bound (not a business window): years outside it are not
  // representable by PostgreSQL timestamps or by the ledger date.
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() < MIN_INSTANT_YEAR ||
    date.getUTCFullYear() > MAX_INSTANT_YEAR
  ) {
    throw new InvalidConfirmSaleCommandError();
  }
  return date;
}

function normalizeItem(
  input: ConfirmSaleItemInput,
  position: number
): NormalizedConfirmSaleItem {
  if (!input || typeof input !== "object") {
    throw new InvalidConfirmSaleCommandError();
  }
  if (
    typeof input.variantId !== "string" ||
    !uuidPattern.test(input.variantId) ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_INVENTORY_QUANTITY ||
    typeof input.listedUnitPrice !== "string" ||
    typeof input.chargedUnitPrice !== "string"
  ) {
    throw new InvalidConfirmSaleCommandError();
  }
  try {
    return {
      chargedUnitPrice: normalizeBrlAmount(input.chargedUnitPrice),
      listedUnitPrice: normalizeBrlAmount(input.listedUnitPrice),
      position,
      quantity: input.quantity,
      variantId: input.variantId.toLowerCase(),
    };
  } catch (cause) {
    // The domain error constructor forwards this value to ErrorOptions.cause.
    // biome-ignore lint/style/useErrorCause: Biome cannot follow the custom error constructor.
    throw new InvalidConfirmSaleCommandError({ cause });
  }
}

function normalizeProfileSelection(
  value: ConfirmSalePaymentProfileSelection | null | undefined
): ConfirmSalePaymentProfileSelection | null {
  if (value === null) {
    return null;
  }
  if (
    value === undefined ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !uuidPattern.test(value.id) ||
    !Number.isInteger(value.expectedVersion) ||
    value.expectedVersion < 1
  ) {
    throw new InvalidConfirmSaleCommandError();
  }
  return { expectedVersion: value.expectedVersion, id: value.id.toLowerCase() };
}

function normalizePartAmount(value: unknown): Money {
  if (typeof value !== "string") {
    throw new InvalidConfirmSaleCommandError();
  }
  try {
    return Money.from(normalizeBrlAmount(value));
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: Biome cannot follow the custom error constructor.
    throw new InvalidConfirmSaleCommandError({ cause });
  }
}

function normalizePaymentParts(
  input: ConfirmSaleCommandInput,
  totalDue: string
): readonly NormalizedConfirmSalePart[] {
  const hasPayment = input.payment !== undefined;
  const hasParts = input.payments !== undefined;
  if (hasPayment === hasParts) {
    throw new InvalidConfirmSaleCommandError();
  }

  if (!hasParts) {
    return [
      {
        payment: normalizeSalePayment(
          input.payment as SalePaymentInput,
          totalDue
        ),
        paymentProfile: normalizeProfileSelection(input.paymentProfile),
      },
    ];
  }

  const parts = input.payments;
  if (
    input.paymentProfile !== undefined ||
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > MAX_SALE_PAYMENT_PARTS
  ) {
    throw new InvalidConfirmSaleCommandError();
  }
  const amounts = parts.map((part) => {
    if (!part || typeof part !== "object") {
      throw new InvalidConfirmSaleCommandError();
    }
    const amount = normalizePartAmount(part.amount);
    if (parts.length > 1 && amount.minorUnits <= 0n) {
      throw new InvalidConfirmSaleCommandError();
    }
    return amount;
  });
  const normalized = parts.map((part, index) => ({
    payment: normalizeSalePayment(part, (amounts[index] as Money).toString()),
    paymentProfile: normalizeProfileSelection(part.paymentProfile),
  }));
  const sum = amounts.reduce(
    (total, amount) => total.add(amount),
    Money.fromMinorUnits(0n)
  );
  if (sum.minorUnits !== Money.from(totalDue).minorUnits) {
    throw new SalePaymentSplitMismatchError();
  }
  return normalized;
}

/**
 * Validates and prices the confirmSale command without touching the database.
 * Nothing here is persisted: the repository combines it with server-resolved
 * product, cost and profile facts inside a single tenant transaction.
 */
export function normalizeConfirmSaleCommand(
  input: ConfirmSaleCommandInput,
  now: Date = new Date()
): NormalizedConfirmSaleCommand {
  if (!input || typeof input !== "object") {
    throw new InvalidConfirmSaleCommandError();
  }
  if (input.commandVersion !== CONFIRM_SALE_COMMAND_VERSION) {
    throw new UnsupportedConfirmSaleCommandVersionError();
  }
  if (
    typeof input.commandId !== "string" ||
    !uuidPattern.test(input.commandId) ||
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    !Array.isArray(input.adjustments)
  ) {
    throw new InvalidConfirmSaleCommandError();
  }

  const occurredAt = parseInstant(input.occurredAt);
  // Offline sales may be confirmed long after they happened, so the past is
  // unbounded; a sale cannot have happened in the future beyond clock skew.
  if (occurredAt.getTime() > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new SaleOccurredInFutureError();
  }
  const recordedAt =
    input.recordedAt === undefined || input.recordedAt === null
      ? null
      : parseInstant(input.recordedAt);
  const items = input.items.map(normalizeItem);

  const calculation = calculateSaleAdjustments({
    adjustments: input.adjustments,
    items,
  });
  const payments = normalizePaymentParts(input, calculation.totalDue);
  const [firstPart] = payments as [NormalizedConfirmSalePart];

  return {
    adjustments: calculation.adjustments,
    calculation,
    recordedAt,
    commandId: input.commandId.toLowerCase(),
    items,
    occurredAt,
    payment: firstPart.payment,
    paymentProfile: firstPart.paymentProfile,
    payments,
  };
}

/**
 * Combines the priced command with server-resolved facts. A missing profile or
 * a profile without an exact rule keeps fees and settlement time unknown.
 * `profiles` is the single profile of a one-part sale, or one entry per part,
 * in the same order as `command.payments`; the fees of each part are computed
 * on that part's amount, so a fixed fee counts once per part.
 */
export function composeConfirmedSale(
  command: NormalizedConfirmSaleCommand,
  resolvedItems: readonly ResolvedConfirmSaleItem[],
  profiles:
    | PaymentProfileForSale
    | null
    | readonly (PaymentProfileForSale | null)[]
): ConfirmedSaleComposition {
  if (resolvedItems.length !== command.items.length) {
    throw new InvalidConfirmSaleCommandError();
  }
  const profilesByPart = Array.isArray(profiles)
    ? (profiles as readonly (PaymentProfileForSale | null)[])
    : [profiles as PaymentProfileForSale | null];
  if (profilesByPart.length !== command.payments.length) {
    throw new InvalidConfirmSaleCommandError();
  }
  const resolvedByPosition = new Map(
    resolvedItems.map((resolved) => [resolved.position, resolved])
  );
  const sale = normalizeConfirmedSaleSnapshot({
    items: command.items.map((item) => {
      const resolved = resolvedByPosition.get(item.position);
      if (!resolved) {
        throw new InvalidConfirmSaleCommandError();
      }
      return {
        chargedUnitPrice: item.chargedUnitPrice,
        listedUnitPrice: item.listedUnitPrice,
        productId: resolved.productId,
        productLabel: resolved.productLabel,
        quantity: item.quantity,
        unitCost: resolved.unitCost,
        variantId: item.variantId,
      };
    }),
  });

  const payments = command.payments.map(({ payment }, index) => ({
    payment,
    paymentProfile: snapshotPaymentProfileForSale(
      payment.amount,
      {
        anticipationRequested: payment.anticipationRequested,
        installmentPlan: payment.installmentPlan,
        installments: payment.installments,
        method: payment.method,
      },
      profilesByPart[index] as PaymentProfileForSale | null
    ),
  }));
  const [firstPart] = payments as [ConfirmedSalePart];

  return {
    calculation: command.calculation,
    payment: firstPart.payment,
    paymentProfile: firstPart.paymentProfile,
    payments,
    sale,
  };
}

export interface ConfirmedSaleTotals {
  discountTotal: string;
  freightTotal: string;
  paymentSurchargeTotal: string;
  subtotal: string;
  surchargeTotal: string;
  totalDue: string;
}

/**
 * Sums persisted amounts without recalculating percentages, so a fresh result
 * and a replayed one report the same confirmed totals.
 */
export function summarizeConfirmedSaleTotals(
  items: readonly { chargedUnitPrice: string; quantity: number }[],
  adjustments: readonly { amount: string; kind: string }[]
): ConfirmedSaleTotals {
  let subtotal = Money.fromMinorUnits(0n);
  for (const item of items) {
    subtotal = subtotal.add(
      Money.from(item.chargedUnitPrice).multiplyByQuantity(item.quantity)
    );
  }
  const totals = {
    discount: Money.fromMinorUnits(0n),
    freight: Money.fromMinorUnits(0n),
    paymentSurcharge: Money.fromMinorUnits(0n),
    surcharge: Money.fromMinorUnits(0n),
  };
  for (const adjustment of adjustments) {
    const amount = Money.from(adjustment.amount);
    switch (adjustment.kind) {
      case "discount":
        totals.discount = totals.discount.add(amount);
        break;
      case "surcharge":
        totals.surcharge = totals.surcharge.add(amount);
        break;
      case "freight":
        totals.freight = totals.freight.add(amount);
        break;
      case "payment_surcharge":
        totals.paymentSurcharge = totals.paymentSurcharge.add(amount);
        break;
      default:
        throw new InvalidConfirmSaleCommandError();
    }
  }
  return {
    discountTotal: totals.discount.toString(),
    freightTotal: totals.freight.toString(),
    paymentSurchargeTotal: totals.paymentSurcharge.toString(),
    subtotal: subtotal.toString(),
    surchargeTotal: totals.surcharge.toString(),
    totalDue: subtotal
      .subtract(totals.discount)
      .add(totals.surcharge)
      .add(totals.freight)
      .add(totals.paymentSurcharge)
      .toString(),
  };
}

/**
 * Calendar date of an instant in an IANA time zone, used as the occurred-on
 * date of the stock ledger. Technical instants stay in UTC.
 */
export function calendarDateInTimeZone(
  instant: Date,
  timeZone: string
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!(year && month && day)) {
    throw new InvalidConfirmSaleCommandError();
  }
  return `${year}-${month}-${day}`;
}
