import { describe, expect, it, vi } from "vitest";
import type { LogoutWorkspace } from "../logout-guard";
import type { Outbox } from "../outbox/outbox";
import {
  endsOnlySession,
  logoutDependencies,
  plainLogoutDependencies,
  signOutFailedMessage,
} from "./logout-dependencies";
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

describe("the logout of a device with no offline runtime", () => {
  it("ends the session and leaves, with no queue to protect and no device to revoke", async () => {
    const leave = vi.fn();
    const revoke = vi.fn(() => Promise.resolve({ endedCurrentSession: false }));
    const signOut = vi.fn(() => Promise.resolve());
    const result = await startLogout(
      plainLogoutDependencies({ leave, revoke, signOut })
    );
    expect(result.status).toBe("signed_out");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("stays on the page when the session could not be ended", async () => {
    const leave = vi.fn();
    const result = await startLogout(
      plainLogoutDependencies({
        leave,
        revoke: effects.revoke,
        signOut: () => Promise.reject(new Error("sign_out_failed")),
      })
    );
    expect(result.status).toBe("sign_out_failed");
    expect(leave).not.toHaveBeenCalled();
  });
});

describe("what a failed sign-out says", () => {
  const failing = {
    ...effects,
    signOut: () => Promise.reject(new Error("sign_out_failed")),
  };

  async function failedMessage(
    runtime: ReturnType<typeof runtimeWith> | null,
    endsWithoutRuntime: boolean
  ) {
    const deps = endsOnlySession(runtime, endsWithoutRuntime)
      ? plainLogoutDependencies(failing)
      : await logoutDependencies(runtime, failing);
    expect(deps).not.toBeNull();
    if (!deps) {
      throw new Error("no dependencies");
    }
    const result = await startLogout(deps);
    expect(result.status).toBe("sign_out_failed");
    return signOutFailedMessage(endsOnlySession(runtime, endsWithoutRuntime));
  }

  it("without a runtime nothing was erased, so the message does not say it was", async () => {
    const message = await failedMessage(null, true);
    expect(message).not.toContain("apagados");
    expect(message).toBe(
      "Não foi possível sair. Confira a internet e tente de novo."
    );
  });

  it("with the runtime the message keeps saying the device was cleared", async () => {
    const message = await failedMessage(
      runtimeWith({ readable: true, workspaces: [] }),
      true
    );
    expect(message).toBe(
      "Os dados deste aparelho foram apagados, mas não foi possível encerrar a sessão. Recarregue a página."
    );
  });

  it("only the screen that asked for a way out without runtime takes the plain path", () => {
    const runtime = runtimeWith({ readable: true, workspaces: [] });
    expect(endsOnlySession(null, true)).toBe(true);
    expect(endsOnlySession(null, false)).toBe(false);
    expect(endsOnlySession(runtime, true)).toBe(false);
    expect(endsOnlySession(runtime, false)).toBe(false);
  });
});
