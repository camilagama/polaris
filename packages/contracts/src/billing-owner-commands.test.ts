import { describe, expect, it } from "vitest";
import { polarisContract } from "./index";

/** What a contract's input schema offers (Standard Schema), as oRPC validates it before the handler runs. */
interface StandardSchemaV1 {
  "~standard": {
    validate: (
      value: unknown
    ) =>
      | { issues?: readonly unknown[] }
      | Promise<{ issues?: readonly unknown[] }>;
  };
}

function inputOf(procedure: unknown): StandardSchemaV1 {
  const schema = (procedure as { "~orpc": { inputSchema?: StandardSchemaV1 } })[
    "~orpc"
  ].inputSchema;
  if (!schema) {
    throw new Error("no input schema");
  }
  return schema;
}

async function accepts(procedure: unknown, input: unknown): Promise<boolean> {
  const result = await inputOf(procedure)["~standard"].validate(input);
  return !result.issues;
}

const REQUEST = "11111111-1111-4111-8111-111111111111";
const base = { organizationId: "org", requestId: REQUEST };

describe("billing.cancelRenewal input: the optional reason (ADR 0104, decision 3)", () => {
  const { cancelRenewal } = polarisContract.billing;

  it.each([
    ["no reason", base],
    ["a reason", { ...base, reason: "Achei caro." }],
    ["line breaks and tabs", { ...base, reason: "Achei caro.\n\tVolto depois." }],
    ["500 characters", { ...base, reason: "a".repeat(500) }],
  ])("takes %s", async (_name, input) => {
    expect(await accepts(cancelRenewal, input)).toBe(true);
  });

  it.each([
    ["a NUL", "caro\u0000"],
    ["a bidirectional override", "caro‮oãn"],
    ["a zero-width space", "ca​ro"],
    ["an escape", "caro\u001B[31m"],
    ["501 characters", "a".repeat(501)],
  ])("refuses %s", async (_name, reason) => {
    expect(await accepts(cancelRenewal, { ...base, reason })).toBe(false);
  });

  it("refuses a key it does not know (strict)", async () => {
    expect(await accepts(cancelRenewal, { ...base, accessEndsAt: null })).toBe(
      false
    );
  });
});

describe("the request ID of the owner's commands", () => {
  it.each([
    "requestRefund",
    "openOverduePayment",
    "cancelRenewal",
  ] as const)("%s takes a UUID and refuses anything else", async (name) => {
    const procedure = polarisContract.billing[name];
    expect(await accepts(procedure, base)).toBe(true);
    expect(await accepts(procedure, { ...base, requestId: REQUEST.toUpperCase() })).toBe(true);
    const refused = await Promise.all(
      [
        "abc",
        "00000000-0000-0000-0000-000000000000",
        `${REQUEST}0`,
        "",
      ].map((requestId) => accepts(procedure, { ...base, requestId }))
    );
    expect(refused).toEqual([false, false, false, false]);
  });
});
