import {
  attemptLogout,
  type BlockedWorkspace,
  discardAndLogout,
  type LogoutWorkspace,
} from "../logout-guard";

/**
 * The whole logout, end to end (ADR 0039): protect the queue first, then end the
 * server session, then leave. The local data is purged by the guard before the
 * session ends, so a failed purge leaves the person signed in, with their data.
 */
export interface LogoutFlowDependencies {
  /** Leaves the app after the session ended (back to the start). */
  leave: () => void;
  /** Ends the session on the server. */
  signOut: () => Promise<void>;
  workspaces: readonly LogoutWorkspace[];
}

export type LogoutFlowResult =
  | { blocked: BlockedWorkspace[]; status: "blocked" }
  | { status: "sign_out_failed" }
  | { status: "signed_out" };

async function finish(
  dependencies: LogoutFlowDependencies
): Promise<LogoutFlowResult> {
  try {
    await dependencies.signOut();
  } catch {
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
