import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFirstSteps,
  rememberedFirstSteps,
  rememberFirstSteps,
} from "../app-shell/first-steps";
import {
  createProduct,
  newProductIds,
  type Workspace,
} from "./product-commands";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createOffline: vi.fn(),
}));

vi.mock("../lib/orpc", () => ({
  orpcClient: { product: { create: mocks.create } },
}));
vi.mock("../offline/product-create", () => ({
  createOfflineProduct: mocks.createOffline,
}));

const ORGANIZATION = "loja-a";
const COMMAND_ID = "0199c2d0-0000-7000-8000-0000000000c1";
const PRODUCT_ID = "0199c2d0-0000-7000-8000-0000000000b1";
const input = {
  categoryId: null,
  description: null,
  initialStock: null,
  listPrice: null,
  name: "Bolsa de couro",
};
const names = { ids: newProductIds(), today: "2026-10-23" };

function device(queued: string[], online: boolean) {
  const syncNow = vi.fn(() => Promise.resolve());
  const stores = {
    deviceId: "d1",
    lease: "lease",
    organizationId: ORGANIZATION,
    outbox: {
      snapshot: () =>
        Promise.resolve({
          commands: queued.map((commandId) => ({ commandId })),
        }),
    },
    writer: {},
  };
  const workspace = {
    online,
    runtime: { context: () => stores, syncNow },
  } as unknown as Workspace;
  return { syncNow, workspace };
}

async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registering a product moves the first steps of the menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFirstSteps();
    rememberFirstSteps(ORGANIZATION, { firstProductId: null });
    mocks.createOffline.mockResolvedValue({
      command: { commandId: COMMAND_ID },
      rows: { product: { id: PRODUCT_ID } },
    });
  });

  it("at once when the server created it", async () => {
    mocks.create.mockResolvedValue({ id: PRODUCT_ID, name: "Bolsa de couro" });
    await createProduct(null, ORGANIZATION, input, names);
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(2);
  });

  it("not when the server refused it", async () => {
    mocks.create.mockRejectedValue(new Error("refused"));
    await expect(
      createProduct(null, ORGANIZATION, input, names)
    ).rejects.toThrow("refused");
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(1);
  });

  it("once the server took the one kept on the device, which leaves the queue", async () => {
    const { syncNow, workspace } = device([], true);
    await createProduct(workspace, ORGANIZATION, input, names);
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(1);
    await settled();
    expect(syncNow).toHaveBeenCalledOnce();
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(2);
  });

  it("not while the one kept on the device is still in the queue (refused or waiting)", async () => {
    const { workspace } = device([COMMAND_ID], true);
    await createProduct(workspace, ORGANIZATION, input, names);
    await settled();
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(1);
  });

  it("not without a connection: the Início does not count it either", async () => {
    const { syncNow, workspace } = device([], false);
    await createProduct(workspace, ORGANIZATION, input, names);
    await settled();
    expect(syncNow).not.toHaveBeenCalled();
    expect(rememberedFirstSteps(ORGANIZATION)).toBe(1);
  });
});
