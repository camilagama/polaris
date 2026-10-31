import { describe, expect, it, vi } from "vitest";
import type { LogoutWorkspace } from "../logout-guard";
import type { Outbox } from "../outbox/outbox";
import { logoutDependencies } from "./logout-dependencies";
import { startLogout } from "./logout-flow";

const DEVICE_ID = "0199c2d0-0000-7000-8000-0000000000d1";

function queuedWorkspace(pending: number): LogoutWorkspace {
  return {
    label: "Loja",
    outbox: {
      snapshot: () =>
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
        }),
    } as unknown as Outbox,
    purge: () => Promise.resolve(),
    trySync: () => Promise.reject(new Error("offline")),
  };
}

const effects = {
  leave: () => undefined,
  revoke: () => Promise.resolve({ endedCurrentSession: false }),
  signOut: () => Promise.resolve(),
};

function runtimeWith(inspection: {
  readable: boolean;
  workspaces: LogoutWorkspace[];
}) {
  return {
    currentDeviceId: () => DEVICE_ID,
    forgetDevice: vi.fn(),
    inspectLogout: () => Promise.resolve(inspection),
  };
}

describe("the dependencies of the protected logout", () => {
  it("an empty list the runtime could read still ends the session: there is nothing to protect", async () => {
    const deps = await logoutDependencies(
      runtimeWith({ readable: true, workspaces: [] }),
      effects
    );
    expect(deps).not.toBeNull();
    if (!deps) {
      return;
    }
    const signOut = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    const result = await startLogout({
      ...deps,
      device: { ...deps.device, isOnline: () => false },
      leave,
      signOut,
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("an empty list the runtime could not read is not a reading: no logout runs", async () => {
    expect(
      await logoutDependencies(
        runtimeWith({ readable: false, workspaces: [] }),
        effects
      )
    ).toBeNull();
  });

  it("without a runtime there is nothing to run", async () => {
    expect(await logoutDependencies(null, effects)).toBeNull();
  });

  it("a queued command still blocks: the session is not ended", async () => {
    const deps = await logoutDependencies(
      runtimeWith({ readable: true, workspaces: [queuedWorkspace(2)] }),
      effects
    );
    expect(deps).not.toBeNull();
    if (!deps) {
      return;
    }
    const signOut = vi.fn(() => Promise.resolve());
    const result = await startLogout({
      ...deps,
      device: { ...deps.device, isOnline: () => false },
      signOut,
    });
    expect(result.status).toBe("blocked");
    expect(signOut).not.toHaveBeenCalled();
  });
});
