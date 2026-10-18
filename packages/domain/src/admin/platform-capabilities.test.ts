import { describe, expect, it } from "vitest";
import {
  assertPlatformCapability,
  hasPlatformCapability,
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLES,
  PlatformAuthorizationError,
  platformCapabilitiesForRole,
} from "./platform-capabilities";

describe("platform capabilities", () => {
  it("gives the platform owner every capability", () => {
    expect(platformCapabilitiesForRole("platform_owner")).toEqual(
      PLATFORM_CAPABILITIES
    );
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(hasPlatformCapability("platform_owner", capability)).toBe(true);
    }
  });

  it("gives nothing to an unknown role, a tenant role or a prototype key", () => {
    for (const role of ["", "owner", "admin", "__proto__", "constructor"]) {
      expect(platformCapabilitiesForRole(role)).toEqual([]);
      expect(hasPlatformCapability(role, "platform:read")).toBe(false);
    }
  });

  it("refuses a capability that does not exist, even for the owner", () => {
    expect(hasPlatformCapability("platform_owner", "everything")).toBe(false);
    expect(() =>
      assertPlatformCapability("platform_owner", "everything" as never)
    ).toThrow(PlatformAuthorizationError);
  });

  it("keeps platform and tenant capabilities apart", () => {
    expect(hasPlatformCapability("platform_owner", "sale:create")).toBe(false);
    expect(PLATFORM_ROLES).toEqual(["platform_owner"]);
  });

  it("raises a stable error when a role lacks the capability", () => {
    try {
      assertPlatformCapability("nobody", "platform:read");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlatformAuthorizationError);
      expect((error as PlatformAuthorizationError).code).toBe(
        "platform_capability_denied"
      );
    }
  });
});
