import { createCustomerCreateHandler } from "./handlers/customer-create";
import { createProductCreateHandler } from "./handlers/product-create";
import {
  createStockCountHandler,
  createStockReceiveHandler,
  createStockWriteOffHandler,
} from "./handlers/stock-commands";
import type { SyncCommandHandler } from "./push";

/**
 * The domain commands a device may send through `sync.push`. The protocol
 * (idempotency, lease revalidation, ordering) lives in `push.ts`; each offline
 * command registers here as it is built: customers (PR54), products (PR55),
 * stock (PR56) and sales (PR57). Any other type is answered with
 * `unsupported_command_type`.
 */
export const syncCommandHandlers: readonly SyncCommandHandler[] = [
  createCustomerCreateHandler(),
  createProductCreateHandler(),
  createStockReceiveHandler(),
  createStockWriteOffHandler(),
  createStockCountHandler(),
];
