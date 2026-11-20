import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSaleDraft } from "../../sales/sale-draft-storage";
import type { NamespaceKey } from "../namespace";
import type { OutboxCommand } from "../outbox/command";
import type { Outbox } from "../outbox/outbox";

const listBalances = vi.hoisted(() => vi.fn());

vi.mock("../../lib/orpc", () => ({
  orpcClient: { inventory: { listBalances } },
}));

import { redoSale } from "./attention-page";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ORG = uuid(2);
const MUG = uuid(10);
const NAMESPACE = uuid(3) as NamespaceKey;
const REFUSED = uuid(500);
const SAO_PAULO = "America/Sao_Paulo";

// 23:55 in São Paulo (UTC−3), the evening before
const REDONE_AT = new Date("2026-11-11T02:55:00.000Z");
const AT_0005 = new Date("2026-11-11T03:05:00.000Z");
const AT_0611 = new Date("2026-11-11T09:11:00.000Z");

const refusedSale = (): OutboxCommand => ({
  attempts: 1,
  baseVersion: null,
  commandId: REFUSED,
  createdAt: "2026-11-10T20:00:00.000Z",
  deviceId: uuid(1),
  lastAttemptAt: null,
  lease: "lease",
  organizationId: ORG,
  payload: {
    adjustments: [],
    items: [
      {
        chargedUnitPrice: "35.00",
        listedUnitPrice: "40.00",
        quantity: 2,
        variantId: MUG,
      },
    ],
    occurredAt: "2026-11-10T20:00:00.000Z",
    payment: {
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: "cash",
    },
    recordedAt: "2026-11-10T20:00:00.000Z",
  },
  rejection: { at: "2026-11-10T21:00:00.000Z", code: "authorization_revoked" },
  seq: 1,
  status: "rejected",
  type: "sale.confirm",
});

const balance = {
  isDefaultVariant: true,
  listPrice: "35.00",
  movingAverageCost: null,
  productId: uuid(20),
  productName: "Caneca",
  productStatus: "active",
  quantity: 10,
  sku: null,
  updatedAt: null,
  values: [],
  variantId: MUG,
  version: 1,
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const outbox = {
  snapshot: () => Promise.resolve({ commands: [refusedSale()] }),
} as unknown as Outbox;

const redo = () => redoSale(REFUSED, outbox, ORG, NAMESPACE, SAO_PAULO);

describe("the draft that redoing a refused sale leaves in Vender", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    });
    listBalances.mockResolvedValue({ entries: [balance] });
    vi.useFakeTimers({ now: REDONE_AT, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    listBalances.mockReset();
  });

  it("is stamped as last edited when it began, so it is still the person's at 00:05 the next day", async () => {
    expect(await redo()).toBe("opened");

    vi.setSystemTime(AT_0005);
    const draft = readSaleDraft(
      window.sessionStorage,
      ORG,
      new Date(),
      SAO_PAULO
    );
    expect(draft.kind).toBe("restored");
    if (draft.kind !== "restored") {
      return;
    }
    expect(draft.draft.startedAt).toBe(REDONE_AT.toISOString());
    expect(draft.draft.updatedAt).toBe(REDONE_AT.toISOString());

    expect(await redo()).toBe("opened");
  });

  it("is dropped only once 6 hours have passed since it began", async () => {
    await redo();

    vi.setSystemTime(AT_0611);
    expect(
      readSaleDraft(window.sessionStorage, ORG, new Date(), SAO_PAULO).kind
    ).toBe("expired");
  });
});
