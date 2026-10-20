import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { createServerApp } from "../app";
import { createAuthenticatedRequestContext } from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import type {
  readAcceptedLegalVersions,
  recordLegalAcceptance,
} from "../legal-acceptance";
import type { SyncCommandHandler } from "../sync/push";
import { createTenantRequestContext } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const requestId = "5f0a6c1e-3b9d-4f5e-8a7b-1c2d3e4f5a6b";
const userId = "session-user-legal";
const leaseSecret = "s".repeat(40);
const session = {
  session: { createdAt: new Date(), id: "session-row-legal" },
  user: { emailVerified: true, id: userId },
};
const pendingBoth = [
  { document: "terms", version: 1 },
  { document: "privacy", version: 1 },
];
const bindings = {
  AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  LEGAL_ACCEPTANCE_ENFORCED: "true",
  OFFLINE_LEASE_SECRET: leaseSecret,
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
  SYNC_PAYLOAD_HASH_SECRET: "h".repeat(32),
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;
type Accepted = {
  -readonly [K in keyof Awaited<
    ReturnType<typeof readAcceptedLegalVersions>
  >]: number;
};

interface ErrorView {
  code: string;
  data?: { pending?: unknown; reason?: string };
}

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * The real authenticated and tenant request contexts (session, database pool and the legal
 * acceptance control), with fakes only for the edges: the session lookup, the pools, the reading of
 * the accepted versions and the tenant transaction.
 */
function setup(
  options: {
    accepted?: Accepted;
    readAccepted?: typeof readAcceptedLegalVersions;
    workerBindings?: WorkerBindings;
  } = {}
) {
  const accepted: Accepted = { ...options.accepted };
  const poolQuery = vi.fn();
  const poolEnd = vi.fn(async () => undefined);
  const readAccepted = vi.fn<typeof readAcceptedLegalVersions>(
    options.readAccepted ?? (async () => ({ ...accepted }))
  );
  const recordAcceptance = vi.fn<typeof recordLegalAcceptance>(
    (_connection, entry) => {
      accepted[entry.document] = LEGAL_DOCUMENTS[entry.document].version;
      return Promise.resolve("recorded" as const);
    }
  );
  const tenantTransaction = vi.fn(
    (
      _database: unknown,
      input: { capability: string },
      operation: (transaction: unknown, identity: unknown) => Promise<unknown>
    ) =>
      operation(
        {},
        {
          capability: input.capability,
          organizationId,
          role: "owner",
          userId,
        }
      )
  );
  const dependencies = {
    createAuth: (() => ({
      api: { getSession: vi.fn(async () => session) },
    })) as never,
    createDatabase: (() => ({
      db: {},
      pool: { end: poolEnd, query: poolQuery },
    })) as never,
    readAcceptedLegalVersions: readAccepted,
  };
  const withAuthenticatedRequestContext =
    createAuthenticatedRequestContext(dependencies);
  const withTenantRequestContext = createTenantRequestContext({
    ...dependencies,
    withAuthorizedTenantTransaction: tenantTransaction as never,
  });

  const listSales = vi.fn(async () => ({ hasMore: false, sales: [] }));
  const listDevices = vi.fn(async () => []);
  const getSyncCursor = vi.fn(async () => 7);
  const runSyncCommand = vi.fn();
  const customerHandler: SyncCommandHandler = {
    capability: "customer:update",
    classify: () => null,
    execute: () => Promise.resolve({ created: true }),
    parse: (payload) => payload as never,
    type: "customer.create",
  };
  const router = createRpcRouter({
    getSyncCursor,
    listDevices,
    listSales,
    readAcceptedLegalVersions: readAccepted,
    recordLegalAcceptance: recordAcceptance,
    runSyncCommand,
    syncCommandHandlers: [customerHandler],
    withAuthenticatedRequestContext,
    withTenantRequestContext,
  } as unknown as Overrides);
  const app = createServerApp({ rpcRouter: router });
  const link = new RPCLink({
    fetch: (request) =>
      Promise.resolve(app.fetch(request, options.workerBindings ?? bindings)),
    headers: {
      origin: "https://polaris.example.invalid",
      "x-request-id": requestId,
    },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  const client = createORPCClient(link) as unknown as {
    account: {
      acceptLegal: (input: unknown) => Promise<{ pending: unknown[] }>;
      legalStatus: () => Promise<{ pending: unknown[] }>;
    };
    device: { list: () => Promise<{ devices: unknown[] }> };
    sale: { list: (input: unknown) => Promise<unknown> };
    sync: {
      getCursor: (input: unknown) => Promise<{ cursor: string }>;
      push: (input: unknown) => Promise<unknown>;
    };
  };

  const raw = (path: string, json: unknown) =>
    app.fetch(
      new Request(`https://polaris.example.invalid${path}`, {
        body: JSON.stringify({ json }),
        headers: {
          "content-type": "application/json",
          origin: "https://polaris.example.invalid",
        },
        method: "POST",
      }),
      options.workerBindings ?? bindings
    );

  return {
    accepted,
    client,
    getSyncCursor,
    listDevices,
    listSales,
    raw,
    readAccepted,
    recordAcceptance,
    runSyncCommand,
    tenantTransaction,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ErrorView> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error as ErrorView
  );
  if (outcome === undefined) {
    throw new Error("expected the call to be refused");
  }
  return outcome;
}

async function lease() {
  const issuedAt = new Date(Date.now() - 3_600_000);
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["customer:update"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(issuedAt.getTime() + 72 * 3_600_000),
      grantId: uuid(900),
      issuedAt,
      organizationId,
      userId,
    }),
    { id: "k1", secret: leaseSecret }
  );
}

async function pushInput() {
  return {
    commands: [
      {
        baseVersion: null,
        commandId: uuid(1),
        createdAt: new Date().toISOString(),
        deviceId,
        lease: await lease(),
        payload: { name: "Cliente 1" },
        type: "customer.create",
      },
    ],
    organizationId,
  };
}

describe("the legal acceptance control through the router", () => {
  describe("without the acceptance of the versions in force", () => {
    it("refuses a tenant read with FORBIDDEN, the reason and what is pending, and never runs the operation", async () => {
      const t = setup();

      const error = await failureOf(t.client.sale.list({ organizationId }));

      expect(error.code).toBe("FORBIDDEN");
      expect(error.data).toEqual({
        pending: pendingBoth,
        reason: "legal_acceptance_required",
      });
      expect(t.readAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
        userId
      );
      expect(t.tenantTransaction).not.toHaveBeenCalled();
      expect(t.listSales).not.toHaveBeenCalled();
    });

    it("refuses sync.push the same way, and runs no command", async () => {
      const t = setup();

      const error = await failureOf(t.client.sync.push(await pushInput()));

      expect(error.code).toBe("FORBIDDEN");
      expect(error.data).toEqual({
        pending: pendingBoth,
        reason: "legal_acceptance_required",
      });
      expect(t.tenantTransaction).not.toHaveBeenCalled();
      expect(t.runSyncCommand).not.toHaveBeenCalled();
    });

    it("refuses the other sync procedures too", async () => {
      const t = setup();

      const error = await failureOf(
        t.client.sync.getCursor({ organizationId })
      );

      expect(error.data?.reason).toBe("legal_acceptance_required");
      expect(t.getSyncCursor).not.toHaveBeenCalled();
    });

    it("asks only for the document still pending", async () => {
      const t = setup({ accepted: { terms: 1 } });

      const error = await failureOf(t.client.sale.list({ organizationId }));

      expect(error.data?.pending).toEqual([
        { document: "privacy", version: 1 },
      ]);
    });

    it("lets account.legalStatus through (exempt) with both documents, their date and what changed", async () => {
      const t = setup();

      await expect(t.client.account.legalStatus()).resolves.toEqual({
        pending: [
          {
            changes: null,
            document: "terms",
            effectiveFrom: null,
            version: 1,
          },
          {
            changes: null,
            document: "privacy",
            effectiveFrom: null,
            version: 1,
          },
        ],
      });
      // read once, by the handler: the control did not read it for an exempt procedure
      expect(t.readAccepted).toHaveBeenCalledTimes(1);
    });

    it("lets device.list through the barrier (exempt)", async () => {
      const t = setup();

      await expect(t.client.device.list()).resolves.toEqual({ devices: [] });

      expect(t.listDevices).toHaveBeenCalledTimes(1);
      expect(t.readAccepted).not.toHaveBeenCalled();
    });
  });

  describe("with the control off", () => {
    it.each([
      ["absent", undefined],
      ["false", "false"],
      ["empty", ""],
      ["TRUE", "TRUE"],
    ])(
      "bars nothing and never reads the acceptance when the flag is %s",
      async (_name, flag) => {
        const { LEGAL_ACCEPTANCE_ENFORCED: _on, ...withoutFlag } = bindings;
        const t = setup({
          workerBindings: (flag === undefined
            ? withoutFlag
            : {
                ...withoutFlag,
                LEGAL_ACCEPTANCE_ENFORCED: flag,
              }) as WorkerBindings,
        });

        await expect(
          t.client.sale.list({ organizationId })
        ).resolves.toBeDefined();

        expect(t.listSales).toHaveBeenCalledTimes(1);
        expect(t.readAccepted).not.toHaveBeenCalled();
      }
    );
  });

  describe("with the control on", () => {
    it("lets a tenant read through when everything in force was accepted", async () => {
      const t = setup({ accepted: { privacy: 1, terms: 1 } });

      await expect(t.client.sale.list({ organizationId })).resolves.toEqual({
        hasMore: false,
        sales: [],
      });

      expect(t.listSales).toHaveBeenCalledTimes(1);
    });

    it("lets sync.push through when everything in force was accepted", async () => {
      const t = setup({ accepted: { privacy: 1, terms: 1 } });
      t.runSyncCommand.mockResolvedValue({
        code: null,
        replayed: false,
        result: { created: true },
        status: "accepted",
      });

      await expect(t.client.sync.push(await pushInput())).resolves.toEqual({
        results: [
          {
            code: null,
            commandId: uuid(1),
            replayed: false,
            result: { created: true },
            status: "accepted",
          },
        ],
      });
    });

    it("fails closed when the acceptance cannot be read: SERVICE_UNAVAILABLE, nothing runs", async () => {
      const t = setup({
        readAccepted: () => Promise.reject(new Error("db down")),
      });

      const error = await failureOf(t.client.sale.list({ organizationId }));

      expect(error.code).toBe("SERVICE_UNAVAILABLE");
      expect(error.data?.reason).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("db down");
      expect(t.tenantTransaction).not.toHaveBeenCalled();
      expect(t.listSales).not.toHaveBeenCalled();
    });
  });

  describe("account.acceptLegal", () => {
    it("refuses a version that is not the one in force with CONFLICT legal_version_mismatch, recording nothing", async () => {
      const t = setup();

      const error = await failureOf(
        t.client.account.acceptLegal({
          documents: [
            { document: "terms", version: LEGAL_DOCUMENTS.terms.version + 1 },
          ],
        })
      );

      expect(error.code).toBe("CONFLICT");
      expect(error.data).toEqual({ reason: "legal_version_mismatch" });
      expect(t.recordAcceptance).not.toHaveBeenCalled();
    });

    it("records nothing when only one of two documents carries the wrong version", async () => {
      const t = setup();

      const error = await failureOf(
        t.client.account.acceptLegal({
          documents: [
            { document: "terms", version: LEGAL_DOCUMENTS.terms.version },
            { document: "privacy", version: 99 },
          ],
        })
      );

      expect(error.data?.reason).toBe("legal_version_mismatch");
      expect(t.recordAcceptance).not.toHaveBeenCalled();
    });

    it("records each document with origin reaceite, the session user and the request id, then answers nothing pending", async () => {
      const t = setup();

      await expect(
        t.client.account.acceptLegal({
          documents: [
            { document: "terms", version: LEGAL_DOCUMENTS.terms.version },
            { document: "privacy", version: LEGAL_DOCUMENTS.privacy.version },
          ],
        })
      ).resolves.toEqual({ pending: [] });

      expect(t.recordAcceptance).toHaveBeenCalledTimes(2);
      for (const [index, document] of (
        ["terms", "privacy"] as const
      ).entries()) {
        expect(t.recordAcceptance).toHaveBeenNthCalledWith(
          index + 1,
          expect.objectContaining({ query: expect.any(Function) }),
          { document, origin: "reaceite", requestId, userId }
        );
      }
    });

    it("answers what is still pending when only one document was accepted", async () => {
      const t = setup();

      const result = await t.client.account.acceptLegal({
        documents: [{ document: "terms", version: 1 }],
      });

      expect(result.pending).toEqual([
        expect.objectContaining({ document: "privacy", version: 1 }),
      ]);
    });

    it("lets the user in afterwards: the same request that was refused now passes", async () => {
      const t = setup();
      await failureOf(t.client.sale.list({ organizationId }));

      await t.client.account.acceptLegal({
        documents: [
          { document: "terms", version: 1 },
          { document: "privacy", version: 1 },
        ],
      });

      await expect(
        t.client.sale.list({ organizationId })
      ).resolves.toBeDefined();
      expect(t.listSales).toHaveBeenCalledTimes(1);
    });

    it("accepts a version in force even with the control off (the record is made either way)", async () => {
      const { LEGAL_ACCEPTANCE_ENFORCED: _on, ...withoutFlag } = bindings;
      const t = setup({ workerBindings: withoutFlag });

      await t.client.account.acceptLegal({
        documents: [{ document: "terms", version: 1 }],
      });

      expect(t.recordAcceptance).toHaveBeenCalledTimes(1);
    });

    it("rejects a duplicated document and an empty list at the contract", async () => {
      const t = setup();

      const duplicated = await failureOf(
        t.client.account.acceptLegal({
          documents: [
            { document: "terms", version: 1 },
            { document: "terms", version: 1 },
          ],
        })
      );
      const empty = await failureOf(
        t.client.account.acceptLegal({ documents: [] })
      );

      expect(duplicated.code).toBe("BAD_REQUEST");
      expect(empty.code).toBe("BAD_REQUEST");
      expect(t.recordAcceptance).not.toHaveBeenCalled();
    });
  });

  it("no spelling of the address turns a controlled procedure into an exempt one", async () => {
    const { listSales, raw } = setup();
    const input = { organizationId };
    for (const path of [
      "/rpc/sale/list/",
      "/rpc/sale%2Flist",
      "/rpc/SALE/list",
      "/rpc/sale/list?path=account/legalStatus",
      "/rpc/sale/list#account/legalStatus",
      "/rpc/account.legalStatus",
      "/rpc/account/legalStatus/../../sale/list",
      "/rpc/account/legalStatus%2F..%2F..%2Fsale%2Flist",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one address at a time
      const response = await raw(path, input);
      // refused for the acceptance, or not a procedure at all: never served
      expect([403, 404]).toContain(response.status);
    }
    expect(listSales).not.toHaveBeenCalled();
  });
});
