import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  SaleDetailReadModel,
  SaleListEntryReadModel,
} from "@polaris/contracts";
import type {
  CancelSaleRepositoryInput,
  CancelSaleResult,
} from "@polaris/db/sale-cancellation-repository";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import { SaleProductUnavailableError } from "@polaris/domain/sales/confirm-sale";
import {
  InvalidSaleCancellationError,
  SaleAlreadyCancelledError,
  SaleCancellationCommandConflictError,
  UnsupportedSaleCancellationCommandVersionError,
} from "@polaris/domain/sales/sale-cancellation";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const saleId = "0199c2d0-0000-7000-8000-000000000004";
const commandId = "0199c2d0-0000-7000-8000-000000000021";
const variantId = "0199c2d0-0000-7000-8000-000000000002";
const productId = "0199c2d0-0000-7000-8000-000000000003";
const cancellationId = "0199c2d0-0000-7000-8000-000000000022";

const identity: TenantRequestIdentity = {
  capability: "sale:cancel",
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

const cancelled: CancelSaleResult = {
  cancellation: {
    cancelledAt: new Date("2026-10-13T20:00:00.000Z"),
    cancelledBy: "verified-session-user",
    commandId,
    id: cancellationId,
    reasonCode: "customer_request",
    reasonNote: "desistiu",
    saleId,
  },
  replayed: false,
  restocked: [{ position: 0, quantity: 2, variantId }],
};

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;
type CancelSale = NonNullable<Overrides["cancelSale"]>;
type ListSales = NonNullable<Overrides["listSales"]>;
type GetSale = NonNullable<Overrides["getSale"]>;

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    sale: {
      cancel: (input: unknown) => Promise<{
        cancellation: { cancelledAt: string; reasonCode: string | null };
        replayed: boolean;
        restocked: Array<{ quantity: number }>;
      }>;
      get: (input: unknown) => Promise<SaleDetailReadModel>;
      list: (
        input: unknown
      ) => Promise<{ hasMore: boolean; sales: SaleListEntryReadModel[] }>;
    };
  };
}

function tenantStub(capability: { seen?: string }) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    capability.seen = input.capability;
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

function rejectingTenantStub(error: unknown) {
  return <T>(_input: TenantRequestContextInput<T>): Promise<T> =>
    Promise.reject(error);
}

describe("sale.cancel RPC", () => {
  it("cancels through the tenant context with the sale:cancel capability", async () => {
    const seen: { seen?: string } = {};
    const cancelSale = vi.fn<CancelSale>(async () => cancelled);
    const client = createRpcClient(
      createRpcRouter({
        cancelSale,
        withTenantRequestContext: tenantStub(seen),
      })
    );

    await expect(
      client.sale.cancel({
        commandId,
        commandVersion: 1,
        organizationId,
        reasonCode: "customer_request",
        reasonNote: "desistiu",
        saleId,
      })
    ).resolves.toMatchObject({
      cancellation: {
        cancelledAt: "2026-10-13T20:00:00.000Z",
        reasonCode: "customer_request",
      },
      replayed: false,
      restocked: [{ quantity: 2 }],
    });
    expect(seen.seen).toBe("sale:cancel");
    const [, passedIdentity, passedInput] = cancelSale.mock.calls[0] as [
      TenantRequestTransaction,
      TenantRequestIdentity,
      CancelSaleRepositoryInput,
    ];
    expect(passedIdentity).toBe(identity);
    expect(passedInput).toMatchObject({
      commandId,
      commandVersion: 1,
      reasonCode: "customer_request",
      reasonNote: "desistiu",
      saleId,
    });
    expect(Object.keys(passedInput)).not.toContain("organizationId");
  });

  it("sends a missing reason as null", async () => {
    const cancelSale = vi.fn<CancelSale>(async () => cancelled);
    const client = createRpcClient(
      createRpcRouter({
        cancelSale,
        withTenantRequestContext: tenantStub({}),
      })
    );
    await client.sale.cancel({
      commandId,
      commandVersion: 1,
      organizationId,
      saleId,
    });
    expect(cancelSale.mock.calls[0]?.[2]).toMatchObject({
      reasonCode: null,
      reasonNote: null,
    });
  });

  it("rejects malformed input before reaching the repository", async () => {
    const cancelSale = vi.fn<CancelSale>();
    const client = createRpcClient(
      createRpcRouter({
        cancelSale,
        withTenantRequestContext: tenantStub({}),
      })
    );
    for (const bad of [
      { commandId: "nope" },
      { commandVersion: 2 },
      { reasonCode: "fraud" },
      { saleId: "nope" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each rejection is asserted before the next input
      await expect(
        client.sale.cancel({
          commandId,
          commandVersion: 1,
          organizationId,
          saleId,
          ...bad,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(cancelSale).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid cancellation", new InvalidSaleCancellationError(), "BAD_REQUEST"],
    [
      "unsupported version",
      new UnsupportedSaleCancellationCommandVersionError(),
      "BAD_REQUEST",
    ],
    ["already cancelled", new SaleAlreadyCancelledError(), "CONFLICT"],
    [
      "command conflict",
      new SaleCancellationCommandConflictError(),
      "CONFLICT",
    ],
    ["unavailable product", new SaleProductUnavailableError(), "CONFLICT"],
    ["deleted product", new ProductDeletedError(), "CONFLICT"],
    ["unknown sale", new SaleNotFoundError(), "NOT_FOUND"],
    [
      "capability",
      new TenantAuthorizationError("capability_denied"),
      "FORBIDDEN",
    ],
    [
      "session",
      new TenantRequestContextError("session_required"),
      "UNAUTHORIZED",
    ],
  ])(
    "maps %s to %s with a reason only for actionable errors",
    async (_label, error, code) => {
      const client = createRpcClient(
        createRpcRouter({
          cancelSale: vi.fn<CancelSale>(),
          withTenantRequestContext: rejectingTenantStub(error),
        })
      );
      const rejection = client.sale.cancel({
        commandId,
        commandVersion: 1,
        organizationId,
        saleId,
      });
      await expect(rejection).rejects.toMatchObject({ code });
      if (["BAD_REQUEST", "CONFLICT", "NOT_FOUND"].includes(code)) {
        await expect(rejection).rejects.toMatchObject({
          data: { reason: (error as { code?: string }).code },
        });
      } else {
        await expect(rejection).rejects.toMatchObject({ data: undefined });
      }
    }
  );
});

describe("sale.list and sale.get RPCs", () => {
  const listed = {
    hasMore: true,
    sales: [
      {
        cancelledAt: null,
        confirmedAt: new Date("2026-10-13T18:30:01.000Z"),
        customerId: null,
        id: saleId,
        itemCount: 1,
        occurredAt: new Date("2026-10-13T18:30:00.000Z"),
        paymentMethod: "pix",
        status: "confirmed" as const,
        totalDue: "99.80",
      },
      {
        cancelledAt: new Date("2026-10-13T21:00:00.000Z"),
        confirmedAt: new Date("2026-10-13T19:00:01.000Z"),
        customerId: "0199c2d0-0000-7000-8000-000000000031",
        id: "0199c2d0-0000-7000-8000-000000000005",
        itemCount: 2,
        occurredAt: new Date("2026-10-13T19:00:00.000Z"),
        paymentMethod: "cash",
        status: "cancelled" as const,
        totalDue: "10.00",
      },
    ],
  };

  it("lists with the read capability and default paging", async () => {
    const seen: { seen?: string } = {};
    const listSales = vi.fn<ListSales>(async () => listed);
    const client = createRpcClient(
      createRpcRouter({
        listSales,
        withTenantRequestContext: tenantStub(seen),
      })
    );
    const result = await client.sale.list({ organizationId });
    expect(seen.seen).toBe("sale:read");
    expect(listSales.mock.calls[0]?.[2]).toEqual({ limit: 50, offset: 0 });
    expect(result.hasMore).toBe(true);
    expect(result.sales.map((sale) => sale.status)).toEqual([
      "confirmed",
      "cancelled",
    ]);
    expect(result.sales[1]).toMatchObject({
      cancelledAt: "2026-10-13T21:00:00.000Z",
      customerId: "0199c2d0-0000-7000-8000-000000000031",
    });
  });

  it("validates paging bounds", async () => {
    const client = createRpcClient(
      createRpcRouter({
        listSales: vi.fn<ListSales>(),
        withTenantRequestContext: tenantStub({}),
      })
    );
    for (const paging of [{ limit: 0 }, { limit: 101 }, { offset: -1 }]) {
      // biome-ignore lint/performance/noAwaitInLoops: each rejection is asserted before the next input
      await expect(
        client.sale.list({ organizationId, ...paging })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("gets one sale with its cancellation and customer", async () => {
    const getSale = vi.fn<GetSale>(async () => ({
      cancellation: cancelled.cancellation,
      customer: { customerId: null, version: 0 },
      sale: {
        adjustments: [],
        items: [
          {
            chargedUnitPrice: "49.90",
            listedUnitPrice: "50.00",
            position: 0,
            productId,
            productLabel: "Camiseta",
            quantity: 2,
            unitCost: "12.345678",
            variantId,
          },
        ],
        payment: {
          amount: "99.80",
          anticipationFee: {
            amount: "0.00",
            fixedAmount: null,
            mode: "not_applicable",
            percentage: null,
          },
          anticipationRequested: false,
          expectedSettlementDays: null,
          installmentPlan: null,
          installments: null,
          method: "pix",
          paymentProfileId: null,
          paymentProfileName: null,
          paymentProfileRuleId: null,
          paymentProfileVersion: null,
          processingFee: {
            amount: null,
            fixedAmount: null,
            mode: "unknown",
            percentage: null,
          },
        },
        sale: {
          clientCreatedAt: null,
          commandId,
          confirmedAt: new Date("2026-10-13T18:30:01.000Z"),
          currency: "BRL",
          id: saleId,
          occurredAt: new Date("2026-10-13T18:30:00.000Z"),
        },
        totals: {
          discountTotal: "0.00",
          freightTotal: "0.00",
          paymentSurchargeTotal: "0.00",
          subtotal: "99.80",
          surchargeTotal: "0.00",
          totalDue: "99.80",
        },
      },
    }));
    const client = createRpcClient(
      createRpcRouter({ getSale, withTenantRequestContext: tenantStub({}) })
    );
    const detail = await client.sale.get({ organizationId, saleId });
    expect(getSale.mock.calls[0]?.[2]).toBe(saleId);
    expect(detail.cancellation?.reasonCode).toBe("customer_request");
    expect(detail.sale.items[0]?.unitCost).toBe("12.345678");
    expect(Object.keys(detail.sale)).not.toContain("replayed");
    expect(detail.customer).toEqual({ customerId: null, version: 0 });
  });

  it("maps a missing sale to not found", async () => {
    const client = createRpcClient(
      createRpcRouter({
        getSale: vi.fn<GetSale>(),
        withTenantRequestContext: rejectingTenantStub(new SaleNotFoundError()),
      })
    );
    await expect(
      client.sale.get({ organizationId, saleId })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { reason: "sale_not_found" },
    });
  });
});
