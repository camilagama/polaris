import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { resolveRoute } from "../../app-shell/navigation-model";
import { signOfflineLease } from "../../lib/offline-lease-token";
import type { LogoutWorkspace } from "../logout-guard";
import { MemoryOutboxStorage } from "../outbox/memory-storage";
import { Outbox } from "../outbox/outbox";
import { discardAndLeave, startLogout } from "./logout-flow";
import type { RuntimeSnapshot } from "./offline-runtime";
import { SyncStatusView, syncStatusLabel } from "./sync-status";

const snapshot = (
  overrides: Partial<RuntimeSnapshot> = {}
): RuntimeSnapshot => ({
  bootstrapped: true,
  counts: { pending: 0, rejected: 0, sending: 0 },
  dataVersion: 0,
  lastSyncAt: null,
  leaseExpiresAt: null,
  online: true,
  phase: "ready",
  reason: null,
  syncing: false,
  ...overrides,
});
const counts = (
  overrides: Partial<RuntimeSnapshot["counts"]>
): RuntimeSnapshot["counts"] => ({
  pending: 0,
  rejected: 0,
  sending: 0,
  ...overrides,
});

describe("the sync status in the header", () => {
  it("says everything is synchronized when online and nothing is waiting", () => {
    expect(syncStatusLabel(snapshot())).toEqual({
      attention: false,
      text: "Tudo sincronizado",
      tone: "ok",
    });
  });

  it("tells how much is kept on the device when there is no connection", () => {
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 2 }), online: false })
      )
    ).toMatchObject({
      text: "Sem conexão · 2 operações guardadas",
      tone: "offline",
    });
    expect(syncStatusLabel(snapshot({ online: false })).text).toContain(
      "tudo guardado neste aparelho"
    );
  });

  it("shows progress while sending, and a failure that kept everything", () => {
    expect(
      syncStatusLabel(snapshot({ counts: counts({ pending: 1 }) }))
    ).toMatchObject({ text: "Enviando 1 operação…", tone: "busy" });
    expect(
      syncStatusLabel(snapshot({ reason: "sync_failed", syncing: false }))
    ).toMatchObject({ tone: "offline" });
  });

  it("a refused operation becomes a call for attention, whatever else is going on", () => {
    expect(
      syncStatusLabel(
        snapshot({ counts: counts({ pending: 3, rejected: 1 }), online: false })
      )
    ).toEqual({
      attention: true,
      text: "1 operação precisa de atenção",
      tone: "attention",
    });
  });

  it("says when the offline mode is being prepared or is not available", () => {
    expect(syncStatusLabel(snapshot({ phase: "starting" })).tone).toBe("busy");
    expect(
      syncStatusLabel(
        snapshot({ phase: "unavailable", reason: "no_lease_offline" })
      ).text
    ).toContain("indisponível");
  });

  it("renders a link to the attention page only when something needs attention", () => {
    const plain = renderToStaticMarkup(
      <SyncStatusView snapshot={snapshot()} />
    );
    expect(plain).not.toContain("<a");
    expect(plain).toContain('role="status"');
    const attention = renderToStaticMarkup(
      <SyncStatusView
        snapshot={snapshot({ counts: counts({ rejected: 2 }) })}
      />
    );
    expect(attention).toContain('href="/attention"');
    expect(attention).toContain("2 operações precisam de atenção");
  });
});

describe("the attention page route", () => {
  it("exists, outside the main menu", () => {
    expect(resolveRoute("/attention")).toMatchObject({
      id: "attention",
      kind: "page",
      navId: null,
    });
  });
});

const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const key = { id: "k1", secret: "s".repeat(40) };
const now = new Date("2026-10-14T12:30:00.000Z");

async function workspace(commands: number, trySync = () => Promise.resolve()) {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      grantId: "0199c2d0-0000-7000-8000-000000000900",
      issuedAt: new Date(now.getTime() - 3_600_000),
      organizationId: "org-1",
      userId: "user-1",
    }),
    key
  );
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId: "org-1",
    storage: new MemoryOutboxStorage(),
    userId: "user-1",
  });
  for (let n = 1; n <= commands; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
    await outbox.enqueue({
      baseVersion: null,
      commandId: `0199c2d0-0000-7000-8000-${String(100 + n).padStart(12, "0")}`,
      deviceId,
      lease,
      organizationId: "org-1",
      payload: { items: [], occurredAt: now.toISOString() },
      type: "sale.confirm",
    });
  }
  const purge = vi.fn((_options: { discardPending: boolean }) =>
    Promise.resolve()
  );
  const value: LogoutWorkspace = { label: "Loja", outbox, purge, trySync };
  return { purge, value };
}

describe("logging out end to end", () => {
  it("purges, ends the session and leaves, in that order, when nothing is queued", async () => {
    const { purge, value } = await workspace(0);
    const order: string[] = [];
    purge.mockImplementation(() => {
      order.push("purge");
      return Promise.resolve();
    });
    const result = await startLogout({
      leave: () => order.push("leave"),
      signOut: () => {
        order.push("signOut");
        return Promise.resolve();
      },
      workspaces: [value],
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(order).toEqual(["purge", "signOut", "leave"]);
  });

  it("does not touch the session, and purges nothing, while the guard blocks", async () => {
    const { purge, value } = await workspace(2, () =>
      Promise.reject(new Error("offline"))
    );
    const signOut = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    const result = await startLogout({ leave, signOut, workspaces: [value] });
    expect(result).toMatchObject({
      blocked: [{ reason: "offline", total: 2 }],
      status: "blocked",
    });
    expect(purge).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("discarding on purpose purges with the flag, then ends the session", async () => {
    const { purge, value } = await workspace(0);
    const signOut = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    expect(
      await discardAndLeave({ leave, signOut, workspaces: [value] })
    ).toEqual({ status: "signed_out" });
    expect(purge).toHaveBeenCalledWith({ discardPending: true });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("reports a session that could not be ended after the data was purged, and does not leave", async () => {
    const { value } = await workspace(0);
    const leave = vi.fn();
    expect(
      await startLogout({
        leave,
        signOut: () => Promise.reject(new Error("network")),
        workspaces: [value],
      })
    ).toEqual({ status: "sign_out_failed" });
    expect(leave).not.toHaveBeenCalled();
  });
});
