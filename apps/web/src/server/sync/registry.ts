import type { SyncCommandHandler } from "./push";

/**
 * The domain commands a device may send through `sync.push`. The protocol
 * (idempotency, lease revalidation, ordering) is in place; each offline command
 * registers here as it is built: customers (PR54), products (PR55), stock
 * (PR56) and sales (PR57). Until then every type is answered with
 * `unsupported_command_type`.
 */
export const syncCommandHandlers: readonly SyncCommandHandler[] = [];
