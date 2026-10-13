import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { SaleCustomerLinkReadModel } from "@polaris/contracts";
import type {
  ChangeSaleCustomerLinkInput,
  SaleCustomerLinkReadModel as SaleCustomerLinkRecord,
} from "@polaris/db/sale-customer-link-repository";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import { CustomerNotFoundError } from "@polaris/domain/customers/customer";
import {
  InvalidSaleCustomerLinkError,
  SaleCustomerArchivedError,
  SaleCustomerLinkStateError,
  SaleCustomerLinkVersionConflictError,
  SaleNotFoundError,
} from "@polaris/domain/sales/sale-customer-link";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const saleId = "0199c2d0-0000-7000-8000-000000000004";
const customerId = "0199c2d0-0000-7000-8000-000000000011";
const otherCustomerId = "0199c2d0-0000-7000-8000-000000000012";

const identity: TenantRequestIdentity = {
  capability: "sale:assign_customer",
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

const assignedRecord: SaleCustomerLinkRecord = {
  current: { customerId, version: 1 },
  history: [
    {
      action: "assign",
      createdAt: new Date("2026-10-13T18:30:00.000Z"),
      customerId,
      version: 1,
    },
  ],
  saleId,
};

type ChangeLink = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["changeSaleCustomerLink"]
>;
type GetLink = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["getSaleCustomerLink"]
>;

interface LinkChange {
  changed: boolean;
  link: SaleCustomerLinkReadModel;
}

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    sale: {
      assignCustomer: (input: unknown) => Promise<LinkChange>;
      getCustomerLink: (input: unknown) => Promise<SaleCustomerLinkReadModel>;
      reassignCustomer: (input: unknown) => Promise<LinkChange>;
      unassignCustomer: (input: unknown) => Promise<LinkChange>;
    };
  };
}

function tenantStub(onCall?: (capability: string, org: string) => void) {
  return async <T>(input: TenantRequestContextInput<T>): Promise<T> => {
    onCall?.(input.capability, input.requestedOrganizationId);
    return await input.operation({} as TenantRequestTransaction, identity);
  };
}

function rejectingTenantStub(error: unknown) {
  return <T>(_input: TenantRequestContextInput<T>): Promise<T> =>
    Promise.reject(error);
}

describe("sale customer link RPCs", () => {
  it("assigns through the tenant context with the dedicated capability", async () => {
    const observed: [string, string][] = [];
    const changeSaleCustomerLink = vi.fn<ChangeLink>(async () => ({
      changed: true,
      link: assignedRecord,
    }));
    const client = createRpcClient(
      createRpcRouter({
        changeSaleCustomerLink,
        withTenantRequestContext: tenantStub((capability, org) =>
          observed.push([capability, org])
        ),
      })
    );

    await expect(
      client.sale.assignCustomer({
        customerId,
        expectedVersion: 0,
        organizationId,
        saleId,
      })
    ).resolves.toEqual({
      changed: true,
      link: {
        current: { customerId, version: 1 },
        history: [
          {
            action: "assign",
            createdAt: "2026-10-13T18:30:00.000Z",
            customerId,
            version: 1,
          },
        ],
        saleId,
      },
    });
    expect(observed).toEqual([["sale:assign_customer", organizationId]]);
    const [, passedIdentity, passedInput] = changeSaleCustomerLink.mock
      .calls[0] as [
      TenantRequestTransaction,
      TenantRequestIdentity,
      ChangeSaleCustomerLinkInput,
    ];
    expect(passedIdentity).toBe(identity);
    expect(passedInput).toMatchObject({
      action: "assign",
      customerId,
      expectedVersion: 0,
      saleId,
    });
    expect(Object.keys(passedInput)).not.toContain("organizationId");
  });

  it("maps reassign and unassign to their actions", async () => {
    const changeSaleCustomerLink = vi.fn<ChangeLink>(async () => ({
      changed: false,
      link: assignedRecord,
    }));
    const client = createRpcClient(
      createRpcRouter({
        changeSaleCustomerLink,
        withTenantRequestContext: tenantStub(),
      })
    );

    await client.sale.reassignCustomer({
      customerId: otherCustomerId,
      expectedVersion: 1,
      organizationId,
      saleId,
    });
    await client.sale.unassignCustomer({
      expectedVersion: 1,
      organizationId,
      saleId,
    });

    expect(changeSaleCustomerLink.mock.calls[0]?.[2]).toMatchObject({
      action: "reassign",
      customerId: otherCustomerId,
    });
    expect(changeSaleCustomerLink.mock.calls[1]?.[2]).toMatchObject({
      action: "unassign",
      customerId: null,
      expectedVersion: 1,
    });
  });

  it("reads the current attribution and its history", async () => {
    const getSaleCustomerLink = vi.fn<GetLink>(async () => assignedRecord);
    const client = createRpcClient(
      createRpcRouter({
        getSaleCustomerLink,
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      client.sale.getCustomerLink({ organizationId, saleId })
    ).resolves.toMatchObject({
      current: { customerId, version: 1 },
      saleId,
    });
    expect(getSaleCustomerLink.mock.calls[0]?.[2]).toBe(saleId);
  });

  it("rejects malformed input before reaching the repository", async () => {
    const changeSaleCustomerLink = vi.fn<ChangeLink>();
    const client = createRpcClient(
      createRpcRouter({
        changeSaleCustomerLink,
        withTenantRequestContext: tenantStub(),
      })
    );
    await expect(
      client.sale.assignCustomer({
        customerId: "not-a-uuid",
        expectedVersion: 0,
        organizationId,
        saleId,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.sale.assignCustomer({ expectedVersion: 0, organizationId, saleId })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.sale.unassignCustomer({
        expectedVersion: -1,
        organizationId,
        saleId,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(changeSaleCustomerLink).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid command", new InvalidSaleCustomerLinkError(), "BAD_REQUEST"],
    ["stale version", new SaleCustomerLinkVersionConflictError(), "CONFLICT"],
    ["wrong state", new SaleCustomerLinkStateError(), "CONFLICT"],
    ["archived customer", new SaleCustomerArchivedError(), "CONFLICT"],
    ["unknown sale", new SaleNotFoundError(), "NOT_FOUND"],
    ["unknown customer", new CustomerNotFoundError(), "NOT_FOUND"],
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
          changeSaleCustomerLink: vi.fn<ChangeLink>(),
          withTenantRequestContext: rejectingTenantStub(error),
        })
      );
      const rejection = client.sale.assignCustomer({
        customerId,
        expectedVersion: 0,
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
