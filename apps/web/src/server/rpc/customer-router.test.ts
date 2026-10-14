import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { CustomerReadModel } from "@polaris/contracts";
import type { CreateCustomerInput } from "@polaris/db/customer-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "@polaris/db/tenant-transaction";
import {
  CustomerNotFoundError,
  CustomerVersionConflictError,
} from "@polaris/domain/customers/customer";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
type TenantRequestRunner = NonNullable<
  NonNullable<Parameters<typeof createRpcRouter>[0]>["withTenantRequestContext"]
>;
const identity: TenantRequestIdentity = {
  capability: "customer:update",
  organizationId,
  role: "owner",
  userId: "verified-session-user",
};

const customerRow = {
  archivedAt: null,
  createdAt: new Date("2026-10-10T12:00:00.000Z"),
  email: "ana@example.com",
  id: "0199c2d0-0000-7000-8000-000000000010",
  name: "Ana Silva",
  notes: null,
  organizationId,
  phone: "+5511999990000",
  updatedAt: new Date("2026-10-10T12:00:00.000Z"),
  version: 1,
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

function createRpcClient(router = createRpcRouter()) {
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });

  return createORPCClient(link) as unknown as {
    customer: {
      archive: (input: unknown) => Promise<{
        changed: boolean;
        customer: CustomerReadModel;
      }>;
      create: (input: unknown) => Promise<CustomerReadModel>;
      findPossibleDuplicates: (input: unknown) => Promise<{
        matches: Array<{
          customer: CustomerReadModel;
          matchedBy: Array<"email" | "phone">;
        }>;
      }>;
      list: (input: unknown) => Promise<{ customers: CustomerReadModel[] }>;
      restore: (input: unknown) => Promise<{
        changed: boolean;
        customer: CustomerReadModel;
      }>;
      update: (input: unknown) => Promise<{
        changed: boolean;
        customer: CustomerReadModel;
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

describe("customer RPCs", () => {
  it("creates a customer with the server-authorized organization and capability", async () => {
    let observedCapability = "";
    const createCustomer = vi.fn(
      async (
        _transaction: TenantRequestTransaction,
        authorizedIdentity: TenantRequestIdentity,
        input: CreateCustomerInput
      ) => ({
        ...customerRow,
        email: input.email ?? null,
        name: input.name,
        notes: input.notes ?? null,
        organizationId: authorizedIdentity.organizationId,
        phone: input.phone ?? null,
      })
    );
    const router = createRpcRouter({
      createCustomer,
      withTenantRequestContext: createTenantRequestStub((capability) => {
        observedCapability = capability;
      }),
    });
    const client = createRpcClient(router);

    await expect(
      client.customer.create({
        email: "ana@example.com",
        name: " Ana Silva ",
        notes: null,
        organizationId: "requested-org",
        phone: "+5511999990000",
      })
    ).resolves.toMatchObject({
      id: customerRow.id,
      name: "Ana Silva",
      organizationId,
      status: "active",
    });
    expect(observedCapability).toBe("customer:update");
    expect(createCustomer).toHaveBeenCalledWith({}, identity, {
      email: "ana@example.com",
      name: "Ana Silva",
      notes: null,
      phone: "+5511999990000",
      requestId: expect.stringMatching(requestIdPattern),
    });
  });

  it("rejects a customer without phone or email before opening tenant context", async () => {
    const withTenantRequestContext = vi.fn(createTenantRequestStub());
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as TenantRequestRunner,
      })
    );

    await expect(
      client.customer.create({
        email: "",
        name: "Ana Silva",
        notes: null,
        organizationId,
        phone: "  ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("lists active or archived rows only through customer:update", async () => {
    let observedCapability = "";
    const listCustomers = vi.fn(async () => [customerRow]);
    const router = createRpcRouter({
      listCustomers,
      withTenantRequestContext: createTenantRequestStub((capability) => {
        observedCapability = capability;
      }),
    });
    const client = createRpcClient(router);

    await expect(
      client.customer.list({ organizationId, status: "active" })
    ).resolves.toMatchObject({ customers: [{ id: customerRow.id }] });
    expect(observedCapability).toBe("customer:update");
    expect(listCustomers).toHaveBeenCalledWith({}, identity, {
      status: "active",
    });
  });

  it("searches possible duplicates inside the authorized organization", async () => {
    let observedCapability = "";
    const findPossibleCustomerDuplicates = vi.fn(async () => [
      {
        customer: {
          ...customerRow,
          archivedAt: new Date("2026-10-10T12:00:00.000Z"),
          email: "Ana@Example.com",
        },
        matchedBy: ["email"] as Array<"email" | "phone">,
      },
    ]);
    const router = createRpcRouter({
      findPossibleCustomerDuplicates,
      withTenantRequestContext: createTenantRequestStub((capability) => {
        observedCapability = capability;
      }),
    });
    const client = createRpcClient(router);

    await expect(
      client.customer.findPossibleDuplicates({
        email: " Ana@Example.com ",
        organizationId: "requested-org",
        phone: " +55 (11) 99999-0000 ",
      })
    ).resolves.toMatchObject({
      matches: [
        {
          customer: {
            email: "Ana@Example.com",
            organizationId,
            status: "archived",
          },
          matchedBy: ["email"],
        },
      ],
    });
    expect(observedCapability).toBe("customer:update");
    expect(findPossibleCustomerDuplicates).toHaveBeenCalledWith({}, identity, {
      email: "Ana@Example.com",
      phone: "+55 (11) 99999-0000",
    });
  });

  it("rejects duplicate searches without contacts before opening tenant context", async () => {
    const withTenantRequestContext = vi.fn(createTenantRequestStub());
    const client = createRpcClient(
      createRpcRouter({
        withTenantRequestContext:
          withTenantRequestContext as unknown as TenantRequestRunner,
      })
    );

    await expect(
      client.customer.findPossibleDuplicates({
        email: "  ",
        organizationId,
        phone: " ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(withTenantRequestContext).not.toHaveBeenCalled();
  });

  it("maps stale versions and missing customers to safe RPC errors", async () => {
    const staleClient = createRpcClient(
      createRpcRouter({
        updateCustomer: () =>
          Promise.reject(new CustomerVersionConflictError()),
        withTenantRequestContext: createTenantRequestStub(),
      })
    );
    await expect(
      staleClient.customer.update({
        email: "ana@example.com",
        expectedVersion: 1,
        id: customerRow.id,
        name: "Ana Silva",
        notes: null,
        organizationId,
        phone: "+5511999990000",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const missingClient = createRpcClient(
      createRpcRouter({
        archiveCustomer: () => Promise.reject(new CustomerNotFoundError()),
        withTenantRequestContext: createTenantRequestStub(),
      })
    );
    await expect(
      missingClient.customer.archive({
        expectedVersion: 1,
        id: customerRow.id,
        organizationId,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
