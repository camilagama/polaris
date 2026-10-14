import {
  CustomerNotFoundError,
  CustomerVersionConflictError,
  InvalidCustomerProfileError,
} from "@polaris/domain/customers/customer";
import { describe, expect, it, vi } from "vitest";
import { InvalidSyncPayloadError } from "../push";
import { createCustomerUpdateHandler } from "./customer-update";

const customerId = "0199c2d0-0000-7000-8000-0000000000c1";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity = {
  capability: "sync:push",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};

function handlerWith(updateCustomer = vi.fn()) {
  return {
    handler: createCustomerUpdateHandler({
      updateCustomer: updateCustomer as never,
    }),
    updateCustomer,
  };
}

describe("customer.update handler", () => {
  it("declares its type and capability", () => {
    const { handler } = handlerWith();
    expect(handler.type).toBe("customer.update");
    expect(handler.capability).toBe("customer:update");
  });

  it("parses the profile like a creation does and refuses what is not a customer", () => {
    const { handler } = handlerWith();
    expect(handler.parse({ customerId, name: "Ana", phone: "1" })).toEqual({
      customerId,
      email: null,
      name: "Ana",
      notes: null,
      phone: "1",
    });
    for (const payload of [
      null,
      {},
      { customerId: "nope", name: "Ana", phone: "1" },
      { customerId, name: "  ", phone: "1" },
      { customerId, name: "Ana" },
    ]) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("updates against the version the device edited, with the command ID as the request ID", async () => {
    const updateCustomer = vi.fn(() =>
      Promise.resolve({
        changed: true,
        customer: { id: customerId, version: 4 },
      })
    );
    const { handler } = handlerWith(updateCustomer);
    const payload = handler.parse({
      customerId,
      email: "a@b.com",
      name: "Ana Souza",
      phone: "11",
    });
    const result = await handler.execute({} as never, identity, payload, {
      baseVersion: 3,
      commandId,
    });
    expect(updateCustomer).toHaveBeenCalledWith({}, identity, {
      email: "a@b.com",
      expectedVersion: 3,
      id: customerId,
      name: "Ana Souza",
      notes: null,
      phone: "11",
      requestId: commandId,
    });
    expect(result).toEqual({ changed: true, customerId, version: 4 });
  });

  it("refuses an edit that does not say which version it was made against, without touching the customer", async () => {
    const { handler, updateCustomer } = handlerWith();
    const payload = handler.parse({ customerId, name: "Ana", phone: "1" });
    for (const baseVersion of [null, 0, -1, 1.5]) {
      // biome-ignore lint/performance/noAwaitInLoops: each version is tried in turn
      await expect(
        handler.execute({} as never, identity, payload, {
          baseVersion,
          commandId,
        })
      ).rejects.toThrow(InvalidSyncPayloadError);
    }
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it("names a newer change on the server, a missing customer and an invalid profile, and nothing else", () => {
    const { handler } = handlerWith();
    expect(handler.classify(new CustomerVersionConflictError())).toBe(
      "customer_version_conflict"
    );
    expect(handler.classify(new CustomerNotFoundError())).toBe(
      "customer_not_found"
    );
    expect(handler.classify(new InvalidCustomerProfileError())).toBe(
      "invalid_payload"
    );
    expect(handler.classify(new Error("db down"))).toBeNull();
  });
});
