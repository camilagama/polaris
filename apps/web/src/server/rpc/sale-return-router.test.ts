import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type {
  CreateSaleReturnRepositoryInput,
  CreateSaleReturnResult,
} from "@polaris/db/sale-return-repository";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { ProductDeletedError } from "@polaris/domain/catalog/product";
import { SaleProductUnavailableError } from "@polaris/domain/sales/confirm-sale";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import {
  InvalidSaleReturnError,
  SaleHasReturnsError,
  SaleNotReturnableError,
  SaleReturnCommandConflictError,
  SaleReturnExceedsAvailableError,
  UnsupportedSaleReturnCommandVersionError,
} from "@polaris/domain/sales/sale-return";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const saleId = "0199c2d0-0000-7000-8000-000000000004";
const commandId = "0199c2d0-0000-7000-8000-000000000041";
const returnId = "0199c2d0-0000-7000-8000-000000000042";

const identity: TenantRequestIdentity = {
  capability: "sale:return",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

const created: CreateSaleReturnResult = {
  lines: [{ position: 0, restockedQuantity: 1, returnedQuantity: 2 }],
  replayed: false,
  saleReturn: {
    commandId,
    id: returnId,
    reasonCode: "defective",
    reasonNote: null,
    returnedAt: new Date("2026-10-13T22:00:00.000Z"),
    returnedBy: "verified-session-user",
    saleId,
  },
};

type CreateReturn = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["createSaleReturn"]
>;

const validInput = {
  commandId,
  commandVersion: 1,
  items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 2 }],
  organizationId,
  reasonCode: "defective",
  saleId,
};

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    sale: {
      return: (input: unknown) => Promise<{
        lines: { position: number; restockedQuantity: number }[];
        replayed: boolean;
        saleReturn: { returnedAt: string; reasonCode: string | null };
      }>;
    };
  };
}

function tenantStub(seen: { seen?: string }) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    seen.seen = input.capability;
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

function rejectingTenantStub(error: unknown) {
  return <T>(_input: TenantRequestContextInput<T>): Promise<T> =>
    Promise.reject(error);
}

describe("sale.return RPC", () => {
  it("returns through the tenant context with the sale:return capability", async () => {
    const seen: { seen?: string } = {};
    const createSaleReturn = vi.fn<CreateReturn>(async () => created);
    const client = createRpcClient(
      createRpcRouter({
        createSaleReturn,
        withTenantRequestContext: tenantStub(seen),
      })
    );

    await expect(client.sale.return(validInput)).resolves.toMatchObject({
      lines: [{ position: 0, restockedQuantity: 1 }],
      replayed: false,
      saleReturn: {
        reasonCode: "defective",
        returnedAt: "2026-10-13T22:00:00.000Z",
      },
    });
    expect(seen.seen).toBe("sale:return");
    const [, passedIdentity, passedInput] = createSaleReturn.mock.calls[0] as [
      TenantRequestTransaction,
      TenantRequestIdentity,
      CreateSaleReturnRepositoryInput,
    ];
    expect(passedIdentity).toBe(identity);
    expect(passedInput).toMatchObject({
      commandId,
      commandVersion: 1,
      items: [{ position: 0, restockedQuantity: 1, returnedQuantity: 2 }],
      reasonCode: "defective",
      reasonNote: null,
      saleId,
    });
    expect(Object.keys(passedInput)).not.toContain("organizationId");
  });

  it("rejects malformed input before reaching the repository", async () => {
    const createSaleReturn = vi.fn<CreateReturn>();
    const client = createRpcClient(
      createRpcRouter({
        createSaleReturn,
        withTenantRequestContext: tenantStub({}),
      })
    );
    for (const bad of [
      { items: [] },
      { items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 0 }] },
      { items: [{ position: -1, restockedQuantity: 0, returnedQuantity: 1 }] },
      { items: [{ position: 0, restockedQuantity: 0.5, returnedQuantity: 1 }] },
      { commandVersion: 2 },
      { reasonCode: "fraud" },
      { saleId: "nope" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each rejection is asserted before the next input
      await expect(
        client.sale.return({ ...validInput, ...bad })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(createSaleReturn).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid return", new InvalidSaleReturnError(), "BAD_REQUEST"],
    [
      "unsupported version",
      new UnsupportedSaleReturnCommandVersionError(),
      "BAD_REQUEST",
    ],
    ["more than available", new SaleReturnExceedsAvailableError(), "CONFLICT"],
    ["cancelled sale", new SaleNotReturnableError(), "CONFLICT"],
    ["sale with returns", new SaleHasReturnsError(), "CONFLICT"],
    ["command conflict", new SaleReturnCommandConflictError(), "CONFLICT"],
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
          createSaleReturn: vi.fn<CreateReturn>(),
          withTenantRequestContext: rejectingTenantStub(error),
        })
      );
      const rejection = client.sale.return(validInput);
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
