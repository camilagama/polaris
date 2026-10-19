import { readUnverifiedOfflineLease } from "../../lib/offline-lease-token";
import { rpcErrorCode } from "../../lib/rpc-error";
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
import { type PushFunction, syncOutbox } from "../sync-runner";

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
 * on a timer, after queueing). It is framework-free and takes every outside
 * thing as a dependency, so it is tested without a browser.
 */
export interface KeyValueStore {
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
   * is none. Throws SessionUnreachableError when the network could not reach the
   * server, and any other error when the server answered with something unusable.
   */
  sessionUserId: () => Promise<string | null>;
  source: (organizationId: string) => BootstrapSource;
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
  isOnline: () => boolean;
  keyValues: KeyValueStore;
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
  /** Deletes only the local collections (the OPFS file) of a namespace, keeping its queue. */
  wipeCollections: (namespace: LocalNamespace) => Promise<void>;
}

type RuntimePhase = "off" | "ready" | "starting" | "unavailable";

export interface RuntimeSnapshot {
  /** Whether the local collections hold a complete snapshot of the organization. */
  bootstrapped: boolean;
  counts: PendingWork;
  /**
   * Goes up whenever the local collections may have changed (opened, synced,
   * or written by a screen), so a screen that reads them knows to read again.
   */
  dataVersion: number;
  lastSyncAt: string | null;
  leaseExpiresAt: string | null;
  online: boolean;
  phase: RuntimePhase;
  /** Why the runtime is unavailable or the last sync failed; null when fine. */
  reason: string | null;
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

/** The server said the session is over or the account may not do this. */
function isSessionRefusal(error: unknown): boolean {
  const code = rpcErrorCode(error);
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

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
  `polaris.offline.lease.${userId}.${organizationId}`;
/** Before the lease belonged to a user; only ever removed. */
const legacyLeaseKey = (organizationId: string) =>
  `polaris.offline.lease.${organizationId}`;
/** Who was signed in the last time the server could be asked; what offline starts trust. */
const SESSION_USER_KEY = "polaris.offline.session-user";
/** The server's code for a lease, device or grant that no longer stands. */
const AUTHORIZATION_REVOKED = "authorization_revoked";
const RENEW_BEFORE_MS = 12 * 3_600_000;
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
    lastSyncAt: null,
    leaseExpiresAt: null,
    online: true,
    phase: "off",
    reason: null,
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
  /** Bumped by every start and stop so a late answer of an old run is dropped. */
  private generation = 0;

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
      !(this.stores && this.deviceId && this.lease && this.organizationId)
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

  /** Where the update cycle reads the queue and sends it (ADR 0041). */
  workSource(): PendingWorkSource {
    return {
      read: async () => {
        await this.refreshCounts();
        return this.snapshot.counts;
      },
      sync: async () => {
        if (!this.dependencies.isOnline()) {
          throw new Error("offline");
        }
        await this.syncNow();
        if (this.snapshot.reason === "sync_failed") {
          throw new Error("sync_failed");
        }
      },
    };
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
        this.forgetDevice();
        this.set({ ...this.snapshot, counts: EMPTY_COUNTS, phase: "off" });
      },
      trySync: async () => {
        if (!this.dependencies.isOnline()) {
          throw new Error("offline");
        }
        await this.syncNow();
      },
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
      return [];
    }
    const others: LogoutWorkspace[] = [];
    const known = this.dependencies.keyValues.read(DEVICE_KEY) ?? this.deviceId;
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
      others.push({
        label: `${item.organizationId} (outra organização)`,
        outbox: stores.outbox,
        purge: async (options) => {
          await release();
          await this.dependencies.purge(namespace, options);
          this.forgetNamespace(namespace);
          this.dependencies.keyValues.remove(
            leaseKey(item.userId, item.organizationId)
          );
        },
        release,
        trySync: () => Promise.reject(new Error("switch_organization")),
      });
    }
    return [current, ...others];
  }

  // ------------------------------------------------------------ lifecycle
  async start(organizationId: string): Promise<void> {
    if (
      this.organizationId === organizationId &&
      (this.snapshot.phase === "starting" || this.snapshot.phase === "ready")
    ) {
      return;
    }
    await this.stop();
    const { generation } = this;
    this.organizationId = organizationId;
    this.set({ ...this.snapshot, phase: "starting", reason: null });
    try {
      await this.boot(organizationId, generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.closeStores();
        this.set({
          ...this.snapshot,
          phase: "unavailable",
          reason: error instanceof Error ? error.message : "start_failed",
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
      lastSyncAt: null,
      leaseExpiresAt: null,
      phase: "off",
      reason: null,
      sessionRefused: false,
      syncing: false,
    });
  }

  /** Sends what is queued and catches the local collections up. Single-flight. */
  syncNow(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.runSync().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
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
  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private set(next: RuntimeSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private forgetDevice() {
    this.dependencies.keyValues.remove(DEVICE_KEY);
    this.dependencies.keyValues.remove(SESSION_USER_KEY);
    this.forgetLease();
    this.deviceId = null;
    this.lease = null;
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
    const claims = readUnverifiedOfflineLease(token);
    return (
      claims !== null &&
      claims.sub === userId &&
      claims.org === organizationId &&
      claims.dev === deviceId &&
      claims.exp * 1000 > this.now().getTime()
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
    } catch {
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
  private async sessionUser(): Promise<string> {
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
      return userId;
    }
    const remembered = keyValues.read(SESSION_USER_KEY);
    if (!remembered) {
      throw new Error("no_session_offline");
    }
    return remembered;
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
    const { api, isOnline, keyValues } = this.dependencies;
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
    if (due && isOnline()) {
      try {
        const issued = await api.issueLease(deviceId, organizationId);
        // a lease for somebody else is never kept, whatever the server said
        if (
          !this.leaseIsUsable(issued.lease, userId, organizationId, deviceId)
        ) {
          throw new Error("lease_wrong_user");
        }
        keyValues.write(
          leaseKey(userId, organizationId),
          JSON.stringify(issued)
        );
        return issued.lease;
      } catch (error) {
        if (!usable) {
          throw error;
        }
        // renewing failed but the cached lease still works: keep going on it
      }
    }
    if (!usable) {
      throw new Error("no_lease_offline");
    }
    return usable.lease;
  }

  private async boot(organizationId: string, generation: number) {
    const userId = await this.sessionUser();
    if (generation !== this.generation) {
      return;
    }
    this.userId = userId;
    this.dependencies.keyValues.remove(legacyLeaseKey(organizationId));
    const deviceId = await this.ensureDevice(userId);
    try {
      const lease = await this.ensureLease(userId, organizationId, deviceId);
      await this.open(userId, organizationId, deviceId, lease, generation);
    } catch (error) {
      if (
        !this.dependencies.isOnline() ||
        (error instanceof Error && error.message === "no_lease_offline") ||
        isPlanRefusal(error)
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
      leaseExpiresAt: new Date(claims.exp * 1000).toISOString(),
      online: this.dependencies.isOnline(),
      phase: "ready",
      reason: null,
    });
    await this.refreshCounts();
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
    options: { forgetDevice: boolean }
  ) {
    const { generation, namespace, stores } = run;
    if (generation !== this.generation) {
      return; // another organization or user took over while the answer was on its way
    }
    const queued = (await stores.outbox.snapshot()).commands.length > 0;
    await this.closeStores();
    this.forgetLease();
    this.lease = null;
    if (options.forgetDevice) {
      this.dependencies.keyValues.remove(DEVICE_KEY);
      this.deviceId = null;
    }
    let reason = "session_refused";
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
      phase: "unavailable",
      reason,
      sessionRefused: true,
      syncing: false,
    });
  }

  /**
   * Whether the session still belongs to the user whose namespace is open. A
   * session that changed hands (another person signed in, in this tab or another)
   * must not keep queueing into the first person's namespace. Nothing is deleted:
   * that data is still its owner's, and only the owner can open it again.
   */
  private async sessionChangedHands(run: RunScope): Promise<boolean> {
    let current: string | null;
    try {
      current = await this.dependencies.api.sessionUserId();
    } catch {
      return false; // the server could not say: the push will be refused if it matters
    }
    if (current === run.userId) {
      return false;
    }
    if (current === null) {
      this.dependencies.keyValues.remove(SESSION_USER_KEY);
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

  private async runSync(): Promise<void> {
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
    if (!this.dependencies.isOnline()) {
      this.set({ ...this.snapshot, online: false });
      return;
    }
    this.set({ ...this.snapshot, online: true, reason: null, syncing: true });
    if (await this.sessionChangedHands(run)) {
      return;
    }
    try {
      this.lease = await this.ensureLease(userId, organizationId, deviceId);
      const source = this.dependencies.api.source(organizationId);
      const summary = await syncOutbox({
        outbox: stores.outbox,
        pull: { source, writer: stores.writer },
        push: this.dependencies.api.push(organizationId),
      });
      if (
        summary.rejected > 0 &&
        summary.blockedBy?.rejection?.code === AUTHORIZATION_REVOKED
      ) {
        await this.dropLocalCopy(run, { forgetDevice: true });
        return;
      }
      const meta = await stores.writer.readMeta();
      if (isLocalStoreReady(meta) && meta?.cursor) {
        await pullLocalChanges(source, stores.writer, meta.cursor);
      } else {
        await bootstrapLocalStore(source, stores.writer);
      }
      this.set({
        ...this.snapshot,
        bootstrapped: true,
        dataVersion: this.snapshot.dataVersion + 1,
        lastSyncAt: this.now().toISOString(),
        reason: null,
        sessionRefused: false,
        syncing: false,
      });
      this.channel?.post();
    } catch (error) {
      if (isSessionRefusal(error)) {
        this.dependencies.keyValues.remove(SESSION_USER_KEY);
        await this.dropLocalCopy(run, { forgetDevice: false });
        return;
      }
      // a partial sync may still have changed rows (accepted commands, pulled pages)
      this.set({
        ...this.snapshot,
        dataVersion: this.snapshot.dataVersion + 1,
        reason: "sync_failed",
        sessionRefused: false,
        syncing: false,
      });
      this.channel?.post();
    }
    await this.refreshCounts();
  }
}
