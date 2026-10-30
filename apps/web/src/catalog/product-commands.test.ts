import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFirstSteps,
  rememberedFirstSteps,
  rememberFirstSteps,
} from "../app-shell/first-steps";

const create = vi.hoisted(() => vi.fn());
const createOfflineProduct = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({ orpcClient: { product: { create } } }));
vi.mock("../offline/product-create", () => ({ createOfflineProduct }));

import { createProduct, newProductIds } from "./product-commands";

const ORGANIZATION = "loja-a";
const INPUT = {
  categoryId: null,
  description: null,
  initialStock: null,
  listPrice: null,
  name: "Camiseta",
};

const COMMAND_ID = "c1";

/** The queue after the send: the command is still in it unless the server accepted it. */
function workspace(options: { accepted?: boolean; online: boolean }) {
  const queue = { commands: [{ commandId: COMMAND_ID, status: "pending" }] };
  const syncNow = vi.fn(() => {
    if (options.accepted) {
      queue.commands = [];
    }
    return Promise.resolve();
  });
  return {
    online: options.online,
    runtime: {
      context: () => ({
        deviceId: "d1",
        lease: "lease",
        organizationId: ORGANIZATION,
        outbox: { snapshot: () => Promise.resolve(queue) },
        writer: {},
      }),
      syncNow,
    },
  } as unknown as Parameters<typeof createProduct>[0];
}

const QUEUED = {
  command: { commandId: COMMAND_ID },
  rows: { product: { id: "p1" } },
};

async function settle() {
  await vi.waitFor(() => expect(createOfflineProduct).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registering the first product", () => {
  beforeEach(() => {
    clearFirstSteps(null);
    rememberFirstSteps(ORGANIZATION, { firstProductId: null }, null);
    create.mockReset();
    createOfflineProduct.mockReset();
  });

  it("makes the foot of the menu say two of three once the server created it", async () => {
    create.mockResolvedValue({ id: "p1", name: "Camiseta" });
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
    await createProduct(null, ORGANIZATION, INPUT, {
      ids: newProductIds(),
      today: "2026-10-30",
    });
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(2);
  });

  it("does not move the steps when the server refuses the product", async () => {
    create.mockRejectedValue(new Error("refused"));
    await expect(
      createProduct(null, ORGANIZATION, INPUT, {
        ids: newProductIds(),
        today: "2026-10-30",
      })
    ).rejects.toThrow("refused");
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
  });

  it("moves the steps after the connected device sent it and the server accepted it", async () => {
    createOfflineProduct.mockResolvedValue(QUEUED);
    await createProduct(
      workspace({ accepted: true, online: true }),
      ORGANIZATION,
      INPUT,
      { ids: newProductIds(), today: "2026-10-30" }
    );
    await vi.waitFor(() =>
      expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(2)
    );
  });

  it("keeps one of three when the server refused or did not answer the queued product", async () => {
    createOfflineProduct.mockResolvedValue(QUEUED);
    const device = workspace({ accepted: false, online: true });
    await createProduct(device, ORGANIZATION, INPUT, {
      ids: newProductIds(),
      today: "2026-10-30",
    });
    await settle();
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
  });

  it("keeps one of three while the product is only on the device, without a connection", async () => {
    createOfflineProduct.mockResolvedValue(QUEUED);
    const device = workspace({ accepted: true, online: false });
    await createProduct(device, ORGANIZATION, INPUT, {
      ids: newProductIds(),
      today: "2026-10-30",
    });
    await settle();
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
  });

  it("keeps one of three when the send itself fails", async () => {
    createOfflineProduct.mockResolvedValue(QUEUED);
    const device = workspace({ accepted: true, online: true });
    (device as unknown as { runtime: { syncNow: unknown } }).runtime.syncNow =
      () => Promise.reject(new Error("offline"));
    await createProduct(device, ORGANIZATION, INPUT, {
      ids: newProductIds(),
      today: "2026-10-30",
    });
    await settle();
    expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
  });
});
