import { describe, expect, it, vi } from "vitest";
import type { LogoutWorkspace } from "../logout-guard";
import type { Outbox } from "../outbox/outbox";
import {
  discardAndLeave,
  type LogoutDevice,
  type LogoutFlowDependencies,
  startLogout,
} from "./logout-flow";

const DEVICE_ID = "0199c2d0-0000-7000-8000-0000000000d1";

/** A workspace with `queued` pending commands; its sync sends them all, or fails offline. */
function workspace(queued: number, order: string[], online = true) {
  let pending = queued;
  const snapshot = () =>
    Promise.resolve({
      blockedBy: null,
      commands: Array.from({ length: pending }, (_, n) => ({
        commandId: `command-${n}`,
        createdAt: "2026-10-22T12:00:00.000Z",
        rejection: null,
        status: "pending",
        type: "sale.confirm",
      })),
      pending,
      rejected: 0,
      sending: 0,
    });
  const value: LogoutWorkspace = {
    label: "Loja",
    outbox: { snapshot } as unknown as Outbox,
    purge: (options) => {
      order.push(options.discardPending ? "discard" : "purge");
      return Promise.resolve();
    },
    trySync: () => {
      order.push("sync");
      if (!online) {
        return Promise.reject(new Error("offline"));
      }
      pending = 0;
      return Promise.resolve();
    },
  };
  return Promise.resolve(value);
}

type Revoke = LogoutDevice["revoke"];

function flow(
  workspaces: LogoutWorkspace[],
  order: string[],
  options: {
    id?: string | null;
    online?: boolean;
    revoke?: Revoke;
    signOut?: () => Promise<void>;
    timeoutMs?: number;
  } = {}
): LogoutFlowDependencies & { revoke: ReturnType<typeof vi.fn<Revoke>> } {
  const revoke = vi.fn<Revoke>((deviceId) => {
    order.push(`revoke ${deviceId}`);
    return options.revoke
      ? options.revoke(deviceId)
      : Promise.resolve({ endedCurrentSession: true });
  });
  return {
    device: {
      forget: () => order.push("forget"),
      id: options.id === undefined ? DEVICE_ID : options.id,
      isOnline: () => options.online ?? true,
      revoke,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    },
    leave: () => order.push("leave"),
    revoke,
    signOut: () => {
      order.push("signOut");
      return options.signOut?.() ?? Promise.resolve();
    },
    workspaces,
  };
}

const rpcFailure = (status: number, code: string, reason?: string) =>
  Object.assign(new Error(code), {
    code,
    data: reason ? { reason } : undefined,
    status,
  });

describe("Sair revokes this device (ADR 0048, emenda de 22/10)", () => {
  it("protects the queue, revokes this device, ends the session, forgets the device and leaves, in that order", async () => {
    const order: string[] = [];
    const result = await startLogout(flow([await workspace(0, order)], order));
    expect(result).toEqual({ status: "signed_out" });
    expect(order).toEqual([
      "purge",
      `revoke ${DEVICE_ID}`,
      "signOut",
      "forget",
      "leave",
    ]);
  });

  it("with operations queued and a network, sends them first and only then revokes", async () => {
    const order: string[] = [];
    await startLogout(flow([await workspace(2, order)], order));
    expect(order).toEqual([
      "sync",
      "purge",
      `revoke ${DEVICE_ID}`,
      "signOut",
      "forget",
      "leave",
    ]);
  });

  it("revokes nothing, ends nothing and forgets nothing while the guard blocks", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(2, order, false)], order);
    const result = await startLogout(deps);
    expect(result.status).toBe("blocked");
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(order).toEqual(["sync"]);
  });

  it("offline, does not try to revoke and leaves as before", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, { online: false });
    expect(await startLogout(deps)).toEqual({ status: "signed_out" });
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(order).toEqual(["purge", "signOut", "forget", "leave"]);
  });

  it("with no device known, does not try to revoke", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, { id: null });
    expect(await startLogout(deps)).toEqual({ status: "signed_out" });
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["no network", () => new TypeError("Failed to fetch")],
    [
      "a 401 (the session already ended)",
      () => rpcFailure(401, "UNAUTHORIZED"),
    ],
    ["a 5xx", () => rpcFailure(503, "SERVICE_UNAVAILABLE")],
    [
      "NOT_FOUND (purged, or a Worker without the command)",
      () => rpcFailure(404, "NOT_FOUND"),
    ],
    [
      "not_current_device",
      () => rpcFailure(403, "FORBIDDEN", "not_current_device"),
    ],
    [
      "legal_acceptance_required",
      () => rpcFailure(403, "FORBIDDEN", "legal_acceptance_required"),
    ],
  ])(
    "a revocation that fails with %s still signs out, forgets the device and leaves, once",
    async (_name, failure) => {
      const order: string[] = [];
      const deps = flow([await workspace(0, order)], order, {
        revoke: () => Promise.reject(failure()),
      });
      expect(await startLogout(deps)).toEqual({ status: "signed_out" });
      expect(deps.revoke).toHaveBeenCalledTimes(1);
      expect(order).toEqual([
        "purge",
        `revoke ${DEVICE_ID}`,
        "signOut",
        "forget",
        "leave",
      ]);
    }
  );

  it("a revocation that does not answer in time is dropped, and the logout goes on", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, {
      revoke: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    expect(await startLogout(deps)).toEqual({ status: "signed_out" });
    expect(deps.revoke).toHaveBeenCalledTimes(1);
    expect(order.slice(-3)).toEqual(["signOut", "forget", "leave"]);
  });

  it("a late failure of a revocation dropped by the time limit is not an unhandled rejection", async () => {
    const order: string[] = [];
    let fail: (error: Error) => void = () => undefined;
    const deps = flow([await workspace(0, order)], order, {
      revoke: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      timeoutMs: 10,
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await startLogout(deps)).toEqual({ status: "signed_out" });
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("when the revocation ended the session, a failed sign-out is no error: the person leaves", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, {
      signOut: () => Promise.reject(new Error("network")),
    });
    expect(await startLogout(deps)).toEqual({ status: "signed_out" });
    expect(order.slice(-2)).toEqual(["forget", "leave"]);
  });

  it("when the revocation did not end the session, a failed sign-out is reported as before", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, {
      revoke: () => Promise.reject(rpcFailure(503, "SERVICE_UNAVAILABLE")),
      signOut: () => Promise.reject(new Error("network")),
    });
    expect(await startLogout(deps)).toEqual({ status: "sign_out_failed" });
    expect(order).not.toContain("leave");
    // the device id is not kept for a next sign-in (plan B, rejected for the v1)
    expect(order).toContain("forget");
  });

  it("an answer that did not end the session leaves the sign-out to end it", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(0, order)], order, {
      revoke: () => Promise.resolve({ endedCurrentSession: false }),
      signOut: () => Promise.reject(new Error("network")),
    });
    expect(await startLogout(deps)).toEqual({ status: "sign_out_failed" });
  });

  it("discarding on purpose revokes after the discard", async () => {
    const order: string[] = [];
    const deps = flow([await workspace(2, order, false)], order);
    expect(await discardAndLeave(deps)).toEqual({ status: "signed_out" });
    expect(order).toEqual([
      "discard",
      `revoke ${DEVICE_ID}`,
      "signOut",
      "forget",
      "leave",
    ]);
  });
});
