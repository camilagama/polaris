import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasCapabilityForRole,
} from "./capabilities";

describe("tenant capability map", () => {
  it("assigns the V1 capability set to owner", () => {
    expect(capabilitiesForRole("owner")).toEqual([
      "catalog:read",
      "product:create",
      "product:update",
      "inventory:read",
      "inventory:adjust",
      "sale:create",
      "sale:read",
      "sale:cancel",
      "sale:return",
      "sale:assign_customer",
      "customer:update",
      "customer:anonymize",
      "expense:create",
      "report:read",
      "goal:manage",
      "catalog:publish",
      "organization:manage",
      "organization:close",
      "organization:export",
      "sync:push",
      "sync:read",
      "offline:manage",
      "category:create",
      "category:manage",
    ]);
    expect(capabilitiesForRole("owner")).toEqual(CAPABILITIES);
  });

  it("allows each named capability for owner", () => {
    for (const capability of CAPABILITIES) {
      expect(hasCapabilityForRole("owner", capability)).toBe(true);
    }
  });

  it("denies unknown and inherited roles and unknown capabilities", () => {
    for (const role of ["admin", "__proto__", "constructor"]) {
      expect(capabilitiesForRole(role)).toEqual([]);
      expect(hasCapabilityForRole(role, "catalog:read")).toBe(false);
    }
    expect(hasCapabilityForRole("owner", "unknown:read")).toBe(false);
  });

  it("does not expose mutable capability lists", () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(capabilitiesForRole("owner"))).toBe(true);
    expect(Object.isFrozen(capabilitiesForRole("unknown"))).toBe(true);
  });
});
