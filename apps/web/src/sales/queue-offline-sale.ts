import { formatBrlAmount } from "../lib/format";
import type { RuntimeContext } from "../offline/runtime/offline-runtime";
import { createOfflineSale } from "../offline/sale-confirm";
import type { PreparedConfirmation, QueuedSaleView } from "./sale-form-model";

type ConfirmRequest = Extract<PreparedConfirmation, { ok: true }>["request"];

/**
 * Keeps a validated sale on this device (plan PR64): the same request the
 * online screen would send becomes ONE `sale.confirm` command in the outbox, with
 * the command ID and the instant of the attempt, so a retry of the same sale
 * reuses them and the queue holds it once. The server confirms it when the
 * connection is back, taking the stock under its own locks; a sale it cannot
 * fit is refused there and waits in Pendências, never silently dropped.
 */
/** The device command carries no typed date: its two times are one instant. */
export class DeviceSaleNotCarriableError extends Error {
  constructor() {
    super("device_sale_not_carriable");
    this.name = "DeviceSaleNotCarriableError";
  }
}

export async function queueOfflineSale(input: {
  /** Product and variant text by variant ID, for the stock warnings. */
  labels: ReadonlyMap<string, string>;
  request: ConfirmRequest;
  stores: RuntimeContext;
}): Promise<QueuedSaleView> {
  const { labels, request, stores } = input;
  if (request.organizationId !== stores.organizationId) {
    // the organization changed under the screen: never queue under another one's outbox
    throw new Error("organization_changed");
  }
  if (request.occurredAt !== request.recordedAt) {
    throw new DeviceSaleNotCarriableError();
  }
  const result = await createOfflineSale({
    adjustments: request.adjustments,
    deviceId: stores.deviceId,
    lease: stores.lease,
    lines: request.items.map((item) => ({
      chargedUnitPrice: item.chargedUnitPrice,
      listedUnitPrice: item.listedUnitPrice,
      quantity: item.quantity,
      variantId: item.variantId,
    })),
    newCommandId: () => request.commandId,
    // The sale happened when the attempt started; no other instant is offered offline.
    now: () => new Date(request.occurredAt),
    organizationId: request.organizationId,
    outbox: stores.outbox,
    payment: request.payment,
    paymentProfile: request.paymentProfile,
    reader: stores.writer,
  });
  return {
    commandId: result.command.commandId,
    stockWarnings: result.warnings.map(
      (warning) =>
        `${labels.get(warning.variantId) ?? "Item"}: o aparelho mostra ${warning.available} em estoque e a venda tem ${warning.requested}.`
    ),
    totalDue: formatBrlAmount(result.totalDue),
  };
}
