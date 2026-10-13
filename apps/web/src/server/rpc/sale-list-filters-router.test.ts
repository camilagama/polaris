import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const identity = {
  capability: "sale:read",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  DB_POC_ENABLED: "false",
  DB_RLS_POC_ENABLED: "false",
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface TenantContextRequest {
  operation: (
    transaction: unknown,
    authorizedIdentity: typeof identity
  ) => Promise<unknown>;
}

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

function createClient(listSales: unknown) {
  const router = createRpcRouter({
    listSales,
    withTenantRequestContext: (request: TenantContextRequest) =>
      request.operation({}, identity),
  } as unknown as Overrides);
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    sale: {
      list: (input: unknown) => Promise<{
        hasMore: boolean;
        sales: Record<string, unknown>[];
      }>;
    };
  };
}

const sale = {
  cancelledAt: null,
  confirmedAt: new Date("2026-10-13T18:30:01.000Z"),
  customerId: "0199c2d0-0000-7000-8000-000000000031",
  customerName: "Ana Souza",
  hasReturns: true,
  id: "0199c2d0-0000-7000-8000-000000000004",
  itemCount: 1,
  occurredAt: new Date("2026-10-12T15:00:00.000Z"),
  occurredOn: "2026-10-12",
  paymentMethod: "pix",
  status: "confirmed" as const,
  totalDue: "99.80",
};

describe("sale.list filters", () => {
  it("forwards the optional period, status, customer and text filters", async () => {
    const listSales = vi.fn(async () => ({ hasMore: false, sales: [sale] }));
    const client = createClient(listSales);

    const result = await client.sale.list({
      customerQuery: " ana ",
      occurredFrom: "2026-10-01",
      occurredTo: "2026-10-31",
      organizationId,
      query: "camiseta",
      status: "with_returns",
    });

    expect(listSales).toHaveBeenCalledWith({}, identity, {
      customerQuery: "ana",
      limit: 50,
      occurredFrom: "2026-10-01",
      occurredTo: "2026-10-31",
      offset: 0,
      query: "camiseta",
      status: "with_returns",
    });
    expect(result.sales[0]).toMatchObject({
      customerName: "Ana Souza",
      occurredOn: "2026-10-12",
    });
  });

  it("keeps the unfiltered call compatible", async () => {
    const listSales = vi.fn(async () => ({ hasMore: false, sales: [] }));
    const client = createClient(listSales);

    await client.sale.list({ organizationId });

    expect(listSales.mock.calls[0]?.[2]).toEqual({ limit: 50, offset: 0 });
  });

  it.each([
    ["an impossible date", { occurredFrom: "2026-02-31" }],
    ["a malformed date", { occurredTo: "13/10/2026" }],
    ["an unknown status", { status: "refunded" }],
  ])("rejects %s before reaching the repository", async (_label, filters) => {
    const listSales = vi.fn();
    const client = createClient(listSales);

    await expect(
      client.sale.list({ organizationId, ...filters })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listSales).not.toHaveBeenCalled();
  });
});
