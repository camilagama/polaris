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

function workspace(online: boolean) {
  const syncNow = vi.fn(() => Promise.resolve());
  return {
    online,
    runtime: {
      context: () => ({
        deviceId: "d1",
        lease: "lease",
        organizationId: ORGANIZATION,
        outbox: {},
        writer: {},
      }),
      syncNow,
    },
  } as unknown as Parameters<typeof createProduct>[0];
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

  it.each([true, false])(
    "waits for the server when the product is only queued on the device (online: %s)",
    async (online) => {
      createOfflineProduct.mockResolvedValue(undefined);
      await createProduct(workspace(online), ORGANIZATION, INPUT, {
        ids: newProductIds(),
        today: "2026-10-30",
      });
      expect(rememberedFirstSteps(ORGANIZATION, null)).toBe(1);
    }
  );
});
