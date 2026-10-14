import type {
  LocalVariantReadModel,
  OfflineSalePayload,
} from "@polaris/contracts";
import {
  type ConfirmSaleItemInput,
  normalizeConfirmSaleCommand,
} from "@polaris/domain/sales/confirm-sale";
import type { SaleAdjustmentInput } from "@polaris/domain/sales/sale-adjustments";
import type { SalePaymentInput } from "@polaris/domain/sales/sale-payment";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";
import { effectiveStock, type LocalInventoryReader } from "./stock-commands";

/**
 * A sale made without a connection (plan PR57). The device records what
 * happened (the lines, the prices it charged, the payment, when) as ONE
 * `sale.confirm` command and shows the sale as pending; the server confirms it
 * with the same transaction the online screen uses, taking the stock under its
 * own locks. Stock is server-authoritative: the device may warn that its copy of
 * the stock looks too low, but it never refuses a sale that really happened and
 * never decides that it fits.
 *
 * What the person sees, for each sale (`OfflineSaleState`):
 * - `pending`: waiting to be sent;
 * - `syncing`: being sent now;
 * - `confirmed`: the server accepted it (reported by `syncOutbox`, afterwards the
 *   sale is in the recent sales the next pull brings);
 * - `rejected`: the server refused it for a business reason (not enough stock, a
 *   product that is no longer sold, a date outside the window). It stays visible,
 *   blocks the queue and is resolved by `resubmitRejectedSale` (same sale, a new
 *   command, after the cause was fixed) or `discardPendingSale`;
 * - `needs_attention`: refused because of the account, not the sale (access
 *   revoked, lease, device, entitlement). Nothing about the sale is wrong; the
 *   person has to fix the account (PR58) first, so it cannot be resubmitted here.
 */
const SALE_CONFIRM = "sale.confirm";

type OfflineSaleState =
  | "confirmed"
  | "needs_attention"
  | "pending"
  | "rejected"
  | "syncing";

/** Refusals about the account or the device, not about the sale. */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set([
  "authorization_revoked",
  "capability_not_in_lease",
  "entitlement_changed",
  "invalid_creation_time",
  "lease_invalid",
  "wrong_device",
]);

/**
 * Refusals about the payment profile the sale was priced with (it changed since
 * the device saw it, or was archived or removed). Nothing else about the sale is
 * wrong, so it can be sent again without the profile.
 */
const PROFILE_REFUSALS: ReadonlySet<string> = new Set([
  "payment_profile_changed",
  "payment_profile_unavailable",
]);

/** Reads the local copy of a variant (its list price). */
export interface LocalVariantReader {
  variantRow: (variantId: string) => Promise<LocalVariantReadModel | undefined>;
}

export class MissingSalePriceError extends Error {
  constructor() {
    super("missing_sale_price");
    this.name = "MissingSalePriceError";
  }
}

export class UnknownLocalVariantError extends Error {
  constructor() {
    super("unknown_local_variant");
    this.name = "UnknownLocalVariantError";
  }
}

interface OfflineSaleLine {
  /** BRL price actually charged; the variant's list price by default. */
  chargedUnitPrice?: string;
  /** BRL list price to record; the variant's list price by default. */
  listedUnitPrice?: string;
  quantity: number;
  variantId: string;
}

export interface CreateOfflineSaleRequest {
  adjustments?: readonly SaleAdjustmentInput[];
  deviceId: string;
  /** The signed lease token the device holds for this organization (PR49). */
  lease: string;
  lines: readonly OfflineSaleLine[];
  newCommandId?: () => string;
  now?: () => Date;
  organizationId: string;
  outbox: Outbox;
  payment: SalePaymentInput;
  /**
   * The payment profile the sale was priced with, by id and by the version the
   * person saw. The server refuses the sale if that is no longer the current
   * version; null prices it with the plain payment method.
   */
  paymentProfile?: { expectedVersion: number; id: string } | null | undefined;
  reader: LocalInventoryReader & LocalVariantReader;
}

interface StockWarning {
  /** What the device's copy of the stock says is available. */
  available: number;
  requested: number;
  variantId: string;
}

export interface OfflineSaleResult {
  command: OutboxCommand;
  /** Total the customer owes, as the server will compute it. */
  totalDue: string;
  /** Lines the local stock does not seem to cover; the sale is queued anyway. */
  warnings: StockWarning[];
}

async function itemsFor(
  request: CreateOfflineSaleRequest
): Promise<ConfirmSaleItemInput[]> {
  const items: ConfirmSaleItemInput[] = [];
  for (const line of request.lines) {
    // biome-ignore lint/performance/noAwaitInLoops: lines are read in order
    const variant = await request.reader.variantRow(line.variantId);
    if (!variant) {
      throw new UnknownLocalVariantError();
    }
    const listed =
      line.listedUnitPrice ?? variant.listPrice ?? line.chargedUnitPrice;
    const charged = line.chargedUnitPrice ?? variant.listPrice;
    if (!(listed && charged)) {
      throw new MissingSalePriceError();
    }
    items.push({
      chargedUnitPrice: charged,
      listedUnitPrice: listed,
      quantity: line.quantity,
      variantId: line.variantId,
    });
  }
  return items;
}

async function stockWarnings(
  request: CreateOfflineSaleRequest,
  items: readonly ConfirmSaleItemInput[]
): Promise<StockWarning[]> {
  const requested = new Map<string, number>();
  for (const item of items) {
    requested.set(
      item.variantId,
      (requested.get(item.variantId) ?? 0) + item.quantity
    );
  }
  const warnings: StockWarning[] = [];
  for (const [variantId, quantity] of requested) {
    // biome-ignore lint/performance/noAwaitInLoops: variants are checked in order
    const stock = await effectiveStock(
      request.outbox,
      request.reader,
      variantId
    );
    if (quantity > stock.quantity) {
      warnings.push({
        available: stock.quantity,
        requested: quantity,
        variantId,
      });
    }
  }
  return warnings;
}

/** What the device stores: the contract's payload, with the profile present only when there is one. */
type StoredSalePayload = Omit<OfflineSalePayload, "paymentProfile"> & {
  paymentProfile?: { expectedVersion: number; id: string };
};

export async function createOfflineSale(
  request: CreateOfflineSaleRequest
): Promise<OfflineSaleResult> {
  const now = (request.now ?? (() => new Date()))();
  const commandId = (request.newCommandId ?? crypto.randomUUID.bind(crypto))();
  const items = await itemsFor(request);
  const payload: StoredSalePayload = {
    adjustments: [
      ...(request.adjustments ?? []),
    ] as OfflineSalePayload["adjustments"],
    items,
    occurredAt: now.toISOString(),
    payment: {
      anticipationRequested: request.payment.anticipationRequested ?? false,
      installmentPlan: request.payment.installmentPlan ?? null,
      installments: request.payment.installments ?? null,
      method: request.payment.method,
    },
    // absent (not null) when there is none, so a sale without a profile keeps its old shape
    ...(request.paymentProfile
      ? { paymentProfile: request.paymentProfile }
      : {}),
    recordedAt: now.toISOString(),
  };
  // The same normalization the server runs, on this device's clock, so a sale
  // the server would refuse for its shape or amounts never enters the queue.
  const normalized = normalizeConfirmSaleCommand(
    {
      ...payload,
      commandId,
      commandVersion: 1,
      paymentProfile: request.paymentProfile ?? null,
    },
    now
  );
  const warnings = await stockWarnings(request, items);
  const command = await request.outbox.enqueue({
    baseVersion: null,
    commandId,
    deviceId: request.deviceId,
    lease: request.lease,
    organizationId: request.organizationId,
    payload,
    type: SALE_CONFIRM,
  });
  return {
    command,
    totalDue: normalized.calculation.totalDue,
    warnings,
  };
}

export interface PendingSale {
  code: string | null;
  commandId: string;
  itemCount: number;
  occurredAt: string;
  state: Exclude<OfflineSaleState, "confirmed">;
}

function isSalePayload(value: unknown): value is OfflineSalePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return Array.isArray(row.items) && typeof row.occurredAt === "string";
}

function stateOf(command: OutboxCommand): PendingSale["state"] {
  if (command.status === "pending") {
    return "pending";
  }
  if (command.status === "sending") {
    return "syncing";
  }
  return ACCOUNT_REFUSALS.has(command.rejection?.code ?? "")
    ? "needs_attention"
    : "rejected";
}

/** The sales still in the outbox, with the state the interface shows. */
export async function pendingSales(outbox: Outbox): Promise<PendingSale[]> {
  const { commands } = await outbox.snapshot();
  return commands.flatMap((command) =>
    command.type === SALE_CONFIRM && isSalePayload(command.payload)
      ? [
          {
            code: command.rejection?.code ?? null,
            commandId: command.commandId,
            itemCount: command.payload.items.length,
            occurredAt: command.payload.occurredAt,
            state: stateOf(command),
          },
        ]
      : []
  );
}

/** The sales the server accepted in a sync run (`confirmed`), with their result. */
export function confirmedSales(
  accepted: readonly { commandId: string; result: unknown; type: string }[]
): { commandId: string; saleId: string | null; totalDue: string | null }[] {
  return accepted
    .filter((command) => command.type === SALE_CONFIRM)
    .map((command) => {
      const { saleId, totalDue } = (command.result ?? {}) as {
        saleId?: unknown;
        totalDue?: unknown;
      };
      return {
        commandId: command.commandId,
        saleId: typeof saleId === "string" ? saleId : null,
        totalDue: typeof totalDue === "string" ? totalDue : null,
      };
    });
}

async function findSale(
  outbox: Outbox,
  commandId: string
): Promise<OutboxCommand & { payload: OfflineSalePayload }> {
  const { commands } = await outbox.snapshot();
  const found = commands.find((command) => command.commandId === commandId);
  if (!(found && found.type === SALE_CONFIRM && isSalePayload(found.payload))) {
    throw new Error("not_a_pending_sale");
  }
  return found as OutboxCommand & { payload: OfflineSalePayload };
}

/**
 * Sends the same sale again as a NEW command, after what made the server refuse
 * it was fixed (the missing stock was received, the product restored). The old
 * command is gone only once the new one is queued, so a crash in between leaves
 * a refused command to discard, never a lost sale. The sale keeps its commercial
 * time and its `recordedAt` evidence; only the command ID and the lease change.
 * A refusal about the account is not resubmittable from here.
 */
export async function resubmitRejectedSale(
  outbox: Outbox,
  request: {
    commandId: string;
    lease: string;
    newCommandId?: () => string;
    /**
     * Send it again without its payment profile (taxes and term unknown), the way
     * out of a profile that changed or went away. Only for those refusals.
     */
    withoutProfile?: boolean;
  }
): Promise<OutboxCommand> {
  const sale = await findSale(outbox, request.commandId);
  if (sale.status !== "rejected") {
    throw new Error("sale_not_rejected");
  }
  if (ACCOUNT_REFUSALS.has(sale.rejection?.code ?? "")) {
    throw new Error("sale_needs_attention");
  }
  let { payload } = sale;
  if (request.withoutProfile) {
    if (!PROFILE_REFUSALS.has(sale.rejection?.code ?? "")) {
      throw new Error("sale_not_profile_refused");
    }
    const { paymentProfile: _profile, ...rest } =
      sale.payload as OfflineSalePayload;
    payload = rest as typeof sale.payload;
  }
  const next = await outbox.enqueue({
    baseVersion: null,
    commandId: (request.newCommandId ?? crypto.randomUUID.bind(crypto))(),
    deviceId: sale.deviceId,
    lease: request.lease,
    organizationId: sale.organizationId,
    payload,
    type: SALE_CONFIRM,
  });
  await outbox.discard(sale.commandId);
  return next;
}

/**
 * The explicit "this sale did not happen" action. A sale being sent is kept: the
 * server may already have confirmed it, so its answer decides.
 */
export async function discardPendingSale(
  outbox: Outbox,
  commandId: string
): Promise<void> {
  const sale = await findSale(outbox, commandId);
  if (sale.status === "sending") {
    throw new Error("sale_is_sending");
  }
  await outbox.discard(commandId);
}
