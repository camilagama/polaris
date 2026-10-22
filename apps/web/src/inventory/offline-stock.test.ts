import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { MemoryOutboxStorage } from "../offline/outbox/memory-storage";
import { Outbox } from "../offline/outbox/outbox";
import type { RuntimeContext } from "../offline/runtime/offline-runtime";
import { pendingStockCommands } from "../offline/stock-commands";
import { FakeWriter } from "../offline/test-support";
import { queueOfflineStock } from "./queue-offline-stock";
import {
  editStockField,
  prepareStockSubmission,
  reviewStock,
  type StockAction,
  type StockCommandState,
  startStockCommand,
  stockActionBlock,
  stockQueueFailed,
  stockSubmitLabel,
  stockSucceeded,
  stockSummary,
  validateStockDraft,
  valuationApplies,
} from "./stock-command-model";
import { stockRows } from "./stock-list-model";
import { type StockTarget, stockTarget, targetCostText } from "./stock-target";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const productId = "0199c2d0-0000-7000-8000-0000000000f1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b1";
const now = new Date("2026-10-14T12:30:00.000Z");
const today = "2026-10-14";
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const entry = {
  isDefaultVariant: false,
  listPrice: "50.00",
  movingAverageCost: null,
  productId,
  productName: "Camiseta",
  productStatus: "active" as const,
  quantity: 5,
  sku: null,
  updatedAt: now.toISOString(),
  values: [{ optionName: "color" as const, optionValueName: "Azul" }],
  variantId,
  version: 3,
};

const offlineTarget: StockTarget = stockTarget(entry, {
  costUnavailable: true,
});
const onlineUnknownCost: StockTarget = stockTarget(entry);

let idCounter = 0;
/** Every call across the file gets a new command ID, like the real attempts. */
function ids() {
  return () => {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
  };
}

function filled(
  action: StockAction,
  fields: Record<string, string>,
  target: StockTarget
): StockCommandState {
  let state = startStockCommand(action, target, today);
  for (const [field, value] of Object.entries(fields)) {
    state = editStockField(state, field as never, value);
  }
  return state;
}

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["inventory:adjust"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * HOUR),
      grantId: uuid(900),
      issuedAt: new Date(now.getTime() - HOUR),
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
  await writer.upsert("inventory", [
    {
      productId,
      quantity: 5,
      updatedAt: now.toISOString(),
      variantId,
      version: 3,
    },
  ]);
  const stores: RuntimeContext = {
    deviceId,
    lease,
    organizationId,
    outbox,
    writer,
  };
  return { outbox, stores };
}

describe("a target without the cost on the device", () => {
  it("never blocks a receipt for an unknown cost it cannot know, but still does online", () => {
    expect(stockActionBlock("receive", offlineTarget)).toBeNull();
    expect(stockActionBlock("receive", onlineUnknownCost)).not.toBeNull();
  });

  it("offers no valuation field and no cost preview, and says the cost needs a connection", () => {
    expect(valuationApplies(offlineTarget)).toBe(false);
    expect(valuationApplies(onlineUnknownCost)).toBe(true);
    expect(targetCostText(offlineTarget)).toBe("Disponível com conexão");

    const receive = filled(
      "receive",
      { quantity: "10", unitCost: "12,50" },
      offlineTarget
    );
    const { body } = validateStockDraft(
      receive.draft,
      receive.target,
      receive.today
    );
    expect(body).not.toBeNull();
    if (body) {
      const labels = stockSummary(body, offlineTarget).map((l) => l.label);
      expect(labels).not.toContain("Custo médio previsto");
    }

    const count = filled("count", { physicalQuantity: "7" }, offlineTarget);
    const countBody = validateStockDraft(
      count.draft,
      count.target,
      count.today
    ).body;
    if (countBody) {
      const lines = stockSummary(countBody, offlineTarget);
      expect(lines.map((l) => l.label)).not.toContain("Custo");
    }
  });

  it("shows the cost column as a connection matter, not as an unknown cost, in the list", () => {
    const [offlineRow] = stockRows([entry], true);
    expect(offlineRow?.costUnknown).toBe(false);
    expect(offlineRow?.costText).toBe("Com conexão");
    expect(offlineRow?.target.costUnavailable).toBe(true);
    const [onlineRow] = stockRows([entry]);
    expect(onlineRow?.costUnknown).toBe(true);
  });
});

describe("queueing a stock movement on the device", () => {
  it("keeps a receipt with the call's command ID and answers with the balance the device shows", async () => {
    const { outbox, stores } = await setup();
    const state = filled(
      "receive",
      { quantity: "10", unitCost: "12,50" },
      offlineTarget
    );
    const prepared = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(state),
    });
    if (!prepared.ok) {
      throw new Error("not prepared");
    }
    const result = await queueOfflineStock({ call: prepared.call, stores });

    expect(result.balance).toEqual({
      movingAverageCost: null,
      quantity: 15,
      variantId,
      version: 4,
    });
    expect(result.replayed).toBe(false);
    const pending = await pendingStockCommands(outbox);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      commandId: prepared.call.input.commandId,
      state: "pending",
      type: "stock.receive",
      variantId,
    });

    // the same call again queues nothing new
    await queueOfflineStock({ call: prepared.call, stores });
    expect(await pendingStockCommands(outbox)).toHaveLength(1);
  });

  it("keeps a count against the version the device shows, and a write-off", async () => {
    const { outbox, stores } = await setup();
    const count = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled("count", { physicalQuantity: "7" }, offlineTarget)
      ),
    });
    if (!count.ok) {
      throw new Error("not prepared");
    }
    const counted = await queueOfflineStock({ call: count.call, stores });
    expect(counted.balance).toMatchObject({ quantity: 7, version: 4 });

    const writeOff = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled(
          "write_off",
          { quantity: "2", reasonCode: "damaged" },
          { ...offlineTarget, quantity: 7, version: 4 }
        )
      ),
    });
    if (!writeOff.ok) {
      throw new Error("not prepared");
    }
    const written = await queueOfflineStock({ call: writeOff.call, stores });
    expect(written.balance).toMatchObject({ quantity: 5, version: 5 });
    expect(await pendingStockCommands(outbox)).toHaveLength(2);
  });

  it("refuses a write-off the device's own stock cannot cover, and queues nothing", async () => {
    const { outbox, stores } = await setup();
    const prepared = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled(
          "write_off",
          { quantity: "4", reasonCode: "damaged" },
          // the screen thought it had 9, the device has 5
          { ...offlineTarget, quantity: 9 }
        )
      ),
    });
    if (!prepared.ok) {
      throw new Error("not prepared");
    }
    await expect(
      queueOfflineStock({ call: prepared.call, stores })
    ).resolves.toBeDefined();

    const second = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled(
          "write_off",
          { quantity: "4", reasonCode: "damaged" },
          { ...offlineTarget, quantity: 9 }
        )
      ),
    });
    if (!second.ok) {
      throw new Error("not prepared");
    }
    // 5 - 4 = 1 left: another 4 does not fit
    await expect(
      queueOfflineStock({ call: second.call, stores })
    ).rejects.toThrow("insufficient_local_stock");
    expect(await pendingStockCommands(outbox)).toHaveLength(1);
  });
});

describe("the outcome shown to the person", () => {
  it("says the movement is kept on the device and only counts once the server confirms", () => {
    const state = filled(
      "write_off",
      { quantity: "2", reasonCode: "damaged" },
      offlineTarget
    );
    const done = stockSucceeded(
      state,
      {
        balance: {
          movingAverageCost: null,
          quantity: 3,
          variantId,
          version: 4,
        },
        replayed: false,
      },
      true
    );
    expect(done.submission.phase).toBe("success");
    if (done.submission.phase === "success") {
      expect(done.submission.queued).toBe(true);
      expect(done.submission.message).toContain("guardada neste aparelho");
      expect(done.submission.message).toContain("Só vale quando o servidor");
    }
    const receipt = stockSucceeded(
      filled("receive", { quantity: "1", unitCost: "1" }, offlineTarget),
      {
        balance: {
          movingAverageCost: null,
          quantity: 6,
          variantId,
          version: 4,
        },
        replayed: false,
      },
      true
    );
    if (receipt.submission.phase === "success") {
      expect(receipt.submission.message).toContain("guardado neste aparelho");
    }
  });

  it("reopens editing, definite, when nothing could be kept", () => {
    const state = filled(
      "write_off",
      { quantity: "2", reasonCode: "damaged" },
      offlineTarget
    );
    const insufficient = Object.assign(new Error("insufficient_local_stock"), {
      name: "InsufficientLocalStockError",
    });
    const failed = stockQueueFailed(state, insufficient);
    expect(failed.step).toBe("editing");
    expect(failed.submission.phase).toBe("failed");
    if (failed.submission.phase === "failed") {
      expect(failed.submission.failure.message).toContain(
        "Estoque insuficiente neste aparelho"
      );
      expect(failed.submission.failure.unknownOutcome).toBe(false);
      // the message sits on the quantity field, not in the alert at the foot
      expect(failed.submission.failure.field).toBe("quantity");
    }
    const other = stockQueueFailed(state, new Error("lease expired"));
    if (other.submission.phase === "failed") {
      expect(other.submission.failure.message).toContain("Nada foi guardado");
    }
    expect(stockSubmitLabel(state)).toBe("Confirmar baixa");
  });
});

describe("a count made against the balance the person reviewed", () => {
  it("is refused when the device's balance moved since the panel was opened, and queues nothing", async () => {
    const { outbox, stores } = await setup();
    // the person reviewed version 3 (the device row)
    const prepared = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled("count", { physicalQuantity: "7" }, offlineTarget)
      ),
    });
    if (!prepared.ok) {
      throw new Error("not prepared");
    }
    // meanwhile a movement was queued on the device: the version is now 4
    const receipt = prepareStockSubmission({
      createId: ids(),
      organizationId,
      state: reviewStock(
        filled("receive", { quantity: "1", unitCost: "1" }, offlineTarget)
      ),
    });
    if (!receipt.ok) {
      throw new Error("not prepared");
    }
    await queueOfflineStock({ call: receipt.call, stores });

    await expect(
      queueOfflineStock({ call: prepared.call, stores })
    ).rejects.toThrow("stale_local_count");
    expect(await pendingStockCommands(outbox)).toHaveLength(1);

    const failed = stockQueueFailed(
      reviewStock(filled("count", { physicalQuantity: "7" }, offlineTarget)),
      Object.assign(new Error("stale_local_count"), {
        name: "StaleLocalCountError",
      })
    );
    if (failed.submission.phase === "failed") {
      expect(failed.submission.failure.message).toContain(
        "mudou depois que você abriu a contagem"
      );
    }
  });
});
