import type { LocalInventoryReadModel } from "@polaris/contracts";
import { normalizeInventoryCountInput } from "@polaris/domain/inventory/inventory-count";
import { normalizeReceiveStockInput } from "@polaris/domain/inventory/receive-stock";
import { normalizeWriteOffStockInput } from "@polaris/domain/inventory/write-off-stock";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";

/**
 * Stock movements made without a connection (plan PR56): receive, write-off and
 * physical count. Each is one queued command; none of them edits the local
 * balance. The balance on screen is the server's row PLUS what is still queued
 * (`effectiveStock`), so a refused or discarded command simply stops counting
 * and nothing has to be undone.
 *
 * The server stays the authority. A write-off that would go below zero is
 * refused (`insufficient_stock`), and a count made against a balance that has
 * moved since the device last saw it is refused (`inventory_version_conflict`):
 * the count carries the version it counted against as the command's `baseVersion`.
 * A refused command stays visible and blocks the queue until the person discards
 * it; there is no "force" that would apply it anyway.
 */
const RECEIVE = "stock.receive";
const WRITE_OFF = "stock.write_off";
const COUNT = "stock.count";
const SALE_CONFIRM = "sale.confirm";
const STOCK_TYPES: readonly string[] = [RECEIVE, WRITE_OFF, COUNT];

/** Reads the local copy of a balance (a missing row means no stock yet). */
export interface LocalInventoryReader {
  inventoryRow: (
    variantId: string
  ) => Promise<LocalInventoryReadModel | undefined>;
}

export interface StockSnapshot {
  quantity: number;
  version: number;
}

export class InsufficientLocalStockError extends Error {
  constructor() {
    super("insufficient_local_stock");
    this.name = "InsufficientLocalStockError";
  }
}

interface StockRequestBase {
  deviceId: string;
  /** The signed lease token the device holds for this organization (PR49). */
  lease: string;
  newCommandId?: () => string;
  now?: () => Date;
  organizationId: string;
  outbox: Outbox;
  reader: LocalInventoryReader;
  variantId: string;
}

export interface ReceiveRequest extends StockRequestBase {
  /** Calendar date `YYYY-MM-DD`; today on the device by default. */
  occurredOn?: string;
  quantity: number;
  /** BRL cost per unit as decimal text. */
  unitCost: string;
}

export interface WriteOffRequest extends StockRequestBase {
  occurredOn?: string;
  quantity: number;
  reasonCode: string;
  reasonNote?: string | null;
}

export interface CountRequest extends StockRequestBase {
  occurredOn?: string;
  physicalQuantity: number;
  /** Cost to value the counted stock at, when the variant has no average yet. */
  valuationUnitCost?: string | null;
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function stockVariantOf(command: OutboxCommand): string | null {
  if (!STOCK_TYPES.includes(command.type)) {
    return null;
  }
  const { payload } = command;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const { variantId } = payload as { variantId?: unknown };
  return typeof variantId === "string" ? variantId : null;
}

/** The lines of a queued `sale.confirm`; none for any other command. */
function saleLinesOf(
  command: OutboxCommand
): { quantity: number; variantId: string }[] {
  if (command.type !== SALE_CONFIRM) {
    return [];
  }
  const { payload } = command;
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const { items } = payload as { items?: unknown };
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item: unknown) => {
    const { quantity, variantId } = (item ?? {}) as {
      quantity?: unknown;
      variantId?: unknown;
    };
    return typeof quantity === "number" && typeof variantId === "string"
      ? [{ quantity, variantId }]
      : [];
  });
}

function applyCommand(
  snapshot: StockSnapshot,
  command: OutboxCommand
): StockSnapshot {
  const payload = command.payload as {
    physicalQuantity?: number;
    quantity?: number;
  };
  // Every movement, a count included, moves the balance version by one.
  const version = snapshot.version + 1;
  if (command.type === COUNT) {
    return { quantity: payload.physicalQuantity ?? snapshot.quantity, version };
  }
  const quantity = payload.quantity ?? 0;
  return {
    quantity:
      command.type === WRITE_OFF
        ? snapshot.quantity - quantity
        : snapshot.quantity + quantity,
    version,
  };
}

/**
 * The balance as this device should show it: the local server row with the
 * movements still waiting (pending or being sent), and the sales still waiting,
 * applied in queue order.
 * Refused commands do not count: they were not applied.
 */
export async function effectiveStock(
  outbox: Outbox,
  reader: LocalInventoryReader,
  variantId: string
): Promise<StockSnapshot> {
  const row = await reader.inventoryRow(variantId);
  let snapshot: StockSnapshot = {
    quantity: row?.quantity ?? 0,
    version: row?.version ?? 0,
  };
  const { commands } = await outbox.snapshot();
  for (const command of commands) {
    if (command.status === "rejected") {
      continue;
    }
    if (stockVariantOf(command) === variantId) {
      snapshot = applyCommand(snapshot, command);
    }
    // A queued sale takes stock from each variant it sells, one movement per line.
    for (const line of saleLinesOf(command)) {
      if (line.variantId === variantId) {
        snapshot = {
          quantity: Math.max(0, snapshot.quantity - line.quantity),
          version: snapshot.version + 1,
        };
      }
    }
  }
  return snapshot;
}

interface Enqueue {
  base: StockSnapshot | null;
  payload: Record<string, string | number | null>;
  request: StockRequestBase;
  type: string;
}

async function enqueue({
  base,
  payload,
  request,
  type,
}: Enqueue): Promise<{ command: OutboxCommand; stock: StockSnapshot }> {
  const command = await request.outbox.enqueue({
    baseVersion: base?.version ?? null,
    commandId: (request.newCommandId ?? crypto.randomUUID.bind(crypto))(),
    deviceId: request.deviceId,
    lease: request.lease,
    organizationId: request.organizationId,
    payload,
    type,
  });
  return {
    command,
    stock: await effectiveStock(
      request.outbox,
      request.reader,
      request.variantId
    ),
  };
}

const placeholderCommandId = "00000000-0000-7000-8000-000000000000";

export async function receiveStockOffline(request: ReceiveRequest) {
  const now = (request.now ?? (() => new Date()))();
  const input = normalizeReceiveStockInput({
    commandId: placeholderCommandId,
    commandVersion: 1,
    occurredOn: request.occurredOn ?? localDate(now),
    quantity: request.quantity,
    unitCost: request.unitCost,
    variantId: request.variantId,
  });
  return await enqueue({
    base: null,
    payload: {
      occurredOn: input.occurredOn,
      quantity: input.quantity,
      unitCost: input.unitCost,
      variantId: input.variantId,
    },
    request,
    type: RECEIVE,
  });
}

export async function writeOffStockOffline(request: WriteOffRequest) {
  const now = (request.now ?? (() => new Date()))();
  const input = normalizeWriteOffStockInput({
    commandId: placeholderCommandId,
    commandVersion: 1,
    occurredOn: request.occurredOn ?? localDate(now),
    quantity: request.quantity,
    reasonCode: request.reasonCode,
    reasonNote: request.reasonNote ?? null,
    variantId: request.variantId,
  });
  const current = await effectiveStock(
    request.outbox,
    request.reader,
    request.variantId
  );
  if (input.quantity > current.quantity) {
    // Refused here with a clear message; the server checks again against its own balance.
    throw new InsufficientLocalStockError();
  }
  return enqueue({
    base: null,
    payload: {
      occurredOn: input.occurredOn,
      quantity: input.quantity,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote,
      variantId: input.variantId,
    },
    request,
    type: WRITE_OFF,
  });
}

export async function countStockOffline(request: CountRequest) {
  const now = (request.now ?? (() => new Date()))();
  const base = await effectiveStock(
    request.outbox,
    request.reader,
    request.variantId
  );
  const input = normalizeInventoryCountInput({
    commandId: placeholderCommandId,
    commandVersion: 1,
    expectedVersion: base.version,
    occurredOn: request.occurredOn ?? localDate(now),
    physicalQuantity: request.physicalQuantity,
    valuationUnitCost: request.valuationUnitCost ?? null,
    variantId: request.variantId,
  });
  return enqueue({
    base,
    payload: {
      occurredOn: input.occurredOn,
      physicalQuantity: input.physicalQuantity,
      valuationUnitCost: input.valuationUnitCost,
      variantId: input.variantId,
    },
    request,
    type: COUNT,
  });
}

/** What the interface shows next to each queued stock movement. */
export interface PendingStockCommand {
  code: string | null;
  commandId: string;
  state: "pending" | "sending" | "rejected";
  type: string;
  variantId: string;
}

export async function pendingStockCommands(
  outbox: Outbox
): Promise<PendingStockCommand[]> {
  const { commands } = await outbox.snapshot();
  return commands.flatMap((command) => {
    const variantId = stockVariantOf(command);
    return variantId === null
      ? []
      : [
          {
            code: command.rejection?.code ?? null,
            commandId: command.commandId,
            state: command.status,
            type: command.type,
            variantId,
          },
        ];
  });
}

/**
 * The explicit "throw this movement away" action. A movement being sent is kept:
 * the server may already have applied it, so its answer decides. Discarding a
 * movement a later queued count was based on makes that count stale; the server
 * refuses it with `inventory_version_conflict` and the person counts again.
 */
export async function discardPendingStock(
  outbox: Outbox,
  commandId: string
): Promise<void> {
  const { commands } = await outbox.snapshot();
  const target = commands.find((command) => command.commandId === commandId);
  if (!(target && stockVariantOf(target))) {
    throw new Error("not_a_pending_stock_command");
  }
  if (target.status === "sending") {
    throw new Error("stock_command_is_sending");
  }
  await outbox.discard(commandId);
}
