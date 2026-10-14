/**
 * Where one user's data of one organization lives on this device (ADR 0015):
 * its own OPFS database file and its own coordinator, so a second user (or a
 * second organization) on the same browser never reads the first one's data,
 * and "leave this organization" or logout can delete exactly one namespace.
 *
 * The name is a hash, never the raw ids, so the file listing of the origin does
 * not reveal who used the device.
 */
export interface LocalNamespace {
  /** Name for the cross-tab coordinator (BroadcastChannel and locks). */
  coordinatorName: string;
  /** The OPFS file of the SQLite database. */
  databaseFile: string;
  /** The stable hash both names derive from. */
  key: string;
  organizationId: string;
  userId: string;
}

const NAMESPACE_VERSION = "v1";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The ids are session-derived values; empty or padded ones are a bug, not an input. */
function assertId(value: string): void {
  if (!value || value !== value.trim()) {
    throw new Error("invalid_local_namespace_id");
  }
}

export async function localNamespace(
  userId: string,
  organizationId: string
): Promise<LocalNamespace> {
  assertId(userId);
  assertId(organizationId);
  // The length prefix keeps ("ab", "c") and ("a", "bc") apart.
  const material = `polaris:${NAMESPACE_VERSION}:${userId.length}:${userId}:${organizationId}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  );
  const key = hex(digest).slice(0, 32);
  return {
    coordinatorName: `polaris-local-${key}`,
    databaseFile: `polaris-local-${key}.sqlite`,
    key,
    organizationId,
    userId,
  };
}
