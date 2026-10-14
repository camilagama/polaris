import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { InvalidSyncCursorError } from "@polaris/db/sync-repository";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const identity = {
  capability: "sync:read",
  organizationId,
  role: "owner",
  userId: "session-user-17",
};
const bindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface PullResult {
  changes: Array<{ entityId: string; entityType: string; seq: number }>;
  hasMore: boolean;
  nextCursor: string;
}

function createClient(overrides: Record<string, unknown>) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, bindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    sync: {
      getCursor: (input: unknown) => Promise<{ cursor: string }>;
      pull: (input: unknown) => Promise<PullResult>;
    };
  };
}

function tenantContext() {
  return vi.fn(
    (input: {
      capability: string;
      operation: (
        transaction: unknown,
        authorized: typeof identity
      ) => Promise<unknown>;
      requestedOrganizationId: string;
    }) => input.operation({}, identity)
  );
}

describe("sync.getCursor", () => {
  it("reads the cursor with sync:read for the requested organization", async () => {
    const withTenantRequestContext = tenantContext();
    const getSyncCursor = vi.fn(() => Promise.resolve(42));
    const client = createClient({ getSyncCursor, withTenantRequestContext });

    await expect(client.sync.getCursor({ organizationId })).resolves.toEqual({
      cursor: "42",
    });
    expect(withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "sync:read",
        requestedOrganizationId: organizationId,
      })
    );
    expect(getSyncCursor).toHaveBeenCalledWith({}, identity);
  });
});

describe("sync.pull", () => {
  const entityId = "0199c2d0-0000-7000-8000-0000000000e1";

  it("passes the cursor and limit and serializes the cursor as text", async () => {
    const pullSyncChanges = vi.fn(() =>
      Promise.resolve({
        changes: [{ entityId, entityType: "product", seq: 7 }],
        hasMore: true,
        nextCursor: 9,
      })
    );
    const client = createClient({
      pullSyncChanges,
      withTenantRequestContext: tenantContext(),
    });

    const result = await client.sync.pull({
      cursor: "5",
      limit: 50,
      organizationId,
    });

    expect(pullSyncChanges).toHaveBeenCalledWith({}, identity, {
      cursor: "5",
      limit: 50,
    });
    expect(result).toEqual({
      changes: [{ entityId, entityType: "product", seq: 7 }],
      hasMore: true,
      nextCursor: "9",
    });
  });

  it("defaults the limit and treats a missing cursor as the start", async () => {
    const pullSyncChanges = vi.fn(() =>
      Promise.resolve({ changes: [], hasMore: false, nextCursor: 0 })
    );
    const client = createClient({
      pullSyncChanges,
      withTenantRequestContext: tenantContext(),
    });
    await client.sync.pull({ organizationId });
    expect(pullSyncChanges).toHaveBeenCalledWith({}, identity, {
      cursor: null,
      limit: 200,
    });
  });

  it("rejects malformed cursors and out-of-range limits before the repository", async () => {
    const pullSyncChanges = vi.fn();
    const client = createClient({
      pullSyncChanges,
      withTenantRequestContext: tenantContext(),
    });
    for (const input of [
      { cursor: "-1", organizationId },
      { cursor: "1.5", organizationId },
      { cursor: "abc", organizationId },
      { limit: 0, organizationId },
      { limit: 501, organizationId },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each input is verified on its own
      await expect(client.sync.pull(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(pullSyncChanges).not.toHaveBeenCalled();
  });

  it("maps a cursor the repository refuses to a bad request", async () => {
    const client = createClient({
      pullSyncChanges: () => Promise.reject(new InvalidSyncCursorError()),
      withTenantRequestContext: tenantContext(),
    });
    await expect(
      client.sync.pull({ cursor: "9007199254740991", organizationId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("sync.bootstrapPage", () => {
  const categoryId = "0199c2d0-0000-7000-8000-0000000000c1";

  function bootstrapClient(overrides: Record<string, unknown>) {
    return createClient(overrides) as unknown as {
      sync: { bootstrapPage: (input: unknown) => Promise<unknown> };
    };
  }

  it("reads a page with sync:read for the requested organization", async () => {
    const withTenantRequestContext = tenantContext();
    const readBootstrapPage = vi.fn(() =>
      Promise.resolve({
        collection: "categories",
        nextAfterId: categoryId,
        rows: [
          {
            archivedAt: null,
            deletedAt: null,
            id: categoryId,
            name: "Camisetas",
            updatedAt: "2026-10-14T12:00:00.000Z",
          },
        ],
      })
    );
    const client = bootstrapClient({
      readBootstrapPage,
      withTenantRequestContext,
    });

    const result = await client.sync.bootstrapPage({
      collection: "categories",
      limit: 50,
      organizationId,
    });

    expect(withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "sync:read",
        requestedOrganizationId: organizationId,
      })
    );
    expect(readBootstrapPage).toHaveBeenCalledWith({}, identity, {
      afterId: null,
      collection: "categories",
      ids: null,
      limit: 50,
    });
    expect(result).toMatchObject({
      collection: "categories",
      nextAfterId: categoryId,
    });
  });

  it("passes keyset positions and ids through", async () => {
    const readBootstrapPage = vi.fn(() =>
      Promise.resolve({ collection: "variants", nextAfterId: null, rows: [] })
    );
    const client = bootstrapClient({
      readBootstrapPage,
      withTenantRequestContext: tenantContext(),
    });
    await client.sync.bootstrapPage({
      afterId: categoryId,
      collection: "variants",
      ids: [categoryId],
      organizationId,
    });
    expect(readBootstrapPage).toHaveBeenCalledWith({}, identity, {
      afterId: categoryId,
      collection: "variants",
      ids: [categoryId],
      limit: 200,
    });
  });

  it("rejects unknown collections, bad ids and bad limits before the repository", async () => {
    const readBootstrapPage = vi.fn();
    const client = bootstrapClient({
      readBootstrapPage,
      withTenantRequestContext: tenantContext(),
    });
    for (const input of [
      { collection: "sales", organizationId },
      { collection: "categories", ids: ["nope"], organizationId },
      { collection: "categories", limit: 0, organizationId },
      { collection: "categories", limit: 501, organizationId },
      {
        collection: "categories",
        ids: Array.from({ length: 201 }, () => categoryId),
        organizationId,
      },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each input is verified on its own
      await expect(client.sync.bootstrapPage(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(readBootstrapPage).not.toHaveBeenCalled();
  });
});
