export const CAPABILITIES = Object.freeze([
  "catalog:read",
  "product:create",
  "product:update",
  "inventory:adjust",
  "sale:create",
  "customer:update",
  "expense:create",
  "organization:manage",
  "category:create",
  "category:manage",
] as const);

export type Capability = (typeof CAPABILITIES)[number];
export type TenantRole = "owner";

const capabilitiesByRole: Readonly<Record<TenantRole, readonly Capability[]>> =
  Object.freeze({
    owner: CAPABILITIES,
  });
const noCapabilities: readonly Capability[] = Object.freeze([]);

/**
 * Maps a tenant role to its named permissions. Unknown roles have no permissions.
 * This does not authenticate a user or validate membership/organization status.
 */
export function capabilitiesForRole(role: string): readonly Capability[] {
  if (!Object.hasOwn(capabilitiesByRole, role)) {
    return noCapabilities;
  }
  return capabilitiesByRole[role as TenantRole];
}

/** Checks a named permission against the central role map; unknown values fail closed. */
export function hasCapabilityForRole(
  role: string,
  capability: string
): boolean {
  return capabilitiesForRole(role).some((assigned) => assigned === capability);
}
