import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { attemptLogout } from "../logout-guard";
import { MemoryOutboxStorage } from "../outbox/memory-storage";
import { Outbox } from "../outbox/outbox";
import { createOfflineProduct } from "../product-create";
import { FakeCatalogServer, FakeWriter } from "../test-support";
import {
  type KeyValueStore,
  OfflineRuntime,
  type OpenedStores,
  type RuntimeApi,
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
  const calls = { issueLease: 0, push: 0, registerDevice: 0 };
  const labels: (string | null)[] = [];
  const owners = new Map<string, string>();
  const session = { user: userId };
  const failures: { issueLease: Error[]; push: boolean } = {
    issueLease: [],
    push: false,
  };
  const keyValues = memoryKeyValues();
  const stores = new Map<string, { outbox: Outbox; writer: FakeWriter }>();
  const closed: string[] = [];
  const purged: { discardPending: boolean }[] = [];

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
  const api: RuntimeApi = {
    deviceIsMine: (deviceId) =>
      Promise.resolve(owners.get(deviceId) === session.user),
    issueLease: (deviceId, org) => {
      calls.issueLease += 1;
      const failure = failures.issueLease.shift();
      return failure ? Promise.reject(failure) : issue(deviceId, org);
    },
    push: () => (input) => {
      calls.push += 1;
      if (failures.push) {
        return Promise.reject(new Error("server down"));
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
    source: () => server,
  };
  const make = (deviceLabel: string | null = null) =>
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
      openStores: (namespace, deviceId) => {
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
          },
          ...value,
        };
        return Promise.resolve(opened);
      },
      purge: (_namespace, purgeOptions) => {
        purged.push(purgeOptions);
        return Promise.resolve();
      },
    });
  return {
    advance: (hours: number) => {
      clock = new Date(clock.getTime() + hours * HOUR);
    },
    calls,
    closed,
    failures,
    keyValues,
    labels,
    make,
    network,
    purged,
    server,
    session,
    stores,
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
    expect(w.keyValues.data.size).toBe(3); // the device, the lease and the namespace registry
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
    expect(await attemptLogout([workspace])).toEqual({ status: "ready" });
    expect(w.purged).toEqual([{ discardPending: false }]);
    expect(w.keyValues.data.size).toBe(0);
    expect(runtime.getSnapshot().phase).toBe("off");
    expect(runtime.context()).toBeNull();
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
    expect(w.keyValues.data.size).toBe(3);
  });

  it("logging out also covers the other organizations this browser holds, and purges them all", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start("org-1");
    await runtime.start("org-2"); // the person switched organization
    const workspaces = await runtime.logoutWorkspaces();
    expect(workspaces.map((workspace) => workspace.label)).toEqual([
      "org-2",
      "org-1 (outra organização)",
    ]);
    expect(await attemptLogout(workspaces)).toEqual({ status: "ready" });
    expect(w.purged).toHaveLength(2);
    expect(w.keyValues.data.size).toBe(0); // device, lease and registry are all gone
  });

  it("work queued in another organization blocks the logout, purges nothing and releases what was opened", async () => {
    const w = world();
    const runtime = w.make();
    await runtime.start("org-1");
    await queueProduct(runtime, "Na outra organização", 1);
    await runtime.start("org-2");
    const workspaces = await runtime.logoutWorkspaces();

    const outcome = await attemptLogout(workspaces);

    expect(outcome).toMatchObject({ status: "blocked" });
    if (outcome.status === "blocked") {
      expect(outcome.blocked.map((item) => item.label)).toEqual([
        "org-1 (outra organização)",
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
