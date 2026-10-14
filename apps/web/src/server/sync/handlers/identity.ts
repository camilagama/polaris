import type { TenantRequestIdentity } from "@polaris/db/tenant-transaction";

/**
 * The sync frame runs every command under the `sync:push` capability, but the
 * repositories keep their own capability check (`inventory:adjust`, ...). A
 * handler may re-issue the identity under its domain capability ONLY because
 * `sync.push` already required that capability in the signed lease and the
 * database revalidated the role still holds it (ADR 0033, ADR 0035).
 */
export function withCapability(
  identity: TenantRequestIdentity,
  capability: string
): TenantRequestIdentity {
  return { ...identity, capability };
}
