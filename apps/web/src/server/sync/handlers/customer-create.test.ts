import { CustomerIdConflictError } from "@polaris/db/customer-repository";
import { InvalidCustomerProfileError } from "@polaris/domain/customers/customer";
import { describe, expect, it, vi } from "vitest";
import { InvalidSyncPayloadError } from "../push";
import { createCustomerCreateHandler } from "./customer-create";

const customerId = "0199c2d0-0000-7000-8000-0000000000c1";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity = {
  capability: "sync:push",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};

function handlerWith(createCustomer = vi.fn()) {
  return {
    createCustomer,
    handler: createCustomerCreateHandler({
      createCustomer: createCustomer as never,
    }),
  };
}

describe("customer.create handler", () => {
  it("declares its type and capability", () => {
    const { handler } = handlerWith();
    expect(handler.type).toBe("customer.create");
    expect(handler.capability).toBe("customer:update");
  });

  it("accepts a valid payload with optional fields missing", () => {
    const { handler } = handlerWith();
    expect(
      handler.parse({ customerId, name: "Ana", phone: "+55 11 90000-0000" })
    ).toEqual({
      customerId,
      email: null,
      name: "Ana",
      notes: null,
      phone: "+55 11 90000-0000",
    });
  });

  it("refuses payloads that are not a customer", () => {
    const { handler } = handlerWith();
    const bad: unknown[] = [
      null,
      "x",
      [],
      {},
      { customerId: "nope", name: "Ana", phone: "1" },
      { customerId, name: 7, phone: "1" },
      { customerId, name: "Ana" },
      { customerId, name: "   ", phone: "1" },
      { customerId, name: "Ana", phone: 5 },
      { customerId, email: {}, name: "Ana" },
      { customerId, name: "x".repeat(201), phone: "1" },
    ];
    for (const payload of bad) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("creates the customer with the device's ID and the command ID as the request ID", async () => {
    const createCustomer = vi.fn(() =>
      Promise.resolve({ id: customerId, version: 1 })
    );
    const { handler } = handlerWith(createCustomer);
    const payload = handler.parse({
      customerId,
      name: "Ana",
      notes: "VIP",
      phone: "+55 11 90000-0000",
    });
    const result = await handler.execute({} as never, identity, payload, {
      baseVersion: null,
      commandId,
    });
    expect(createCustomer).toHaveBeenCalledWith({}, identity, {
      email: null,
      id: customerId,
      name: "Ana",
      notes: "VIP",
      phone: "+55 11 90000-0000",
      requestId: commandId,
    });
    expect(result).toEqual({ customerId, version: 1 });
  });

  it("classifies a taken customer ID and an invalid profile, and nothing else", () => {
    const { handler } = handlerWith();
    expect(handler.classify(new CustomerIdConflictError())).toBe(
      "customer_id_conflict"
    );
    expect(handler.classify(new InvalidCustomerProfileError())).toBe(
      "invalid_payload"
    );
    expect(handler.classify(new Error("db down"))).toBeNull();
  });
});
