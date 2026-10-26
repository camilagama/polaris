import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";
import { NoWorkerAnswerError } from "../../lib/connection";
import { createReadGate, type ReadGate } from "../../lib/read-gate";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { attemptLogout } from "../logout-guard";
import { MemoryOutboxStorage } from "../outbox/memory-storage";
import { Outbox } from "../outbox/outbox";
import { createOfflineProduct } from "../product-create";
import { FakeCatalogServer, FakeWriter } from "../test-support";
import {
  type DataChannel,
  type KeyValueStore,
  OfflineRuntime,
  type OpenedStores,
  type RuntimeApi,
  type RuntimeDependencies,
  SessionUnreachableError,
} from "./offline-runtime";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function memoryKeyValues(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    keys: () => [...data.keys()],
    read: (name) => data.get(name) ?? null,
    remove: (name) => {
      data.delete(name);
    },
    write: (name, value) => {
      data.set(name, value);
    },
  };
}

/** Everything the runtime touches, faked, with the stores surviving a "restart". */
function world(options: { leaseHours?: number } = {}) {
  const server = new FakeCatalogServer();
  const network = { online: true };
  let clock = new Date("2026-10-14T12:00:00.000Z");
  const calls = {
    issueLease: 0,
    pull: 0,
    push: 0,
    registerDevice: 0,
    sessionUser: 0,
  };
  const labels: (string | null)[] = [];
  const owners = new Map<string, string>();
  const session: { signedIn: boolean; user: string } = {
    signedIn: true,
    user: userId,
  };
  const failures: {
    /** The server cannot say whose a device is (down, timed out). */
    deviceIsMine: boolean;
    /** What asking whose a device is throws, if anything (wins over `deviceIsMine`). */
    deviceIsMineError?: Error;
    /** What asking who is signed in throws, if anything. */
    sessionUser?: Error;
    issueLease: Error[];
    push: boolean;
    /** What the failing push throws as is (a network failure, a response that was not the Worker's). */
    pushError?: Error | undefined;
    /** The oRPC code the failing push carries (UNAUTHORIZED, FORBIDDEN...), if any. */
    pushCode?: string | undefined;
    /** The `data` the failing push carries (the domain reason), if any. */
    pushData?: Record<string, unknown> | undefined;
    /** The server answers every pushed command as rejected, with this code. */
    rejectCode?: string | undefined;
  } = {
    deviceIsMine: false,
    issueLease: [],
    push: false,
  };
  /** The timers the runtime set (the one at the lease's exp), fired by hand. */
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  /** Makes closing the stores wait, to catch stop/start overlapping. */
  const gates: {
    close?: Promise<void> | undefined;
    /** Makes the next lease request wait, to catch what happens meanwhile. */
    issueLease?: Promise<void> | undefined;
    /** Opening stores fails this many more times. */
    openStoresFailures?: number;
    /** Makes every pull wait for this promise. */
    pull?: Promise<void> | undefined;
    /** Makes every pull go through the tab's read gate, as the real `fetch` does (the signal frees it). */
    readGate?: ReadGate | undefined;
    /** Makes every push wait for this promise. */
    push?: Promise<void> | undefined;
  } = {};
  const keyValues = memoryKeyValues();
  const stores = new Map<string, { outbox: Outbox; writer: FakeWriter }>();
  const closed: string[] = [];
  const purged: { discardPending: boolean }[] = [];
  const wiped: string[] = [];
  // two tabs: every channel of a name hears the posts of the others, never its own
  const bus = new Map<string, Set<{ listener: () => void }>>();
  const openDataChannel = (name: string): DataChannel => {
    const mine: { listener: () => void } = { listener: () => undefined };
    const members = bus.get(name) ?? new Set();
    members.add(mine);
    bus.set(name, members);
    return {
      close: () => {
        members.delete(mine);
      },
      post: () => {
        for (const member of members) {
          if (member !== mine) {
            member.listener();
          }
        }
      },
      subscribe: (listener) => {
        mine.listener = listener;
        return () => {
          mine.listener = () => undefined;
        };
      },
    };
  };

  const issue = async (deviceId: string, org: string) => {
    const lease = await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["product:create", "inventory:adjust"],
        deviceId,
        epoch: 0,
        expiresAt: new Date(
          clock.getTime() + (options.leaseHours ?? 72) * HOUR
        ),
        grantId: uuid(900),
        issuedAt: clock,
        organizationId: org,
        userId: session.user,
      }),
      key
    );
    return {
      expiresAt: new Date(
        clock.getTime() + (options.leaseHours ?? 72) * HOUR
      ).toISOString(),
      lease,
    };
  };
  // the server as a source of pulls, counting them and able to make them wait
  const countedSource = Object.create(server) as FakeCatalogServer;
  let pullSignal: AbortSignal | undefined;
  countedSource.pull = async (cursor, limit) => {
    calls.pull += 1;
    await gates.pull;
    const release = await gates.readGate?.acquire(pullSignal);
    try {
      return await server.pull(cursor, limit);
    } finally {
      release?.();
    }
  };
  const api: RuntimeApi = {
    deviceIsMine: (deviceId) => {
      if (failures.deviceIsMineError) {
        return Promise.reject(failures.deviceIsMineError);
      }
      return failures.deviceIsMine
        ? Promise.reject(new Error("server down"))
        : Promise.resolve(owners.get(deviceId) === session.user);
    },
    issueLease: async (deviceId, org) => {
      calls.issueLease += 1;
      const failure = failures.issueLease.shift();
      const gate = gates.issueLease;
      gates.issueLease = undefined;
      await gate;
      return failure ? Promise.reject(failure) : issue(deviceId, org);
    },
    push: () => async (input) => {
      calls.push += 1;
      await gates.push;
      if (failures.pushError) {
        throw failures.pushError;
      }
      if (failures.push) {
        return Promise.reject(
          Object.assign(new Error("server down"), {
            ...(failures.pushCode === undefined
              ? {}
              : { code: failures.pushCode }),
            ...(failures.pushData === undefined
              ? {}
              : { data: failures.pushData }),
          })
        );
      }
      if (failures.rejectCode !== undefined) {
        const code = failures.rejectCode;
        return Promise.resolve({
          results: input.commands.map((command) => ({
            code,
            commandId: command.commandId,
            replayed: false,
            result: null,
            status: "rejected" as const,
          })),
        });
      }
      return server.push(input);
    },
    registerDevice: (label) => {
      calls.registerDevice += 1;
      labels.push(label);
      const id = uuid(700 + calls.registerDevice);
      owners.set(id, session.user);
      return Promise.resolve(id);
    },
    sessionUserId: () => {
      calls.sessionUser += 1;
      return failures.sessionUser
        ? Promise.reject(failures.sessionUser)
        : Promise.resolve(session.signedIn ? session.user : null);
    },
    source: (_organizationId, signal) => {
      pullSignal = signal;
      return countedSource;
    },
  };
  const make = (
    deviceLabel: string | null = null,
    extra: Partial<RuntimeDependencies> = {}
  ) =>
    new OfflineRuntime({
      api,
      deviceLabel,
      isOnline: () => network.online,
      keyValues,
      namespaceFor: (user, org) =>
        Promise.resolve({
          coordinatorName: `c-${user}-${org}`,
          databaseFile: `d-${user}-${org}`,
          key: `${user}-${org}`,
          organizationId: org,
          userId: user,
        }),
      now: () => clock,
      openDataChannel,
      openStores: (namespace, deviceId) => {
        if ((gates.openStoresFailures ?? 0) > 0) {
          gates.openStoresFailures = (gates.openStoresFailures ?? 0) - 1;
          return Promise.reject(new Error("opfs_failed"));
        }
        const existing = stores.get(namespace.key);
        const value = existing ?? {
          outbox: new Outbox({
            deviceId,
            now: () => clock,
            organizationId: namespace.organizationId,
            storage: new MemoryOutboxStorage(),
            userId: namespace.userId,
          }),
          writer: new FakeWriter(),
        };
        stores.set(namespace.key, value);
        const opened: OpenedStores = {
          close: () => {
            closed.push(namespace.key);
            return gates.close;
          },
          ...value,
        };
        return Promise.resolve(opened);
      },
      purge: (_namespace, purgeOptions) => {
        purged.push(purgeOptions);
        return Promise.resolve();
      },
      schedule: (callback, delayMs) => {
        const timer = {
          at: clock.getTime() + delayMs,
          callback,
          cancelled: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      wipeCollections: (namespace) => {
        wiped.push(namespace.key);
        return Promise.resolve();
      },
      ...extra,
    });
  return {
    advance: (hours: number) => {
      clock = new Date(clock.getTime() + hours * HOUR);
    },
    calls,
    closed,
    failures,
    /** Fires every live timer that is due by the clock, as the browser would. */
    fireDueTimers: () => {
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) {
          continue;
        }
        if (timer.at <= clock.getTime()) {
          timer.callback();
        } else {
          timers.push(timer);
        }
      }
    },
    gates,
    keyValues,
    labels,
    liveTimers: () => timers.filter((timer) => !timer.cancelled),
    make,
    network,
    purged,
    server,
    session,
    stores,
    wiped,
  };
}

async function queueProduct(runtime: OfflineRuntime, name: string, n: number) {
  const context = runtime.context();
  if (!context) {
    throw new Error("not ready");
  }
  await createOfflineProduct({
    ...context,
    input: { name },
    newCommandId: () => uuid(100 + n),
    newProductId: () => uuid(200 + n),
    newVariantId: () => uuid(300 + n),
  });
  await runtime.refreshCounts();
}

describe("starting", () => {
  it("registers the device once, takes a lease, opens the stores and bootstraps", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);

    const snapshot = runtime.getSnapshot();
    expect(snapshot).toMatchObject({
      bootstrapped: true,
      online: true,
      phase: "ready",
      reason: null,
    });
    expect(snapshot.leaseExpiresAt).toBe("2026-10-17T12:00:00.000Z");
    expect(w.calls).toMatchObject({ issueLease: 1, registerDevice: 1 });
    expect(runtime.context()).toMatchObject({
      deviceId: uuid(701),
      organizationId,
    });
    // the device, the user's lease, the namespace registry and who was signed in
    expect(w.keyValues.data.size).toBe(4);
    expect(
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`)
    ).not.toBeNull();
  });

  it("opens offline on a later visit from the remembered device and lease, with no network", async () => {
    const w = world();
    await w.make().start(organizationId);
    const online = { ...w.calls };

    w.network.online = false;
    const second = w.make();
    await second.start(organizationId);

    expect(second.getSnapshot()).toMatchObject({
      bootstrapped: true,
      online: false,
      phase: "ready",
    });
    expect(w.calls).toEqual(online); // nothing was asked of the server
  });

  it("is unavailable, with the reason, when it cannot start without a network", async () => {
    const w = world();
    w.network.online = false;
    const nobody = w.make();
    await nobody.start(organizationId);
    expect(nobody.getSnapshot().reason).toBe("no_session_offline");

    w.keyValues.write("polaris.offline.session-user", userId);
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "no_device_offline",
    });
    expect(runtime.context()).toBeNull();

    // a device but no lease, still offline
    w.keyValues.write("polaris.offline.device", uuid(701));
    const next = w.make();
    await next.start(organizationId);
    expect(next.getSnapshot().reason).toBe("no_lease_offline");
  });

  it("renews a lease that is about to end, and keeps working on it when renewal fails", async () => {
    const w = world({ leaseHours: 72 });
    await w.make().start(organizationId);
    expect(w.calls.issueLease).toBe(1);

    w.advance(65); // 7 hours left: due for renewal
    await w.make().start(organizationId);
    expect(w.calls.issueLease).toBe(2);

    w.advance(60); // the renewed lease has 12 hours left; the next renewal fails
    w.failures.issueLease.push(new Error("server down"));
    const kept = w.make();
    await kept.start(organizationId);
    expect(kept.getSnapshot().phase).toBe("ready");
  });

  it("forgets a remembered device that belongs to someone else and registers again", async () => {
    const w = world();
    w.keyValues.write("polaris.offline.device", uuid(999)); // nobody's
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(w.calls.registerDevice).toBe(1);
    expect(runtime.context()?.deviceId).toBe(uuid(701));
  });

  it("a plan without offline writes is not a broken device: it is kept, not registered again, and the app stays online", async () => {
    const w = world();
    w.failures.issueLease.push(
      Object.assign(new Error("conflict"), {
        data: { reason: "entitlement_denied" },
      })
    );
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot().phase).not.toBe("ready");
    expect(w.calls.issueLease).toBe(1);
    expect(w.calls.registerDevice).toBe(1);
    expect(w.keyValues.read("polaris.offline.device")).not.toBeNull();
  });

  it("a second user of the same browser gets their own device, lease and namespace, and the first user's work is left alone", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Do primeiro usuário", 1);
    await first.stop(); // the session ended without a logout: nothing was purged

    w.session.user = "user-2";
    const second = w.make();
    await second.start(organizationId);

    expect(second.getSnapshot().phase).toBe("ready");
    expect(w.calls.registerDevice).toBe(2); // a new device, not the first user's
    expect(second.context()?.deviceId).toBe(uuid(702));
    // the second user opened their own namespace and sees none of the first one's queue
    expect(second.getSnapshot().counts.pending).toBe(0);
    const firstQueue = w.stores.get(`user-1-${organizationId}`);
    expect((await firstQueue?.outbox.snapshot())?.commands).toHaveLength(1);
    expect(w.stores.has(`user-2-${organizationId}`)).toBe(true);
  });

  it("a second user never sees the first one's data, even when the server cannot say whose the device is", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Do primeiro usuário", 1);
    await first.stop(); // the session ended without a logout: the lease and the data stay

    w.session.user = "user-2";
    w.failures.deviceIsMine = true;
    const second = w.make();
    await second.start(organizationId);

    // the first user's device is not lent on the strength of a failed question
    expect(second.getSnapshot().phase).toBe("ready");
    expect(second.context()?.deviceId).not.toBe(uuid(701));
    expect(second.getSnapshot().counts.pending).toBe(0);
    expect(w.stores.has(`user-1-${organizationId}`)).toBe(true);
    expect(w.stores.get(`user-1-${organizationId}`)?.outbox).not.toBe(
      second.context()?.outbox
    );
    expect(second.context()?.lease).not.toBe(
      w.keyValues.read(`polaris.offline.lease.user-1.${organizationId}`)
    );
    // the first user's lease is still theirs alone
    expect(
      JSON.parse(
        w.keyValues.read(`polaris.offline.lease.user-1.${organizationId}`) ??
          "{}"
      ).lease
    ).toBeTypeOf("string");
  });

  it("opens only the namespace of the session user, never the one a cached lease names", async () => {
    const w = world();
    await w.make().start(organizationId);
    // a lease of user-1 planted under user-2's key (a copied or tampered entry)
    w.keyValues.write(
      `polaris.offline.lease.user-2.${organizationId}`,
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`) ??
        ""
    );
    w.session.user = "user-2";
    w.network.online = false;
    w.keyValues.write("polaris.offline.session-user", "user-2");
    const intruder = w.make();
    await intruder.start(organizationId);
    expect(intruder.getSnapshot().phase).not.toBe("ready");
    expect(intruder.context()).toBeNull();
    expect(w.stores.has("user-2-org-1")).toBe(false);
  });

  it("the first user keeps working offline on their own device, lease and data", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Camiseta", 1);
    await first.stop();

    w.network.online = false;
    w.failures.deviceIsMine = true;
    const again = w.make();
    await again.start(organizationId);
    expect(again.getSnapshot()).toMatchObject({
      online: false,
      phase: "ready",
    });
    expect(again.getSnapshot().counts.pending).toBe(1);
    await queueProduct(again, "Calça", 2);
    expect(again.getSnapshot().counts.pending).toBe(2);

    // and with the network back but the server unable to answer about the device
    w.network.online = true;
    const online = w.make();
    await online.start(organizationId);
    expect(online.getSnapshot().phase).toBe("ready");
    expect(online.context()?.deviceId).toBe(uuid(701));
  });

  it("a session that changes hands while the app is open stops the first user's runtime without touching their data", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Do primeiro usuário", 1);

    w.session.user = "user-2"; // somebody else signed in, in another tab
    w.advance(0.02); // past the window in which the last confirmation is reused
    await runtime.syncNow();

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "session_changed",
      sessionRefused: true,
    });
    expect(runtime.context()).toBeNull();
    expect(w.calls.push).toBe(0);
    expect(w.wiped).toEqual([]);
    const kept = w.stores.get(`${userId}-${organizationId}`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(1);
  });

  it("when the server answers about the session with something unusable, it never falls back to the remembered user; with no connection at all it does", async () => {
    const w = world();
    await w.make().start(organizationId);
    w.session.user = "user-2"; // the remembered user is now somebody else's

    w.failures.sessionUser = new Error("session_unavailable");
    const refused = w.make();
    await refused.start(organizationId);
    expect(refused.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "session_unavailable",
    });
    expect(refused.context()).toBeNull();

    w.session.user = userId; // the real session is still the remembered user's
    w.failures.sessionUser = new SessionUnreachableError();
    const lieFi = w.make();
    await lieFi.start(organizationId);
    expect(lieFi.getSnapshot().phase).toBe("ready");
    expect(lieFi.context()?.organizationId).toBe(organizationId);
  });

  it("a logout of the second user only covers their own namespaces, never the first user's queue", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Do primeiro usuário", 1);
    await first.stop();

    w.session.user = "user-2";
    const second = w.make();
    await second.start(organizationId);
    const workspaces = await second.logoutWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.label).toBe(organizationId);
  });

  it("a server that gives no answer about the session (5xx, 429, no connection) keeps a running runtime syncing and never signs anyone out", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.sessionUser = new SessionUnreachableError("session_http_503");
    w.advance(0.02);

    await runtime.syncNow();

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      reason: null,
      sessionRefused: false,
    });
    expect(w.calls.push).toBe(1);
    expect(runtime.getSnapshot().counts.pending).toBe(0);
    expect(w.wiped).toEqual([]);
  });

  it("starts from the remembered user and the own lease when the server answers the session with 5xx, like a start with no network", async () => {
    const w = world();
    await w.make().start(organizationId);
    w.failures.sessionUser = new SessionUnreachableError("session_http_500");
    w.failures.deviceIsMine = true;
    const runtime = w.make();

    await runtime.start(organizationId);

    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.context()?.organizationId).toBe(organizationId);
    expect(w.calls.registerDevice).toBe(1);
  });

  it("a session the server refuses at start drops the remembered user", async () => {
    const w = world();
    await w.make().start(organizationId);
    w.session.signedIn = false; // what a 401 or 403 becomes: no session
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "no_session",
    });
    expect(w.keyValues.read("polaris.offline.session-user")).toBeNull();
  });

  it("reuses the last confirmation of the session for the syncs that follow it, and looks again after the window or a trip offline", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(w.calls.sessionUser).toBe(1); // the start's own confirmation

    await runtime.syncNow();
    await runtime.syncNow();
    expect(w.calls.sessionUser).toBe(1);

    w.advance(0.02);
    await runtime.syncNow();
    expect(w.calls.sessionUser).toBe(2);
    await runtime.syncNow();
    expect(w.calls.sessionUser).toBe(2);

    w.network.online = false;
    await runtime.syncNow();
    w.network.online = true;
    await runtime.syncNow();
    expect(w.calls.sessionUser).toBe(3);
  });

  it("sweeps the leases of the old layout of every organization at the first start, and only those", async () => {
    const w = world();
    w.keyValues.write("polaris.offline.lease.org-1", "old");
    w.keyValues.write("polaris.offline.lease.org-9", "old");
    w.keyValues.write("polaris.offline.lease.user-9.org-9", "{}");
    w.keyValues.write("polaris.offline.other", "kept");

    await w.make().start(organizationId);

    expect(w.keyValues.read("polaris.offline.lease.org-1")).toBeNull();
    expect(w.keyValues.read("polaris.offline.lease.org-9")).toBeNull();
    expect(w.keyValues.read("polaris.offline.lease.user-9.org-9")).toBe("{}");
    expect(w.keyValues.read("polaris.offline.other")).toBe("kept");
  });

  it("logging out with no store open still deletes the user's data, the lease, the device and the registry", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await first.stop();
    const runtime = w.make(); // a fresh page: nothing open, but the disk holds the copy

    const workspaces = await runtime.logoutWorkspaces();
    expect(workspaces.map((workspace) => workspace.label)).toEqual([
      organizationId,
    ]);
    const deviceId = runtime.currentDeviceId();
    expect(deviceId).not.toBeNull();
    expect(await attemptLogout(workspaces)).toEqual({ status: "ready" });

    expect(w.purged).toEqual([{ discardPending: false }]);
    // the purge keeps only the device id, for "Sair" to revoke it; the last step forgets it
    expect([...w.keyValues.data.keys()]).toEqual(["polaris.offline.device"]);
    expect(runtime.currentDeviceId()).toBe(deviceId);
    runtime.forgetDevice();
    expect(w.keyValues.data.size).toBe(0);
    expect(runtime.currentDeviceId()).toBeNull();
  });

  describe("\"Sair\" with the reads of the tab held (the pause of a 429, the line full)", () => {
    /** Four reads in flight and a 60 s pause: nothing goes through this gate until the (never firing) clock moves. */
    function heldGate(): ReadGate {
      const gate = createReadGate({
        now: () => 0,
        schedule: () => () => undefined,
      });
      for (let read = 0; read < 4; read += 1) {
        gate.acquire().catch(() => undefined);
      }
      gate.pause(60_000);
      return gate;
    }

    it("sends the queue and goes on, without a pull that would wait for the gate", async () => {
      const w = world();
      const runtime = w.make();
      await runtime.start(organizationId);
      await queueProduct(runtime, "Camiseta", 1);
      w.gates.readGate = heldGate();
      const pulls = w.calls.pull;

      const outcome = await attemptLogout(await runtime.logoutWorkspaces());

      expect(outcome).toEqual({ status: "ready" });
      expect(w.calls.push).toBeGreaterThan(0);
      expect(w.calls.pull).toBe(pulls);
      expect(w.purged).toEqual([{ discardPending: false }]);
    });

    it("cuts the pull of a sync already waiting for the gate, and sends what was queued after its push", async () => {
      const w = world();
      const runtime = w.make();
      await runtime.start(organizationId);
      w.gates.readGate = heldGate();
      const pulls = w.calls.pull;
      const held = runtime.syncNow();
      await vi.waitFor(() => expect(w.calls.pull).toBe(pulls + 1));
      await queueProduct(runtime, "Camiseta", 1);
      const pushes = w.calls.push;

      const outcome = await attemptLogout(await runtime.logoutWorkspaces());

      expect(outcome).toEqual({ status: "ready" });
      expect(w.calls.push).toBeGreaterThan(pushes);
      expect(w.calls.pull).toBe(pulls + 1);
      await held; // the cut run ended by itself, not as a failure
      expect(runtime.getSnapshot().reason).toBeNull();
    });
  });

  it("logging out with no store open and work queued is blocked, deletes the collections and the lease, and keeps the queue", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Camiseta", 1);
    await first.stop();
    const runtime = w.make();

    const outcome = await attemptLogout(await runtime.logoutWorkspaces());

    expect(outcome).toMatchObject({
      blocked: [{ reason: "offline", total: 1 }],
      status: "blocked",
    });
    expect(w.wiped).toEqual([`${userId}-${organizationId}`]);
    expect(w.purged).toEqual([]);
    expect(
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`)
    ).toBeNull();
    const kept = w.stores.get(`${userId}-${organizationId}`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(1);
    expect(w.keyValues.read("polaris.offline.namespaces")).toContain(userId);
  });

  it("logging out with no store open only reaches the namespaces of whoever is signed in, and names no one when the server answers nonsense", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await queueProduct(first, "Do primeiro usuário", 1);
    await first.stop();
    w.session.user = "user-2";
    const second = w.make();
    await second.start(organizationId);
    await second.stop();

    const runtime = w.make();
    const workspaces = await runtime.logoutWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(await attemptLogout(workspaces)).toEqual({ status: "ready" });
    expect(w.wiped).toEqual([]);
    const kept = w.stores.get(`${userId}-${organizationId}`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(1);

    w.failures.sessionUser = new Error("session_unavailable");
    expect(await w.make().logoutWorkspaces()).toEqual([]);
  });

  it("logging out with no store open names no one without the server's answer, so it touches nothing: not a stale remembered user, not offline", async () => {
    const w = world();
    const first = w.make();
    await first.start(organizationId);
    await first.stop();

    w.failures.sessionUser = new SessionUnreachableError("session_http_503");
    expect(await w.make().logoutWorkspaces()).toEqual([]);
    w.failures.sessionUser = undefined as never;
    w.network.online = false;
    expect(await w.make().logoutWorkspaces()).toEqual([]);
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
  });

  it("a session that changed hands remembers the new user, so a later logout never reaches the first user's data", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.session.user = "user-2";
    w.advance(0.02);
    await runtime.syncNow();
    expect(w.keyValues.read("polaris.offline.session-user")).toBe("user-2");
  });

  it("never pushes the queue on a reused session confirmation", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.session.user = "user-2"; // changed hands inside the window
    await runtime.syncNow();
    expect(w.calls.push).toBe(0);
    expect(runtime.getSnapshot().reason).toBe("session_changed");
  });

  it("a start that could only use the remembered user does not open the window that reuses the session confirmation", async () => {
    const w = world();
    await w.make().start(organizationId);
    w.failures.sessionUser = new SessionUnreachableError("session_http_503");
    const runtime = w.make();
    await runtime.start(organizationId);
    w.failures.sessionUser = undefined as never;
    const before = w.calls.sessionUser;

    await runtime.syncNow();

    expect(w.calls.sessionUser).toBe(before + 1);
  });

  it("with two organizations, one with queued work, the blocked logout still deletes the data of both and keeps the queue", async () => {
    const w = world();
    const first = w.make();
    await first.start("org-1");
    await queueProduct(first, "Na primeira", 1);
    await first.start("org-2");
    await first.stop();

    const outcome = await attemptLogout(await w.make().logoutWorkspaces());

    expect(outcome).toMatchObject({ status: "blocked" });
    expect(w.wiped.sort()).toEqual([`${userId}-org-1`, `${userId}-org-2`]);
    expect(w.purged).toEqual([]);
    const kept = w.stores.get(`${userId}-org-1`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(1);
  });

  it("is unavailable, with no data, when nobody is signed in", async () => {
    const w = world();
    await w.make().start(organizationId);
    w.session.signedIn = false;
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "no_session",
    });
    expect(runtime.context()).toBeNull();
  });

  it("sends the server a device label it accepts, or none", async () => {
    const long =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    expect(long.length).toBeGreaterThan(80);
    const w = world();
    await w.make(long).start(organizationId);
    const [label] = w.labels;
    expect(typeof label).toBe("string");
    expect([...(label ?? "")].length).toBeLessThanOrEqual(80);
    const none = world();
    await none.make(null).start(organizationId);
    expect(none.labels[0]).toBeNull();
  });

  it("switching organization closes the first one's stores", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await runtime.start("org-2");
    expect(w.closed).toContain(`${userId}-${organizationId}`);
    expect(runtime.context()?.organizationId).toBe("org-2");
  });
});

describe("syncing", () => {
  it("sends what was queued offline, catches up the local collections and updates the figures", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.network.online = false;
    await queueProduct(runtime, "Camiseta", 1);
    expect(runtime.getSnapshot().counts.pending).toBe(1);
    await runtime.syncNow();
    expect(runtime.getSnapshot().online).toBe(false);
    expect(w.server.products.size).toBe(0);

    w.network.online = true;
    await runtime.syncNow();

    expect(w.server.products.size).toBe(1);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.counts).toEqual({ pending: 0, rejected: 0, sending: 0 });
    expect(snapshot.lastSyncAt).toBe("2026-10-14T12:00:00.000Z");
    expect(snapshot.reason).toBeNull();
    expect(runtime.context()?.writer.inventoryRow).toBeDefined();
  });

  it("is single-flight: concurrent calls share one run", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    const before = w.calls.push;
    await Promise.all([
      runtime.syncNow(),
      runtime.syncNow(),
      runtime.syncNow(),
    ]);
    expect(w.calls.push - before).toBe(1);
    expect(w.server.executions).toBe(1);
  });

  it("a failing server leaves the queue intact and says so; the next success clears it", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.push = true;
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      reason: "sync_failed",
      syncing: false,
    });

    w.failures.push = false;
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 0 },
      reason: null,
    });
    expect(w.server.products.size).toBe(1);
  });

  it("does nothing before it is ready", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.syncNow();
    expect(w.calls.push).toBe(0);
  });
});

describe("what the rest of the app plugs into", () => {
  it("the work source reads the queue and refuses to send without a network", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    const source = runtime.workSource();
    expect(await source.read()).toEqual({
      pending: 1,
      rejected: 0,
      sending: 0,
    });

    w.network.online = false;
    await expect(source.sync()).rejects.toThrow("offline");
    w.network.online = true;
    await source.sync();
    expect(await source.read()).toEqual({
      pending: 0,
      rejected: 0,
      sending: 0,
    });
  });

  it("the work source reports a failed sync as a failure", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.push = true;
    await expect(runtime.workSource().sync()).rejects.toThrow("sync_failed");
  });

  it("logging out with an empty queue purges the namespace and forgets the device and lease", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    const workspace = runtime.logoutWorkspace();
    expect(workspace).not.toBeNull();
    if (!workspace) {
      return;
    }
    const deviceId = runtime.currentDeviceId();
    expect(deviceId).not.toBeNull();
    expect(await attemptLogout([workspace])).toEqual({ status: "ready" });
    expect(w.purged).toEqual([{ discardPending: false }]);
    // the lease and the remembered user go with the purge; the device id waits for the revocation
    expect([...w.keyValues.data.keys()]).toEqual(["polaris.offline.device"]);
    expect(runtime.currentDeviceId()).toBe(deviceId);
    expect(runtime.getSnapshot().phase).toBe("off");
    expect(runtime.context()).toBeNull();
    runtime.forgetDevice();
    expect(w.keyValues.data.size).toBe(0);
    expect(runtime.currentDeviceId()).toBeNull();
  });

  it("logging out is blocked, and nothing is purged, while work is queued and the network is down", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.network.online = false;
    const workspace = runtime.logoutWorkspace();
    if (!workspace) {
      throw new Error("no workspace");
    }
    expect(await attemptLogout([workspace])).toMatchObject({
      blocked: [{ reason: "offline", total: 1 }],
      status: "blocked",
    });
    expect(w.purged).toEqual([]);
    expect(w.keyValues.data.size).toBe(4);
  });

  it("logging out also covers the other organizations this browser holds, and purges them all", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start("org-1");
    await runtime.start("org-2"); // the person switched organization
    const workspaces = await runtime.logoutWorkspaces();
    expect(workspaces.map((workspace) => workspace.label)).toEqual([
      "org-2",
      "org-1 (outra loja)",
    ]);
    expect(await attemptLogout(workspaces)).toEqual({ status: "ready" });
    expect(w.purged).toHaveLength(2);
    // leases and registry are gone; the device goes at the last step of "Sair"
    expect([...w.keyValues.data.keys()]).toEqual(["polaris.offline.device"]);
    runtime.forgetDevice();
    expect(w.keyValues.data.size).toBe(0);
  });

  it("work queued in another organization blocks the logout, purges nothing and releases what was opened", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start("org-1");
    await queueProduct(runtime, "Na outra loja", 1);
    await runtime.start("org-2");
    const workspaces = await runtime.logoutWorkspaces();

    const outcome = await attemptLogout(workspaces);

    expect(outcome).toMatchObject({ status: "blocked" });
    if (outcome.status === "blocked") {
      expect(outcome.blocked.map((item) => item.label)).toEqual([
        "org-1 (outra loja)",
      ]);
    }
    expect(w.purged).toEqual([]);
    expect(
      w.closed.filter((name) => name === `${userId}-org-1`).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("notifies subscribers as the figures change", async () => {
    const w = world();
    const runtime = w.make();
    const listener = vi.fn();
    runtime.subscribe(listener);
    await runtime.start(organizationId);
    expect(listener).toHaveBeenCalled();
  });
});

describe("the data version the screens read by", () => {
  it("goes up when the stores open, when a screen wrote, and after every sync (even a failed one)", async () => {
    const w = world();
    const runtime = w.make();
    expect(runtime.getSnapshot().dataVersion).toBe(0);
    await runtime.start(organizationId);
    const opened = runtime.getSnapshot().dataVersion;
    expect(opened).toBeGreaterThan(0);

    runtime.localDataChanged();
    const written = runtime.getSnapshot().dataVersion;
    expect(written).toBe(opened + 1);

    await runtime.syncNow();
    const synced = runtime.getSnapshot().dataVersion;
    expect(synced).toBeGreaterThan(written);

    w.failures.push = true;
    await queueProduct(runtime, "Camiseta", 1);
    await runtime.syncNow();
    expect(runtime.getSnapshot().reason).toBe("sync_failed");
    expect(runtime.getSnapshot().dataVersion).toBeGreaterThan(synced);
  });

  it("exposes every row of a collection to the screens", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    await queueProduct(runtime, "Calça", 2);
    const rows = await runtime.context()?.writer.rows("products");
    expect(rows?.map((row) => row.name).sort()).toEqual(["Calça", "Camiseta"]);
  });
});

describe("two tabs of the same namespace", () => {
  it("a change in one makes the other read again, and the news does not echo back", async () => {
    const w = world();
    const first = w.make();
    const second = w.make();
    await first.start(organizationId);
    await second.start(organizationId);
    const before = second.getSnapshot().dataVersion;
    const firstBefore = first.getSnapshot().dataVersion;

    first.localDataChanged();

    expect(first.getSnapshot().dataVersion).toBe(firstBefore + 1);
    expect(second.getSnapshot().dataVersion).toBe(before + 1);
    // the second tab heard it but did not announce it again
    expect(first.getSnapshot().dataVersion).toBe(firstBefore + 1);
  });

  it("a tab that closed its stores no longer hears the others", async () => {
    const w = world();
    const first = w.make();
    const second = w.make();
    await first.start(organizationId);
    await second.start(organizationId);
    await second.stop();
    const before = second.getSnapshot().dataVersion;
    first.localDataChanged();
    expect(second.getSnapshot().dataVersion).toBe(before);
  });
});

describe("switching organization", () => {
  it("a stop that was still closing the old stores does not undo the organization opened after it", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    let release: () => void = () => undefined;
    w.gates.close = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the cleanup of the old organization is not awaited; the new one starts at once
    const stopping = runtime.stop();
    await runtime.start("org-2");
    w.gates.close = undefined;
    release();
    await stopping;

    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.context()?.organizationId).toBe("org-2");
  });
});

describe("a session the server refuses", () => {
  it("is flagged only when the server says not signed in or not allowed, and clears with a sync that works", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);

    w.failures.push = true;
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      reason: "sync_failed",
      sessionRefused: false,
    });

    for (const code of ["UNAUTHORIZED", "FORBIDDEN"]) {
      const refused = world();
      const other = refused.make();
      // biome-ignore lint/performance/noAwaitInLoops: each code is tried on its own world
      await other.start(organizationId);
      refused.failures.push = true;
      refused.failures.pushCode = code;
      await queueProduct(other, "Camiseta", 1);
      await other.syncNow();
      expect(other.getSnapshot().sessionRefused).toBe(true);
    }

    // starting again (the app reads the organizations again and restarts) works once the session does
    w.failures.push = false;
    await runtime.stop();
    await runtime.start(organizationId);
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      reason: null,
      sessionRefused: false,
    });
  });

  it("a refused session forgets the lease and the session user and deletes the local collections, but keeps the work that was queued", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.push = true;
    w.failures.pushCode = "UNAUTHORIZED";
    await runtime.syncNow();

    expect(w.wiped).toEqual([`${userId}-${organizationId}`]);
    expect(w.purged).toEqual([]); // the queue is not thrown away with the session
    expect(
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`)
    ).toBeNull();
    expect(w.keyValues.read("polaris.offline.session-user")).toBeNull();
    expect(runtime.context()).toBeNull();
    expect(runtime.getSnapshot()).toMatchObject({
      bootstrapped: false,
      phase: "unavailable",
      sessionRefused: true,
    });
    const kept = w.stores.get(`${userId}-${organizationId}`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(1);
    expect(w.keyValues.read("polaris.offline.namespaces")).toContain(userId);
  });

  it("a session the server ended (told by a screen, not found while sending) goes the same way as a refused one: lease and collections go now, the queue stays, and a second call does nothing", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    await queueProduct(runtime, "Calça", 2);

    await runtime.dropSessionCopy();
    await runtime.dropSessionCopy();

    expect(w.wiped).toEqual([`${userId}-${organizationId}`]);
    expect(w.purged).toEqual([]);
    expect(
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`)
    ).toBeNull();
    expect(runtime.context()).toBeNull();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      sessionRefused: true,
    });
    const kept = w.stores.get(`${userId}-${organizationId}`);
    expect((await kept?.outbox.snapshot())?.commands).toHaveLength(2);
  });

  it("a refused session with nothing queued deletes the whole namespace", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.advance(73); // the lease ended, so the sync has to ask for a new one
    w.failures.issueLease.push(
      Object.assign(new Error("forbidden"), { code: "FORBIDDEN" })
    );
    await runtime.syncNow();

    expect(runtime.getSnapshot().sessionRefused).toBe(true);
    expect(w.purged).toEqual([{ discardPending: false }]);
    expect(w.wiped).toEqual([]);
    expect(w.keyValues.read("polaris.offline.namespaces")).toBeNull();
  });

  it("a command the server refuses as authorization_revoked ends the lease, the device and the collections once, and keeps the refused work to show", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.rejectCode = "authorization_revoked";
    await runtime.syncNow();

    expect(w.wiped).toEqual([`${userId}-${organizationId}`]);
    expect(
      w.keyValues.read(`polaris.offline.lease.${userId}.${organizationId}`)
    ).toBeNull();
    expect(w.keyValues.read("polaris.offline.device")).toBeNull();
    expect(runtime.context()).toBeNull();
    expect(runtime.getSnapshot().sessionRefused).toBe(true);

    // the app starts again with the same refused command in the queue: that is not a new refusal
    w.failures.rejectCode = undefined;
    const again = w.make();
    await again.start(organizationId);
    await again.syncNow();
    expect(again.getSnapshot().phase).toBe("ready");
    expect(again.getSnapshot().counts.rejected).toBe(1);
    expect(w.wiped).toHaveLength(1);
  });

  it("a late refusal from an old run does not touch the organization opened after it", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.push = true;
    w.failures.pushCode = "UNAUTHORIZED";
    const sync = runtime.syncNow();
    await runtime.start("org-2"); // stops org-1 while its push is still on the way
    await sync;
    expect(w.wiped).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      sessionRefused: false,
    });
    expect(runtime.context()?.organizationId).toBe("org-2");
  });

  it("a different refusal keeps the data: only authorization ends it", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    w.failures.rejectCode = "sku_conflict";
    await runtime.syncNow();

    expect(w.purged).toEqual([]);
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.getSnapshot().counts.rejected).toBe(1);
  });

  it("stopping forgets the last figures of the organization that was open", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await runtime.syncNow();
    expect(runtime.getSnapshot().lastSyncAt).not.toBeNull();
    await runtime.stop();
    expect(runtime.getSnapshot()).toMatchObject({
      lastSyncAt: null,
      leaseExpiresAt: null,
    });
  });
});

describe("the offline access that expired (emenda do ADR 0047)", () => {
  const leaseKeyOf = `polaris.offline.lease.${userId}.${organizationId}`;

  /** Online once (device and lease), then offline with one product queued. */
  async function queuedOffline() {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.network.online = false;
    await queueProduct(runtime, "Camiseta", 1);
    return { runtime, w };
  }

  async function queuedCommands(w: ReturnType<typeof world>) {
    const stored = w.stores.get(`${userId}-${organizationId}`);
    return (await stored?.outbox.snapshot())?.commands ?? [];
  }

  it("opening with no network and the own lease past its exp: expired, no copy, no new work, the queue counted and intact, and nothing forgotten", async () => {
    const { runtime: first, w } = await queuedOffline();
    const before = await queuedCommands(w);
    await first.stop();
    const asked = { ...w.calls };

    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);

    expect(runtime.getSnapshot()).toMatchObject({
      bootstrapped: false,
      counts: { pending: 1 },
      leaseExpiresAt: "2026-10-17T12:00:00.000Z",
      online: false,
      phase: "expired",
      reason: "offline_access_expired",
      sessionRefused: false,
    });
    expect(runtime.context()).toBeNull();
    expect(await queuedCommands(w)).toEqual(before);
    // only time ran out: the device, the lease, the remembered user and the copy stay
    expect(w.keyValues.read("polaris.offline.device")).toBe(uuid(701));
    expect(w.keyValues.read(leaseKeyOf)).not.toBeNull();
    expect(w.keyValues.read("polaris.offline.session-user")).toBe(userId);
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
    expect(w.calls).toEqual(asked);
  });

  it("without a network, a sync tries nothing (no loop) and keeps the state", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);
    const asked = { ...w.calls };

    await runtime.syncNow();
    await runtime.syncNow();

    expect(w.calls).toEqual(asked);
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
    });
    expect(w.liveTimers()).toEqual([]);
  });

  it("when the network returns, it renews by itself, opens the copy again and sends the queue", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);

    w.network.online = true;
    await runtime.syncNow();

    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 0 },
      leaseExpiresAt: "2026-10-20T13:00:00.000Z",
      phase: "ready",
      reason: null,
    });
    expect(runtime.context()).not.toBeNull();
    expect(w.calls.issueLease).toBe(2);
    expect(w.server.products.size).toBe(1);
  });

  it("a server that gives no answer (5xx, 429) to the renewal is the same as no network: expired, the device is not registered again", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    w.network.online = true;
    w.failures.issueLease.push(
      Object.assign(new Error("server down"), {
        code: "INTERNAL_SERVER_ERROR",
      }),
      Object.assign(new Error("throttled"), { code: "TOO_MANY_REQUESTS" })
    );
    const runtime = w.make();
    await runtime.start(organizationId);

    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
      syncing: false,
    });
    expect(w.calls.registerDevice).toBe(1);

    // one try per sync, and the next one works
    await runtime.syncNow();
    expect(runtime.getSnapshot().phase).toBe("expired");
    await runtime.syncNow();
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(w.server.products.size).toBe(1);
  });

  it("a session the server refuses at the renewal goes as any refused session: the collections go, the queue stays", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);
    const before = await queuedCommands(w);

    w.network.online = true;
    w.failures.issueLease.push(
      Object.assign(new Error("Unauthorized"), { code: "UNAUTHORIZED" })
    );
    await runtime.syncNow();

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "session_refused",
      sessionRefused: true,
    });
    expect(w.wiped).toEqual([`${userId}-${organizationId}`]);
    expect(w.keyValues.read(leaseKeyOf)).toBeNull();
    expect(await queuedCommands(w)).toEqual(before);
  });

  it("with the app open, the timer at the exp ends the access at once and the queue stays; the network back renews it without a restart", async () => {
    const { runtime, w } = await queuedOffline();
    const before = await queuedCommands(w);
    expect(w.liveTimers()).toHaveLength(1);

    w.advance(71);
    w.fireDueTimers();
    expect(runtime.getSnapshot().phase).toBe("ready");

    w.advance(1);
    const version = runtime.getSnapshot().dataVersion;
    w.fireDueTimers();
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
      reason: "offline_access_expired",
    });
    expect(runtime.getSnapshot().dataVersion).toBeGreaterThan(version);
    expect(runtime.context()).toBeNull();
    expect(await queuedCommands(w)).toEqual(before);

    w.network.online = true;
    await runtime.syncNow();
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.context()).not.toBeNull();
    expect(w.server.products.size).toBe(1);
    // a new timer at the new exp, and only that one
    expect(w.liveTimers()).toHaveLength(1);
    expect(w.liveTimers()[0]?.at).toBe(
      Date.parse(runtime.getSnapshot().leaseExpiresAt ?? "")
    );
  });

  it("tells apart an access that ended with the app open from one that was already ended at start", async () => {
    const { runtime: first, w } = await queuedOffline();
    expect(first.getSnapshot().expiredWhileOpen).toBe(false);
    w.advance(72);
    w.fireDueTimers();
    expect(first.getSnapshot()).toMatchObject({
      expiredWhileOpen: true,
      phase: "expired",
    });

    await first.stop();
    const second = w.make();
    await second.start(organizationId);
    expect(second.getSnapshot()).toMatchObject({
      expiredWhileOpen: false,
      phase: "expired",
    });

    w.network.online = true;
    await first.start(organizationId);
    expect(first.getSnapshot()).toMatchObject({
      expiredWhileOpen: false,
      phase: "ready",
    });
  });

  it("the renewed access forgets that it ended with the app open", async () => {
    const { runtime, w } = await queuedOffline();
    w.advance(72);
    w.fireDueTimers();
    expect(runtime.getSnapshot().expiredWhileOpen).toBe(true);

    w.network.online = true;
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      expiredWhileOpen: false,
      phase: "ready",
    });
  });

  it("a renewal the server refuses for another reason than the session is marked refused; no answer is not, and the next good one clears it", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    w.network.online = true;
    w.failures.issueLease.push(
      Object.assign(new Error("server down"), {
        code: "INTERNAL_SERVER_ERROR",
      }),
      Object.assign(new Error("unknown device"), { code: "NOT_FOUND" })
    );
    const runtime = w.make();
    await runtime.start(organizationId);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "expired",
      renewalRefused: false,
      syncing: false,
    });

    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      online: true,
      phase: "expired",
      renewalRefused: true,
      syncing: false,
    });
    // the queue is intact and nothing was forgotten
    expect(runtime.getSnapshot().counts.pending).toBe(1);
    expect(w.keyValues.read("polaris.offline.device")).toBe(uuid(701));

    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      renewalRefused: false,
    });
  });

  it("a refusal followed by no answer from the server is no longer a refusal", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId); // offline: expired, nothing tried
    w.network.online = true;
    w.failures.issueLease.push(
      Object.assign(new Error("unknown device"), { code: "NOT_FOUND" }),
      Object.assign(new Error("server down"), {
        code: "INTERNAL_SERVER_ERROR",
      })
    );

    await runtime.syncNow();
    expect(runtime.getSnapshot().renewalRefused).toBe(true);
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      online: true,
      phase: "expired",
      renewalRefused: false,
      syncing: false,
    });
  });

  it("a timer that has not fired yet (a tab in the background) never lets a command in after the exp, and the next sync ends the access", async () => {
    const { runtime, w } = await queuedOffline();
    w.advance(72);

    expect(runtime.context()).toBeNull();
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
    });
  });

  it("a lease renewed by a sync moves the timer to the new exp", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.advance(65); // due for renewal
    await runtime.syncNow();

    expect(w.calls.issueLease).toBe(2);
    expect(runtime.getSnapshot().leaseExpiresAt).toBe(
      "2026-10-20T05:00:00.000Z"
    );
    expect(w.liveTimers().map((timer) => timer.at)).toEqual([
      Date.parse("2026-10-20T05:00:00.000Z"),
    ]);
    w.advance(8); // past the first lease's exp, well before the new one
    w.fireDueTimers();
    expect(runtime.getSnapshot().phase).toBe("ready");
  });

  it("stopping cancels the timer, so the first organization's exp does not touch the next one", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await runtime.stop();
    expect(w.liveTimers()).toEqual([]);

    w.advance(10);
    await runtime.start("org-2");
    w.advance(63); // past the first lease's exp, before the second one's
    w.fireDueTimers();
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(runtime.context()?.organizationId).toBe("org-2");
  });

  it("a renewal whose stores fail to open again goes back to the expired state, never stuck renewing, and the next sync tries again", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);

    w.network.online = true;
    w.gates.openStoresFailures = 1;
    await runtime.syncNow();
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
      syncing: false,
    });

    await runtime.syncNow();
    expect(runtime.getSnapshot().phase).toBe("ready");
    expect(w.server.products.size).toBe(1);
  });

  it("a renewal that fails after the stores opened closes them before going back to the expired state", async () => {
    const { runtime: first, w } = await queuedOffline();
    await first.stop();
    w.advance(73);
    const runtime = w.make();
    await runtime.start(organizationId);
    const namespaceKey = `${userId}-${organizationId}`;
    const writer = w.stores.get(namespaceKey)?.writer;
    if (!writer) {
      throw new Error("no stores");
    }
    const readMeta = writer.readMeta.bind(writer);
    writer.readMeta = () => {
      writer.readMeta = readMeta;
      return Promise.reject(new Error("opfs_read_failed"));
    };
    const closedBefore = w.closed.length;

    w.network.online = true;
    await runtime.syncNow();

    // the expired stores, then the ones the failed open kept
    expect(w.closed.length).toBe(closedBefore + 2);
    expect(runtime.getSnapshot()).toMatchObject({
      counts: { pending: 1 },
      phase: "expired",
      syncing: false,
    });
    await runtime.syncNow();
    expect(runtime.getSnapshot().phase).toBe("ready");
  });

  it("the timer firing while a sync is renewing the lease is undone by the new lease: the screens come back in the same sync", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.advance(65); // due for renewal
    let release: () => void = () => undefined;
    w.gates.issueLease = new Promise((resolve) => {
      release = resolve;
    });
    const sync = runtime.syncNow();
    await vi.waitFor(() => expect(w.calls.issueLease).toBe(2));

    w.advance(8); // the first lease's exp passes while the renewal is on its way
    w.fireDueTimers();
    expect(runtime.getSnapshot().phase).toBe("expired");
    expect(runtime.context()).toBeNull();

    release();
    await sync;
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "ready",
      reason: null,
    });
    expect(runtime.context()).not.toBeNull();
  });

  it("renewing that fails while the old lease runs out on the way leaves the access expired, not ready on the old lease", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.advance(71.9); // due, still usable
    let release: () => void = () => undefined;
    w.gates.issueLease = new Promise((resolve) => {
      release = resolve;
    });
    w.failures.issueLease.push(new Error("server down"));
    const sync = runtime.syncNow();
    await vi.waitFor(() => expect(w.calls.issueLease).toBe(2));
    w.advance(0.2);
    release();
    await sync;

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "expired",
      syncing: false,
    });
    expect(runtime.context()).toBeNull();
  });

  it("a sync of the first organization whose lease arrives after the switch never touches the second one", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    w.advance(65); // due for renewal
    let release: () => void = () => undefined;
    w.gates.issueLease = new Promise((resolve) => {
      release = resolve;
    });
    const sync = runtime.syncNow();
    await vi.waitFor(() => expect(w.calls.issueLease).toBe(2));

    await runtime.start("org-2");
    const second = runtime.getSnapshot().leaseExpiresAt;
    release();
    await sync;

    expect(runtime.context()?.organizationId).toBe("org-2");
    expect(runtime.getSnapshot().leaseExpiresAt).toBe(second);
    expect(w.liveTimers().map((timer) => timer.at)).toEqual([
      Date.parse(second ?? ""),
    ]);
  });
});

/** The refusal the server gives for lack of the legal acceptance (ADR 0100), shaped like the oRPC one. */
function legalRefusal(): Error {
  return Object.assign(new Error("legal acceptance required"), {
    code: "FORBIDDEN",
    data: {
      pending: [{ document: "terms", version: 2 }],
      reason: "legal_acceptance_required",
    },
    status: 403,
  });
}

describe("a server that waits for the legal acceptance", () => {
  const scope = `${userId}-${organizationId}`;
  const leaseKeyName = `polaris.offline.lease.${userId}.${organizationId}`;

  function refuseAcceptance(w: ReturnType<typeof world>) {
    w.failures.push = true;
    w.failures.pushCode = "FORBIDDEN";
    w.failures.pushData = {
      pending: [{ document: "terms", version: 2 }],
      reason: "legal_acceptance_required",
    };
  }

  async function commandsOf(w: ReturnType<typeof world>) {
    const kept = w.stores.get(scope);
    return (await kept?.outbox.snapshot())?.commands ?? [];
  }

  it("pauses the sync: the queue waits, nothing is rejected or deleted, and the session is not refused", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    await queueProduct(runtime, "Calça", 2);
    const device = w.keyValues.read("polaris.offline.device");
    const lease = w.keyValues.read(leaseKeyName);
    expect(device).not.toBeNull();
    expect(lease).not.toBeNull();

    refuseAcceptance(w);
    await runtime.syncNow();

    expect(w.calls.push).toBeGreaterThan(0);
    const commands = await commandsOf(w);
    expect(commands.map((c) => c.status)).toEqual(["pending", "pending"]);
    expect(commands.map((c) => c.commandId)).toEqual([uuid(101), uuid(102)]);
    expect(runtime.getSnapshot().counts).toMatchObject({
      pending: 2,
      rejected: 0,
      sending: 0,
    });
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
    expect(w.keyValues.read(leaseKeyName)).toBe(lease);
    expect(w.keyValues.read("polaris.offline.device")).toBe(device);
    expect(w.keyValues.read("polaris.offline.namespaces")).toContain(userId);
    expect(runtime.context()).not.toBeNull();
    expect(runtime.getSnapshot()).toMatchObject({
      bootstrapped: true,
      legalAcceptanceRequired: true,
      phase: "ready",
      reason: "legal_acceptance_required",
      sessionRefused: false,
      syncing: false,
    });
  });

  it("sends the same two commands at the next sync that the server accepts, and the pause ends", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    await queueProduct(runtime, "Calça", 2);
    refuseAcceptance(w);
    await runtime.syncNow();
    expect(runtime.getSnapshot().legalAcceptanceRequired).toBe(true);

    w.failures.push = false;
    w.failures.pushCode = undefined;
    w.failures.pushData = undefined;
    await runtime.syncNow();

    expect(w.server.products.size).toBe(2);
    expect(await commandsOf(w)).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      legalAcceptanceRequired: false,
      phase: "ready",
      reason: null,
      sessionRefused: false,
    });
    expect(runtime.getSnapshot().counts).toMatchObject({
      pending: 0,
      rejected: 0,
    });
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
  });

  it("contrast: a FORBIDDEN without the acceptance reason, or with another one, is still a refused session", async () => {
    for (const data of [undefined, { reason: "something_else" }]) {
      const w = world();
      const runtime = w.make();
      // biome-ignore lint/performance/noAwaitInLoops: each shape is tried on its own world
      await runtime.start(organizationId);
      await queueProduct(runtime, "Camiseta", 1);
      w.failures.push = true;
      w.failures.pushCode = "FORBIDDEN";
      w.failures.pushData = data;
      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        legalAcceptanceRequired: false,
        sessionRefused: true,
      });
      expect(w.wiped).toEqual([scope]);
      expect(w.keyValues.read(leaseKeyName)).toBeNull();
    }
  });

  it("at start, keeps the remembered device when asking whose it is gets the acceptance refusal", async () => {
    const w = world();
    await w.make().start(organizationId);
    const device = w.keyValues.read("polaris.offline.device");
    const lease = w.keyValues.read(leaseKeyName);
    const registered = w.calls.registerDevice;
    const issued = w.calls.issueLease;

    w.failures.deviceIsMineError = legalRefusal();
    const runtime = w.make();
    await runtime.start(organizationId);

    expect(w.calls.registerDevice).toBe(registered);
    expect(w.calls.issueLease).toBe(issued);
    expect(w.keyValues.read("polaris.offline.device")).toBe(device);
    expect(w.keyValues.read(leaseKeyName)).toBe(lease);
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      legalAcceptanceRequired: true,
      phase: "unavailable",
      reason: "legal_acceptance_required",
      sessionRefused: false,
    });
  });

  it("at start with no lease in cache, a refused lease keeps the device, registers nothing again and deletes nothing", async () => {
    const w = world();
    await w.make().start(organizationId);
    const device = w.keyValues.read("polaris.offline.device");
    const registered = w.calls.registerDevice;
    w.keyValues.remove(leaseKeyName);

    w.failures.issueLease.push(legalRefusal());
    const runtime = w.make();
    await runtime.start(organizationId);

    expect(w.calls.registerDevice).toBe(registered);
    expect(w.keyValues.read("polaris.offline.device")).toBe(device);
    expect(w.wiped).toEqual([]);
    expect(w.purged).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      legalAcceptanceRequired: true,
      phase: "unavailable",
      reason: "legal_acceptance_required",
      sessionRefused: false,
    });
    expect(runtime.context()).toBeNull();

    // once accepted, the next start opens normally with the same device
    const later = w.make();
    await later.start(organizationId);
    expect(later.getSnapshot()).toMatchObject({
      legalAcceptanceRequired: false,
      phase: "ready",
      reason: null,
    });
    expect(w.calls.registerDevice).toBe(registered);
  });

  it("the work source of an update throws while the sync is stopped by the acceptance, and not after it goes through", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    refuseAcceptance(w);

    await expect(runtime.workSource().sync()).rejects.toThrow(
      "legal_acceptance_required"
    );

    w.failures.push = false;
    w.failures.pushCode = undefined;
    w.failures.pushData = undefined;
    await expect(runtime.workSource().sync()).resolves.toBeUndefined();
  });
});

describe("conexão com prova (F7)", () => {
  const leaseKeyName = `polaris.offline.lease.${userId}.${organizationId}`;

  /** Starts proven online, with one command queued; then the connection can be flipped. */
  async function readyThenFlip(
    w: ReturnType<typeof world>,
    flags: { proven: boolean; mayTry: boolean }
  ) {
    const runtime = await readyWithQueue(w, {
      isOnline: () => flags.proven,
      mayTry: () => flags.mayTry,
    });
    return runtime;
  }

  async function readyWithQueue(
    w: ReturnType<typeof world>,
    extra: Partial<RuntimeDependencies> = {}
  ) {
    const runtime = w.make(null, extra);
    await runtime.start(organizationId);
    await queueProduct(runtime, "Camiseta", 1);
    return runtime;
  }

  /** One lock per name across runtimes, `ifAvailable` like navigator.locks. */
  function sharedLock() {
    const held = new Set<string>();
    return async (name: string, task: () => Promise<void>) => {
      if (held.has(name)) {
        return false;
      }
      held.add(name);
      try {
        await task();
        return true;
      } finally {
        held.delete(name);
      }
    };
  }

  function deferred() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  describe("an answer that did not come from the Worker is no refusal", () => {
    it("a 403 without the mark keeps the copy, the lease and the session", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const lease = w.keyValues.read(leaseKeyName);
      w.failures.pushError = new NoWorkerAnswerError("intercepted");

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "ready",
        reason: null,
        sessionRefused: false,
      });
      expect(w.wiped).toEqual([]);
      expect(w.purged).toEqual([]);
      expect(w.keyValues.read(leaseKeyName)).toBe(lease);
      expect(runtime.context()).not.toBeNull();
      expect(runtime.getSnapshot().counts.pending).toBe(1);
    });

    it("an oRPC FORBIDDEN from the Worker drops the copy, as before", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      w.failures.pushError = Object.assign(new Error("forbidden"), {
        code: "FORBIDDEN",
      });

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        phase: "unavailable",
        sessionRefused: true,
      });
      expect(w.wiped).toEqual([scopeOf()]);
      expect(w.keyValues.read(leaseKeyName)).toBeNull();
    });

    it("a FORBIDDEN for the legal acceptance is an acceptance, never a refused session", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      w.failures.pushError = Object.assign(new Error("forbidden"), {
        code: "FORBIDDEN",
        data: { reason: "legal_acceptance_required" },
      });

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        legalAcceptanceRequired: true,
        phase: "ready",
        reason: "legal_acceptance_required",
        sessionRefused: false,
      });
      expect(w.wiped).toEqual([]);
      expect(w.keyValues.read(leaseKeyName)).not.toBeNull();
    });

    function scopeOf() {
      return `${userId}-${organizationId}`;
    }
  });

  describe("how a failed sync ends", () => {
    it("a network failure is no 'sync_failed': reason stays null and online follows the connection", async () => {
      const w = world();
      let proven = true;
      const runtime = await readyWithQueue(w, {
        isOnline: () => proven,
        mayTry: () => true,
      });
      w.failures.pushError = new TypeError("Failed to fetch");
      // the connection decides the state while the try is on its way
      w.gates.push = Promise.resolve().then(() => {
        proven = false;
      });

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        online: false,
        reason: null,
        syncing: false,
      });
      expect(runtime.getSnapshot().counts.pending).toBe(1);
    });

    it("a network failure with the connection still proven keeps online true", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      w.failures.pushError = new TypeError("Failed to fetch");

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        online: true,
        reason: null,
      });
    });

    it("a Worker killed for CPU (1102) is not offline and says nothing for 60 s; then 'sync_failed'", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      // what oRPC throws for the platform's HTML 503 (`server_failed`: cf-ray, no mark)
      w.failures.pushError = new ORPCError("SERVICE_UNAVAILABLE", {
        status: 503,
      });

      await runtime.syncNow();
      expect(runtime.getSnapshot()).toMatchObject({
        online: true,
        reason: null,
        syncing: false,
      });
      expect(runtime.retriesQuietly()).toBe(true);
      expect(runtime.getSnapshot().counts.pending).toBe(1);

      w.advance(59 / 3600);
      await runtime.syncNow();
      expect(runtime.getSnapshot().reason).toBeNull();

      w.advance(1 / 3600); // 60 s in a row with no good sync
      await runtime.syncNow();
      expect(runtime.getSnapshot().reason).toBe("sync_failed");
      expect(runtime.retriesQuietly()).toBe(false);
      expect(runtime.getSnapshot().counts.pending).toBe(1);
    });

    it("a good sync between two deaths for CPU starts the 60 s again", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const died = new ORPCError("SERVICE_UNAVAILABLE", { status: 503 });
      w.failures.pushError = died;
      await runtime.syncNow();
      w.advance(50 / 3600);
      w.failures.pushError = undefined;
      await runtime.syncNow();
      expect(runtime.retriesQuietly()).toBe(false);

      await queueProduct(runtime, "Boné", 1);
      w.failures.pushError = died;
      w.advance(20 / 3600);
      await runtime.syncNow();
      expect(runtime.getSnapshot().reason).toBeNull();
      expect(runtime.retriesQuietly()).toBe(true);
    });

    it("a death for CPU long after the last one starts a quiet minute of its own, and no answer is never retried quietly", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const died = new ORPCError("SERVICE_UNAVAILABLE", { status: 503 });
      w.failures.pushError = died;
      await runtime.syncNow();
      w.advance(10 / 60); // 10 min with no sync at all (the page hidden)
      await runtime.syncNow();
      expect(runtime.getSnapshot().reason).toBeNull();
      expect(runtime.retriesQuietly()).toBe(true);

      w.failures.pushError = new TypeError("Failed to fetch");
      await runtime.syncNow();
      expect(runtime.retriesQuietly()).toBe(false);
    });

    it("a server failure (5xx) is 'sync_failed'", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      w.failures.pushError = Object.assign(new Error("boom"), {
        code: "INTERNAL_SERVER_ERROR",
      });

      await runtime.syncNow();

      expect(runtime.getSnapshot()).toMatchObject({
        reason: "sync_failed",
        sessionRefused: false,
      });
    });
  });

  describe("the state never stops the real try", () => {
    it("with the connection not proven but the browser able, the sync pushes for real", async () => {
      const w = world();
      const flags = { mayTry: true, proven: true };
      const runtime = await readyThenFlip(w, flags);
      flags.proven = false;
      const before = w.calls.push;

      await runtime.syncNow();

      expect(w.calls.push).toBeGreaterThan(before);
      expect(runtime.getSnapshot().counts.pending).toBe(0);
    });

    it("when nothing may leave, the push is not called and the sync ends as no answer", async () => {
      const w = world();
      const flags = { mayTry: true, proven: true };
      const runtime = await readyThenFlip(w, flags);
      flags.proven = false;
      flags.mayTry = false;

      await runtime.syncNow();

      expect(w.calls.push).toBe(0);
      expect(runtime.getSnapshot()).toMatchObject({ online: false });
      expect(runtime.getSnapshot().counts.pending).toBe(1);
    });
  });

  describe("'Sair' tries the send for real", () => {
    it("rejects with 'offline' when the push got no answer", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const workspace = runtime.logoutWorkspace();
      w.failures.pushError = new TypeError("Failed to fetch");

      await expect(workspace?.trySync()).rejects.toThrow("offline");
    });

    it("rejects with 'offline' when the answer was not the Worker's", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const workspace = runtime.logoutWorkspace();
      w.failures.pushError = new NoWorkerAnswerError("unproven");

      await expect(workspace?.trySync()).rejects.toThrow("offline");
    });

    it("does not reject when the server answered, even with a failure", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      const workspace = runtime.logoutWorkspace();
      w.failures.pushError = Object.assign(new Error("boom"), {
        code: "INTERNAL_SERVER_ERROR",
      });

      await expect(workspace?.trySync()).resolves.toBeUndefined();
    });

    it("sends with the connection not proven when the browser may try", async () => {
      const w = world();
      const flags = { mayTry: true, proven: true };
      const runtime = await readyThenFlip(w, flags);
      flags.proven = false;

      await expect(runtime.logoutWorkspace()?.trySync()).resolves.toBe(
        undefined
      );
      expect(w.calls.push).toBeGreaterThan(0);
    });

    it("rejects with 'offline' without trying when nothing may leave", async () => {
      const w = world();
      const flags = { mayTry: true, proven: true };
      const runtime = await readyThenFlip(w, flags);
      flags.proven = false;
      flags.mayTry = false;

      await expect(runtime.logoutWorkspace()?.trySync()).rejects.toThrow(
        "offline"
      );
      expect(w.calls.push).toBe(0);
    });
  });

  it("never sends the queue of user A under the session of user B", async () => {
    const w = world();
    const runtime = await readyWithQueue(w);
    w.session.user = "user-2";

    await runtime.syncNow();

    expect(w.calls.push).toBe(0);
    expect(w.server.executions).toBe(0);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "session_changed",
    });
  });

  describe("one pull after the push", () => {
    it("pulls once per sync with the cursor ready, with or without a queue", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      w.calls.pull = 0;

      await runtime.syncNow(); // sends the product, then catches up
      expect(w.calls.pull).toBe(1);

      await runtime.syncNow(); // nothing queued
      expect(w.calls.pull).toBe(2);
    });

    it("counts the queue as soon as the push answered, before the pull ends", async () => {
      const w = world();
      const runtime = await readyWithQueue(w);
      expect(runtime.getSnapshot().counts.pending).toBe(1);
      const gate = deferred();
      w.gates.pull = gate.promise;
      w.calls.pull = 0;

      const sync = runtime.syncNow();
      await vi.waitFor(() => expect(w.calls.pull).toBe(1));

      expect(runtime.getSnapshot().counts.pending).toBe(0);
      expect(runtime.getSnapshot().syncing).toBe(true);
      gate.release();
      await sync;
      expect(runtime.getSnapshot().syncing).toBe(false);
    });
  });

  it("across two runtimes sharing a lock, one sync runs and the other does not push", async () => {
    const w = world();
    const exclusive = sharedLock();
    const first = await readyWithQueue(w, { exclusive });
    const second = w.make(null, { exclusive });
    await second.start(organizationId);
    const gate = deferred();
    w.gates.push = gate.promise;

    const running = first.syncNow();
    await vi.waitFor(() => expect(w.calls.push).toBe(1));
    await second.syncNow();

    expect(w.calls.push).toBe(1);
    gate.release();
    await running;
    expect(w.calls.push).toBe(1);
    expect(first.getSnapshot().counts.pending).toBe(0);
  });

  it("marks the phases of a sync in order", async () => {
    const w = world();
    const marks: string[] = [];
    const runtime = await readyWithQueue(w, { mark: (m) => marks.push(m) });
    marks.length = 0;

    await runtime.syncNow();

    expect(marks[0]).toBe("sync:start");
    expect(marks.at(-1)).toBe("sync:done");
    const order = [
      "sync:start",
      "sync:phase:sessao",
      "sync:phase:lease",
      "sync:phase:push",
      "sync:phase:contagens",
      "sync:phase:catchUp",
      "sync:done",
    ];
    expect(order.map((name) => marks.indexOf(name))).toEqual(
      [...order.map((name) => marks.indexOf(name))].sort((a, b) => a - b)
    );
    expect(order.every((name) => marks.includes(name))).toBe(true);
  });

  it("marks a plain pull when nothing was sent", async () => {
    const w = world();
    const marks: string[] = [];
    const runtime = w.make(null, { mark: (m) => marks.push(m) });
    await runtime.start(organizationId);
    marks.length = 0;

    await runtime.syncNow();

    expect(marks).toContain("sync:phase:pull");
    expect(marks).not.toContain("sync:phase:catchUp");
  });

  it("connectionChanged puts the connection state in the snapshot and tells the screens", async () => {
    const w = world();
    let proven = true;
    const runtime = w.make(null, { isOnline: () => proven });
    await runtime.start(organizationId);
    const heard = vi.fn();
    runtime.subscribe(heard);
    expect(runtime.getSnapshot().online).toBe(true);

    proven = false;
    runtime.connectionChanged();
    expect(runtime.getSnapshot().online).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);

    runtime.connectionChanged(); // nothing changed: nobody is told
    expect(heard).toHaveBeenCalledTimes(1);

    proven = true;
    runtime.connectionChanged();
    expect(runtime.getSnapshot().online).toBe(true);
  });
});
