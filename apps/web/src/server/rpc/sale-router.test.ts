import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ConfirmedSaleReadModel } from "@polaris/contracts";
import type {
  ConfirmSaleRepositoryInput,
  ConfirmSaleResult,
} from "@polaris/db/sale-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import {
  InsufficientStockError,
  InventoryVariantNotFoundError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidConfirmSaleCommandError,
  SaleCommandConflictError,
  SaleOccurredInFutureError,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import {
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
} from "@polaris/domain/sales/payment-profile";
import { SaleDiscountExceedsSubtotalError } from "@polaris/domain/sales/sale-adjustments";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { InvalidSalePaymentError } from "@polaris/domain/sales/sale-payment";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import {
  createTenantRequestContext,
  type TenantRequestContextInput,
} from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const otherOrganizationId = "11111111-f90b-4e05-9e9a-0c0eb1c9c9b0";
const commandId = "0199c2d0-0000-7000-8000-000000000001";
const variantId = "0199c2d0-0000-7000-8000-000000000002";
const productId = "0199c2d0-0000-7000-8000-000000000003";
const saleId = "0199c2d0-0000-7000-8000-000000000004";
const profileId = "0199c2d0-0000-7000-8000-000000000005";
const ruleId = "0199c2d0-0000-7000-8000-000000000006";

const identity: TenantRequestIdentity = {
  capability: "sale:create",
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

const validInput = {
  adjustments: [
    { kind: "discount", value: { percentage: "10", type: "percentage" } },
  ],
  commandId,
  commandVersion: 1,
  items: [
    {
      chargedUnitPrice: "89.90",
      listedUnitPrice: "100.00",
      quantity: 2,
      variantId,
    },
  ],
  occurredAt: "2026-10-13T15:30:00-03:00",
  organizationId,
  payment: {
    anticipationRequested: true,
    installmentPlan: "issuer",
    installments: 3,
    method: "credit_card",
  },
  paymentProfile: { expectedVersion: 2, id: profileId },
};

const confirmedResult: ConfirmSaleResult = {
  adjustments: [
    {
      amount: "17.98",
      kind: "discount",
      percentage: "10.000000",
      position: 0,
      valueType: "percentage",
    },
  ],
  items: [
    {
      chargedUnitPrice: "89.90",
      listedUnitPrice: "100.00",
      position: 0,
      productId,
      productLabel: "Camiseta",
      quantity: 2,
      unitCost: null,
      variantId,
    },
  ],
  payment: {
    amount: "161.82",
    anticipationFee: {
      amount: null,
      fixedAmount: null,
      mode: "unknown",
      percentage: null,
    },
    anticipationRequested: true,
    expectedSettlementDays: null,
    installmentPlan: "issuer",
    installments: 3,
    method: "credit_card",
    paymentProfileId: profileId,
    paymentProfileName: "Maquininha",
    paymentProfileRuleId: null,
    paymentProfileVersion: 2,
    processingFee: {
      amount: null,
      fixedAmount: null,
      mode: "unknown",
      percentage: null,
    },
  },
  replayed: false,
  sale: {
    commandId,
    confirmedAt: new Date("2026-10-13T18:30:01.000Z"),
    currency: "BRL",
    id: saleId,
    occurredAt: new Date("2026-10-13T18:30:00.000Z"),
    occurredOn: "2026-10-13",
    recordedAt: new Date("2026-10-13T18:29:58.000Z"),
  },
  totals: {
    discountTotal: "17.98",
    freightTotal: "0.00",
    paymentSurchargeTotal: "0.00",
    subtotal: "179.80",
    surchargeTotal: "0.00",
    totalDue: "161.82",
  },
};

type ConfirmSale = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["confirmSale"]
>;

function createRpcClient(
  router = createRpcRouter(),
  bindings: WorkerBindings = testBindings
) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, bindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    sale: { confirm: (input: unknown) => Promise<ConfirmedSaleReadModel> };
  };
}

function tenantStub(
  onCall?: (input: { capability: string; org: string }) => void
) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.({
      capability: input.capability,
      org: input.requestedOrganizationId,
    });
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

function rejectingTenantStub(error: unknown) {
  return <T>(_input: TenantRequestContextInput<T>): Promise<T> =>
    Promise.reject(error);
}

describe("sale.confirm RPC", () => {
  it("confirms through the tenant context with the sale:create capability", async () => {
    const observed: Array<{ capability: string; org: string }> = [];
    const confirmSale = vi.fn<ConfirmSale>(async () => confirmedResult);
    const client = createRpcClient(
      createRpcRouter({
        confirmSale,
        withTenantRequestContext: tenantStub((call) => observed.push(call)),
      })
    );

    const result = await client.sale.confirm(validInput);

    expect(observed).toEqual([
      { capability: "sale:create", org: organizationId },
    ]);
    expect(result).toMatchObject({
      payment: {
        amount: "161.82",
        anticipationFee: { amount: null, mode: "unknown" },
        paymentProfileId: profileId,
        paymentProfileRuleId: null,
        processingFee: { amount: null, mode: "unknown" },
      },
      replayed: false,
      sale: {
        commandId,
        confirmedAt: "2026-10-13T18:30:01.000Z",
        currency: "BRL",
        id: saleId,
        occurredAt: "2026-10-13T18:30:00.000Z",
        occurredOn: "2026-10-13",
        recordedAt: "2026-10-13T18:29:58.000Z",
      },
      totals: { totalDue: "161.82" },
    });
    expect(confirmSale).toHaveBeenCalledTimes(1);
    const [, passedIdentity, passedInput] = confirmSale.mock.calls[0] as [
      TenantRequestTransaction,
      TenantRequestIdentity,
      ConfirmSaleRepositoryInput,
    ];
    expect(passedIdentity).toBe(identity);
    expect(passedInput).toMatchObject({
      commandId,
      commandVersion: 1,
      paymentProfile: { expectedVersion: 2, id: profileId },
    });
    // The organization comes from the server identity; the payload field is
    // only the requested context and is never forwarded as a sale fact.
    expect(Object.keys(passedInput)).not.toContain("organizationId");
  });

  it("forwards an explicit null profile choice", async () => {
    const confirmSale = vi.fn<ConfirmSale>(async () => ({
      ...confirmedResult,
      replayed: true,
    }));
    const client = createRpcClient(
      createRpcRouter({ confirmSale, withTenantRequestContext: tenantStub() })
    );

    await expect(
      client.sale.confirm({
        ...validInput,
        payment: {
          anticipationRequested: false,
          installmentPlan: null,
          installments: null,
          method: "pix",
        },
        paymentProfile: null,
      })
    ).resolves.toMatchObject({ replayed: true });
    expect(confirmSale.mock.calls[0]?.[2]).toMatchObject({
      payment: { method: "pix" },
      paymentProfile: null,
    });
  });

  it("rejects a missing profile choice before reaching the repository", async () => {
    const confirmSale = vi.fn<ConfirmSale>();
    const client = createRpcClient(
      createRpcRouter({ confirmSale, withTenantRequestContext: tenantStub() })
    );
    const { paymentProfile: _omitted, ...withoutProfile } = validInput;

    await expect(client.sale.confirm(withoutProfile)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client.sale.confirm({ ...validInput, items: [] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.sale.confirm({ ...validInput, commandVersion: 2 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.sale.confirm({ ...validInput, occurredAt: "2026-10-13" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(confirmSale).not.toHaveBeenCalled();
  });

  it.each([
    ["domain validation", new InvalidConfirmSaleCommandError(), "BAD_REQUEST"],
    ["payment validation", new InvalidSalePaymentError(), "BAD_REQUEST"],
    [
      "discount above subtotal",
      new SaleDiscountExceedsSubtotalError(),
      "BAD_REQUEST",
    ],
    ["insufficient stock", new InsufficientStockError(), "CONFLICT"],
    ["command conflict", new SaleCommandConflictError(), "CONFLICT"],
    ["archived product", new SaleProductUnavailableError(), "CONFLICT"],
    ["profile version", new PaymentProfileVersionConflictError(), "CONFLICT"],
    ["archived profile", new PaymentProfileLifecycleError(), "CONFLICT"],
    ["unknown profile", new PaymentProfileNotFoundError(), "NOT_FOUND"],
    ["unknown variant", new InventoryVariantNotFoundError(), "NOT_FOUND"],
    [
      "capability",
      new TenantAuthorizationError("capability_denied"),
      "FORBIDDEN",
    ],
    [
      "membership",
      new TenantAuthorizationError("tenant_access_denied"),
      "FORBIDDEN",
    ],
    [
      "session",
      new TenantRequestContextError("session_required"),
      "UNAUTHORIZED",
    ],
  ])("maps %s to %s", async (_label, error, code) => {
    const client = createRpcClient(
      createRpcRouter({
        confirmSale: vi.fn<ConfirmSale>(),
        withTenantRequestContext: rejectingTenantStub(error),
      })
    );
    const rejection = client.sale.confirm(validInput);
    await expect(rejection).rejects.toMatchObject({ code });
    const actionable = ["BAD_REQUEST", "CONFLICT", "NOT_FOUND"].includes(code);
    const domainCode = (error as { code?: string }).code;
    if (actionable) {
      // Clients explain 400/404/409 with the stable domain code, not a message.
      await expect(rejection).rejects.toMatchObject({
        data: { reason: domainCode },
      });
    } else {
      // Authorization failures expose no reason.
      await expect(rejection).rejects.toMatchObject({ data: undefined });
    }
  });

  it.each([
    ["no session", null],
    ["a session without an id", { session: {}, user: { id: "u" } }],
    [
      "a session past its 30-day lifetime",
      {
        session: {
          createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          id: "s",
        },
        user: { id: "u" },
      },
    ],
  ])(
    "a 401 never records the sale (%s): the repository is not reached and no transaction opens",
    async (_label, session) => {
      const confirmSale = vi.fn<ConfirmSale>(async () => confirmedResult);
      const runTransaction = vi.fn();
      const getSession = vi.fn(async () => session);
      const database = { db: {}, pool: { end: vi.fn() } };
      const client = createRpcClient(
        createRpcRouter({
          confirmSale,
          // the real tenant context, with a session lookup that refuses: what a dead session does
          withTenantRequestContext: createTenantRequestContext({
            createAuth: (() => ({
              api: { getSession },
            })) as never,
            createDatabase: (() => database) as never,
            withAuthorizedTenantTransaction: runTransaction as never,
          }),
        }),
        {
          ...testBindings,
          AUTH_HYPERDRIVE: {
            connectionString: "postgresql://auth.invalid/neondb",
          },
        }
      );
      await expect(client.sale.confirm(validInput)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(getSession).toHaveBeenCalledOnce();
      expect(runTransaction).not.toHaveBeenCalled();
      expect(confirmSale).not.toHaveBeenCalled();
    }
  );

  it("explains a commercial time in the future with a stable reason", async () => {
    const client = createRpcClient(
      createRpcRouter({
        confirmSale: vi.fn<ConfirmSale>(),
        withTenantRequestContext: rejectingTenantStub(
          new SaleOccurredInFutureError()
        ),
      })
    );
    await expect(client.sale.confirm(validInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "sale_occurred_in_future" },
    });
  });

  it("explains a sale older than the retroactive window with a stable reason", async () => {
    const client = createRpcClient(
      createRpcRouter({
        confirmSale: vi.fn<ConfirmSale>(),
        withTenantRequestContext: rejectingTenantStub(
          new SaleOccurredTooOldError()
        ),
      })
    );
    await expect(client.sale.confirm(validInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "sale_occurred_too_old" },
    });
  });

  it("forwards the device evidence time and never trusts it as the sale time", async () => {
    const confirmSale = vi.fn<ConfirmSale>(async () => confirmedResult);
    const client = createRpcClient(
      createRpcRouter({ confirmSale, withTenantRequestContext: tenantStub() })
    );
    await client.sale.confirm({
      ...validInput,
      recordedAt: "2026-10-13T18:29:58.000Z",
    });
    const passed = confirmSale.mock.calls[0]?.[2] as ConfirmSaleRepositoryInput;
    expect(passed.recordedAt).toBe("2026-10-13T18:29:58.000Z");
    expect(passed.occurredAt).toBe(validInput.occurredAt);
    await expect(
      client.sale.confirm({ ...validInput, recordedAt: "ontem" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("does not leak a requested organization into the repository identity", async () => {
    const confirmSale = vi.fn<ConfirmSale>(async () => confirmedResult);
    const client = createRpcClient(
      createRpcRouter({ confirmSale, withTenantRequestContext: tenantStub() })
    );
    await client.sale.confirm({
      ...validInput,
      organizationId: otherOrganizationId,
    });
    // The stub resolves identity server-side; the repository only ever sees it.
    expect(confirmSale.mock.calls[0]?.[1]?.organizationId).toBe(organizationId);
  });

  it("does not map unexpected failures to client errors", async () => {
    const client = createRpcClient(
      createRpcRouter({
        confirmSale: vi.fn<ConfirmSale>(),
        withTenantRequestContext: rejectingTenantStub(new Error("boom")),
      })
    );
    await expect(client.sale.confirm(validInput)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("references the rule id only when an exact rule was snapshotted", async () => {
    const client = createRpcClient(
      createRpcRouter({
        confirmSale: vi.fn<ConfirmSale>(async () => ({
          ...confirmedResult,
          payment: {
            ...confirmedResult.payment,
            anticipationFee: {
              amount: "0.75",
              fixedAmount: "0.25",
              mode: "fixed_and_percentage",
              percentage: "0.500000",
            },
            expectedSettlementDays: 45,
            paymentProfileRuleId: ruleId,
            processingFee: {
              amount: "0.00",
              fixedAmount: null,
              mode: "none",
              percentage: null,
            },
          },
        })),
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(client.sale.confirm(validInput)).resolves.toMatchObject({
      payment: {
        anticipationFee: { amount: "0.75" },
        expectedSettlementDays: 45,
        paymentProfileRuleId: ruleId,
        processingFee: { amount: "0.00", mode: "none" },
      },
    });
  });
});
