import type { LocalCustomerReadModel } from "@polaris/contracts";
import { InvalidCustomerProfileError } from "@polaris/domain/customers/customer";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import {
  discardPendingCustomerUpdate,
  overlayPendingCustomerEdits,
  pendingCustomerUpdates,
  updateOfflineCustomer,
} from "./customer-update";
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
const customerId = uuid(201);

const serverRow: LocalCustomerReadModel = {
  archivedAt: null,
  email: null,
  id: customerId,
  name: "Ana Souza",
  notes: null,
  phone: "11900000001",
  updatedAt: "2026-10-14T10:00:00.000Z",
  version: 4,
};

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
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId,
    storage: new MemoryOutboxStorage(),
    userId,
  });
  const writer = new FakeWriter();
  const server = new FakeCustomerServer();
  server.customers.set(customerId, serverRow);
  await writer.upsert("customers", [serverRow]);
  let counter = 0;
  const edit = (
    input: { name: string; phone?: string | null; email?: string | null },
    current: { id: string; version: number } = serverRow
  ) => {
    counter += 1;
    const n = counter;
    return updateOfflineCustomer({
      current,
      deviceId,
      input,
      lease,
      newCommandId: () => uuid(300 + n),
      organizationId,
      outbox,
    });
  };
  const sync = () =>
    syncOutbox({
      outbox,
      pull: { source: server, writer },
      push: server.push,
    });
  return { edit, lease, outbox, server, sync, writer };
}

describe("editing a customer offline", () => {
  it("queues the command from the version the person edited, without touching the local row", async () => {
    const { edit, outbox, writer } = await setup();
    const command = await edit({ name: "  Ana Lima  ", phone: "11900000001" });

    expect(command).toMatchObject({
      baseVersion: 4,
      status: "pending",
      type: "customer.update",
    });
    expect(command.payload).toEqual({
      customerId,
      email: null,
      name: "Ana Lima",
      notes: null,
      phone: "11900000001",
    });
    expect(writer.customer(customerId)).toEqual(serverRow);
    expect(await pendingCustomerUpdates(outbox)).toEqual([
      { code: null, commandId: uuid(301), customerId, state: "pending" },
    ]);
  });

  it("refuses a profile the server would refuse, queueing nothing", async () => {
    const { edit, outbox } = await setup();
    for (const input of [{ name: "   ", phone: "1" }, { name: "Ana" }]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(edit(input)).rejects.toBeInstanceOf(
        InvalidCustomerProfileError
      );
    }
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("allows one waiting edit per customer", async () => {
    const { edit, outbox } = await setup();
    await edit({ name: "Ana Lima", phone: "1" });

    await expect(edit({ name: "Ana Costa", phone: "1" })).rejects.toThrow(
      "customer_has_pending_command"
    );
    expect((await outbox.snapshot()).commands).toHaveLength(1);
    // another customer is not affected
    await expect(
      edit({ name: "Bia", phone: "2" }, { id: uuid(202), version: 1 })
    ).resolves.toMatchObject({ baseVersion: 1 });
  });

  it("is not allowed on a customer whose creation is still waiting", async () => {
    const { edit, lease, outbox } = await setup();
    await outbox.enqueue({
      baseVersion: null,
      commandId: uuid(150),
      deviceId,
      lease,
      organizationId,
      payload: { customerId: uuid(202), name: "Bia", phone: "2" },
      type: "customer.create",
    });
    await expect(
      edit({ name: "Bia Lima", phone: "2" }, { id: uuid(202), version: 1 })
    ).rejects.toThrow("customer_has_pending_command");
  });

  it("is applied by the server on a sync and the server row replaces the overlay", async () => {
    const { edit, outbox, server, sync, writer } = await setup();
    writer.meta = {
      bootstrappedAt: now.toISOString(),
      cursor: "0",
      status: "ready",
      updatedAt: now.toISOString(),
      version: 1,
    };
    await edit({ name: "Ana Lima", phone: "11900000001" });

    const summary = await sync();

    expect(summary).toMatchObject({ accepted: 1, rejected: 0 });
    expect(server.customers.get(customerId)).toMatchObject({
      name: "Ana Lima",
      version: 5,
    });
    expect(writer.customer(customerId)).toMatchObject({
      name: "Ana Lima",
      version: 5,
    });
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("is refused when the customer changed on the server meanwhile, and nothing is overwritten", async () => {
    const { edit, outbox, server, sync, writer } = await setup();
    await edit({ name: "Nome do aparelho", phone: "1" });
    // another device edited the customer: the server is at version 5
    server.customers.set(customerId, {
      ...serverRow,
      name: "Nome de outro aparelho",
      version: 5,
    });

    const summary = await sync();

    expect(summary).toMatchObject({ accepted: 0, rejected: 1 });
    expect(server.customers.get(customerId)?.name).toBe(
      "Nome de outro aparelho"
    );
    expect(await pendingCustomerUpdates(outbox)).toEqual([
      {
        code: "customer_version_conflict",
        commandId: uuid(301),
        customerId,
        state: "rejected",
      },
    ]);
    // the device row is still the one it had
    expect(writer.customer(customerId)?.name).toBe("Ana Souza");
  });

  it("is dropped from the device, typed text and all, when the customer was anonymized, and the queue goes on", async () => {
    const { edit, outbox, server, sync, writer } = await setup();
    writer.meta = {
      bootstrappedAt: now.toISOString(),
      cursor: "0",
      status: "ready",
      updatedAt: now.toISOString(),
      version: 1,
    };
    const otherId = uuid(202);
    const other = { ...serverRow, id: otherId, name: "Bia", version: 1 };
    server.customers.set(otherId, other);
    await writer.upsert("customers", [other]);
    await edit({ name: "Ana Lima", phone: "11911112222" });
    await edit({ name: "Bia Lima", phone: "2" }, other);
    server.anonymized.add(customerId);

    const summary = await sync();

    expect(summary).toMatchObject({
      accepted: 1,
      blockedBy: null,
      discarded: 1,
      rejected: 0,
    });
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(JSON.stringify(await outbox.snapshot())).not.toContain(
      "11911112222"
    );
    expect(server.customers.get(otherId)?.name).toBe("Bia Lima");
  });

  it("drops an edit refused for anonymization before this version kept it", async () => {
    const { edit, outbox, sync } = await setup();
    const command = await edit({ name: "Ana Lima", phone: "11911112222" });
    await outbox.markSending(command.commandId);
    await outbox.reject(command.commandId, "customer_anonymized");

    const summary = await sync();

    expect(summary.discarded).toBe(1);
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("can be discarded (even refused), changing no local row; not while being sent", async () => {
    const { edit, outbox, writer } = await setup();
    const first = await edit({ name: "Ana Lima", phone: "1" });
    await outbox.markSending(first.commandId);
    await expect(
      discardPendingCustomerUpdate(outbox, first.commandId)
    ).rejects.toThrow("customer_update_is_sending");
    await outbox.recoverInterrupted();

    await discardPendingCustomerUpdate(outbox, first.commandId);

    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(writer.customer(customerId)).toEqual(serverRow);
    await expect(
      discardPendingCustomerUpdate(outbox, first.commandId)
    ).rejects.toThrow("not_a_pending_customer_update");
  });
});

describe("overlayPendingCustomerEdits", () => {
  it("shows the waiting edit over the server row, and the server row once it is refused", async () => {
    const { edit, outbox, server, sync } = await setup();
    await edit({ email: "ana@example.com", name: "Ana Lima", phone: "22" });
    const waiting = (await outbox.snapshot()).commands;

    expect(overlayPendingCustomerEdits([serverRow], waiting)).toEqual([
      {
        ...serverRow,
        email: "ana@example.com",
        name: "Ana Lima",
        phone: "22",
      },
    ]);

    server.customers.set(customerId, { ...serverRow, version: 9 });
    await sync();
    const refused = (await outbox.snapshot()).commands;
    expect(overlayPendingCustomerEdits([serverRow], refused)).toEqual([
      serverRow,
    ]);
  });

  it("returns the same rows when nothing is waiting", () => {
    const rows = [serverRow];
    expect(overlayPendingCustomerEdits(rows, [])).toBe(rows);
  });
});
