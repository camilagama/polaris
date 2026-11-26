import type { PushCommandReadModel } from "@polaris/contracts";
import type {
  runSyncCommand,
  SyncCommandOutcome,
} from "@polaris/db/sync-command-repository";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import {
  type NormalizedConfirmSaleCommand,
  normalizeConfirmSaleCommand,
  SaleCommandConflictError,
} from "@polaris/domain/sales/confirm-sale";
import { PaymentProfileVersionConflictError } from "@polaris/domain/sales/payment-profile";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { buildAttention } from "../../offline/attention";
import { MemoryOutboxStorage } from "../../offline/outbox/memory-storage";
import { Outbox } from "../../offline/outbox/outbox";
import {
  createOfflineSale,
  type OfflineSalePaymentPart,
  pendingSales,
  resubmitRejectedSale,
} from "../../offline/sale-confirm";
import { syncOutbox } from "../../offline/sync-runner";
import { FakeWriter } from "../../offline/test-support";
import { queueOfflineSale } from "../../sales/queue-offline-sale";
import {
  prepareConfirmation,
  type SaleCommandBody,
} from "../../sales/sale-form-model";
import { createSaleConfirmHandler } from "./handlers/sale-confirm";
import {
  InvalidSyncPayloadError,
  pushCommands,
  type SyncCommandHandler,
} from "./push";

/**
 * A sale paid in parts and made without a connection, from the device's queue
 * to the server's `sync.push`, with the real builder, outbox, sync runner,
 * push orchestration and `sale.confirm` handler; only the database frame and
 * `confirmSale` are stand-ins. The database side (two rows, a refused part
 * leaving nothing) is the offline end-to-end gate's.
 */
const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const profile = { expectedVersion: 3, id: uuid(601) };

const PARTS: readonly OfflineSalePaymentPart[] = [
  { amount: "30.00", method: "pix", paymentProfile: null },
  {
    amount: "70.00",
    installmentPlan: "issuer",
    installments: 3,
    method: "credit_card",
    paymentProfile: profile,
  },
];

interface Stored {
  hash: string;
  outcome: SyncCommandOutcome;
}

/**
 * The part of `runSyncCommand` the queue relies on: one stored outcome per
 * command ID, a retry with the same content replays it, and a refusal is stored
 * like an acceptance (sending the same command again cannot succeed).
 */
function databaseFrame() {
  const stored = new Map<string, Stored>();
  const hashes: string[] = [];
  const run: typeof runSyncCommand = async (
    _transaction,
    _identity,
    input,
    execute,
    classify
  ) => {
    hashes.push(input.payloadHash);
    const earlier = stored.get(input.commandId);
    if (earlier) {
      if (earlier.hash !== input.payloadHash) {
        return {
          code: "command_id_conflict",
          replayed: false,
          result: null,
          status: "rejected",
        };
      }
      return { ...earlier.outcome, replayed: true };
    }
    let outcome: SyncCommandOutcome;
    if (input.precheckFailure) {
      outcome = {
        code: input.precheckFailure,
        replayed: false,
        result: null,
        status: "rejected",
      };
    } else {
      try {
        outcome = {
          code: null,
          replayed: false,
          result: await execute({} as never),
          status: "accepted",
        };
      } catch (error) {
        const code = classify?.(error) ?? null;
        if (code === null) {
          throw error;
        }
        outcome = { code, replayed: false, result: null, status: "rejected" };
      }
    }
    stored.set(input.commandId, { hash: input.payloadHash, outcome });
    return outcome;
  };
  return { hashes, run, stored };
}

function confirmSaleStub() {
  let sales = 0;
  return vi.fn((..._args: unknown[]) => {
    sales += 1;
    return Promise.resolve({
      sale: { confirmedAt: now, id: `sale-${sales}` },
      totals: { totalDue: "100.00" },
    });
  });
}

/**
 * The server of the version before split payments, as a rollback of the Worker
 * would bring back: its sale payload was strict and did not know `payments`,
 * so the field alone made it an invalid payload. Everything else it read like
 * the current one.
 */
function serverWithoutParts(current: SyncCommandHandler): SyncCommandHandler {
  return {
    ...current,
    parse: (payload) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "payments" in payload
      ) {
        throw new InvalidSyncPayloadError();
      }
      return current.parse(payload);
    },
  };
}

async function setup() {
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
  const writer = new FakeWriter();
  await writer.upsert("variants", [
    {
      id: variantId,
      isDefault: true,
      listPrice: "50.00",
      position: null,
      productId: uuid(700),
      sku: null,
      values: [],
    },
  ]);
  await writer.upsert("inventory", [
    {
      productId: uuid(700),
      quantity: 10,
      updatedAt: now.toISOString(),
      variantId,
      version: 1,
    },
  ]);
  const frame = databaseFrame();
  let handler: SyncCommandHandler = createSaleConfirmHandler({
    confirmSale: confirmSaleStub() as never,
  });
  let dropResponses = 0;
  const push = async (input: { commands: PushCommandReadModel[] }) => {
    const results = await pushCommands(input.commands, {
      handlers: [handler],
      hashKeys: { current: "h".repeat(32), previous: [] },
      keys: { signing: key, verification: [key] },
      now: () => now,
      runSyncCommand: frame.run,
      withTenant: (operation) => operation({} as never, {} as never),
    });
    if (dropResponses > 0) {
      dropResponses -= 1;
      throw new Error("the network dropped the response");
    }
    return { results };
  };
  let counter = 0;
  const sell = (request: Partial<Parameters<typeof createOfflineSale>[0]>) => {
    counter += 1;
    const n = counter;
    return createOfflineSale({
      deviceId,
      lease,
      lines: [{ quantity: 2, variantId }],
      newCommandId: () => uuid(100 + n),
      now: () => now,
      organizationId,
      outbox,
      reader: writer,
      ...request,
    });
  };
  return {
    dropNextResponse: () => {
      dropResponses = 1;
    },
    frame,
    lease,
    outbox,
    sell,
    serve: (next: SyncCommandHandler) => {
      handler = next;
    },
    stores: { deviceId, lease, organizationId, outbox, writer },
    sync: () => syncOutbox({ outbox, push }),
  };
}

describe("a sale paid in parts, made offline", () => {
  it("is taken by the current server with its parts in order and no single payment", async () => {
    const confirmSale = confirmSaleStub();
    const device = await setup();
    device.serve(
      createSaleConfirmHandler({ confirmSale: confirmSale as never })
    );
    const { command } = await device.sell({ payments: PARTS });

    const summary = await device.sync();

    expect(summary.accepted).toBe(1);
    expect(confirmSale).toHaveBeenCalledTimes(1);
    const input = confirmSale.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input.commandId).toBe(command.commandId);
    expect(input.commandVersion).toBe(1);
    expect(input.payments).toEqual([
      {
        amount: "30.00",
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
        paymentProfile: null,
      },
      {
        amount: "70.00",
        anticipationRequested: false,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
        paymentProfile: profile,
      },
    ]);
    expect(input).not.toHaveProperty("payment");
    expect(input).not.toHaveProperty("paymentProfile");
    expect((await device.outbox.snapshot()).commands).toEqual([]);
  });

  it("is sold once when the answer is lost and the same command is sent again", async () => {
    const confirmSale = confirmSaleStub();
    const device = await setup();
    device.serve(
      createSaleConfirmHandler({ confirmSale: confirmSale as never })
    );
    await device.sell({ payments: PARTS });

    device.dropNextResponse();
    await expect(device.sync()).rejects.toThrow("dropped the response");
    const second = await device.sync();

    expect(second).toMatchObject({ accepted: 1, replayed: 1 });
    expect(confirmSale).toHaveBeenCalledTimes(1);
    expect(device.frame.stored.size).toBe(1);
    const [first, retry] = device.frame.hashes;
    expect(retry).toBe(first);
  });

  it("has a payload hash that covers each part and the order of the parts", async () => {
    const device = await setup();
    await device.sell({ newCommandId: () => uuid(1), payments: PARTS });
    await device.sell({
      newCommandId: () => uuid(2),
      payments: [PARTS[1], PARTS[0]] as OfflineSalePaymentPart[],
    });
    await device.sell({
      newCommandId: () => uuid(3),
      payments: [
        PARTS[0],
        { ...PARTS[1], paymentProfile: { ...profile, expectedVersion: 4 } },
      ] as OfflineSalePaymentPart[],
    });
    await device.sell({
      newCommandId: () => uuid(4),
      payments: [
        { ...PARTS[0], amount: "30.01" },
        { ...PARTS[1], amount: "69.99" },
      ] as OfflineSalePaymentPart[],
    });
    await device.sell({ newCommandId: () => uuid(5), payments: PARTS });

    expect((await device.sync()).accepted).toBe(5);

    const [same, swapped, otherProfile, otherAmounts, again] =
      device.frame.hashes;
    expect(new Set([same, swapped, otherProfile, otherAmounts]).size).toBe(4);
    // the payload carries the device's clock, not the command ID: the same sale gives the same hash
    expect(again).toBe(same);
  });

  it("after a rollback of the Worker to one without parts, is refused as an invalid payload and kept on the device with its parts", async () => {
    const confirmSale = confirmSaleStub();
    const current = createSaleConfirmHandler({
      confirmSale: confirmSale as never,
    });
    const device = await setup();
    device.serve(serverWithoutParts(current));
    const { command } = await device.sell({ payments: PARTS });

    const refused = await device.sync();

    expect(refused.rejected).toBe(1);
    expect(refused.blockedBy?.rejection?.code).toBe("invalid_payload");
    expect(confirmSale).not.toHaveBeenCalled();
    const snapshot = await device.outbox.snapshot();
    expect(snapshot.commands).toHaveLength(1);
    expect(snapshot.commands[0]?.payload).toEqual(command.payload);
    expect(await pendingSales(device.outbox)).toMatchObject([
      { code: "invalid_payload", commandId: command.commandId },
    ]);
    expect((await pendingSales(device.outbox))[0]?.state).toBe("rejected");
    expect(buildAttention(snapshot).items).toMatchObject([
      { commandId: command.commandId, kind: "sale" },
    ]);

    // the current Worker is back: the device does not send a refused command
    // again by itself, and the same sale sent as a new command is confirmed
    device.serve(current);
    expect((await device.sync()).accepted).toBe(0);
    const again = await resubmitRejectedSale(device.outbox, {
      commandId: command.commandId,
      lease: device.lease,
      newCommandId: () => uuid(500),
    });
    expect(again.payload).toEqual(command.payload);
    expect((await device.sync()).accepted).toBe(1);
    expect(confirmSale).toHaveBeenCalledTimes(1);
    expect(confirmSale.mock.calls[0]?.[2]).toMatchObject({
      payments: [{ amount: "30.00" }, { amount: "70.00" }],
    });
  });

  it("is refused whole when the second part's profile moved on, and sent again without it keeps both parts and drops only that profile", async () => {
    const accepted = confirmSaleStub();
    const confirmSale = vi.fn((...args: unknown[]) => {
      const input = args[2] as {
        payments?: { paymentProfile: unknown }[];
      };
      return input.payments?.some((part) => part.paymentProfile !== null)
        ? Promise.reject(new PaymentProfileVersionConflictError(1))
        : accepted(...args);
    });
    const device = await setup();
    device.serve(
      createSaleConfirmHandler({ confirmSale: confirmSale as never })
    );
    const { command } = await device.sell({ payments: PARTS });

    const refused = await device.sync();

    expect(refused.blockedBy?.rejection?.code).toBe("payment_profile_changed");
    expect(accepted).not.toHaveBeenCalled();
    const again = await resubmitRejectedSale(device.outbox, {
      commandId: command.commandId,
      lease: device.lease,
      newCommandId: () => uuid(501),
      withoutProfile: true,
    });
    expect(again.commandId).toBe(uuid(501));
    expect((await device.sync()).accepted).toBe(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted.mock.calls[0]?.[2]).toMatchObject({
      payments: [
        { amount: "30.00", method: "pix", paymentProfile: null },
        {
          amount: "70.00",
          installments: 3,
          method: "credit_card",
          paymentProfile: null,
        },
      ],
    });
    expect((await device.outbox.snapshot()).commands).toHaveLength(0);
  });

  it("with a different profile on each part, the device does not guess which one was refused and keeps the sale", async () => {
    const confirmSale = vi.fn(() =>
      Promise.reject(new PaymentProfileVersionConflictError(1))
    );
    const device = await setup();
    device.serve(
      createSaleConfirmHandler({ confirmSale: confirmSale as never })
    );
    const [first, second] = PARTS;
    const { command } = await device.sell({
      payments: [
        {
          ...(first as OfflineSalePaymentPart),
          paymentProfile: { expectedVersion: 1, id: uuid(602) },
        },
        second as OfflineSalePaymentPart,
      ],
    });
    await device.sync();

    await expect(
      resubmitRejectedSale(device.outbox, {
        commandId: command.commandId,
        lease: device.lease,
        withoutProfile: true,
      })
    ).rejects.toThrow("split_sale_profile_unknown");
    const [kept] = (await device.outbox.snapshot()).commands;
    expect(kept?.commandId).toBe(command.commandId);
    expect(kept?.payload).toEqual(command.payload);
  });
});

describe("a single payment made offline, next to parts", () => {
  it("keeps the shape every server already takes", async () => {
    const confirmSale = confirmSaleStub();
    const device = await setup();
    const current = createSaleConfirmHandler({
      confirmSale: confirmSale as never,
    });
    // a single payment never names `payments`, so even the server before parts takes it
    device.serve(serverWithoutParts(current));
    const { command } = await device.sell({
      payment: { method: "debit_card" },
      paymentProfile: profile,
    });

    expect(command.payload).not.toHaveProperty("payments");
    expect((await device.sync()).accepted).toBe(1);
    const input = confirmSale.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input.payment).toEqual({
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: "debit_card",
    });
    expect(input.paymentProfile).toEqual(profile);
    expect(input).not.toHaveProperty("payments");
  });
});

/**
 * The sales table of the server, as `confirmSale` reads it: a command ID already recorded is replayed only when the
 * normalized command is the same (instants, lines, and each part in its position), and is a command conflict
 * otherwise. The comparison of the real repository is the database gate's.
 */
function salesTable() {
  const recorded = new Map<
    string,
    { command: NormalizedConfirmSaleCommand; saleId: string }
  >();
  const sameSale = (
    a: NormalizedConfirmSaleCommand,
    b: NormalizedConfirmSaleCommand
  ) =>
    JSON.stringify([a.occurredAt, a.recordedAt, a.items, a.payments]) ===
    JSON.stringify([b.occurredAt, b.recordedAt, b.items, b.payments]);
  const confirm = vi.fn((...args: unknown[]) => {
    const command = normalizeConfirmSaleCommand(
      args[2] as Parameters<typeof normalizeConfirmSaleCommand>[0],
      now
    );
    const earlier = recorded.get(command.commandId);
    if (earlier && !sameSale(earlier.command, command)) {
      return Promise.reject(new SaleCommandConflictError());
    }
    const saleId = earlier?.saleId ?? `sale-${recorded.size + 1}`;
    recorded.set(command.commandId, { command, saleId });
    return Promise.resolve({
      replayed: earlier !== undefined,
      sale: { confirmedAt: now, id: saleId },
      totals: { totalDue: "100.00" },
    });
  });
  return { confirm, recorded };
}

describe("a sale in parts locked with no answer and kept on the device", () => {
  const body: SaleCommandBody = {
    adjustments: [],
    commandVersion: 1,
    items: [
      {
        chargedUnitPrice: "50.00",
        listedUnitPrice: "50.00",
        quantity: 2,
        variantId,
      },
    ],
    payments: [
      {
        amount: "30.00",
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
        paymentProfile: null,
      },
      {
        amount: "70.00",
        anticipationRequested: false,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
        paymentProfile: profile,
      },
    ],
  };

  /** The screen sent the sale online, the server recorded it and the answer was lost; the sale is kept on the device. */
  async function sentOnlineThenKept(
    keptParts?: NonNullable<SaleCommandBody["payments"]>
  ) {
    const table = salesTable();
    const device = await setup();
    device.serve(
      createSaleConfirmHandler({ confirmSale: table.confirm as never })
    );
    const sent = prepareConfirmation({
      body,
      createId: () => uuid(101),
      now,
      organizationId,
      previousAttempt: null,
    });
    if (!sent.ok) {
      throw new Error("the sent body is valid");
    }
    const online = await table.confirm({}, {}, sent.request);
    const kept = prepareConfirmation({
      attemptUnsettled: true,
      body,
      createId: () => uuid(999),
      now,
      occurredAtOverride: null,
      organizationId,
      previousAttempt: sent.attempt,
    });
    if (!kept.ok) {
      throw new Error("the kept body is valid");
    }
    await queueOfflineSale({
      labels: new Map(),
      request:
        keptParts === undefined
          ? kept.request
          : { ...kept.request, payments: keptParts },
      stores: device.stores,
    });
    return { device, online, sent, table };
  }

  it("is the same sale on the server: the device's command replays it, with both parts, and no second sale", async () => {
    const { device, online, sent, table } = await sentOnlineThenKept();

    const summary = await device.sync();

    expect(summary.accepted).toBe(1);
    expect(table.confirm).toHaveBeenCalledTimes(2);
    expect(await table.confirm.mock.results[1]?.value).toMatchObject({
      replayed: true,
      sale: { id: online.sale.id },
    });
    expect(table.recorded.size).toBe(1);
    expect(
      table.recorded.get(sent.request.commandId)?.command.payments
    ).toHaveLength(2);
    expect(
      device.frame.stored.get(sent.request.commandId)?.outcome
    ).toMatchObject({
      result: { saleId: online.sale.id },
      status: "accepted",
    });
    expect((await device.outbox.snapshot()).commands).toEqual([]);
  });

  it("with the second part of another amount under the same command ID, is a conflict and never a second sale", async () => {
    const [first, second] = body.payments ?? [];
    if (!(first && second)) {
      throw new Error("the body has two parts");
    }
    const { device, sent, table } = await sentOnlineThenKept([
      { ...first, amount: "40.00" },
      { ...second, amount: "60.00" },
    ]);

    const summary = await device.sync();

    expect(summary.blockedBy?.rejection?.code).toBe("sale_command_conflict");
    expect(table.recorded.size).toBe(1);
    expect(
      table.recorded.get(sent.request.commandId)?.command.payments
    ).toEqual(normalizeConfirmSaleCommand(sent.request, now).payments);
    const [kept] = (await device.outbox.snapshot()).commands;
    expect(kept?.commandId).toBe(sent.request.commandId);
  });
});
