import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { OperationalSelectionReadModel } from "@polaris/contracts";
import { InvalidOperationalSelectionError } from "@polaris/db/operational-selection-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { OperationalSelectionError } from "@polaris/domain/billing/operational-selection";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const variantA = "0199c2d0-0000-7000-8000-0000000000a1";
const variantB = "0199c2d0-0000-7000-8000-0000000000a2";
const identity: TenantRequestIdentity = {
  capability: "product:update",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};
const windowEndsAt = new Date("2026-10-21T12:00:00.000Z");

const selection = {
  limit: 50,
  liveVariants: 55,
  phase: "adapting" as const,
  selectedVariantIds: [variantA],
  windowEndsAt,
};

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

interface PlanClient {
  plan: {
    operationalSelection: (
      input: unknown
    ) => Promise<OperationalSelectionReadModel>;
    selectOperationalVariants: (
      input: unknown
    ) => Promise<OperationalSelectionReadModel>;
  };
}

function client(router: ReturnType<typeof createRpcRouter>) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as PlanClient;
}

function tenantStub(onCall?: (capability: string) => void) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.(input.capability);
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

describe("plan RPCs (Free Over Limit)", () => {
  it("reads where the organization stands and what it chose, needing the capability to manage products", async () => {
    const capabilities: string[] = [];
    const readOperationalSelection = vi.fn(async () => selection);

    const result = await client(
      createRpcRouter({
        planRepository: { readOperationalSelection },
        withTenantRequestContext: tenantStub((capability) =>
          capabilities.push(capability)
        ),
      })
    ).plan.operationalSelection({ organizationId });

    expect(capabilities).toEqual(["product:update"]);
    expect(readOperationalSelection).toHaveBeenCalledWith({}, identity);
    expect(result).toEqual({
      limit: 50,
      liveVariants: 55,
      phase: "adapting",
      selectedVariantIds: [variantA],
      windowEndsAt: windowEndsAt.toISOString(),
    });
  });

  it("says there is no window when nothing is restricted", async () => {
    const result = await client(
      createRpcRouter({
        planRepository: {
          readOperationalSelection: () =>
            Promise.resolve({
              ...selection,
              liveVariants: 10,
              phase: "unrestricted" as const,
              selectedVariantIds: [],
              windowEndsAt: null,
            }),
        },
        withTenantRequestContext: tenantStub(),
      })
    ).plan.operationalSelection({ organizationId });

    expect(result.windowEndsAt).toBeNull();
    expect(result.phase).toBe("unrestricted");
  });

  it("chooses with the identity from the session and an audit request ID, never the one the request names", async () => {
    const selectOperationalVariants = vi.fn(async () => ({
      ...selection,
      selectedVariantIds: [variantA, variantB],
    }));

    const result = await client(
      createRpcRouter({
        planRepository: { selectOperationalVariants },
        withTenantRequestContext: tenantStub(),
      })
    ).plan.selectOperationalVariants({
      organizationId: "requested-org",
      variantIds: [variantA, variantB],
    });

    expect(selectOperationalVariants).toHaveBeenCalledWith({}, identity, {
      requestId: expect.stringMatching(requestIdPattern),
      variantIds: [variantA, variantB],
    });
    expect(result.selectedVariantIds).toEqual([variantA, variantB]);
  });

  it("refuses a malformed request before touching anything", async () => {
    const withTenantRequestContext = vi.fn();
    const strict = client(
      createRpcRouter({
        planRepository: {},
        withTenantRequestContext:
          withTenantRequestContext as unknown as ReturnType<typeof tenantStub>,
      })
    );

    for (const variantIds of [
      ["not-a-uuid"],
      Array.from({ length: 5001 }, () => variantA),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(
        strict.plan.selectOperationalVariants({ organizationId, variantIds })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing to choose", new OperationalSelectionError("nothing_to_select")],
    [
      "a choice too large",
      new OperationalSelectionError("selection_too_large"),
    ],
    ["a frozen choice", new OperationalSelectionError("selection_frozen")],
    [
      "a variant that is not live",
      new OperationalSelectionError("variant_unavailable"),
    ],
  ])("maps %s to a conflict that carries its reason", async (_label, error) => {
    await expect(
      client(
        createRpcRouter({
          planRepository: {
            selectOperationalVariants: () => Promise.reject(error),
          },
          withTenantRequestContext: tenantStub(),
        })
      ).plan.selectOperationalVariants({
        organizationId,
        variantIds: [variantA],
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: (error as OperationalSelectionError).code },
    });
  });

  it("maps a malformed list the repository rejects to a bad request", async () => {
    await expect(
      client(
        createRpcRouter({
          planRepository: {
            selectOperationalVariants: () =>
              Promise.reject(new InvalidOperationalSelectionError()),
          },
          withTenantRequestContext: tenantStub(),
        })
      ).plan.selectOperationalVariants({
        organizationId,
        variantIds: [variantA],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
