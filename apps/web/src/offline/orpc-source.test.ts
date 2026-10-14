import { describe, expect, it, vi } from "vitest";
import {
  BootstrapResponseMismatchError,
  createOrpcBootstrapSource,
  type OfflineSyncClient,
  RECENT_SALES_WINDOW,
} from "./orpc-source";

const organizationId = "org-1";

function fakeClient(overrides: Partial<OfflineSyncClient["sync"]> = {}) {
  const bootstrapPage = vi.fn(() =>
    Promise.resolve({
      collection: "categories" as const,
      nextAfterId: null,
      rows: [],
    })
  );
  const getCursor = vi.fn(() => Promise.resolve({ cursor: "12" }));
  const pull = vi.fn(() =>
    Promise.resolve({ changes: [], hasMore: false, nextCursor: "12" })
  );
  const list = vi.fn(() => Promise.resolve({ hasMore: false, sales: [] }));
  const client: OfflineSyncClient = {
    sale: { list },
    sync: { bootstrapPage, getCursor, pull, ...overrides },
  };
  return { bootstrapPage, client, getCursor, list, pull };
}

describe("oRPC bootstrap source", () => {
  it("reads the cursor for its organization", async () => {
    const { client, getCursor } = fakeClient();
    await expect(
      createOrpcBootstrapSource(client, organizationId).getCursor()
    ).resolves.toBe("12");
    expect(getCursor).toHaveBeenCalledWith({ organizationId });
  });

  it("asks for pages with the keyset position and page size", async () => {
    const { bootstrapPage, client } = fakeClient();
    await createOrpcBootstrapSource(client, organizationId).page("categories", {
      afterId: "after",
      limit: 50,
    });
    expect(bootstrapPage).toHaveBeenCalledWith({
      afterId: "after",
      collection: "categories",
      ids: null,
      limit: 50,
      organizationId,
    });
  });

  it("asks for entities by id without a keyset position", async () => {
    const { bootstrapPage, client } = fakeClient();
    await createOrpcBootstrapSource(client, organizationId).page("categories", {
      ids: ["a", "b"],
    });
    expect(bootstrapPage).toHaveBeenCalledWith({
      afterId: null,
      collection: "categories",
      ids: ["a", "b"],
      organizationId,
    });
  });

  it("refuses an answer for another collection", async () => {
    const { client } = fakeClient();
    await expect(
      createOrpcBootstrapSource(client, organizationId).page("products", {})
    ).rejects.toBeInstanceOf(BootstrapResponseMismatchError);
  });

  it("pulls with the cursor and limit", async () => {
    const { client, pull } = fakeClient();
    await createOrpcBootstrapSource(client, organizationId).pull("5", 500);
    expect(pull).toHaveBeenCalledWith({
      cursor: "5",
      limit: 500,
      organizationId,
    });
  });

  it("reads the recent sales window from the sale list", async () => {
    const { client, list } = fakeClient();
    await createOrpcBootstrapSource(client, organizationId).recentSales();
    expect(list).toHaveBeenCalledWith({
      limit: RECENT_SALES_WINDOW,
      offset: 0,
      organizationId,
    });
    expect(RECENT_SALES_WINDOW).toBeLessThanOrEqual(100);
  });
});
