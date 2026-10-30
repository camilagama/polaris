import { timerSchedule } from "../../lib/connection";
import { readUnverifiedOfflineLease } from "../../lib/offline-lease-token";
import {
  isConnectionFailure,
  isDefiniteRpcRejection,
  isLegalAcceptanceRefusal,
  isOrganizationClosedRefusal,
  isPlatformCut,
  isTransientReadFailure,
  rpcErrorCode,
} from "../../lib/rpc-error";
import type { PendingWork, PendingWorkSource } from "../../pwa/update-model";
import {
  type BootstrapSource,
  bootstrapLocalStore,
  isLocalStoreReady,
  type LocalWriter,
  pullLocalChanges,
} from "../bootstrap";
import { restorePendingCustomers } from "../customer-create";
import type { LogoutWorkspace } from "../logout-guard";
import type { LocalNamespace } from "../namespace";
import type { Outbox } from "../outbox/outbox";
import { restorePendingProducts } from "../product-create";
import type { LocalVariantReader } from "../sale-confirm";
import type { LocalInventoryReader } from "../stock-commands";
import {
  type PushFunction,
  type SyncOutboxSummary,
  syncOutbox,
} from "../sync-runner";
import { leaseStanding, leaseTimerDelay } from "./lease-standing";

/**
 * The offline runtime of the running app (Phase 5 wiring). One per signed-in
 * organization on this device. It owns what the offline modules need to work
 * together, and nothing else knows about their order:
 *
 * 1. the device (registered once, remembered here);
 * 2. the signed lease (cached, renewed while online before it ends), whose claims
 *    also tell WHOSE namespace to open, so the app works offline from the first
 *    paint of a second visit;
 * 3. the stores of the namespace: the outbox and the local collections, restored
 *    after a crash and bootstrapped when still empty;
 * 4. the sync: single-flight, in queue order, pulling the changes afterwards;
 * 5. the figures the screens show (online, queued, refused, last sync).
 *
 * It never decides WHEN to sync: the host calls syncNow (on start, on reconnect,
 * on a timer, after queueing) and reads the outcome (offline, `server_busy` or `sync_failed`
 * to try again later). It is framework-free and takes every outside thing as a
 * dependency, so it is tested without a browser.
 */
export interface KeyValueStore {
  /** Every key held, when the store can list them (used to sweep keys of an older layout). */
  keys?: () => string[];
  read: (key: string) => string | null;
  remove: (key: string) => void;
  write: (key: string, value: string) => void;
}

export interface RuntimeApi {
  /**
   * Whether this device is registered to the signed-in user and not revoked.
   * Asked at every start, so a browser whose previous user left without logging
   * out never lends that user's device, lease or data to the next one.
   */
  deviceIsMine: (deviceId: string) => Promise<boolean>;
  /** Issues (or renews) the lease of the device for the organization. */
  issueLease: (
    deviceId: string,
    organizationId: string
  ) => Promise<{ expiresAt: string; lease: string }>;
  push: (organizationId: string) => PushFunction;
  /** Registers this device for the signed-in user and returns its ID. */
  registerDevice: (label: string | null) => Promise<string>;
  /**
   * The ID of the signed-in user, as the server sees the session; null when there
   * is none (the server said so, or refused with 401/403). Throws
   * SessionUnreachableError when the server gave no answer (no connection, timeout,
   * 5xx, 429: the remembered user stands in), and any other error when it answered
   * with something unusable.
   */
  sessionUserId: () => Promise<string | null>;
  /**
   * The reads of the sync (pull, bootstrap). `signal` ends the ones still going when someone is waiting for the
   * queue to be sent: a read held by the tab's read gate (a 429 pause) must not hold "Sair".
   */
  source: (organizationId: string, signal?: AbortSignal) => BootstrapSource;
}

/** The own lease ended and could not be renewed: the offline access expired (not a refused session). */
class OfflineAccessExpiredError extends Error {
  constructor(message = "offline_access_expired", options?: ErrorOptions) {
    super(message, options);
    this.name = "OfflineAccessExpiredError";
  }
}

/** The server could not be reached at all (no connection, timeout): the last known session user may stand in. */
export class SessionUnreachableError extends Error {
  constructor(message = "session_unreachable", options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionUnreachableError";
  }
}

export interface OpenedStores {
  close: () => Promise<void> | void;
  outbox: Outbox;
  writer: LocalWriter & LocalInventoryReader & LocalVariantReader;
}

/** Tells the other tabs of this namespace that the local rows changed, and hears them. */
export interface DataChannel {
  close: () => void;
  post: () => void;
  subscribe: (listener: () => void) => () => void;
}

export interface RuntimeDependencies {
  api: RuntimeApi;
  deviceLabel?: string | null;
  /**
   * Runs the sync only if no other tab of this browser is running one for the same namespace
   * (`navigator.locks`, `ifAvailable`); false when it did not run. Without it the sync always runs.
   */
  exclusive?: (name: string, task: () => Promise<void>) => Promise<boolean>;
  /**
   * Whether the connection is proven (an answer of the Worker, emenda do ADR 0043): what the screens are
   * told (`online`) and what decides asking the server instead of trusting the device (the session, the
   * device, a lease renewal, the bootstrap).
   */
  isOnline: () => boolean;
  keyValues: KeyValueStore;
  /** Timeline marks per phase of a sync (`performance.mark` in the browser); nothing is sent. */
  mark?: (name: string) => void;
  /**
   * Whether a call may leave at all (`navigator.onLine`); `isOnline` when not given. A sync and the sends
   * of "Sair" try for real whenever it is true, even with the connection not proven: an answer of the
   * Worker is what proves it again, and a state must never stop the real try.
   */
  mayTry?: () => boolean;
  namespaceFor: (
    userId: string,
    organizationId: string
  ) => Promise<LocalNamespace>;
  now?: () => Date;
  /** Cross-tab news (BroadcastChannel in the browser); without it tabs refresh on their own syncs. */
  openDataChannel?: (name: string) => DataChannel;
  openStores: (
    namespace: LocalNamespace,
    deviceId: string
  ) => Promise<OpenedStores>;
  purge: (
    namespace: LocalNamespace,
    options: { discardPending: boolean }
  ) => Promise<void>;
  /** Runs the callback after the delay and returns how to cancel it (setTimeout in the browser). */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Deletes only the local collections (the OPFS file) of a namespace, keeping its queue. */
  wipeCollections: (namespace: LocalNamespace) => Promise<void>;
}

/**
 * `expired`: the session user's own lease passed its `exp` with no way to renew
 * it (no connection, or a server that gave no answer). The queue is open only to
 * be counted and sent once the access is renewed; the local collections are not
 * offered to any screen and nothing new is queued (emenda do ADR 0047).
 */
type RuntimePhase = "expired" | "off" | "ready" | "starting" | "unavailable";

export interface RuntimeSnapshot {
  /** Whether the local collections hold a complete snapshot of the organization. */
  bootstrapped: boolean;
  counts: PendingWork;
  /**
   * Goes up whenever the local collections may have changed (opened, synced,
   * or written by a screen), so a screen that reads them knows to read again.
   */
  dataVersion: number;
  /**
   * The offline access ended with the app open (the timer at the lease's `exp`, or a sync that
   * found it ended), not at start: the page that was open was taken off the screen, with
   * whatever was being typed in it. Only meaningful while the phase is `expired`.
   */
  expiredWhileOpen: boolean;
  lastSyncAt: string | null;
  leaseExpiresAt: string | null;
  /**
   * The server refused the last call for lack of the legal acceptance (ADR 0100). It is not a refused
   * session: the collections, the lease and the queue stay as they are, nothing is rejected, and the
   * sync tries again at its usual moments; it clears once a sync goes through.
   */
  legalAcceptanceRequired: boolean;
  online: boolean;
  /**
   * The server refused a call because the organization was closed (ADR 0081): the local copy and the lease were
   * dropped as for a refused session, the queue stays, and the session itself is fine (nothing reads the
   * organizations again for it). It holds until the runtime stops.
   */
  organizationClosed: boolean;
  phase: RuntimePhase;
  /**
   * Why the runtime is unavailable or the last sync failed; null when fine. A failed sync is `server_busy` when the
   * server got the call and died on it (`isPlatformCut`: the regime of the Free plan, past the 60 s of quiet), and
   * `sync_failed` for any other failure (`syncFailed`).
   */
  reason: string | null;
  /**
   * While `expired`: the server answered the renewal with a refusal that is not about the
   * session (an unknown device, a lease it does not issue). Waiting for the network does not
   * fix it; the next try (a sync, or opening the app again) may.
   */
  renewalRefused: boolean;
  /**
   * The server answered the last sync with "not signed in" or "not allowed": the
   * session ended or the membership was withdrawn while the app was open. The
   * local copy must stop standing in for the server until a sync works again.
   */
  sessionRefused: boolean;
  syncing: boolean;
}

/** What a screen needs to queue a command. */
export interface RuntimeContext {
  deviceId: string;
  lease: string;
  organizationId: string;
  outbox: Outbox;
  writer: LocalWriter & LocalInventoryReader & LocalVariantReader;
}

/**
 * The server said the session is over or the account may not do this. Only the Worker says it: a 401 or
 * 403 without its mark (a WAF, a portal) reaches here as a connection failure, never as a refusal.
 */
function isSessionRefusal(error: unknown): boolean {
  if (isConnectionFailure(error)) {
    return false;
  }
  const code = rpcErrorCode(error);
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

/**
 * The runtime already knows the store was closed (a call of this page was refused for it): no lease is asked for it
 * again, and whatever was on its way ends as the server's own refusal would.
 */
class KnownClosedError extends Error {
  constructor() {
    super("organization_closed");
    this.name = "KnownClosedError";
  }
}

function isClosedRefusal(error: unknown): boolean {
  return (
    error instanceof KnownClosedError || isOrganizationClosedRefusal(error)
  );
}

/**
 * How long a sync that keeps failing in a transient way (a Worker killed for CPU, 1102; a 503 "try again") stays quiet:
 * nothing said before 60 s in a row without a good sync (paliativo dos 1102), then `server_busy`. Nothing kept is lost
 * meanwhile.
 */
const QUIET_FAILURE_MS = 60_000;

/** The last sync failed and said so (`server_busy` or `sync_failed`): the queue was not sent. */
function syncFailed(snapshot: Pick<RuntimeSnapshot, "reason">): boolean {
  return snapshot.reason === "sync_failed" || snapshot.reason === "server_busy";
}

function failureReason(error: unknown): "server_busy" | "sync_failed" {
  return isPlatformCut(error) ? "server_busy" : "sync_failed";
}

/** Why the pull of a run is aborted: "Sair" or an update needs the queue out and must not wait for the read gate. */
const PULL_CUT = new DOMException("pull_cut", "AbortError");

/** The error of a read that was cut on purpose (its own reason, or an abort the client wrapped). */
function isPullCut(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  for (let level = 0, next = error; level < 3 && next; level += 1) {
    if (next === signal.reason || (next as Error).name === "AbortError") {
      return true;
    }
    next = (next as Error).cause;
  }
  return false;
}

/** How the last sync ended, for "Sair": a try that got no answer blocks it as offline (ADR 0039). */
type SyncOutcome = "answered" | "no_answer" | "not_run";

const DEVICE_KEY = "polaris.offline.device";
const NAMESPACES_KEY = "polaris.offline.namespaces";
const MAX_LABEL_CODE_POINTS = 80;
const controlCharacters = /\p{Cc}/gu;

/** A device label the server accepts: trimmed, no control characters, at most 80 characters, or none. */
function clampLabel(label: string | null | undefined): string | null {
  const cleaned = (label ?? "").replace(controlCharacters, " ").trim();
  return cleaned
    ? [...cleaned].slice(0, MAX_LABEL_CODE_POINTS).join("").trim()
    : null;
}
/** The lease is the user's own: a second user of this browser never finds it. */
const leaseKey = (userId: string, organizationId: string) =>
  `${LEASE_KEY_PREFIX}${userId}.${organizationId}`;
/** Before the lease belonged to a user; only ever removed. */
const LEASE_KEY_PREFIX = "polaris.offline.lease.";
/** The old key was `prefix + organization` and ids have no dots; the new one is `prefix + user.organization`. */
const isLegacyLeaseKey = (key: string) =>
  key.startsWith(LEASE_KEY_PREFIX) &&
  !key.slice(LEASE_KEY_PREFIX.length).includes(".");
/** Who was signed in the last time the server could be asked; what offline starts trust. */
const SESSION_USER_KEY = "polaris.offline.session-user";
/** The server's code for a lease, device or grant that no longer stands. */
const AUTHORIZATION_REVOKED = "authorization_revoked";
const RENEW_BEFORE_MS = 12 * 3_600_000;
/**
 * A confirmation of who is signed in is reused by the syncs that follow it, so a
 * burst of syncs (reconnect, return to the app) costs one get-session, not one
 * each. Never reused when something is queued: the push must not leave under
 * somebody else's session (the server would refuse and record that for good).
 * It only bounds how long a first user's runtime may keep reading and queueing
 * after somebody else signed in.
 */
const SESSION_RECHECK_MS = 30_000;
const EMPTY_COUNTS: PendingWork = { pending: 0, rejected: 0, sending: 0 };

/** What one sync run was started for, so a late answer never acts on whoever opened after it. */
interface RunScope {
  generation: number;
  namespace: LocalNamespace;
  stores: OpenedStores;
  userId: string;
}

interface CachedLease {
  expiresAt: string;
  lease: string;
}

/**
 * The server refuses a lease when the plan does not include offline writes: the
 * device is fine, so it is neither forgotten nor registered again; the app just
 * stays online.
 */
function isPlanRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return false;
  }
  const { data } = error;
  return (
    typeof data === "object" &&
    data !== null &&
    "reason" in data &&
    data.reason === "entitlement_denied"
  );
}

export class OfflineRuntime {
  private readonly dependencies: RuntimeDependencies;
  private readonly listeners = new Set<() => void>();
  private snapshot: RuntimeSnapshot = {
    bootstrapped: false,
    counts: EMPTY_COUNTS,
    dataVersion: 0,
    expiredWhileOpen: false,
    lastSyncAt: null,
    leaseExpiresAt: null,
    legalAcceptanceRequired: false,
    online: true,
    organizationClosed: false,
    phase: "off",
    reason: null,
    renewalRefused: false,
    sessionRefused: false,
    syncing: false,
  };
  private stores: OpenedStores | null = null;
  private channel: DataChannel | null = null;
  private stopListening: (() => void) | null = null;
  private namespace: LocalNamespace | null = null;
  private organizationId: string | null = null;
  private userId: string | null = null;
  private deviceId: string | null = null;
  private lease: string | null = null;
  private inFlight: Promise<void> | null = null;
  /** The start in progress, so a drop asked meanwhile acts on what it opens and is not undone by it. */
  private startRun: Promise<void> | null = null;
  /** The stores a call of this page was refused for as closed: never opened again by this runtime. */
  private readonly closedOrganizations = new Set<string>();
  /** A drop for a closed store is on its way: a run that meets the same refusal meanwhile leaves it to finish. */
  private closedDrop: Promise<void> | null = null;
  /** Ends the reads (the pull) of the run in flight; a send that needs the queue out does not wait for them. */
  private pullAbort: AbortController | null = null;
  /** `trySend` is waiting for the run in flight: its pull is cut even if it has not got that far yet. */
  private pullCutRequested = false;
  /** Whether the run in flight pulls (a full sync) or only pushes (`trySend`). */
  private inFlightPulls = true;
  private lastOutcome: SyncOutcome = "not_run";
  /** The first of the transient failures in a row of the sync (ms), or null after a good one. */
  private failingSince: number | null = null;
  /** The last of those failures (ms): a gap longer than the quiet minute starts a new run of failures. */
  private failedAt = 0;
  /** When the server last confirmed the session user of the open namespace; null forces a new look. */
  private sessionConfirmedAt: number | null = null;
  /** Bumped by every start and stop so a late answer of an old run is dropped. */
  private generation = 0;
  /** Cancels the timer at the lease's `exp`, while one is set. */
  private cancelExpiryTimer: (() => void) | null = null;

  constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
  }

  // ------------------------------------------------------------- reading
  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** What a screen needs to queue a command, or null when the runtime is not ready. */
  context(): RuntimeContext | null {
    if (
      this.snapshot.phase !== "ready" ||
      !(
        this.stores &&
        this.deviceId &&
        this.lease &&
        this.organizationId &&
        this.userId
      ) ||
      // a timer that fires late (a tab in the background) never lets a command in after the exp
      !this.leaseIsUsable(
        this.lease,
        this.userId,
        this.organizationId,
        this.deviceId
      )
    ) {
      return null;
    }
    return {
      deviceId: this.deviceId,
      lease: this.lease,
      organizationId: this.organizationId,
      outbox: this.stores.outbox,
      writer: this.stores.writer,
    };
  }

  /** Where the update cycle reads the queue (ADR 0041): a swap of the build waits while it holds work. */
  workSource(): PendingWorkSource {
    return {
      // no store open (stopped, or not open yet) or another organization meanwhile: the queue was not read, and
      // the counts in the snapshot are not its figures; the swap takes an unread queue for one that holds work
      read: async () => {
        const { generation, stores } = this;
        if (!stores) {
          throw new Error("queue_unread");
        }
        await this.refreshCounts();
        if (generation !== this.generation || this.stores !== stores) {
          throw new Error("queue_unread");
        }
        return this.snapshot.counts;
      },
      sync: async () => {
        await this.trySend();
        if (syncFailed(this.snapshot)) {
          throw new Error("sync_failed");
        }
        // the queue was not sent: an update must not take it for done
        if (this.snapshot.legalAcceptanceRequired) {
          throw new Error("legal_acceptance_required");
        }
      },
    };
  }

  /**
   * The real try of "Sair" (and of the `sync` of the work source): it sends whatever the connection state says, and only
   * then a send that got no answer counts as offline (ADR 0039). Rejects with `offline` in that case.
   *
   * It sends the queue and nothing else: the pull does not protect work, and it goes through the tab's read gate
   * (the line, the pause of a 429, up to 60 s). A run in flight stops at its pull (its push is already out, or
   * done before it gets there) and this one pushes alone, with the same command ids and no gate.
   */
  private async trySend(): Promise<void> {
    if (!this.mayTry()) {
      throw new Error("offline");
    }
    while (this.inFlight) {
      this.pullCutRequested = true;
      this.pullAbort?.abort(PULL_CUT);
      // biome-ignore lint/performance/noAwaitInLoops: one run at a time, each one cut at its pull
      await this.inFlight.catch(() => undefined);
    }
    await this.syncNow({ pull: false });
    if (this.lastOutcome === "no_answer") {
      throw new Error("offline");
    }
  }

  private mayTry(): boolean {
    return (this.dependencies.mayTry ?? this.dependencies.isOnline)();
  }

  /** The connection state changed: the screens are told at once (the sync, if any, follows from the host). */
  connectionChanged(): void {
    const online = this.dependencies.isOnline();
    if (online !== this.snapshot.online) {
      this.set({ ...this.snapshot, online });
    }
  }

  /**
   * The server said, outside of a sync (the answer to a revocation), that this
   * session is over: the same as a refusal found while sending. The lease and
   * the local collections go now, not at the next send; the queue stays. Nothing
   * to do when the stores are already closed (a refusal got there first).
   */
  async dropSessionCopy(): Promise<void> {
    // a send in flight finishes first (it ends in the same refusal), never under the stores being closed
    await this.inFlight?.catch(() => undefined);
    const { namespace, stores, userId } = this;
    if (!(namespace && stores && userId)) {
      return;
    }
    this.dependencies.keyValues.remove(SESSION_USER_KEY);
    await this.dropLocalCopy(
      { generation: this.generation, namespace, stores, userId },
      { forgetDevice: false }
    );
  }

  /**
   * A screen's own call was refused because the organization was closed: the same drop as a refused session (the
   * collections and the lease go, the queue stays), but the remembered user stays, since the session is fine. The
   * store is remembered as closed for the life of this runtime: a start that comes after the refusal (the screen's read
   * may answer first) drops the copy instead of opening it.
   */
  async dropClosedCopy(organizationId: string): Promise<void> {
    this.closedOrganizations.add(organizationId);
    await this.startRun?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
    if (
      this.organizationId !== organizationId ||
      this.snapshot.organizationClosed
    ) {
      return;
    }
    const { namespace, stores, userId } = this;
    if (namespace && stores && userId) {
      await this.dropLocalCopy(
        { generation: this.generation, namespace, stores, userId },
        { forgetDevice: false, organizationClosed: true }
      );
      return;
    }
    await this.closeStores();
    await this.dropClosedAtStart(organizationId, this.generation);
  }

  /** This organization's part of a logout (ADR 0039). */
  logoutWorkspace(): LogoutWorkspace | null {
    const { namespace, organizationId, stores } = this;
    if (!(namespace && organizationId && stores)) {
      return null;
    }
    return {
      label: organizationId,
      outbox: stores.outbox,
      purge: async (options) => {
        await this.closeStores();
        await this.dependencies.purge(namespace, options);
        this.forgetNamespace(namespace);
        // the device id stays until the logout revoked it (or gave up): `forgetDevice`, the last step
        this.forgetSessionCopy();
        this.set({ ...this.snapshot, counts: EMPTY_COUNTS, phase: "off" });
      },
      trySync: () => this.trySend(),
    };
  }

  /**
   * Every namespace this browser holds for the signed-in user, not only the open
   * organization: logging out of a shared browser must not leave another
   * organization's data behind. The ones that are not open are opened just to be
   * inspected; they cannot be sent from here (that needs that organization's
   * session context), so a queued command in one blocks the logout until the
   * person switches to it. Each workspace releases what it opened.
   */
  async logoutWorkspaces(): Promise<LogoutWorkspace[]> {
    const current = this.logoutWorkspace();
    if (!current) {
      return await this.closedLogoutWorkspaces();
    }
    const others: LogoutWorkspace[] = [];
    for (const item of this.namespaces()) {
      if (this.namespace && item.userId !== this.namespace.userId) {
        // somebody else's data on this browser is not this person's to inspect, send or discard
        continue;
      }
      if (
        this.namespace &&
        item.organizationId === this.namespace.organizationId
      ) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each namespace is opened and inspected in turn
      const workspace = await this.inspectedWorkspace(item, {
        stoppedRuntime: false,
      });
      others.push(workspace);
    }
    return [current, ...others];
  }

  /**
   * "Sair" with no store open (the runtime is unavailable, refused or stopped):
   * the person's local copy is still on the disk and must go with the session.
   * Every namespace of the signed-in user is opened just to be inspected and
   * purged like the others; whose they are comes from the server's answer, never from
   * what the runtime last held or remembered.
   * With work still queued the logout is blocked as always, but the collections
   * (patient-level data) and the lease go anyway, the same rule as a revocation:
   * the queue stays until the person sends or discards it (ADR 0038).
   */
  private async closedLogoutWorkspaces(): Promise<LogoutWorkspace[]> {
    if (this.snapshot.phase === "starting") {
      return []; // the start is still opening stores: not a moment to open them again
    }
    const userId = await this.signedInUserForLogout();
    if (!userId) {
      return [];
    }
    const workspaces: LogoutWorkspace[] = [];
    for (const item of this.namespaces()) {
      if (item.userId === userId) {
        // biome-ignore lint/performance/noAwaitInLoops: each namespace is opened and inspected in turn
        const workspace = await this.inspectedWorkspace(item, {
          stoppedRuntime: true,
        });
        workspaces.push(workspace);
      }
    }
    return workspaces;
  }

  /**
   * Who is leaving when the runtime holds nothing: only the server's own answer
   * names them. A remembered user can be stale (another person signed in since),
   * and ending a session needs the server anyway, so with no answer nobody is named.
   */
  private async signedInUserForLogout(): Promise<string | null> {
    if (!this.dependencies.isOnline()) {
      return null;
    }
    try {
      return await this.dependencies.api.sessionUserId();
    } catch {
      return null;
    }
  }

  /**
   * A namespace that is not the open one, opened only to look at its queue. It
   * cannot be sent from here (that needs that organization's session context),
   * so queued work blocks the logout until the person switches to it.
   */
  private async inspectedWorkspace(
    item: { organizationId: string; userId: string },
    options: { stoppedRuntime: boolean }
  ): Promise<LogoutWorkspace> {
    const { keyValues } = this.dependencies;
    const known = keyValues.read(DEVICE_KEY) ?? this.deviceId;
    const namespace = await this.dependencies.namespaceFor(
      item.userId,
      item.organizationId
    );
    const stores = await this.dependencies.openStores(
      namespace,
      known ?? "00000000-0000-7000-8000-000000000000"
    );
    let closed = false;
    const release = async () => {
      if (!closed) {
        closed = true;
        await stores.close();
      }
    };
    const forgetLease = () =>
      keyValues.remove(leaseKey(item.userId, item.organizationId));
    return {
      label: options.stoppedRuntime
        ? item.organizationId
        : `${item.organizationId} (outra loja)`,
      outbox: stores.outbox,
      purge: async (purgeOptions) => {
        await release();
        await this.dependencies.purge(namespace, purgeOptions);
        this.forgetNamespace(namespace);
        forgetLease();
        if (options.stoppedRuntime) {
          // no open organization is left to forget the remembered user; the device goes at the end of the logout
          keyValues.remove(SESSION_USER_KEY);
        }
      },
      release,
      ...(options.stoppedRuntime
        ? {
            scrub: async () => {
              await release();
              await this.dependencies.wipeCollections(namespace);
              forgetLease();
            },
          }
        : {}),
      trySync: () => Promise.reject(new Error("switch_organization")),
    };
  }

  // ------------------------------------------------------------ lifecycle
  async start(organizationId: string): Promise<void> {
    const run = this.startNow(organizationId);
    this.startRun = run;
    try {
      await run;
    } finally {
      if (this.startRun === run) {
        this.startRun = null;
      }
    }
  }

  private async startNow(organizationId: string): Promise<void> {
    if (
      this.organizationId === organizationId &&
      (this.snapshot.phase === "starting" ||
        this.snapshot.phase === "ready" ||
        this.snapshot.phase === "expired")
    ) {
      return;
    }
    await this.stop();
    const { generation } = this;
    this.organizationId = organizationId;
    this.set({ ...this.snapshot, phase: "starting", reason: null });
    if (this.closedOrganizations.has(organizationId)) {
      await this.dropClosedBeforeBoot(organizationId, generation);
      return;
    }
    try {
      await this.boot(organizationId, generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.closeStores();
        if (isClosedRefusal(error)) {
          this.closedOrganizations.add(organizationId);
          await this.dropClosedAtStart(organizationId, generation);
          return;
        }
        // without the legal acceptance nothing is forgotten: the device, the lease and the namespace stay
        const legal = isLegalAcceptanceRefusal(error);
        const failure = error instanceof Error ? error.message : "start_failed";
        this.set({
          ...this.snapshot,
          legalAcceptanceRequired: legal,
          phase: "unavailable",
          reason: legal ? "legal_acceptance_required" : failure,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const { generation } = this;
    await this.closeStores();
    if (generation !== this.generation) {
      // a later stop or start took over while the stores were closing: it owns
      // the state now, and resetting it here would undo the organization it opened
      return;
    }
    this.organizationId = null;
    this.userId = null;
    this.lease = null;
    this.set({
      ...this.snapshot,
      counts: EMPTY_COUNTS,
      expiredWhileOpen: false,
      lastSyncAt: null,
      leaseExpiresAt: null,
      legalAcceptanceRequired: false,
      organizationClosed: false,
      phase: "off",
      reason: null,
      renewalRefused: false,
      sessionRefused: false,
      syncing: false,
    });
  }

  /** Sends what is queued and catches the local collections up. Single-flight. */
  syncNow(options: { pull?: boolean } = {}): Promise<void> {
    const pull = options.pull !== false;
    if (this.inFlight) {
      // a run that only pushed is no sync for whoever asked for the pull: another one follows it
      return pull && !this.inFlightPulls
        ? this.inFlight.then(() => this.syncNow())
        : this.inFlight;
    }
    const run = this.runExclusive(pull).finally(() => {
      this.inFlight = null;
      this.pullCutRequested = false;
    });
    this.inFlight = run;
    this.inFlightPulls = pull;
    return run;
  }

  /**
   * Whether the open copy was pulled less than `maxAgeMs` ago (by this tab or another: the collections and
   * their cursor are shared) and nothing waits to be sent. The scheduler skips the sync of a page load or
   * of a return to the page then; anything off the plain ready state is not fresh.
   */
  async isFresh(maxAgeMs: number): Promise<boolean> {
    const { stores } = this;
    if (
      !stores ||
      this.snapshot.phase !== "ready" ||
      this.snapshot.reason !== null ||
      this.openLeaseEnded()
    ) {
      return false;
    }
    const meta = await stores.writer.readMeta();
    if (!(meta && isLocalStoreReady(meta))) {
      return false;
    }
    const age = this.now().getTime() - Date.parse(meta.updatedAt);
    if (!(age >= 0 && age < maxAgeMs)) {
      return false;
    }
    const queue = await stores.outbox.snapshot();
    return queue.pending + queue.sending === 0;
  }

  /** Tells the screens that read the local collections to read them again (call after writing to them). */
  localDataChanged(): void {
    this.set({ ...this.snapshot, dataVersion: this.snapshot.dataVersion + 1 });
    this.channel?.post();
  }

  /** Re-reads the queue figures (call after queueing or resolving a command). */
  async refreshCounts(): Promise<void> {
    const { generation, stores } = this;
    if (!stores) {
      return;
    }
    const queue = await stores.outbox.snapshot();
    if (generation !== this.generation) {
      // the organization changed while the queue was being read
      return;
    }
    this.set({
      ...this.snapshot,
      counts: {
        pending: queue.pending,
        rejected: queue.rejected,
        sending: queue.sending,
      },
    });
  }

  // ------------------------------------------------------------- internals
  /** One sync per namespace across the tabs: another tab sending the same queue now makes this one wait for the next. */
  private async runExclusive(pull: boolean): Promise<void> {
    const { exclusive } = this.dependencies;
    if (!exclusive) {
      await this.runSync(pull);
      return;
    }
    const name = `polaris-sync:${this.namespace?.coordinatorName ?? "none"}`;
    const ran = await exclusive(name, () => this.runSync(pull));
    if (!ran) {
      this.lastOutcome = "not_run";
    }
  }

  private mark(name: string) {
    this.dependencies.mark?.(name);
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private set(next: RuntimeSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * The device of this installation, as the runtime holds it or this browser remembers it; null when it has none.
   * "Sair" reads it before anything else, to revoke it on the server once the queue is safe.
   */
  currentDeviceId(): string | null {
    return this.deviceId ?? this.dependencies.keyValues.read(DEVICE_KEY);
  }

  /**
   * The last step of a logout: forgets the device id, the lease left and the remembered user. After it the next
   * sign-in registers a device (the old one was revoked, or stays on the list when the revocation could not happen).
   */
  forgetDevice() {
    this.dependencies.keyValues.remove(DEVICE_KEY);
    this.forgetSessionCopy();
    this.deviceId = null;
  }

  /** What the session gave this browser: the lease and the remembered user, never the device id. */
  private forgetSessionCopy() {
    this.dependencies.keyValues.remove(SESSION_USER_KEY);
    this.forgetLease();
    this.lease = null;
  }

  /** Leases of the old layout (one per organization, no user) are never read again: sweep them all, whatever the organization. */
  private sweepLegacyLeases() {
    const { keyValues } = this.dependencies;
    for (const key of keyValues.keys?.() ?? []) {
      if (isLegacyLeaseKey(key)) {
        keyValues.remove(key);
      }
    }
  }

  private forgetLease() {
    if (this.userId && this.organizationId) {
      this.dependencies.keyValues.remove(
        leaseKey(this.userId, this.organizationId)
      );
    }
  }

  /** Another tab changed the shared rows: read them (and the queue) again. */
  private onRemoteChange() {
    this.set({ ...this.snapshot, dataVersion: this.snapshot.dataVersion + 1 });
    this.refreshCounts().catch(() => undefined);
  }

  private closeChannel() {
    this.stopListening?.();
    this.stopListening = null;
    this.channel?.close();
    this.channel = null;
  }

  private async closeStores() {
    const { stores } = this;
    this.clearExpiryTimer();
    this.closeChannel();
    this.stores = null;
    this.namespace = null;
    await stores?.close();
  }

  private cachedLease(
    userId: string,
    organizationId: string
  ): CachedLease | null {
    const raw = this.dependencies.keyValues.read(
      leaseKey(userId, organizationId)
    );
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachedLease>;
      return typeof parsed.lease === "string" &&
        typeof parsed.expiresAt === "string"
        ? { expiresAt: parsed.expiresAt, lease: parsed.lease }
        : null;
    } catch {
      return null;
    }
  }

  private leaseIsUsable(
    token: string,
    userId: string,
    organizationId: string,
    deviceId: string
  ): boolean {
    return (
      leaseStanding(
        readUnverifiedOfflineLease(token),
        { deviceId, organizationId, userId },
        this.now().getTime()
      ) === "usable"
    );
  }

  /** The cached lease is this person's own for this device and organization, and only its `exp` passed. */
  private leaseExpired(
    cached: CachedLease | null,
    userId: string,
    organizationId: string,
    deviceId: string
  ): boolean {
    return (
      cached !== null &&
      leaseStanding(
        readUnverifiedOfflineLease(cached.lease),
        { deviceId, organizationId, userId },
        this.now().getTime()
      ) === "expired"
    );
  }

  private async ensureDevice(userId: string): Promise<string> {
    const { keyValues } = this.dependencies;
    const known = keyValues.read(DEVICE_KEY);
    if (known && (await this.stillMine(known, userId))) {
      return known;
    }
    if (known) {
      // Somebody else's device (or a revoked one): never reuse it or its lease.
      keyValues.remove(DEVICE_KEY);
      this.forgetLease();
    }
    if (!this.dependencies.isOnline()) {
      throw new Error("no_device_offline");
    }
    const id = await this.dependencies.api.registerDevice(
      clampLabel(this.dependencies.deviceLabel)
    );
    keyValues.write(DEVICE_KEY, id);
    return id;
  }

  /**
   * Online, asks the server whether the remembered device is this user's; offline,
   * trusts it (the session user is the one the server last confirmed). When the
   * server cannot be asked, a hiccup does not discard the device of a user who
   * already holds a lease for it, but it never lends it to a user who does not.
   */
  private async stillMine(deviceId: string, userId: string): Promise<boolean> {
    if (!this.dependencies.isOnline()) {
      return true;
    }
    try {
      return await this.dependencies.api.deviceIsMine(deviceId);
    } catch (error) {
      // the server answered, and the device is fine: it only waits for the acceptance, never forget it
      if (isLegalAcceptanceRefusal(error)) {
        throw error;
      }
      return this.leaseProvesDevice(deviceId, userId);
    }
  }

  /** Whether this user's own cached lease names the device, i.e. the server once issued it to them for it. */
  private leaseProvesDevice(deviceId: string, userId: string): boolean {
    if (!this.organizationId) {
      return false;
    }
    const cached = this.cachedLease(userId, this.organizationId);
    const claims = cached ? readUnverifiedOfflineLease(cached.lease) : null;
    return claims?.sub === userId && claims.dev === deviceId;
  }

  /**
   * Who is signed in: the server's answer while online (remembered for the next
   * offline start), the last remembered one otherwise or when the server cannot
   * be asked. A session that is over, or never was known, has no one to open.
   */
  private async sessionUser(): Promise<{ confirmed: boolean; userId: string }> {
    const { api, isOnline, keyValues } = this.dependencies;
    let userId: string | null | undefined;
    if (isOnline()) {
      try {
        userId = await api.sessionUserId();
      } catch (error) {
        if (!(error instanceof SessionUnreachableError)) {
          throw error; // the server answered, and not with a session: never guess who it is
        }
        userId = undefined; // no connection after all: the remembered one stands in, as offline
      }
    }
    if (userId === null) {
      keyValues.remove(SESSION_USER_KEY);
      throw new Error("no_session");
    }
    if (userId !== undefined) {
      keyValues.write(SESSION_USER_KEY, userId);
      return { confirmed: true, userId };
    }
    const remembered = keyValues.read(SESSION_USER_KEY);
    if (!remembered) {
      throw new Error("no_session_offline");
    }
    return { confirmed: false, userId: remembered };
  }

  private namespaces(): { organizationId: string; userId: string }[] {
    try {
      const parsed: unknown = JSON.parse(
        this.dependencies.keyValues.read(NAMESPACES_KEY) ?? "[]"
      );
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is { organizationId: string; userId: string } =>
              typeof item?.organizationId === "string" &&
              typeof item?.userId === "string"
          )
        : [];
    } catch {
      return [];
    }
  }

  private writeNamespaces(list: { organizationId: string; userId: string }[]) {
    if (list.length === 0) {
      this.dependencies.keyValues.remove(NAMESPACES_KEY);
      return;
    }
    this.dependencies.keyValues.write(NAMESPACES_KEY, JSON.stringify(list));
  }

  private rememberNamespace(namespace: LocalNamespace) {
    const list = this.namespaces();
    if (
      !list.some(
        (item) =>
          item.userId === namespace.userId &&
          item.organizationId === namespace.organizationId
      )
    ) {
      this.writeNamespaces([
        ...list,
        { organizationId: namespace.organizationId, userId: namespace.userId },
      ]);
    }
  }

  private forgetNamespace(namespace: LocalNamespace) {
    this.writeNamespaces(
      this.namespaces().filter(
        (item) =>
          !(
            item.userId === namespace.userId &&
            item.organizationId === namespace.organizationId
          )
      )
    );
  }

  /** The lease to work under: the cached one while it lasts, a fresh one when due. */
  private async ensureLease(
    userId: string,
    organizationId: string,
    deviceId: string
  ): Promise<string> {
    if (this.closedOrganizations.has(organizationId)) {
      throw new KnownClosedError();
    }
    const cached = this.cachedLease(userId, organizationId);
    const usable =
      cached &&
      this.leaseIsUsable(cached.lease, userId, organizationId, deviceId)
        ? cached
        : null;
    const due =
      !usable ||
      new Date(usable.expiresAt).getTime() - this.now().getTime() <
        RENEW_BEFORE_MS;
    const expired =
      !usable && this.leaseExpired(cached, userId, organizationId, deviceId);
    if (due && this.dependencies.isOnline()) {
      const owner = { deviceId, organizationId, userId };
      return await this.issueLease(owner, { expired, usable });
    }
    if (usable) {
      return usable.lease;
    }
    if (expired) {
      throw new OfflineAccessExpiredError();
    }
    throw new Error("no_lease_offline");
  }

  /** Asks the server for a lease; a cached one that still works stands in when that fails. */
  private async issueLease(
    owner: { deviceId: string; organizationId: string; userId: string },
    cached: { expired: boolean; usable: CachedLease | null }
  ): Promise<string> {
    const { deviceId, organizationId, userId } = owner;
    const { usable } = cached;
    let issued: CachedLease;
    try {
      issued = await this.dependencies.api.issueLease(deviceId, organizationId);
    } catch (error) {
      if (isClosedRefusal(error)) {
        throw error; // the lease left is no use for a closed store: the copy and the lease go
      }
      if (usable) {
        return usable.lease; // renewing failed but the cached lease still works: keep going on it
      }
      if (cached.expired && !isDefiniteRpcRejection(error)) {
        // no answer (no connection after all, 5xx, 429): the same as offline, never a refusal
        throw new OfflineAccessExpiredError("offline_access_expired", {
          cause: error,
        });
      }
      throw error;
    }
    // a lease for somebody else is never kept, whatever the server said
    if (!this.leaseIsUsable(issued.lease, userId, organizationId, deviceId)) {
      if (usable) {
        return usable.lease;
      }
      throw new Error("lease_wrong_user");
    }
    this.dependencies.keyValues.write(
      leaseKey(userId, organizationId),
      JSON.stringify(issued)
    );
    return issued.lease;
  }

  private async boot(organizationId: string, generation: number) {
    const { confirmed, userId } = await this.sessionUser();
    if (generation !== this.generation) {
      return;
    }
    this.userId = userId;
    // only the server's own answer opens the window; a remembered user does not
    this.sessionConfirmedAt = confirmed ? this.now().getTime() : null;
    this.sweepLegacyLeases();
    const deviceId = await this.ensureDevice(userId);
    try {
      const lease = await this.ensureLease(userId, organizationId, deviceId);
      await this.open(userId, organizationId, deviceId, lease, generation);
    } catch (error) {
      if (error instanceof OfflineAccessExpiredError) {
        // the device and the lease are this person's: only time ran out, so nothing is forgotten
        await this.openExpired(userId, organizationId, deviceId, generation);
        return;
      }
      if (
        !this.dependencies.isOnline() ||
        // no answer is not a refusal: the remembered device is not somebody else's for that
        isConnectionFailure(error) ||
        (error instanceof Error && error.message === "no_lease_offline") ||
        isPlanRefusal(error) ||
        // the device is not somebody else's: the server only waits for the acceptance, or the store was closed
        isLegalAcceptanceRefusal(error) ||
        isClosedRefusal(error)
      ) {
        throw error;
      }
      // The remembered device may belong to another user of this browser:
      // forget it and register again, once.
      this.dependencies.keyValues.remove(DEVICE_KEY);
      const fresh = await this.ensureDevice(userId);
      const lease = await this.ensureLease(userId, organizationId, fresh);
      await this.open(userId, organizationId, fresh, lease, generation);
    }
  }

  private async open(
    userId: string,
    organizationId: string,
    deviceId: string,
    lease: string,
    generation: number
  ) {
    const claims = readUnverifiedOfflineLease(lease);
    if (!claims) {
      throw new Error("lease_unreadable");
    }
    if (claims.sub !== userId) {
      // the namespace is the session user's, never the one a lease happens to name
      throw new Error("lease_wrong_user");
    }
    const namespace = await this.dependencies.namespaceFor(
      userId,
      organizationId
    );
    const stores = await this.dependencies.openStores(namespace, deviceId);
    this.rememberNamespace(namespace);
    if (generation !== this.generation) {
      await stores.close();
      return;
    }
    this.stores = stores;
    this.namespace = namespace;
    this.closeChannel();
    this.channel =
      this.dependencies.openDataChannel?.(
        `${namespace.coordinatorName}:changed`
      ) ?? null;
    this.stopListening =
      this.channel?.subscribe(() => this.onRemoteChange()) ?? null;
    this.deviceId = deviceId;
    this.lease = lease;
    await stores.outbox.recoverInterrupted();
    await restorePendingCustomers(stores.outbox, stores.writer);
    await restorePendingProducts(stores.outbox, stores.writer);
    const meta = await stores.writer.readMeta();
    let bootstrapped = isLocalStoreReady(meta);
    if (!bootstrapped && this.dependencies.isOnline()) {
      await bootstrapLocalStore(
        this.dependencies.api.source(organizationId),
        stores.writer
      );
      bootstrapped = true;
    }
    this.set({
      ...this.snapshot,
      bootstrapped,
      dataVersion: this.snapshot.dataVersion + 1,
      expiredWhileOpen: false,
      leaseExpiresAt: new Date(claims.exp * 1000).toISOString(),
      online: this.dependencies.isOnline(),
      phase: "ready",
      reason: null,
      renewalRefused: false,
    });
    this.scheduleExpiry(claims.exp * 1000, generation);
    await this.refreshCounts();
  }

  /**
   * The offline access expired at start: the stores of this person's namespace
   * are opened only so the queue can be counted (and sent once renewed). The
   * local collections are not offered to any screen, the lease is not used, and
   * nothing is deleted.
   */
  private async openExpired(
    userId: string,
    organizationId: string,
    deviceId: string,
    generation: number
  ) {
    const cached = this.cachedLease(userId, organizationId);
    const claims = cached ? readUnverifiedOfflineLease(cached.lease) : null;
    const namespace = await this.dependencies.namespaceFor(
      userId,
      organizationId
    );
    const stores = await this.dependencies.openStores(namespace, deviceId);
    if (generation !== this.generation) {
      await stores.close();
      return;
    }
    this.stores = stores;
    this.namespace = namespace;
    this.deviceId = deviceId;
    this.lease = null;
    await stores.outbox.recoverInterrupted(); // a send cut short counts as waiting, as at any start
    this.set({
      ...this.snapshot,
      bootstrapped: false,
      dataVersion: this.snapshot.dataVersion + 1,
      leaseExpiresAt: claims ? new Date(claims.exp * 1000).toISOString() : null,
      online: this.dependencies.isOnline(),
      phase: "expired",
      reason: "offline_access_expired",
      renewalRefused: false,
      syncing: false,
    });
    await this.refreshCounts();
  }

  /** A timer at the lease's `exp`: with the app open, the access ends on time, not at the next sync. */
  private scheduleExpiry(expiresAtMs: number, generation: number) {
    if (generation !== this.generation) {
      return; // set for an organization that is no longer the open one
    }
    this.clearExpiryTimer();
    const schedule = this.dependencies.schedule ?? timerSchedule;
    this.cancelExpiryTimer = schedule(
      () => {
        this.cancelExpiryTimer = null;
        if (generation !== this.generation) {
          return;
        }
        if (expiresAtMs > this.now().getTime()) {
          this.scheduleExpiry(expiresAtMs, generation); // the end is past what one timer holds: wait again
          return;
        }
        if (!this.openLeaseEnded()) {
          return; // the lease it was set for was replaced (a newer timer follows the new one)
        }
        this.expireNow();
        if (this.dependencies.isOnline()) {
          this.syncNow().catch(() => undefined);
        }
      },
      leaseTimerDelay(expiresAtMs, this.now().getTime())
    );
  }

  private clearExpiryTimer() {
    this.cancelExpiryTimer?.();
    this.cancelExpiryTimer = null;
  }

  /**
   * The lease of the open namespace reached its `exp`: no screen reads the copy
   * and nothing new is queued from now on. The queue stays as it is. With a
   * network the next sync renews it (one try per sync, never a loop).
   */
  private expireNow() {
    if (this.snapshot.phase !== "ready") {
      return;
    }
    this.lease = null;
    this.clearExpiryTimer();
    this.set({
      ...this.snapshot,
      dataVersion: this.snapshot.dataVersion + 1,
      expiredWhileOpen: true,
      phase: "expired",
      reason: "offline_access_expired",
      syncing: false,
    });
  }

  /** Whether the lease the open namespace works under has reached its `exp`. */
  private openLeaseEnded(): boolean {
    const { deviceId, lease, organizationId, userId } = this;
    return (
      lease !== null &&
      deviceId !== null &&
      organizationId !== null &&
      userId !== null &&
      !this.leaseIsUsable(lease, userId, organizationId, deviceId)
    );
  }

  /**
   * Expired, with a network: one try to renew the lease. A new lease reopens the
   * namespace as at start (the screens come back without a reload); no answer
   * keeps the expired state until the next sync; a refused session goes as
   * always (the collections are deleted, the queue stays).
   */
  private async renewExpired(run: RunScope): Promise<boolean> {
    const { deviceId, organizationId } = this;
    if (!(deviceId && organizationId)) {
      return false;
    }
    this.set({
      ...this.snapshot,
      online: this.dependencies.isOnline(),
      syncing: true,
    });
    let lease: string;
    try {
      lease = await this.ensureLease(run.userId, organizationId, deviceId);
    } catch (error) {
      if (isLegalAcceptanceRefusal(error)) {
        // not a refused session, and not a refusal for good: the acceptance renews it at the next sync
        if (run.generation === this.generation) {
          this.set({
            ...this.snapshot,
            legalAcceptanceRequired: true,
            syncing: false,
          });
        }
      } else if (isClosedRefusal(error)) {
        // before the session refusal (it is a FORBIDDEN too): the session is fine, the store is not
        await this.dropLocalCopy(run, {
          forgetDevice: false,
          organizationClosed: true,
        });
      } else if (isSessionRefusal(error)) {
        this.dependencies.keyValues.remove(SESSION_USER_KEY);
        await this.dropLocalCopy(run, { forgetDevice: false });
      } else if (run.generation === this.generation) {
        // no answer is the same as offline; any other answer is a refusal that waiting does not fix
        this.set({
          ...this.snapshot,
          renewalRefused: !(
            error instanceof OfflineAccessExpiredError ||
            (error instanceof Error && error.message === "no_lease_offline")
          ),
          syncing: false,
        });
      }
      return false;
    }
    if (run.generation !== this.generation) {
      return false;
    }
    await this.closeStores();
    try {
      await this.open(
        run.userId,
        organizationId,
        deviceId,
        lease,
        run.generation
      );
    } catch {
      // the lease is renewed but the stores did not open again: back to the queue alone, so the next sync tries again
      if (run.generation === this.generation) {
        await this.reopenExpired(run.userId, organizationId, deviceId);
      }
      return false;
    }
    return this.snapshot.phase === "ready";
  }

  /** After a failed reopening: the expired state again, or unavailable when not even the queue opens. */
  private async reopenExpired(
    userId: string,
    organizationId: string,
    deviceId: string
  ) {
    const { generation } = this;
    await this.closeStores(); // a failed open may have kept its stores and channel
    try {
      await this.openExpired(userId, organizationId, deviceId, generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.closeStores();
        this.set({
          ...this.snapshot,
          phase: "unavailable",
          reason: error instanceof Error ? error.message : "start_failed",
          syncing: false,
        });
      }
      return;
    }
    if (generation === this.generation) {
      this.set({ ...this.snapshot, syncing: false });
    }
  }

  /**
   * The server withdrew this user's access (the session ended, the membership or
   * the device was revoked). Nothing of this user is read again: the lease is
   * forgotten at once, not left to work until it expires, and the local
   * collections are deleted. What was still queued is work no one else can redo,
   * so it stays in its own namespace (the next session of this user sends it, or
   * asks what to do with what the server refused); with nothing queued the whole
   * namespace goes. Only this user's namespace is ever touched.
   */
  private async dropLocalCopy(
    run: RunScope,
    options: { forgetDevice: boolean; organizationClosed?: boolean }
  ) {
    if (run.generation !== this.generation) {
      return; // another organization or user took over while the answer was on its way
    }
    const closed = options.organizationClosed === true;
    if (!closed) {
      await this.dropCopyNow(run, options.forgetDevice, false);
      return;
    }
    // a sync that met the refusal while another drop was on its way waits for that one
    if (this.closedDrop) {
      await this.closedDrop;
      return;
    }
    if (this.snapshot.organizationClosed) {
      return;
    }
    if (this.organizationId) {
      this.closedOrganizations.add(this.organizationId);
    }
    const drop = this.dropCopyNow(run, options.forgetDevice, true);
    this.closedDrop = drop;
    try {
      await drop;
    } finally {
      this.closedDrop = null;
    }
  }

  private async dropCopyNow(
    run: RunScope,
    forgetDevice: boolean,
    closed: boolean
  ) {
    const { generation, namespace, stores } = run;
    const queued = (await stores.outbox.snapshot()).commands.length > 0;
    await this.closeStores();
    this.forgetLease();
    this.lease = null;
    if (forgetDevice) {
      this.dependencies.keyValues.remove(DEVICE_KEY);
      this.deviceId = null;
    }
    let reason = closed ? "organization_closed" : "session_refused";
    try {
      if (queued) {
        await this.dependencies.wipeCollections(namespace);
      } else {
        await this.dependencies.purge(namespace, { discardPending: false });
        this.forgetNamespace(namespace);
      }
    } catch {
      reason = "purge_failed";
    }
    if (generation !== this.generation) {
      return;
    }
    this.set({
      ...this.snapshot,
      bootstrapped: false,
      counts: EMPTY_COUNTS,
      dataVersion: this.snapshot.dataVersion + 1,
      leaseExpiresAt: null,
      organizationClosed: closed,
      phase: "unavailable",
      reason,
      sessionRefused: !closed,
      syncing: false,
    });
  }

  /** A store already known as closed: only who is signed in is asked, to find the copy to drop. */
  private async dropClosedBeforeBoot(
    organizationId: string,
    generation: number
  ) {
    try {
      const { userId } = await this.sessionUser();
      if (generation === this.generation) {
        this.userId = userId;
      }
    } catch {
      // without knowing who is signed in nothing is opened; the next opening drops the copy
    }
    await this.dropClosedAtStart(organizationId, generation);
  }

  /**
   * The lease was refused at start because the organization was closed: no store is open, so the collections of its
   * namespace are wiped from the disk (the queue stays) and its lease is forgotten. The device and the remembered user
   * stay: the person may own another store, or reopen this one.
   */
  private async dropClosedAtStart(organizationId: string, generation: number) {
    const { userId } = this;
    let reason = "organization_closed";
    if (userId) {
      this.dependencies.keyValues.remove(leaseKey(userId, organizationId));
      try {
        await this.dependencies.wipeCollections(
          await this.dependencies.namespaceFor(userId, organizationId)
        );
      } catch {
        reason = "purge_failed";
      }
    }
    this.lease = null;
    if (generation !== this.generation) {
      return;
    }
    this.set({
      ...this.snapshot,
      bootstrapped: false,
      counts: EMPTY_COUNTS,
      dataVersion: this.snapshot.dataVersion + 1,
      leaseExpiresAt: null,
      organizationClosed: true,
      phase: "unavailable",
      reason,
      sessionRefused: false,
      syncing: false,
    });
  }

  /**
   * Whether the session still belongs to the user whose namespace is open. A
   * session that changed hands (another person signed in, in this tab or another)
   * must not keep queueing into the first person's namespace. Nothing is deleted:
   * that data is still its owner's, and only the owner can open it again.
   */
  /**
   * The lease a sync got (cached or renewed) becomes the one the open namespace
   * works under. False when the sync must stop: another organization opened
   * meanwhile (the lease is not this one's), or renewing failed and the old lease
   * ran out on the way (expired, never back to ready on it). The timer follows a
   * new lease, and a timer that fired while the renewal was on its way is undone.
   */
  private adoptLease(run: RunScope, lease: string): boolean {
    const { deviceId, organizationId } = this;
    if (run.generation !== this.generation || !(deviceId && organizationId)) {
      return false;
    }
    if (!this.leaseIsUsable(lease, run.userId, organizationId, deviceId)) {
      this.expireNow();
      this.set({ ...this.snapshot, syncing: false });
      return false;
    }
    if (lease !== this.lease) {
      this.lease = lease;
      const claims = readUnverifiedOfflineLease(lease);
      if (claims) {
        this.set({
          ...this.snapshot,
          leaseExpiresAt: new Date(claims.exp * 1000).toISOString(),
        });
        this.scheduleExpiry(claims.exp * 1000, run.generation);
      }
    }
    if (this.snapshot.phase === "expired") {
      // the stores are still open (expiring closes nothing): the screens come back
      this.set({
        ...this.snapshot,
        dataVersion: this.snapshot.dataVersion + 1,
        expiredWhileOpen: false,
        phase: "ready",
        reason: null,
        renewalRefused: false,
      });
    }
    return true;
  }

  /** Expired: offline, nothing is tried (no loop); online, the session is looked at and one renewal is tried. */
  private async renewWhenExpired(): Promise<boolean> {
    const { namespace, stores, userId } = this;
    if (!(namespace && stores && userId)) {
      return false;
    }
    if (!this.mayTry()) {
      this.sessionConfirmedAt = null;
      this.lastOutcome = "no_answer";
      this.set({ ...this.snapshot, online: false });
      return false;
    }
    const run: RunScope = {
      generation: this.generation,
      namespace,
      stores,
      userId,
    };
    this.set({
      ...this.snapshot,
      online: this.dependencies.isOnline(),
      syncing: true,
    });
    if (await this.sessionChangedHands(run)) {
      return false;
    }
    return await this.renewExpired(run);
  }

  private async sessionChangedHands(run: RunScope): Promise<boolean> {
    const queued = (await run.stores.outbox.snapshot()).commands.length > 0;
    const sinceConfirmed =
      this.sessionConfirmedAt === null
        ? Number.NaN
        : this.now().getTime() - this.sessionConfirmedAt;
    // never push the queue on a reused confirmation: a refusal of a command is recorded by the server for good
    if (!queued && sinceConfirmed >= 0 && sinceConfirmed < SESSION_RECHECK_MS) {
      return false; // (a clock that went back counts as no confirmation)
    }
    let current: string | null;
    try {
      current = await this.dependencies.api.sessionUserId();
    } catch {
      return false; // the server could not say: the push will be refused if it matters
    }
    if (current === run.userId) {
      this.sessionConfirmedAt = this.now().getTime();
      return false;
    }
    if (current === null) {
      this.dependencies.keyValues.remove(SESSION_USER_KEY);
    } else {
      this.dependencies.keyValues.write(SESSION_USER_KEY, current);
    }
    if (run.generation !== this.generation) {
      return true;
    }
    await this.closeStores();
    this.lease = null;
    this.set({
      ...this.snapshot,
      counts: EMPTY_COUNTS,
      leaseExpiresAt: null,
      phase: "unavailable",
      reason: "session_changed",
      sessionRefused: true,
      syncing: false,
    });
    return true;
  }

  private async runSync(pull: boolean): Promise<void> {
    this.lastOutcome = "not_run";
    this.mark("sync:start");
    try {
      await this.runSyncSteps(pull);
    } finally {
      this.pullAbort = null;
      this.mark("sync:done");
    }
  }

  private async runSyncSteps(pull: boolean): Promise<void> {
    if (this.snapshot.phase === "ready" && this.openLeaseEnded()) {
      this.expireNow(); // the timer has not fired yet (a tab in the background): the sync looks itself
    }
    if (this.snapshot.phase === "expired" && !(await this.renewWhenExpired())) {
      return;
    }
    const { stores, organizationId, deviceId, userId, namespace } = this;
    if (
      this.snapshot.phase !== "ready" ||
      !(stores && organizationId && deviceId && userId && namespace)
    ) {
      return;
    }
    const run: RunScope = {
      generation: this.generation,
      namespace,
      stores,
      userId,
    };
    if (!this.mayTry()) {
      this.sessionConfirmedAt = null; // whoever is signed in when the network returns is looked at again
      this.lastOutcome = "no_answer";
      this.set({ ...this.snapshot, online: false });
      return;
    }
    // a try with the connection not proven is a real try: the screens stay as they are until it answers
    const reasonBefore = this.snapshot.reason;
    this.set({
      ...this.snapshot,
      online: this.dependencies.isOnline(),
      reason: null,
      syncing: true,
    });
    this.mark("sync:phase:sessao");
    if (await this.sessionChangedHands(run)) {
      this.lastOutcome = "answered";
      this.failingSince = null;
      return;
    }
    let pullAbort: AbortController | null = null;
    let pulling = false;
    try {
      this.mark("sync:phase:lease");
      const lease = await this.ensureLease(userId, organizationId, deviceId);
      if (!this.adoptLease(run, lease)) {
        return;
      }
      pullAbort = new AbortController();
      this.pullAbort = pullAbort;
      if (this.isPullCutRequested()) {
        pullAbort.abort(PULL_CUT);
      }
      const source = this.dependencies.api.source(
        organizationId,
        pullAbort.signal
      );
      this.mark("sync:phase:push");
      // the catch-up comes below, once: the chip counts what is left as soon as the push answered
      const summary = await syncOutbox({
        outbox: stores.outbox,
        push: this.dependencies.api.push(organizationId),
      });
      if (
        summary.rejected > 0 &&
        summary.blockedBy?.rejection?.code === AUTHORIZATION_REVOKED
      ) {
        this.lastOutcome = "answered";
        await this.dropLocalCopy(run, { forgetDevice: true });
        return;
      }
      this.mark("sync:phase:contagens");
      await this.refreshCounts();
      if (!pull) {
        this.pushOnlyDone(summary.requests > 0, reasonBefore);
        return;
      }
      if (pullAbort.signal.aborted) {
        this.pullCut();
        return;
      }
      pulling = true;
      await this.catchUp({ source, stores, summary });
      this.lastOutcome = "answered";
      this.failingSince = null;
      this.set({
        ...this.snapshot,
        bootstrapped: true,
        dataVersion: this.snapshot.dataVersion + 1,
        lastSyncAt: this.now().toISOString(),
        legalAcceptanceRequired: false,
        online: this.dependencies.isOnline(),
        reason: null,
        sessionRefused: false,
        syncing: false,
      });
      this.channel?.post();
    } catch (error) {
      if (pulling && pullAbort && isPullCut(error, pullAbort.signal)) {
        // someone needs the queue out and cut the pull: the push answered, the next sync catches up
        this.pullCut();
        await this.refreshCounts();
        return;
      }
      await this.syncFailed(run, error);
      return;
    }
    await this.refreshCounts(); // what was queued while the pull ran
  }

  /** Read at the time of the question: `trySend` may ask while the run is awaiting something else. */
  private isPullCutRequested(): boolean {
    return this.pullCutRequested;
  }

  /** The pull (or the first bootstrap) after the push: accepted or dropped commands, then the others' changes. */
  private async catchUp(work: {
    source: BootstrapSource;
    stores: OpenedStores;
    summary: SyncOutboxSummary;
  }): Promise<void> {
    const { source, stores, summary } = work;
    const meta = await stores.writer.readMeta();
    if (isLocalStoreReady(meta) && meta?.cursor) {
      // accepted or dropped commands: the server's rows replace the optimistic ones; otherwise the others' changes
      const caughtUp = summary.accepted > 0 || summary.discarded > 0;
      this.mark(caughtUp ? "sync:phase:catchUp" : "sync:phase:pull");
      await pullLocalChanges(source, stores.writer, meta.cursor);
    } else {
      this.mark("sync:phase:pull");
      await bootstrapLocalStore(source, stores.writer);
    }
  }

  /**
   * The end of a run that only pushed. Only a push that reached the server says anything about the acceptance or
   * the failures; with the queue empty, what the screens showed before stays (the pull is not here to confirm it).
   */
  private pushOnlyDone(sent: boolean, reasonBefore: RuntimeSnapshot["reason"]) {
    this.lastOutcome = "answered";
    if (sent) {
      this.failingSince = null;
    }
    this.set({
      ...this.snapshot,
      legalAcceptanceRequired: sent
        ? false
        : this.snapshot.legalAcceptanceRequired,
      online: this.dependencies.isOnline(),
      reason: sent ? null : reasonBefore,
      sessionRefused: false,
      syncing: false,
    });
    this.channel?.post();
  }

  /** The run ended at its pull, cut on purpose (`trySend`): not a failure, and not a catch-up either. */
  private pullCut() {
    this.lastOutcome = "answered";
    this.set({
      ...this.snapshot,
      dataVersion: this.snapshot.dataVersion + 1,
      online: this.dependencies.isOnline(),
      reason: null,
      sessionRefused: false,
      syncing: false,
    });
    this.channel?.post();
  }

  /**
   * A transient failure of the server (the platform killed the Worker, a 503 "try again") within 60 s of the first
   * one in a row: the sync tries again soon (`retriesQuietly`) and says nothing yet. Any other failure ends the run.
   */
  private failsQuietly(error: unknown): boolean {
    if (!isTransientReadFailure(error)) {
      this.failingSince = null;
      return false;
    }
    const now = this.now().getTime();
    if (this.failingSince === null || now - this.failedAt > QUIET_FAILURE_MS) {
      this.failingSince = now;
    }
    this.failedAt = now;
    return now - this.failingSince < QUIET_FAILURE_MS;
  }

  /** The last sync failed in a transient way and says nothing yet: the scheduler tries again in 2, 4 and 8 s. */
  retriesQuietly(): boolean {
    // only after a try the server answered: with no answer (or no try at all) the return of the connection syncs
    return (
      this.failingSince !== null &&
      this.lastOutcome === "answered" &&
      this.snapshot.reason === null
    );
  }

  /** What a sync that threw leaves: paused for the acceptance, a refused session, no answer, or a failure. */
  private async syncFailed(run: RunScope, error: unknown): Promise<void> {
    // before the session refusal (it is a FORBIDDEN too): only the sync pauses. The batch went back to
    // waiting, nothing was rejected, and the collections, the lease and the device stay (ADR 0100)
    if (isLegalAcceptanceRefusal(error)) {
      this.lastOutcome = "answered";
      this.set({
        ...this.snapshot,
        dataVersion: this.snapshot.dataVersion + 1,
        legalAcceptanceRequired: true,
        reason: "legal_acceptance_required",
        sessionRefused: false,
        syncing: false,
      });
      this.channel?.post();
      await this.refreshCounts();
      return;
    }
    // before the session refusal too: the store was closed, the session is fine and the queue stays
    if (isClosedRefusal(error)) {
      this.lastOutcome = "answered";
      await this.dropLocalCopy(run, {
        forgetDevice: false,
        organizationClosed: true,
      });
      return;
    }
    if (isSessionRefusal(error)) {
      this.lastOutcome = "answered";
      this.dependencies.keyValues.remove(SESSION_USER_KEY);
      await this.dropLocalCopy(run, { forgetDevice: false });
      return;
    }
    const noAnswer = isConnectionFailure(error);
    this.lastOutcome = noAnswer ? "no_answer" : "answered";
    if (noAnswer) {
      this.failingSince = null;
    }
    const quiet = !noAnswer && this.failsQuietly(error);
    // a partial sync may still have changed rows (accepted commands, pulled pages). No answer is not
    // "Envio falhou": the connection state says offline (its probe decides) and the queue waits for it
    this.set({
      ...this.snapshot,
      dataVersion: this.snapshot.dataVersion + 1,
      online: this.dependencies.isOnline(),
      reason: noAnswer || quiet ? null : failureReason(error),
      sessionRefused: false,
      syncing: false,
    });
    this.channel?.post();
    this.mark("sync:phase:contagens");
    await this.refreshCounts();
  }
}
