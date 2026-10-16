/**
 * What a platform operator (someone who runs Polaris, not a customer) may do in
 * the Admin app (plan PR94, ADR 0070). Kept apart from the tenant capabilities:
 * a tenant role never holds one of these, and nothing here reaches an
 * organization's data on its own; reading a tenant's records needs a support
 * case and a temporary grant on top.
 */
export const PLATFORM_CAPABILITIES = Object.freeze([
  "platform:read",
  "organization:diagnose",
  "support_case:manage",
  "tenant_access:grant",
  "pii:reveal",
  "billing:operate",
  "organization:suspend",
  "privacy_case:manage",
] as const);

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];
export type PlatformRole = "platform_owner";

export const PLATFORM_ROLES = Object.freeze(["platform_owner"] as const);

const capabilitiesByRole: Readonly<
  Record<PlatformRole, readonly PlatformCapability[]>
> = Object.freeze({
  platform_owner: PLATFORM_CAPABILITIES,
});
const noCapabilities: readonly PlatformCapability[] = Object.freeze([]);

/** Maps a platform role to its named permissions. Unknown roles have none (fail closed). */
export function platformCapabilitiesForRole(
  role: string
): readonly PlatformCapability[] {
  if (!Object.hasOwn(capabilitiesByRole, role)) {
    return noCapabilities;
  }
  return capabilitiesByRole[role as PlatformRole];
}

export function hasPlatformCapability(
  role: string,
  capability: string
): boolean {
  return platformCapabilitiesForRole(role).some(
    (assigned) => assigned === capability
  );
}

export class PlatformAuthorizationError extends Error {
  readonly code = "platform_capability_denied";

  constructor() {
    super("platform_capability_denied");
    this.name = "PlatformAuthorizationError";
  }
}

/** Every use case asks for the named capability here; none checks a role by name. */
export function assertPlatformCapability(
  role: string,
  capability: PlatformCapability
): void {
  if (!hasPlatformCapability(role, capability)) {
    throw new PlatformAuthorizationError();
  }
}
