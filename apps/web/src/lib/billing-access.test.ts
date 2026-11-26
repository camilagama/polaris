import { describe, expect, it } from "vitest";
import { canManageBilling } from "@/lib/billing-access";

const UNKNOWN_ROLES = ["", "admin", "Owner", "__proto__", "constructor"];

describe("canManageBilling", () => {
  it("shows the plan to the owner when the self-service is on", () => {
    expect(canManageBilling(true, "owner")).toBe(true);
  });

  it("hides the plan from the owner when the self-service is off", () => {
    expect(canManageBilling(false, "owner")).toBe(false);
  });

  it.each(UNKNOWN_ROLES)(
    "hides the plan from the unknown role %j with the self-service on",
    (role) => {
      expect(canManageBilling(true, role)).toBe(false);
    }
  );

  it.each(UNKNOWN_ROLES)(
    "hides the plan from the unknown role %j with the self-service off",
    (role) => {
      expect(canManageBilling(false, role)).toBe(false);
    }
  );
});
