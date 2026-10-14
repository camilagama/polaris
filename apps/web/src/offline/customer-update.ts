import type { LocalCustomerReadModel } from "@polaris/contracts";
import { normalizeCustomerProfile } from "@polaris/domain/customers/customer";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";

/**
 * Editing a customer without a connection. The command carries the version the
 * person edited (`baseVersion`), and the server applies it only if the customer
 * is still at that version: an edit made on top of an older copy is refused
 * (`customer_version_conflict`) and nothing is overwritten.
 *
 * The device does not write the edit into its customer row. The row stays what
 * the server last said, and the pending edit is laid over it for display
 * (`overlayPendingCustomerEdits`): the outbox is the single source of truth for
 * what is still pending, so a crash, a discard or a refusal never leaves a
 * half-applied row behind, and an accepted edit is replaced by the server row
 * on the next pull like any other change.
 *
 * One pending edit per customer: a second edit would be made on top of a
 * version the server has not produced yet.
 */
const CUSTOMER_UPDATE_COMMAND = "customer.update";

interface CustomerUpdatePayload {
  customerId: string;
  email: string | null;
  name: string;
  notes: string | null;
  phone: string | null;
  [key: string]: string | null;
}

export interface UpdateOfflineCustomerRequest {
  /** What the customer looked like when the person started editing. */
  current: Pick<LocalCustomerReadModel, "id" | "version">;
  deviceId: string;
  input: {
    email?: string | null;
    name: string;
    notes?: string | null;
    phone?: string | null;
  };
  /** The signed lease token the device holds for this organization. */
  lease: string;
  newCommandId?: () => string;
  organizationId: string;
  outbox: Outbox;
}

function isUpdatePayload(value: unknown): value is CustomerUpdatePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.customerId === "string" && typeof row.name === "string";
}

function updatesOf(commands: OutboxCommand[]) {
  return commands.flatMap((command) =>
    command.type === CUSTOMER_UPDATE_COMMAND && isUpdatePayload(command.payload)
      ? [{ command, payload: command.payload }]
      : []
  );
}

/** Queues the edit. Throws if the customer already has one waiting. */
export async function updateOfflineCustomer(
  request: UpdateOfflineCustomerRequest
): Promise<OutboxCommand> {
  // The same rules the server applies (throws InvalidCustomerProfileError).
  const profile = normalizeCustomerProfile({
    email: request.input.email ?? null,
    name: request.input.name,
    notes: request.input.notes ?? null,
    phone: request.input.phone ?? null,
  });
  const { commands } = await request.outbox.snapshot();
  const waiting = commands.some(
    (command) =>
      JSON.stringify(command.payload).includes(request.current.id) &&
      (command.type === CUSTOMER_UPDATE_COMMAND ||
        command.type === "customer.create")
  );
  if (waiting) {
    throw new Error("customer_has_pending_command");
  }
  const payload: CustomerUpdatePayload = {
    customerId: request.current.id,
    email: profile.email,
    name: profile.name,
    notes: profile.notes,
    phone: profile.phone,
  };
  return await request.outbox.enqueue({
    baseVersion: request.current.version,
    commandId: (request.newCommandId ?? crypto.randomUUID.bind(crypto))(),
    deviceId: request.deviceId,
    lease: request.lease,
    organizationId: request.organizationId,
    payload,
    type: CUSTOMER_UPDATE_COMMAND,
  });
}

/** What the interface shows next to each customer with an edit on the way. */
export interface PendingCustomerUpdate {
  code: string | null;
  commandId: string;
  customerId: string;
  state: "pending" | "sending" | "rejected";
}

export async function pendingCustomerUpdates(
  outbox: Outbox
): Promise<PendingCustomerUpdate[]> {
  const { commands } = await outbox.snapshot();
  return updatesOf(commands).map(({ command, payload }) => ({
    code: command.rejection?.code ?? null,
    commandId: command.commandId,
    customerId: payload.customerId,
    state: command.status,
  }));
}

/**
 * The rows as the person expects to see them: each customer with an edit still
 * waiting (not refused) shows the edited values. A refused edit shows the
 * server's row, and the refusal is in Pendências with what was typed.
 */
export function overlayPendingCustomerEdits(
  rows: LocalCustomerReadModel[],
  commands: OutboxCommand[]
): LocalCustomerReadModel[] {
  const edits = new Map(
    updatesOf(commands)
      .filter(({ command }) => command.status !== "rejected")
      .map(({ payload }) => [payload.customerId, payload])
  );
  if (edits.size === 0) {
    return rows;
  }
  return rows.map((row) => {
    const edit = edits.get(row.id);
    return edit
      ? {
          ...row,
          email: edit.email,
          name: edit.name,
          notes: edit.notes,
          phone: edit.phone,
        }
      : row;
  });
}

/**
 * The explicit "throw this edit away": removes only the command, because the
 * local row was never changed. Kept while the command is being sent (the server
 * may already have applied it).
 */
export async function discardPendingCustomerUpdate(
  outbox: Outbox,
  commandId: string
): Promise<void> {
  const { commands } = await outbox.snapshot();
  const target = commands.find((command) => command.commandId === commandId);
  if (target?.type !== CUSTOMER_UPDATE_COMMAND) {
    throw new Error("not_a_pending_customer_update");
  }
  if (target.status === "sending") {
    throw new Error("customer_update_is_sending");
  }
  await outbox.discard(commandId);
}
