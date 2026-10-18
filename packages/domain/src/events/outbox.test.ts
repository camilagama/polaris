import { describe, expect, it } from "vitest";
import {
  InvalidOutboxEventError,
  OUTBOX_EVENT_MAX_BYTES,
  OUTBOX_EVENT_MAX_KEYS,
  OUTBOX_EVENT_TYPES,
  outboxEvent,
  outboxIdempotencyKey,
} from "./outbox";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const REQUEST = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";

const valid = {
  correlationId: REQUEST,
  event: { exportId: EXPORT },
  idempotencyKey: outboxIdempotencyKey("data_export.requested", EXPORT),
  organizationId: "org_AbC123-xyz",
  type: "data_export.requested",
};

describe("outboxEvent", () => {
  it("accepts an event that names a thing by its ID", () => {
    expect(outboxEvent(valid)).toEqual(valid);
  });

  it("fills in no correlation when there is none, and keeps numbers and booleans", () => {
    const { correlationId: _dropped, ...withoutCorrelation } = valid;
    expect(
      outboxEvent({
        ...withoutCorrelation,
        event: { exportId: EXPORT, files: 3, retry: false },
      })
    ).toEqual({
      ...withoutCorrelation,
      correlationId: null,
      event: { exportId: EXPORT, files: 3, retry: false },
    });
  });

  it("builds one key from the type and the ID, the same every time", () => {
    expect(outboxIdempotencyKey("data_export.requested", EXPORT)).toBe(
      `data_export.requested:${EXPORT}`
    );
    expect(valid.idempotencyKey).toBe(
      outboxIdempotencyKey("data_export.requested", EXPORT)
    );
  });

  it("knows only the types the tenant runtime may write", () => {
    expect(OUTBOX_EVENT_TYPES).toEqual(["data_export.requested"]);
  });

  it.each([
    ["a type nobody declared", { ...valid, type: "organization.purged" }],
    [
      "a name where an ID goes",
      { ...valid, event: { exportId: "Maria Souza" } },
    ],
    [
      "an e-mail",
      { ...valid, event: { exportId: EXPORT, owner: "maria@example.com" } },
    ],
    [
      "a note longer than an ID",
      { ...valid, event: { exportId: "a".repeat(65) } },
    ],
    ["a nested object", { ...valid, event: { exportId: { id: EXPORT } } }],
    ["a list", { ...valid, event: { exportId: [EXPORT] } }],
    ["null", { ...valid, event: { exportId: null } }],
    ["a decimal", { ...valid, event: { exportId: EXPORT, amount: 1.5 } }],
    [
      "a key that is not a name",
      { ...valid, event: { "Nome Completo": EXPORT } },
    ],
    ["a body that is not an object", { ...valid, event: [EXPORT] }],
    [
      "an organization that is not opaque",
      { ...valid, organizationId: "Org A" },
    ],
    ["a key with spaces", { ...valid, idempotencyKey: "data export" }],
    ["an empty key", { ...valid, idempotencyKey: "" }],
    ["a correlation that is not a token", { ...valid, correlationId: "a b" }],
    ["a field beyond the contract", { ...valid, status: "dispatched" }],
    [
      "a field beyond the contract, available_at",
      { ...valid, availableAt: "now" },
    ],
  ])("refuses %s", (_label, bad) => {
    expect(() => outboxEvent(bad as never)).toThrow(InvalidOutboxEventError);
  });

  it("refuses a body with too many keys", () => {
    const event = Object.fromEntries(
      Array.from({ length: OUTBOX_EVENT_MAX_KEYS + 1 }, (_, index) => [
        `key${String.fromCharCode(97 + index)}`,
        EXPORT,
      ])
    );
    expect(() => outboxEvent({ ...valid, event })).toThrow(
      InvalidOutboxEventError
    );
  });

  it("keeps the body small", () => {
    expect(OUTBOX_EVENT_MAX_BYTES).toBeGreaterThan(
      JSON.stringify(valid.event).length
    );
  });
});
