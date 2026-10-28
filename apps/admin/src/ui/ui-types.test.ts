import type { AdminOrganizationPage } from "@polaris/db/admin-diagnostics-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { describe, expect, it } from "vitest";
import type { OrganizationPage, WhoAmI } from "../../ui/types";

/**
 * The page writes the shapes of the store list and of `whoami` itself (its script imports nothing of the database).
 * This file fails to compile when the server's answer and the page's reading of it drift apart, in either direction.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const listMatches: Same<AdminOrganizationPage, OrganizationPage> = true;
// what /api/whoami answers (app.ts), as the page reads it
const whoamiMatches: Same<
  {
    capabilities: readonly PlatformCapability[];
    principal: { emailSnapshot: string | null; id: string; role: string };
  },
  Omit<WhoAmI, "capabilities"> & { capabilities: readonly PlatformCapability[] }
> = true;
const capabilitiesRead: readonly PlatformCapability[] extends readonly string[]
  ? true
  : false = true;

describe("the page's types", () => {
  it("match the server's answers (checked by the compiler)", () => {
    expect([listMatches, whoamiMatches, capabilitiesRead]).toEqual([
      true,
      true,
      true,
    ]);
  });
});
