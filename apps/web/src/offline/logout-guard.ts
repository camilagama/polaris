import { type AttentionSummary, buildAttention } from "./attention";
import type { Outbox } from "./outbox/outbox";

/**
 * Leaving this device safely (plan PR59). Queued commands are the only copy of
 * work the server has not seen, so logging out must never lose them quietly.
 * For each workspace (a user's organization on this device):
 *
 * 1. nothing queued: the local data is purged and the session can end;
 * 2. something queued: try to send it first. If that empties the queue, purge and
 *    end the session;
 * 3. otherwise (no network, a refusal, still waiting) the logout is BLOCKED and
 *    the person chooses: try again, look at what needs attention, or discard it
 *    explicitly. Discarding is never the default and never implied.
 *
 * After the session ends, the local data of the workspace is purged: the outbox
 * (with the signed leases in it) and the local collections. The purge itself
 * refuses to drop queued commands unless told to (`discardPending`), so even a
 * bug here cannot lose them silently.
 *
 * The order for a caller is: `attemptLogout` (or `discardAndLogout`) first, and
 * end the server session only when it says `ready`: a failed purge then leaves
 * the person signed in, with their data, instead of signed out with leftovers.
 */
export interface LogoutWorkspace {
  label: string;
  outbox: Outbox;
  /** Removes this workspace's local data; refuses queued commands unless told to discard. */
  purge: (options: { discardPending: boolean }) => Promise<void>;
  /** Frees what was opened only to inspect this workspace; safe to call twice. */
  release?: () => Promise<void> | void;
  /**
   * Removes everything except the queue (the local collections, the lease), for a
   * workspace nothing is reading when the logout is blocked by queued work.
   * Safe to call twice; the queue is never touched.
   */
  scrub?: () => Promise<void>;
  /** Sends what is queued (the caller wires `syncOutbox`); rejects when there is no network. */
  trySync: () => Promise<unknown>;
}

export type LogoutBlockReason =
  /** The sync could not reach the server. */
  | "offline"
  /** The server refused something: it needs a person (see the attention panel). */
  | "refused"
  /** Sent, but commands are still waiting (the server did not take them all). */
  | "still_pending";

export interface BlockedWorkspace {
  attention: AttentionSummary;
  label: string;
  pending: number;
  reason: LogoutBlockReason;
  /** Commands whose answer is unknown: the server may already have applied them. */
  sending: number;
  total: number;
}

export type LogoutOutcome =
  | { status: "ready" }
  | { blocked: BlockedWorkspace[]; status: "blocked" };

async function snapshotOf(workspace: LogoutWorkspace) {
  return await workspace.outbox.snapshot();
}

async function settle(
  workspace: LogoutWorkspace
): Promise<BlockedWorkspace | null> {
  if ((await snapshotOf(workspace)).commands.length === 0) {
    return null;
  }
  let reachedServer = true;
  try {
    await workspace.trySync();
  } catch {
    // No network (or the server is down): the queue is untouched and safe.
    reachedServer = false;
  }
  const after = await snapshotOf(workspace);
  if (after.commands.length === 0) {
    return null;
  }
  let reason: LogoutBlockReason = "still_pending";
  if (!reachedServer) {
    reason = "offline";
  } else if (after.rejected > 0) {
    reason = "refused";
  }
  return {
    attention: buildAttention(after),
    label: workspace.label,
    pending: after.pending,
    reason,
    sending: after.sending,
    total: after.commands.length,
  };
}

async function releaseAll(workspaces: readonly LogoutWorkspace[]) {
  await Promise.all(workspaces.map((workspace) => workspace.release?.()));
}

/** Tries to log out without losing anything: sends first, purges only what is empty. */
export async function attemptLogout(
  workspaces: readonly LogoutWorkspace[]
): Promise<LogoutOutcome> {
  try {
    return await attemptLogoutUnreleased(workspaces);
  } finally {
    await releaseAll(workspaces);
  }
}

async function attemptLogoutUnreleased(
  workspaces: readonly LogoutWorkspace[]
): Promise<LogoutOutcome> {
  const blocked: BlockedWorkspace[] = [];
  const clear: LogoutWorkspace[] = [];
  for (const workspace of workspaces) {
    // biome-ignore lint/performance/noAwaitInLoops: one workspace at a time keeps the network use gentle
    const result = await settle(workspace);
    if (result) {
      blocked.push(result);
    } else {
      clear.push(workspace);
    }
  }
  if (blocked.length > 0) {
    // Nothing is purged while any workspace still holds work: the person decides first.
    // A workspace nothing is reading gives up its copy of the data, never its queue,
    // blocked or not (an organization with an empty queue is not purged here, but its data goes).
    await Promise.allSettled(
      workspaces.map((workspace) => workspace.scrub?.())
    );
    return { blocked, status: "blocked" };
  }
  for (const workspace of clear) {
    // biome-ignore lint/performance/noAwaitInLoops: purged one by one so a failure names where it stopped
    await workspace.purge({ discardPending: false });
  }
  return { status: "ready" };
}

export class LogoutDiscardNotConfirmedError extends Error {
  constructor() {
    super("logout_discard_not_confirmed");
    this.name = "LogoutDiscardNotConfirmedError";
  }
}

/**
 * The explicit "log out and discard what is queued" action. It needs the
 * person's confirmation as an argument so no caller can reach it by accident,
 * and reports how many commands were thrown away.
 */
export async function discardAndLogout(
  workspaces: readonly LogoutWorkspace[],
  options: { confirmed: boolean }
): Promise<{ discarded: number; status: "ready" }> {
  if (!options.confirmed) {
    await releaseAll(workspaces);
    throw new LogoutDiscardNotConfirmedError();
  }
  try {
    return await discardUnreleased(workspaces);
  } finally {
    await releaseAll(workspaces);
  }
}

async function discardUnreleased(
  workspaces: readonly LogoutWorkspace[]
): Promise<{ discarded: number; status: "ready" }> {
  let discarded = 0;
  for (const workspace of workspaces) {
    // biome-ignore lint/performance/noAwaitInLoops: purged one by one so a failure names where it stopped
    discarded += (await snapshotOf(workspace)).commands.length;
    await workspace.purge({ discardPending: true });
  }
  return { discarded, status: "ready" };
}
