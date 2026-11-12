import { describe, expect, it } from "vitest";
import { isAsaasId } from "./ids";

describe("isAsaasId", () => {
  it("accepts the shapes Asaas writes, an underscore inside the suffix included", () => {
    expect(isAsaasId("sub", "sub_fake0000000001")).toBe(true);
    expect(isAsaasId("pay", "pay_fake0000000001")).toBe(true);
    expect(isAsaasId("pay", "pay_1_abcd2efgh3i4jk")).toBe(true);
  });

  it("refuses what could leave the path or has the wrong prefix", () => {
    expect(isAsaasId("pay", "sub_fake0000000001")).toBe(false);
    expect(isAsaasId("pay", "pay_")).toBe(false);
    expect(isAsaasId("pay", "pay_../x")).toBe(false);
    expect(isAsaasId("pay", "pay_a?b")).toBe(false);
    expect(isAsaasId("pay", "pay_a#b")).toBe(false);
    expect(isAsaasId("pay", "pay_a%2Fb")).toBe(false);
    expect(isAsaasId("pay", "pay_a-b")).toBe(false);
    expect(isAsaasId("pay", `pay_${"a".repeat(65)}`)).toBe(false);
    expect(isAsaasId("pay", 12)).toBe(false);
  });

  it("accepts a suffix made only of underscores", () => {
    // Accepted and harmless on the webhook path: `_` is path-safe, so the encoded request path stays inside the resource.
    expect(isAsaasId("pay", "pay__")).toBe(true);
  });
});
