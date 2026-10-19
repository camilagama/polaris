import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { PaymentProfileReadModel } from "@polaris/contracts";
import type {
  CreatePaymentProfileInput,
  UpdatePaymentProfileInput,
} from "@polaris/db/payment-profile-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const profileId = "0199c2d0-0000-7000-8000-000000000051";
const ruleId = "0199c2d0-0000-7000-8000-000000000052";
const requestIdPattern = /^[0-9a-f-]{36}$/i;
type TenantRequestRunner = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["withTenantRequestContext"]
>;

const identity: TenantRequestIdentity = {
  capability: "organization:manage",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const profileRow = {
  archivedAt: null,
  createdAt: new Date("2026-10-11T12:00:00.000Z"),
  id: profileId,
  name: "Stone",
  organizationId,
  rules: [
    {
      anticipationFeeFixedAmount: null,
      anticipationFeeMode: "unknown",
      anticipationFeePercentage: null,
      archivedAt: null,
      createdAt: new Date("2026-10-11T12:00:00.000Z"),
      expectedSettlementDays: 14,
      id: ruleId,
      installmentPlan: "issuer",
      installments: 3,
      method: "credit_card",
      organizationId,
      paymentProfileId: profileId,
      processingFeeFixedAmount: "0.50",
      processingFeeMode: "fixed_and_percentage",
      processingFeePercentage: "2.500000",
      updatedAt: new Date("2026-10-11T12:00:00.000Z"),
    },
  ],
  updatedAt: new Date("2026-10-11T12:00:00.000Z"),
  version: 2,
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    paymentProfile: {
      archive: (input: unknown) => Promise<{
        changed: boolean;
        profile: PaymentProfileReadModel;
      }>;
      create: (input: unknown) => Promise<PaymentProfileReadModel>;
      list: (input: unknown) => Promise<{
        profiles: PaymentProfileReadModel[];
      }>;
      restore: (input: unknown) => Promise<{
        changed: boolean;
        profile: PaymentProfileReadModel;
      }>;
      update: (input: unknown) => Promise<{
        changed: boolean;
        profile: PaymentProfileReadModel;
      }>;
    };
  };
}

function createTenantRequestStub(onCall?: (capability: string) => void) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.(input.capability);
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

describe("payment profile RPCs", () => {
  it("lists profiles with organization management capability", async () => {
    let observedCapability = "";
    const listPaymentProfiles = vi.fn(async () => [profileRow]);
    const client = createRpcClient(
      createRpcRouter({
        listPaymentProfiles,
        withTenantRequestContext: createTenantRequestStub((capability) => {
          observedCapability = capability;
        }),
      })
    );

    await expect(
      client.paymentProfile.list({ organizationId, status: "all" })
    ).resolves.toMatchObject({
      profiles: [
        {
          id: profileId,
          name: "Stone",
          organizationId,
          rules: [
            {
              anticipationFee: { mode: "unknown" },
              installmentPlan: "issuer",
              installments: 3,
              method: "credit_card",
              processingFee: {
                fixedAmount: "0.50",
                mode: "fixed_and_percentage",
              },
            },
          ],
          status: "active",
          version: 2,
        },
      ],
    });
    expect(observedCapability).toBe("organization:manage");
    expect(listPaymentProfiles).toHaveBeenCalledWith({}, identity, {
      status: "all",
    });
  });

  it("creates a profile using only the server-authorized organization", async () => {
    const createPaymentProfile = vi.fn(
      async (
        _transaction: TenantRequestTransaction,
        authorizedIdentity: TenantRequestIdentity,
        input: CreatePaymentProfileInput
      ) => ({
        ...profileRow,
        name: input.name,
        organizationId: authorizedIdentity.organizationId,
      })
    );
    const client = createRpcClient(
      createRpcRouter({
        createPaymentProfile,
        withTenantRequestContext: createTenantRequestStub(),
      })
    );

    await expect(
      client.paymentProfile.create({
        name: " Stone ",
        organizationId: "requested-org",
        rules: [
          {
            anticipationFee: {
              fixedAmount: null,
              mode: "unknown",
              percentage: null,
            },
            expectedSettlementDays: 14,
            installmentPlan: "issuer",
            installments: 3,
            method: "credit_card",
            processingFee: {
              fixedAmount: "0.50",
              mode: "fixed_and_percentage",
              percentage: "2.5",
            },
          },
        ],
      })
    ).resolves.toMatchObject({
      id: profileId,
      name: "Stone",
      organizationId,
      status: "active",
    });
    expect(createPaymentProfile).toHaveBeenCalledWith({}, identity, {
      name: "Stone",
      requestId: expect.stringMatching(requestIdPattern),
      rules: [
        expect.objectContaining({ installments: 3, method: "credit_card" }),
      ],
    });
  });

  it("passes optimistic version and maps archived profile status on update", async () => {
    const updatePaymentProfile = vi.fn(
      async (
        _transaction: TenantRequestTransaction,
        _authorizedIdentity: TenantRequestIdentity,
        input: UpdatePaymentProfileInput
      ) => ({
        changed: true,
        profile: { ...profileRow, name: input.name, version: 3 },
      })
    );
    const client = createRpcClient(
      createRpcRouter({
        updatePaymentProfile,
        withTenantRequestContext: createTenantRequestStub(),
      })
    );

    await expect(
      client.paymentProfile.update({
        expectedVersion: 2,
        id: profileId,
        name: "Stone loja 2",
        organizationId,
        rules: [
          {
            anticipationFee: {
              fixedAmount: null,
              mode: "unknown",
              percentage: null,
            },
            expectedSettlementDays: 14,
            installmentPlan: "issuer",
            installments: 3,
            method: "credit_card",
            processingFee: {
              fixedAmount: "0.50",
              mode: "fixed_and_percentage",
              percentage: "2.5",
            },
          },
        ],
      })
    ).resolves.toMatchObject({
      changed: true,
      profile: { name: "Stone loja 2", status: "active", version: 3 },
    });
    expect(updatePaymentProfile).toHaveBeenCalledWith({}, identity, {
      expectedVersion: 2,
      id: profileId,
      name: "Stone loja 2",
      requestId: expect.stringMatching(requestIdPattern),
      rules: [expect.objectContaining({ method: "credit_card" })],
    });
  });

  it("rejects a profile with duplicate method and installment rules", async () => {
    const withTenantRequestContext = vi.fn(createTenantRequestStub());
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as TenantRequestRunner,
      })
    );
    const rule = {
      anticipationFee: {
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      },
      expectedSettlementDays: null,
      installmentPlan: "merchant",
      installments: 2,
      method: "credit_card",
      processingFee: {
        fixedAmount: null,
        mode: "none",
        percentage: null,
      },
    };

    await expect(
      client.paymentProfile.create({
        name: "Perfil",
        organizationId,
        rules: [rule, rule],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects profile reads without a Better Auth session", async () => {
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext: () =>
          Promise.reject(new TenantRequestContextError("session_required")),
      })
    );

    await expect(
      client.paymentProfile.list({ organizationId, status: "active" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
