import { InvalidCustomerProfileError } from "@polaris/domain/customers/customer";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { isTransientReadFailure } from "../lib/rpc-error";
import {
  createOfflineCustomer,
  pendingCustomers,
  restorePendingCustomers,
} from "./customer-create";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import { syncOutbox } from "./sync-runner";
import { FakeCustomerServer, FakeWriter } from "./test-support";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["customer:update"],
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
  const storage = new MemoryOutboxStorage();
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId,
    storage,
    userId,
  });
  const writer = new FakeWriter();
  const server = new FakeCustomerServer();
  let counter = 0;
  const create = (input: {
    name: string;
    phone?: string | null;
    email?: string | null;
  }) => {
    counter += 1;
    const n = counter;
    return createOfflineCustomer({
      deviceId,
      input,
      lease,
      newCommandId: () => uuid(100 + n),
      newCustomerId: () => uuid(200 + n),
      now: () => now,
      organizationId,
      outbox,
      writer,
    });
  };
  const sync = (overrides: Partial<Parameters<typeof syncOutbox>[0]> = {}) =>
    syncOutbox({
      outbox,
      pull: { source: server, writer },
      push: server.push,
      ...overrides,
    });
  return { create, outbox, server, storage, sync, writer };
}

describe("creating a customer offline", () => {
  it("queues the command and shows the customer at once", async () => {
    const { create, outbox, writer } = await setup();
    const { command, customer } = await create({
      name: "  Ana  ",
      phone: " +55 11 90000-0000 ",
    });

    expect(customer).toMatchObject({
      id: uuid(201),
      name: "Ana",
      phone: "+55 11 90000-0000",
      version: 1,
    });
    expect(writer.customer(uuid(201))).toEqual(customer);
    expect(command).toMatchObject({
      commandId: uuid(101),
      status: "pending",
      type: "customer.create",
    });
    expect(command.payload).toEqual({
      customerId: uuid(201),
      email: null,
      name: "Ana",
      notes: null,
      phone: "+55 11 90000-0000",
    });
    expect(await pendingCustomers(outbox)).toEqual([
      {
        code: null,
        commandId: uuid(101),
        customerId: uuid(201),
        state: "pending",
      },
    ]);
  });

  it("refuses a customer the server would refuse, queueing nothing", async () => {
    const { create, outbox, writer } = await setup();
    for (const input of [
      { name: "   ", phone: "1" },
      { name: "Ana" },
      { name: "x".repeat(201), phone: "1" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(create(input)).rejects.toBeInstanceOf(
        InvalidCustomerProfileError
      );
    }
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(writer.data.customers.size).toBe(0);
  });

  it("confirms after a sync: the command leaves the outbox and the server row replaces the optimistic one", async () => {
    const { create, outbox, server, sync, writer } = await setup();
    writer.meta = {
      bootstrappedAt: now.toISOString(),
      cursor: "0",
      status: "ready",
      updatedAt: now.toISOString(),
      version: 1,
    };
    await create({ name: "Ana", phone: "1" });

    const summary = await sync();

    expect(summary).toMatchObject({ accepted: 1, rejected: 0, replayed: 0 });
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(server.customers.has(uuid(201))).toBe(true);
    expect(writer.customer(uuid(201))?.updatedAt).toBe(
      "2026-10-14T13:00:00.000Z"
    );
    expect(writer.meta?.cursor).toBe("1");
    expect(await pendingCustomers(outbox)).toEqual([]);
  });

  it("is safe to push twice: a lost response is resent and the server replays it", async () => {
    const { create, outbox, server, sync } = await setup();
    await create({ name: "Ana", phone: "1" });
    server.lostResponses = 1;

    await expect(sync()).rejects.toThrow("network lost the response");
    // the server did the work, the device does not know, the command is waiting again
    expect(server.customers.size).toBe(1);
    expect(server.executions).toBe(1);
    expect((await outbox.snapshot()).commands.map((c) => c.status)).toEqual([
      "pending",
    ]);

    const second = await sync();
    expect(second).toMatchObject({ accepted: 1, replayed: 1 });
    expect(server.executions).toBe(1);
    expect(server.customers.size).toBe(1);
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("keeps a rejected customer visible, needing attention, and blocks the queue", async () => {
    const { create, outbox, server, sync, writer } = await setup();
    await create({ name: "Ana", phone: "1" });
    await create({ name: "Bia", phone: "2" });
    server.rejectCode = "customer_id_conflict";

    const summary = await sync();

    expect(summary).toMatchObject({
      accepted: 0,
      notProcessed: 1,
      rejected: 1,
    });
    expect(summary.blockedBy?.commandId).toBe(uuid(101));
    expect(await pendingCustomers(outbox)).toEqual([
      {
        code: "customer_id_conflict",
        commandId: uuid(101),
        customerId: uuid(201),
        state: "rejected",
      },
      {
        code: null,
        commandId: uuid(102),
        customerId: uuid(202),
        state: "pending",
      },
    ]);
    expect(writer.customer(uuid(201))?.name).toBe("Ana");
    // nothing more is sent while the head is refused
    const again = await sync();
    expect(again.requests).toBe(0);
  });

  it("restores the local rows of queued customers after a crash", async () => {
    const { create, outbox, writer } = await setup();
    await create({ name: "Ana", phone: "1" });
    writer.data.customers.clear();

    expect(await restorePendingCustomers(outbox, writer)).toBe(1);
    expect(writer.customer(uuid(201))?.name).toBe("Ana");
  });
});

describe("syncOutbox", () => {
  it("sends in batches, in order", async () => {
    const { create, outbox, server, sync } = await setup();
    for (let n = 1; n <= 5; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: customers are created in order
      await create({ name: `Cliente ${n}`, phone: String(n) });
    }
    const summary = await sync({ batchSize: 2 });
    expect(summary).toMatchObject({ accepted: 5, requests: 3 });
    expect([...server.customers.keys()]).toEqual(
      [201, 202, 203, 204, 205].map(uuid)
    );
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("recovers a command a previous session left 'sending'", async () => {
    const { create, outbox, server, sync } = await setup();
    const { command } = await create({ name: "Ana", phone: "1" });
    await outbox.markSending(command.commandId);

    const summary = await sync();
    expect(summary.accepted).toBe(1);
    expect(server.executions).toBe(1);
  });

  /** What the real oRPC client throws when the platform killed the Worker for CPU (1102): HTML, cf-ray, no mark. */
  const killedForCpu = () =>
    createORPCClient<{ sync: { push: () => Promise<unknown> } }>(
      new RPCLink({
        fetch: () =>
          Promise.resolve(
            new Response("<html>Error 1102</html>", {
              headers: { "cf-ray": "abc-GRU", "content-type": "text/html" },
              status: 503,
            })
          ),
        url: "http://localhost/rpc",
      })
    )
      .sync.push()
      .catch((caught: unknown) => caught as Error);

  it("a push killed for CPU (1102) is transient: the command waits and is written once, with the same key", async () => {
    const { create, outbox, server, sync } = await setup();
    await create({ name: "Ana", phone: "1" });
    const died = await killedForCpu();
    expect(isTransientReadFailure(died)).toBe(true);
    const sent: string[][] = [];
    let first = true;
    const push: typeof server.push = (input) => {
      sent.push(input.commands.map((command) => command.commandId));
      if (first) {
        first = false;
        return Promise.reject(died);
      }
      return server.push(input);
    };

    await expect(sync({ push })).rejects.toBe(died);
    expect((await outbox.snapshot()).commands).toMatchObject([
      { commandId: uuid(101), status: "pending" },
    ]);
    expect(server.executions).toBe(0);

    expect(await sync({ push })).toMatchObject({ accepted: 1 });
    expect(sent).toEqual([[uuid(101)], [uuid(101)]]);
    expect(server.executions).toBe(1);
    expect([...server.customers.keys()]).toEqual([uuid(201)]);
  });

  it("killed for CPU after the server wrote it: the second push with the same key does not write it again", async () => {
    const { create, server, sync } = await setup();
    await create({ name: "Ana", phone: "1" });
    const died = await killedForCpu();
    let first = true;
    const push: typeof server.push = async (input) => {
      const result = await server.push(input);
      if (first) {
        first = false;
        throw died; // the answer never came back
      }
      return result;
    };

    await expect(sync({ push })).rejects.toBe(died);
    expect(await sync({ push })).toMatchObject({ accepted: 1 });
    expect(server.executions).toBe(1);
    expect(server.customers.size).toBe(1);
  });

  it("does nothing, and sends nothing, with an empty outbox", async () => {
    const { server, sync } = await setup();
    expect(await sync()).toMatchObject({ accepted: 0, requests: 0 });
    expect(server.requests).toBe(0);
  });
});
