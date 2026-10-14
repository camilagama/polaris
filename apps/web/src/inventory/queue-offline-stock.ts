import type { RuntimeContext } from "../offline/runtime/offline-runtime";
import {
  countStockOffline,
  receiveStockOffline,
  writeOffStockOffline,
} from "../offline/stock-commands";
import type { StockCall, StockResult } from "./stock-command-model";

/**
 * Keeps a validated stock movement on this device (plan PR64): the same call the
 * panel would send becomes ONE command in the outbox, with the call's command ID,
 * so a retry of the same movement queues it once. The answer is the balance as
 * this device shows it (the server's row with the queue applied), never the
 * server's: the movement only counts once the server confirms it.
 */
export async function queueOfflineStock(input: {
  call: StockCall;
  stores: RuntimeContext;
}): Promise<StockResult> {
  const { call, stores } = input;
  const base = {
    deviceId: stores.deviceId,
    lease: stores.lease,
    newCommandId: () => call.input.commandId,
    occurredOn: call.input.occurredOn,
    organizationId: stores.organizationId,
    outbox: stores.outbox,
    reader: stores.writer,
    variantId: call.input.variantId,
  };
  let balance: { quantity: number; version: number };
  if (call.action === "receive") {
    ({ stock: balance } = await receiveStockOffline({
      ...base,
      quantity: call.input.quantity,
      unitCost: call.input.unitCost,
    }));
  } else if (call.action === "count") {
    // The count is made against the balance the person reviewed; its version
    // is the command's base version.
    ({ stock: balance } = await countStockOffline({
      ...base,
      // what the person reviewed: the count is refused if the device's balance moved since
      expectedVersion: call.input.expectedVersion,
      physicalQuantity: call.input.physicalQuantity,
      valuationUnitCost: call.input.valuationUnitCost ?? null,
    }));
  } else {
    ({ stock: balance } = await writeOffStockOffline({
      ...base,
      quantity: call.input.quantity,
      reasonCode: call.input.reasonCode,
      reasonNote: call.input.reasonNote ?? null,
    }));
  }
  return {
    balance: {
      // the device never holds the cost (ADR 0031)
      movingAverageCost: null,
      quantity: balance.quantity,
      variantId: call.input.variantId,
      version: balance.version,
    },
    replayed: false,
  };
}
