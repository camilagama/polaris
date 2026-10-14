import type { LocalCustomerReadModel } from "@polaris/contracts";
import { normalizeCustomerProfile } from "@polaris/domain/customers/customer";
import { uuidv7 } from "../lib/uuidv7";
import type { LocalWriter } from "./bootstrap";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";

/**
 * The first real offline write (plan PR54): creating a customer without a
 * connection. The device names the customer itself (a UUIDv7), queues a
 * `customer.create` command durably and shows the customer at once from the
 * local collection; the server later creates the same entity under the same ID,
 * and the next pull replaces the optimistic row with the server's.
 *
 * The outbox is the source of truth for what is still pending: if the app dies
 * between queueing the command and writing the local row, `restorePendingCustomers`
 * writes the row again from the command.
 */
const CUSTOMER_CREATE_COMMAND = "customer.create";

interface OfflineCustomerInput {
  email?: string | null;
  name: string;
  notes?: string | null;
  phone?: string | null;
}

export interface CreateOfflineCustomerRequest {
  deviceId: string;
  input: OfflineCustomerInput;
  /** The signed lease token the device holds for this organization (PR49). */
  lease: string;
  newCommandId?: () => string;
  newCustomerId?: () => string;
  now?: () => Date;
  organizationId: string;
  outbox: Outbox;
  writer: LocalWriter;
}

interface CustomerCreatePayload {
  customerId: string;
  email: string | null;
  name: string;
  notes: string | null;
  phone: string | null;
  [key: string]: string | null;
}

function localRow(
  payload: CustomerCreatePayload,
  at: string
): LocalCustomerReadModel {
  return {
    archivedAt: null,
    email: payload.email,
    id: payload.customerId,
    name: payload.name,
    notes: payload.notes,
    phone: payload.phone,
    updatedAt: at,
    // The server assigns the real version; 1 is what a new customer has.
    version: 1,
  };
}

export async function createOfflineCustomer(
  request: CreateOfflineCustomerRequest
): Promise<{ command: OutboxCommand; customer: LocalCustomerReadModel }> {
  const now = (request.now ?? (() => new Date()))();
  // The same rules the server applies, so a form the device accepts is never
  // refused for its shape (throws InvalidCustomerProfileError otherwise).
  const profile = normalizeCustomerProfile({
    email: request.input.email ?? null,
    name: request.input.name,
    notes: request.input.notes ?? null,
    phone: request.input.phone ?? null,
  });
  const payload: CustomerCreatePayload = {
    customerId: (request.newCustomerId ?? uuidv7)(),
    email: profile.email,
    name: profile.name,
    notes: profile.notes,
    phone: profile.phone,
  };
  const command = await request.outbox.enqueue({
    baseVersion: null,
    commandId: (request.newCommandId ?? crypto.randomUUID.bind(crypto))(),
    deviceId: request.deviceId,
    lease: request.lease,
    organizationId: request.organizationId,
    payload,
    type: CUSTOMER_CREATE_COMMAND,
  });
  const customer = localRow(payload, now.toISOString());
  await request.writer.upsert("customers", [customer]);
  return { command, customer };
}

function isCustomerPayload(value: unknown): value is CustomerCreatePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.customerId === "string" && typeof row.name === "string";
}

/** What the interface shows next to each pending customer. */
export interface PendingCustomer {
  code: string | null;
  commandId: string;
  customerId: string;
  state: "pending" | "sending" | "rejected";
}

export async function pendingCustomers(
  outbox: Outbox
): Promise<PendingCustomer[]> {
  const { commands } = await outbox.snapshot();
  return commands
    .filter((command) => command.type === CUSTOMER_CREATE_COMMAND)
    .flatMap((command) =>
      isCustomerPayload(command.payload)
        ? [
            {
              code: command.rejection?.code ?? null,
              commandId: command.commandId,
              customerId: command.payload.customerId,
              state: command.status,
            },
          ]
        : []
    );
}

/**
 * Writes the local row of every customer still queued, again. Idempotent: it
 * restores rows lost to a crash between queueing and writing, and keeps a
 * rejected customer visible (needing attention) after a bootstrap.
 */
export async function restorePendingCustomers(
  outbox: Outbox,
  writer: LocalWriter
): Promise<number> {
  const { commands } = await outbox.snapshot();
  const rows = commands
    .filter((command) => command.type === CUSTOMER_CREATE_COMMAND)
    .flatMap((command) =>
      isCustomerPayload(command.payload)
        ? [localRow(command.payload, command.createdAt)]
        : []
    );
  if (rows.length > 0) {
    await writer.upsert("customers", rows);
  }
  return rows.length;
}

/**
 * The explicit "throw this customer away" action for one that was refused (or
 * that the person no longer wants): removes the command and its local row. Kept
 * while the command is being sent (the server may already have created it) and
 * while a later queued command refers to the customer.
 */
export async function discardPendingCustomer(
  outbox: Outbox,
  writer: LocalWriter,
  commandId: string
): Promise<void> {
  const { commands } = await outbox.snapshot();
  const target = commands.find((command) => command.commandId === commandId);
  if (
    !(
      target &&
      target.type === CUSTOMER_CREATE_COMMAND &&
      isCustomerPayload(target.payload)
    )
  ) {
    throw new Error("not_a_pending_customer");
  }
  if (target.status === "sending") {
    throw new Error("customer_is_sending");
  }
  const { customerId } = target.payload;
  const dependent = commands.some(
    (command) =>
      command.commandId !== commandId &&
      JSON.stringify(command.payload).includes(customerId)
  );
  if (dependent) {
    throw new Error("customer_has_dependent_commands");
  }
  await outbox.discard(commandId);
  await writer.remove("customers", [customerId]);
}
