import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import {
  attemptLogout,
  discardAndLogout,
  LogoutDiscardNotConfirmedError,
  type LogoutWorkspace,
} from "./logout-guard";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function workspace(
  label: string,
  commands: number,
  trySync: (outbox: Outbox) => Promise<unknown> = () => Promise.resolve()
) {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      grantId: uuid(900),
      issuedAt: new Date(now.getTime() - 3_600_000),
      organizationId,
      userId,
    }),
    key
  );
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId,
    storage: new MemoryOutboxStorage(),
    userId,
  });
  for (let n = 1; n <= commands; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
    await outbox.enqueue({
      baseVersion: null,
      commandId: uuid(100 + n),
      deviceId,
      lease,
      organizationId,
      payload: { items: [], n, occurredAt: now.toISOString() },
      type: "sale.confirm",
    });
  }
  const purge = vi.fn((_options: { discardPending: boolean }) =>
    Promise.resolve()
  );
  const value: LogoutWorkspace = {
    label,
    outbox,
    purge,
    trySync: () => trySync(outbox),
  };
  return { outbox, purge, value };
}

/** A server that accepts everything. */
async function acceptAll(outbox: Outbox) {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: acknowledged in queue order
    const next = await outbox.next();
    if (!next) {
      return;
    }
    await outbox.markSending(next.commandId);
    await outbox.acknowledge(next.commandId);
  }
}

describe("logging out", () => {
  it("purges and is ready at once when nothing is queued, without touching the network", async () => {
    const trySync = vi.fn(() => Promise.resolve());
    const { purge, value } = await workspace("Loja", 0, trySync);
    expect(await attemptLogout([value])).toEqual({ status: "ready" });
    expect(trySync).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith({ discardPending: false });
  });

  it("sends what is queued first and purges only once the queue is empty", async () => {
    const { outbox, purge, value } = await workspace("Loja", 2, acceptAll);
    expect(await attemptLogout([value])).toEqual({ status: "ready" });
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(purge).toHaveBeenCalledWith({ discardPending: false });
  });

  it("is blocked, with nothing purged and the queue intact, when there is no network", async () => {
    const { outbox, purge, value } = await workspace("Loja", 2, () =>
      Promise.reject(new Error("offline"))
    );
    const outcome = await attemptLogout([value]);
    expect(outcome).toMatchObject({
      blocked: [
        { label: "Loja", pending: 2, reason: "offline", sending: 0, total: 2 },
      ],
      status: "blocked",
    });
    expect(purge).not.toHaveBeenCalled();
    expect((await outbox.snapshot()).commands).toHaveLength(2);
  });

  it("is blocked as refused when the server refused something, and hands over what needs attention", async () => {
    const { purge, value } = await workspace("Loja", 2, async (outbox) => {
      const head = await outbox.next();
      if (head) {
        await outbox.markSending(head.commandId);
        await outbox.reject(head.commandId, "insufficient_stock");
      }
    });
    const outcome = await attemptLogout([value]);
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") {
      return;
    }
    expect(outcome.blocked[0]).toMatchObject({ reason: "refused", total: 2 });
    expect(outcome.blocked[0]?.attention.items).toMatchObject([
      { cause: "insufficient_stock", code: "insufficient_stock" },
    ]);
    expect(outcome.blocked[0]?.attention.waitingBehind).toBe(1);
    expect(purge).not.toHaveBeenCalled();
  });

  it("reports commands whose answer is unknown (sending) so the person can be warned", async () => {
    const { value } = await workspace("Loja", 2, async (outbox) => {
      const head = await outbox.next();
      if (head) {
        await outbox.markSending(head.commandId);
      }
      throw new Error("connection dropped");
    });
    const outcome = await attemptLogout([value]);
    expect(outcome).toMatchObject({
      blocked: [{ reason: "offline", sending: 1 }],
      status: "blocked",
    });
  });

  it("purges nothing anywhere while any workspace still holds work", async () => {
    const clean = await workspace("Matriz", 0);
    const busy = await workspace("Filial", 1, () =>
      Promise.reject(new Error("offline"))
    );
    const outcome = await attemptLogout([clean.value, busy.value]);
    expect(outcome.status).toBe("blocked");
    expect(clean.purge).not.toHaveBeenCalled();
    expect(busy.purge).not.toHaveBeenCalled();
  });

  it("never reports ready when the purge fails", async () => {
    const { purge, value } = await workspace("Loja", 0);
    purge.mockRejectedValueOnce(new Error("opfs busy"));
    await expect(attemptLogout([value])).rejects.toThrow("opfs busy");
  });
});

describe("discarding on purpose", () => {
  it("needs the confirmation of the person as an argument", async () => {
    const { purge, value } = await workspace("Loja", 2);
    await expect(
      discardAndLogout([value], { confirmed: false })
    ).rejects.toBeInstanceOf(LogoutDiscardNotConfirmedError);
    expect(purge).not.toHaveBeenCalled();
  });

  it("purges with the discard flag and says how many commands were thrown away", async () => {
    const first = await workspace("Loja", 2);
    const second = await workspace("Filial", 1);
    expect(
      await discardAndLogout([first.value, second.value], { confirmed: true })
    ).toEqual({ discarded: 3, status: "ready" });
    expect(first.purge).toHaveBeenCalledWith({ discardPending: true });
    expect(second.purge).toHaveBeenCalledWith({ discardPending: true });
  });
});
