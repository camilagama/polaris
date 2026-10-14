import type { OfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import {
  InvalidOfflineLeaseKeyError,
  type OfflineLeaseKey,
  signOfflineLease,
} from "../lib/offline-lease-token";
import type { WorkerBindings } from "./environment";

/** The lease secret is missing or unusable: leases cannot be issued or checked. */
export class OfflineLeaseUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("offline_lease_unavailable", options);
    this.name = "OfflineLeaseUnavailableError";
  }
}

const DEFAULT_KEY_ID = "k1";

export interface OfflineLeaseKeys {
  signing: OfflineLeaseKey;
  /** The signing key plus a previous one still accepted during a rotation. */
  verification: OfflineLeaseKey[];
}

/**
 * Reads the lease keys from the Worker secrets. `OFFLINE_LEASE_SECRET` signs;
 * during a rotation `OFFLINE_LEASE_PREVIOUS_SECRET` (with its key id) keeps live
 * leases verifiable until they expire (at most 72 hours). Without a secret the
 * feature fails closed.
 */
export function offlineLeaseKeys(bindings: WorkerBindings): OfflineLeaseKeys {
  const secret = bindings.OFFLINE_LEASE_SECRET;
  if (!secret) {
    throw new OfflineLeaseUnavailableError();
  }
  const signing = {
    id: bindings.OFFLINE_LEASE_KEY_ID || DEFAULT_KEY_ID,
    secret,
  };
  const verification = [signing];
  const previousSecret = bindings.OFFLINE_LEASE_PREVIOUS_SECRET;
  if (previousSecret) {
    const previousId = bindings.OFFLINE_LEASE_PREVIOUS_KEY_ID;
    if (!previousId || previousId === signing.id) {
      throw new OfflineLeaseUnavailableError();
    }
    verification.push({ id: previousId, secret: previousSecret });
  }
  return { signing, verification };
}

export async function signLeaseClaims(
  claims: OfflineLeaseClaims,
  keys: OfflineLeaseKeys
): Promise<string> {
  try {
    return await signOfflineLease(claims, keys.signing);
  } catch (error) {
    if (error instanceof InvalidOfflineLeaseKeyError) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new OfflineLeaseUnavailableError({ cause: error });
    }
    throw error;
  }
}
