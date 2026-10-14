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
    // The count is made against the balance this device shows (the queue
    // applied), whose version it carries as the command's base version.
    ({ stock: balance } = await countStockOffline({
      ...base,
      physicalQuantity: call.input.physicalQuantity,
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
