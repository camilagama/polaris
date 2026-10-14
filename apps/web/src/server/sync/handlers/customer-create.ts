import {
  CustomerIdConflictError,
  createCustomer,
} from "@polaris/db/customer-repository";
import {
  InvalidCustomerProfileError,
  normalizeCustomerProfile,
} from "@polaris/domain/customers/customer";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../push";

/**
 * `customer.create`, the first real offline write (plan PR54). The device names
 * the customer (a UUID it generated) so its local row and the server's are the
 * same entity; the command ID makes the creation idempotent, and the customer ID
 * guards against a second, different command claiming the same customer.
 */
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CustomerCreatePayload {
  customerId: string;
  email: string | null;
  name: string;
  notes: string | null;
  phone: string | null;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidSyncPayloadError();
  }
  return value;
}

function parsePayload(payload: unknown): CustomerCreatePayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidSyncPayloadError();
  }
  const { customerId, email, name, notes, phone } = payload as Record<
    string,
    unknown
  >;
  if (
    typeof customerId !== "string" ||
    !uuidPattern.test(customerId) ||
    typeof name !== "string"
  ) {
    throw new InvalidSyncPayloadError();
  }
  const parsed = {
    customerId,
    email: optionalString(email),
    name,
    notes: optionalString(notes),
    phone: optionalString(phone),
  };
  try {
    normalizeCustomerProfile(parsed);
  } catch (error) {
    if (error instanceof InvalidCustomerProfileError) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new InvalidSyncPayloadError({ cause: error });
    }
    throw error;
  }
  return parsed;
}

const CUSTOMER_CREATE_TYPE = "customer.create";

export function createCustomerCreateHandler(
  dependencies: { createCustomer: typeof createCustomer } = { createCustomer }
): SyncCommandHandler {
  return {
    capability: "customer:update",
    classify: (error) => {
      if (error instanceof CustomerIdConflictError) {
        return "customer_id_conflict";
      }
      if (error instanceof InvalidCustomerProfileError) {
        return "invalid_payload";
      }
      return null;
    },
    async execute(transaction, identity, payload, context) {
      const input = payload as CustomerCreatePayload;
      const customer = await dependencies.createCustomer(
        transaction,
        identity,
        {
          email: input.email,
          id: input.customerId,
          name: input.name,
          notes: input.notes,
          phone: input.phone,
          requestId: context.commandId,
        }
      );
      return { customerId: customer.id, version: customer.version };
    },
    parse: parsePayload,
    type: CUSTOMER_CREATE_TYPE,
  };
}
