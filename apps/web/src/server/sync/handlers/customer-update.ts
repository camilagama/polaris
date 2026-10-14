import { updateCustomer } from "@polaris/db/customer-repository";
import {
  CustomerNotFoundError,
  CustomerVersionConflictError,
  InvalidCustomerProfileError,
} from "@polaris/domain/customers/customer";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../push";
import { parseCustomerPayload } from "./customer-create";

/**
 * `customer.update`: a customer edited without a connection. The command carries
 * the version the person edited (`baseVersion`), exactly like the online edit's
 * `expectedVersion`: if the customer changed meanwhile (another device, the
 * office), the server refuses the edit (`customer_version_conflict`) instead of
 * overwriting a newer change, and the device keeps the refused edit visible. An
 * edit of a customer the server does not know is `customer_not_found`.
 */
const CUSTOMER_UPDATE_TYPE = "customer.update";

export function createCustomerUpdateHandler(
  dependencies: { updateCustomer: typeof updateCustomer } = { updateCustomer }
): SyncCommandHandler {
  return {
    capability: "customer:update",
    classify: (error) => {
      if (error instanceof CustomerVersionConflictError) {
        return "customer_version_conflict";
      }
      if (error instanceof CustomerNotFoundError) {
        return "customer_not_found";
      }
      if (error instanceof InvalidCustomerProfileError) {
        return "invalid_payload";
      }
      return null;
    },
    async execute(transaction, identity, payload, context) {
      const input = parseCustomerPayload(payload);
      if (
        context.baseVersion === null ||
        !Number.isInteger(context.baseVersion) ||
        context.baseVersion < 1
      ) {
        // an edit only means something against the version the person saw
        throw new InvalidSyncPayloadError();
      }
      const result = await dependencies.updateCustomer(transaction, identity, {
        email: input.email,
        expectedVersion: context.baseVersion,
        id: input.customerId,
        name: input.name,
        notes: input.notes,
        phone: input.phone,
        requestId: context.commandId,
      });
      return {
        changed: result.changed,
        customerId: result.customer.id,
        version: result.customer.version,
      };
    },
    parse: parseCustomerPayload,
    type: CUSTOMER_UPDATE_TYPE,
  };
}
