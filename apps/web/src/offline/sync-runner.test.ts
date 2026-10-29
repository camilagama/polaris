import { ORPCError } from "@orpc/client";
import type { PushCommandReadModel } from "@polaris/contracts";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { OUTBOX_MAX_PAYLOAD_BYTES } from "./outbox/command";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import {
  PUSH_BATCH_TARGET_BYTES,
  type PushFunction,
  PushPayloadTooLargeError,
  syncOutbox,
} from "./sync-runner";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const now = new Date(issuedAt.getTime() + 3_600_000);
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(issuedAt.getTime() + 72 * 3_600_000),
      grantId: uuid(900),
      issuedAt,
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
  /** Queues `count` commands whose payload is `bytes` long (each as the outbox measures it). */
  const queue = async (count: number, bytes: number, first = 1) => {
    for (let n = first; n < first + count; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: queued in order
      await outbox.enqueue({
        baseVersion: null,
        commandId: uuid(n),
        deviceId,
        lease,
        organizationId,
        // `{"note":"..."}` takes 11 bytes besides the text
        payload: { note: "x".repeat(bytes - 11) },
        type: "sale.confirm",
      });
    }
  };
  return { lease, outbox, queue };
}

const KIB = 1024;

function acceptAll(
  commands: PushCommandReadModel[]
): Awaited<ReturnType<PushFunction>> {
  return {
    results: commands.map((command) => ({
      code: null,
      commandId: command.commandId,
      replayed: false,
      result: null,
      status: "accepted" as const,
    })),
  };
}

const bodyBytes = (commands: PushCommandReadModel[]) =>
  new TextEncoder().encode(JSON.stringify({ commands })).length;

const tooLarge = () => new ORPCError("PAYLOAD_TOO_LARGE", { status: 413 });

describe("the batch of sync.push", () => {
  it("closes by bytes before the ceiling of the body, not only by count", async () => {
    const { outbox, queue } = await setup();
    // 7 commands of 100 KiB: 700 KiB by count alone, in one request of the default 20
    await queue(7, 100 * KIB);
    const sent: PushCommandReadModel[][] = [];

    const summary = await syncOutbox({
      outbox,
      push: (input) => {
        sent.push(input.commands);
        return Promise.resolve(acceptAll(input.commands));
      },
    });

    expect(sent.map((commands) => commands.length)).toEqual([3, 3, 1]);
    for (const commands of sent) {
      expect(bodyBytes(commands)).toBeLessThanOrEqual(PUSH_BATCH_TARGET_BYTES);
    }
    expect(summary).toMatchObject({ accepted: 7, requests: 3 });
  });

  it("sends a command that is alone above the target in a batch of its own, never empty", async () => {
    const { outbox, queue } = await setup();
    await queue(2, OUTBOX_MAX_PAYLOAD_BYTES - KIB);
    const sent: number[] = [];

    await syncOutbox({
      outbox,
      push: (input) => {
        sent.push(input.commands.length);
        return Promise.resolve(acceptAll(input.commands));
      },
    });

    // 2 × ~255 KiB passes the 400 KiB target: one command per request
    expect(sent).toEqual([1, 1]);
  });

  it("takes the first command into the batch even when it alone passes the target", async () => {
    // the outbox keeps a command at 256 KiB, so the guard only matters if that ceiling grows: a stand-in queue holds one at 450 KiB
    const queue = [
      {
        attempts: 0,
        baseVersion: null,
        commandId: uuid(1),
        createdAt: now.toISOString(),
        deviceId,
        lease: "lease",
        organizationId,
        payload: { note: "x".repeat(450 * KIB) },
        rejection: null,
        seq: 1,
        status: "pending",
        type: "sale.confirm",
      },
    ];
    const stub = {
      acknowledge: (id: string) => {
        queue.splice(
          queue.findIndex((command) => command.commandId === id),
          1
        );
        return Promise.resolve();
      },
      markSending: () => Promise.resolve(),
      recoverInterrupted: () => Promise.resolve(),
      retry: () => Promise.resolve(),
      snapshot: () =>
        Promise.resolve({
          blockedBy: null,
          commands: queue,
          pending: queue.length,
          rejected: 0,
          sending: 0,
        }),
    } as unknown as Outbox;
    const sent: number[] = [];

    const summary = await syncOutbox({
      outbox: stub,
      push: (input) => {
        sent.push(input.commands.length);
        return Promise.resolve(acceptAll(input.commands));
      },
    });

    expect(sent).toEqual([1]);
    expect(summary.accepted).toBe(1);
    expect(queue).toEqual([]);
  });

  it("halves the batch on a 413 and puts the commands back, none rejected", async () => {
    const { outbox, queue } = await setup();
    await queue(8, KIB);
    const sent: number[] = [];

    const summary = await syncOutbox({
      outbox,
      push: (input) => {
        sent.push(input.commands.length);
        if (input.commands.length > 2) {
          return Promise.reject(tooLarge());
        }
        return Promise.resolve(acceptAll(input.commands));
      },
    });

    // 8 refused, 4 refused, then 2 at a time; the batch stays at the size that was accepted
    expect(sent).toEqual([8, 4, 2, 2, 2, 2]);
    expect(summary).toMatchObject({ accepted: 8, rejected: 0 });
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("keeps a single command in the queue when even it is refused with 413, and stops without a loop", async () => {
    const { outbox, queue } = await setup();
    await queue(3, KIB);
    let requests = 0;

    const failure = await syncOutbox({
      outbox,
      push: () => {
        requests += 1;
        if (requests > 10) {
          // a run that does not stop must fail the test, not hang it
          return Promise.reject(new Error("loop"));
        }
        return Promise.reject(tooLarge());
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PushPayloadTooLargeError);
    expect((failure as Error).cause).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });

    // 3 → 1 → stop
    expect(requests).toBe(2);
    const snapshot = await outbox.snapshot();
    expect(snapshot.commands.map((command) => command.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(snapshot).toMatchObject({ pending: 3, rejected: 0, sending: 0 });
  });

  it("does not take another failure for a 413: it throws as it came and the batch goes back", async () => {
    const { outbox, queue } = await setup();
    await queue(2, KIB);
    const failure = new ORPCError("SERVICE_UNAVAILABLE", { status: 503 });

    await expect(
      syncOutbox({ outbox, push: () => Promise.reject(failure) })
    ).rejects.toBe(failure);

    expect(await outbox.snapshot()).toMatchObject({ pending: 2, sending: 0 });
  });
});

describe("a command the server refuses as an invalid payload", () => {
  it("stays rejected with its whole payload, leaves the others pending, ends the run and lets the queue go on once discarded", async () => {
    const { lease, outbox, queue } = await setup();
    const productPayload = {
      name: "Camiseta",
      productId: uuid(11),
      sku: "S".repeat(65),
      variantId: uuid(12),
    };
    await outbox.enqueue({
      baseVersion: null,
      commandId: uuid(10),
      deviceId,
      lease,
      organizationId,
      payload: productPayload,
      type: "product.create",
    });
    await queue(2, KIB, 20);
    const before = (await outbox.snapshot()).commands.filter(
      (command) => command.type === "sale.confirm"
    );
    const sent: string[][] = [];
    const push: PushFunction = (input) => {
      sent.push(input.commands.map((command) => command.commandId));
      let refused = false;
      return Promise.resolve({
        results: input.commands.map((command) => {
          if (command.type === "product.create") {
            refused = true;
            return {
              code: "invalid_payload",
              commandId: command.commandId,
              replayed: false,
              result: null,
              status: "rejected" as const,
            };
          }
          return refused
            ? {
                code: null,
                commandId: command.commandId,
                replayed: false,
                result: null,
                status: "not_processed" as const,
              }
            : acceptAll([command]).results[0];
        }) as Awaited<ReturnType<PushFunction>>["results"],
      });
    };

    const summary = await syncOutbox({ outbox, push });

    expect(summary).toMatchObject({
      accepted: 0,
      notProcessed: 2,
      rejected: 1,
      requests: 1,
    });
    const snapshot = await outbox.snapshot();
    expect(snapshot).toMatchObject({ pending: 2, rejected: 1, sending: 0 });
    expect(snapshot.blockedBy).toMatchObject({
      commandId: uuid(10),
      payload: productPayload,
      rejection: { code: "invalid_payload" },
      status: "rejected",
    });
    const others = snapshot.commands.filter(
      (command) => command.type === "sale.confirm"
    );
    expect(
      others.map(({ commandId, payload, status }) => ({
        commandId,
        payload,
        status,
      }))
    ).toEqual(
      before.map(({ commandId, payload }) => ({
        commandId,
        payload,
        status: "pending",
      }))
    );

    // blocked behind the refusal, a new run ends at once instead of sending it again
    expect(await syncOutbox({ outbox, push })).toMatchObject({ requests: 0 });
    expect(sent).toHaveLength(1);

    // discarding it, the only action the panel of attention offers, frees the queue
    await outbox.discard(uuid(10));
    expect(await syncOutbox({ outbox, push })).toMatchObject({
      accepted: 2,
      requests: 1,
    });
    expect(await outbox.snapshot()).toMatchObject({ pending: 0, rejected: 0 });
  });
});
