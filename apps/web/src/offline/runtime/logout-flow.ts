import {
  attemptLogout,
  type BlockedWorkspace,
  discardAndLogout,
  type LogoutWorkspace,
} from "../logout-guard";

/**
 * The whole logout, end to end (ADR 0039 and the emenda of 22/10 of ADR 0048): protect the queue first, then,
 * online, revoke this device on the server, then end the server session, then forget the device and leave. The
 * local data is purged by the guard before anything else, so a failed purge leaves the person signed in, with
 * their data. The revocation never stops the logout and never touches the queue, which is already empty or was
 * discarded on purpose: without it the device only stays on the list until it is revoked from another one.
 */
export interface LogoutFlowDependencies {
  device: LogoutDevice;
  /** Leaves the app after the session ended (back to the start). */
  leave: () => void;
  /** Ends the session on the server. */
  signOut: () => Promise<void>;
  workspaces: readonly LogoutWorkspace[];
}

export interface LogoutDevice {
  /** Forgets the device id, the lease left and the remembered user (the last step). */
  forget: () => void;
  /** This installation's device, read before anything else; null when it has none. */
  id: string | null;
  isOnline: () => boolean;
  /**
   * Revokes the device on the server (`device.revokeCurrent`) and says whether the session ended with it. Any
   * failure (no network, 401, 5xx, a refusal) rejects, and the logout goes on as if it had not been tried.
   */
  revoke: (deviceId: string) => Promise<{ endedCurrentSession: boolean }>;
  /** How long the revocation may take, at most (5 s, as the wait for the copy of an ended session). */
  timeoutMs?: number;
}

export type LogoutFlowResult =
  | { blocked: BlockedWorkspace[]; status: "blocked" }
  | { status: "sign_out_failed" }
  | { status: "signed_out" };

const REVOKE_TIMEOUT_MS = 5000;

/** Whether the revocation ended this session; false for any failure, a refusal or the time running out. */
async function revokeThisDevice(device: LogoutDevice): Promise<boolean> {
  if (device.id === null || !device.isOnline()) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(
      () => resolve(null),
      device.timeoutMs ?? REVOKE_TIMEOUT_MS
    );
  });
  try {
    const revocation = device.revoke(device.id);
    // an answer that comes after the time limit is dropped without an unhandled rejection
    revocation.catch(() => undefined);
    const result = await Promise.race([revocation, timeout]);
    return result?.endedCurrentSession === true;
  } catch {
    // not revoked, or not known to be: no new try, the device stays on the list (the same as "Sair" offline)
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function finish(
  dependencies: LogoutFlowDependencies
): Promise<LogoutFlowResult> {
  const sessionEnded = await revokeThisDevice(dependencies.device);
  let signedOut = true;
  try {
    // always: it is the sign-out that clears the cookie, even when the session already ended with the device
    await dependencies.signOut();
  } catch {
    signedOut = sessionEnded;
  }
  dependencies.device.forget();
  if (!signedOut) {
    // The local data is already gone but the session is not: the person is still
    // signed in, and the next load rebuilds what was purged.
    return { status: "sign_out_failed" };
  }
  dependencies.leave();
  return { status: "signed_out" };
}

/** Tries to log out without losing anything. */
export async function startLogout(
  dependencies: LogoutFlowDependencies
): Promise<LogoutFlowResult> {
  const outcome = await attemptLogout(dependencies.workspaces);
  return outcome.status === "blocked"
    ? { blocked: outcome.blocked, status: "blocked" }
    : await finish(dependencies);
}

/** The explicit choice to discard what is queued and log out. */
export async function discardAndLeave(
  dependencies: LogoutFlowDependencies
): Promise<LogoutFlowResult> {
  await discardAndLogout(dependencies.workspaces, { confirmed: true });
  return await finish(dependencies);
}
