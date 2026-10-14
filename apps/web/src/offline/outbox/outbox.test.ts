import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import {
  InvalidOutboxCommandError,
  OUTBOX_MAX_PAYLOAD_BYTES,
  type OutboxCommandInput,
} from "./command";
import { MemoryOutboxStorage } from "./memory-storage";
import {
  OfflineLeaseUnusableError,
  Outbox,
  OutboxCommandConflictError,
  OutboxCommandNotFoundError,
  OutboxCommandStateError,
} from "./outbox";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const expiresAt = new Date(issuedAt.getTime() + 72 * 3_600_000);
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function leaseFor(
  overrides: Partial<{ dev: string; org: string; sub: string }> = {}
) {
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId: overrides.dev ?? deviceId,
      epoch: 0,
      expiresAt,
      grantId: uuid(900),
      issuedAt,
      organizationId: overrides.org ?? organizationId,
      userId: overrides.sub ?? userId,
    }),
    key
  );
}

async function command(
  n: number,
  overrides: Partial<OutboxCommandInput> = {}
): Promise<OutboxCommandInput> {
  return {
    baseVersion: null,
    commandId: uuid(n),
    deviceId,
    lease: await leaseFor(),
    organizationId,
    payload: { items: [{ quantity: n, variantId: uuid(100 + n) }] },
    type: "sale.confirm",
    ...overrides,
  };
}

function outboxAt(now: Date, storage = new MemoryOutboxStorage()) {
  return {
    outbox: new Outbox({
      deviceId,
      now: () => now,
      organizationId,
      storage,
      userId,
    }),
    storage,
  };
}

const during = new Date(issuedAt.getTime() + 3_600_000);

describe("outbox enqueue", () => {
  it("stores commands durably in send order with monotonic positions", async () => {
    const { outbox } = outboxAt(during);
    await outbox.enqueue(await command(1));
    await outbox.enqueue(await command(2));
    await outbox.enqueue(await command(3));
    const snapshot = await outbox.snapshot();
    expect(snapshot.commands.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(snapshot.commands.map((c) => c.commandId)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
    expect(snapshot).toMatchObject({ pending: 3, rejected: 0, sending: 0 });
    expect(snapshot.commands[0]).toMatchObject({
      attempts: 0,
      createdAt: during.toISOString(),
      rejection: null,
      status: "pending",
    });
  });

  it("is idempotent for the same command and rejects a changed one", async () => {
    const { outbox } = outboxAt(during);
    const first = await outbox.enqueue(await command(1));
    const again = await outbox.enqueue(await command(1));
    expect(again).toEqual(first);
    expect((await outbox.snapshot()).commands).toHaveLength(1);
    await expect(
      outbox.enqueue(await command(1, { payload: { items: [] } }))
    ).rejects.toBeInstanceOf(OutboxCommandConflictError);
    // key order of the payload does not make a different command
    const reordered = await outbox.enqueue(
      await command(2, { payload: { a: 2, b: 1 } })
    );
    expect(
      await outbox.enqueue(await command(2, { payload: { a: 2, b: 1 } }))
    ).toEqual(reordered);
  });

  it("never reuses a position, even after commands left", async () => {
    const { outbox } = outboxAt(during);
    await outbox.enqueue(await command(1));
    await outbox.markSending(uuid(1));
    await outbox.acknowledge(uuid(1));
    const second = await outbox.enqueue(await command(2));
    expect(second.seq).toBe(2);
  });

  it("refuses commands that are malformed, oversized or for another namespace", async () => {
    const { outbox } = outboxAt(during);
    const bad: [Partial<OutboxCommandInput>, string][] = [
      [{ commandId: "nope" }, "command_id"],
      [{ deviceId: "nope" }, "device_id"],
      [{ type: "Sale Confirm" }, "type"],
      [{ type: "confirm" }, "type"],
      [{ baseVersion: -1 }, "base_version"],
      [{ baseVersion: 1.5 }, "base_version"],
      [{ lease: "" }, "lease"],
      [{ payload: { n: Number.NaN } }, "payload_not_json"],
      [
        { payload: { big: "x".repeat(OUTBOX_MAX_PAYLOAD_BYTES + 1) } },
        "payload_too_large",
      ],
      [{ organizationId: "other-org" }, "wrong_namespace"],
      [{ deviceId: uuid(777) }, "wrong_namespace"],
    ];
    for (const [change, reason] of bad) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      const rejected = await outbox.enqueue(await command(5, change)).then(
        () => null,
        (error: unknown) => error
      );
      expect(rejected).toBeInstanceOf(InvalidOutboxCommandError);
      expect((rejected as InvalidOutboxCommandError).reason).toBe(reason);
    }
    expect((await outbox.snapshot()).commands).toHaveLength(0);
  });
});

describe("outbox and the offline lease", () => {
  it("blocks new commands once the lease expired but keeps the queued ones", async () => {
    const storage = new MemoryOutboxStorage();
    const { outbox } = outboxAt(during, storage);
    await outbox.enqueue(await command(1));

    const { outbox: later } = outboxAt(
      new Date(expiresAt.getTime() + 1000),
      storage
    );
    await expect(later.enqueue(await command(2))).rejects.toMatchObject({
      reason: "expired",
    });
    expect((await later.snapshot()).commands.map((c) => c.commandId)).toEqual([
      uuid(1),
    ]);
    // the same command again is still recognized, with no new lease check
    expect((await later.enqueue(await command(1))).commandId).toBe(uuid(1));
  });

  it("refuses a lease of another user, organization or device, or a garbage one", async () => {
    const { outbox } = outboxAt(during);
    const leases = [
      await leaseFor({ sub: "someone-else" }),
      await leaseFor({ org: "other-org" }),
      await leaseFor({ dev: uuid(555) }),
    ];
    for (const lease of leases) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(
        outbox.enqueue(await command(3, { lease }))
      ).rejects.toMatchObject({
        reason: "mismatch",
      });
    }
    await expect(
      outbox.enqueue(await command(3, { lease: "garbage" }))
    ).rejects.toBeInstanceOf(OfflineLeaseUnusableError);
  });
});

describe("outbox sending, rejection and recovery", () => {
  async function filled() {
    const ctx = outboxAt(during);
    for (const n of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
      await ctx.outbox.enqueue(await command(n));
    }
    return ctx;
  }

  it("offers the head only while it is waiting", async () => {
    const { outbox } = await filled();
    expect((await outbox.next())?.commandId).toBe(uuid(1));
    await outbox.markSending(uuid(1));
    expect(await outbox.next()).toBeNull();
    await outbox.acknowledge(uuid(1));
    expect((await outbox.next())?.commandId).toBe(uuid(2));
  });

  it("counts attempts and records when the command was last sent", async () => {
    const { outbox } = await filled();
    const sent = await outbox.markSending(uuid(1));
    expect(sent).toMatchObject({
      attempts: 1,
      lastAttemptAt: during.toISOString(),
      status: "sending",
    });
    await expect(outbox.markSending(uuid(1))).rejects.toBeInstanceOf(
      OutboxCommandStateError
    );
  });

  it("keeps a rejected command at the head, blocking those behind it, until resolved", async () => {
    const { outbox } = await filled();
    await outbox.markSending(uuid(1));
    const rejected = await outbox.reject(uuid(1), "stock_insufficient");
    expect(rejected.rejection?.code).toBe("stock_insufficient");
    const snapshot = await outbox.snapshot();
    expect(snapshot.blockedBy?.commandId).toBe(uuid(1));
    expect(snapshot).toMatchObject({ pending: 2, rejected: 1 });
    expect(await outbox.next()).toBeNull();

    await outbox.retry(uuid(1));
    expect((await outbox.next())?.commandId).toBe(uuid(1));
    expect((await outbox.snapshot()).blockedBy).toBeNull();
  });

  it("lets a person discard a refused command explicitly", async () => {
    const { outbox } = await filled();
    await outbox.markSending(uuid(1));
    await outbox.reject(uuid(1), "conflict");
    await outbox.discard(uuid(1));
    expect((await outbox.next())?.commandId).toBe(uuid(2));
    await expect(outbox.discard(uuid(1))).rejects.toBeInstanceOf(
      OutboxCommandNotFoundError
    );
  });

  it("validates the rejection code and the state transitions", async () => {
    const { outbox } = await filled();
    await expect(outbox.reject(uuid(1), "Bad Code")).rejects.toBeInstanceOf(
      InvalidOutboxCommandError
    );
    await expect(outbox.reject(uuid(1), "conflict")).rejects.toBeInstanceOf(
      OutboxCommandStateError
    );
    await expect(outbox.acknowledge(uuid(1))).rejects.toBeInstanceOf(
      OutboxCommandStateError
    );
    await expect(outbox.markSending(uuid(99))).rejects.toBeInstanceOf(
      OutboxCommandNotFoundError
    );
  });

  it("recovers a command left 'sending' by a restart, to be resent with the same ID", async () => {
    const storage = new MemoryOutboxStorage();
    const first = outboxAt(during, storage).outbox;
    await first.enqueue(await command(1));
    await first.markSending(uuid(1));

    // a new session over the same storage
    const restarted = outboxAt(during, storage).outbox;
    expect(await restarted.next()).toBeNull();
    expect(await restarted.recoverInterrupted()).toBe(1);
    const head = await restarted.next();
    expect(head).toMatchObject({
      attempts: 1,
      commandId: uuid(1),
      status: "pending",
    });
    expect(await restarted.recoverInterrupted()).toBe(0);
  });

  it("keeps order across many commands and interleaved acknowledgements", async () => {
    const { outbox } = outboxAt(during);
    for (let n = 1; n <= 30; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
      await outbox.enqueue(await command(n));
    }
    const sent: string[] = [];
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: sending is sequential by design
      const head = await outbox.next();
      if (!head) {
        break;
      }
      await outbox.markSending(head.commandId);
      sent.push(head.commandId);
      await outbox.acknowledge(head.commandId);
    }
    expect(sent).toEqual(Array.from({ length: 30 }, (_, i) => uuid(i + 1)));
    expect((await outbox.snapshot()).commands).toEqual([]);
  });
});
