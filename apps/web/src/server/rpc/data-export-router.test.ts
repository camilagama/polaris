import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { InvalidExportRequestError } from "@polaris/domain/privacy/data-export";
import { describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createRpcRouter } from "./router";

const organizationId = "org_7b9c212a";
const session = { user: { emailVerified: true, id: "session-user-17" } };

const testBindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

function createClient(overrides: Record<string, unknown>) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, testBindings)),
    headers: { origin: "https://polaris.example.invalid" },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    dataExport: {
      list: (input: unknown) => Promise<{ exports: unknown[] }>;
      request: (input: unknown) => Promise<{ id: string }>;
    };
  };
}

function tenant(seen: string[] = []) {
  return (input: TenantRequestContextInput<unknown>) => {
    seen.push(input.capability);
    return input.operation({} as never, {
      capability: input.capability,
      organizationId: input.requestedOrganizationId,
      role: "owner",
      userId: session.user.id,
    });
  };
}

describe("dataExport.request", () => {
  it("runs under its own capability and hands over the formats asked for", async () => {
    const seen: string[] = [];
    const requestDataExport = vi.fn(() =>
      Promise.resolve({ id: "0199c2d0-0000-7000-8000-0000000000aa" })
    );
    const client = createClient({
      dataExportRepository: { requestDataExport },
      withTenantRequestContext: tenant(seen),
    });
    await expect(
      client.dataExport.request({ formats: ["json", "csv"], organizationId })
    ).resolves.toEqual({ id: "0199c2d0-0000-7000-8000-0000000000aa" });
    expect(seen).toEqual(["organization:export"]);
    expect(requestDataExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId }),
      expect.objectContaining({ formats: ["json", "csv"] })
    );
  });

  it("refuses an empty or unknown format list before reaching the database", async () => {
    const requestDataExport = vi.fn();
    const client = createClient({
      dataExportRepository: { requestDataExport },
      withTenantRequestContext: tenant(),
    });
    for (const formats of [[], ["pdf"], ["json", "json", "csv", "images"]]) {
      // biome-ignore lint/performance/noAwaitInLoops: One refusal at a time.
      await expect(
        client.dataExport.request({ formats, organizationId })
      ).rejects.toBeDefined();
    }
    expect(requestDataExport).not.toHaveBeenCalled();
  });

  it.each([
    ["export_already_running", "CONFLICT"],
    ["export_limit_reached", "CONFLICT"],
    ["invalid_export_request", "BAD_REQUEST"],
  ] as const)("answers %s as %s with the reason", async (reason, code) => {
    const client = createClient({
      dataExportRepository: {
        requestDataExport: () =>
          Promise.reject(new InvalidExportRequestError(reason)),
      },
      withTenantRequestContext: tenant(),
    });
    await expect(
      client.dataExport.request({ formats: ["json"], organizationId })
    ).rejects.toMatchObject({ code, data: { reason } });
  });

  it("answers 401 without a session and does nothing", async () => {
    const requestDataExport = vi.fn();
    const client = createClient({
      dataExportRepository: { requestDataExport },
      withTenantRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(
      client.dataExport.request({ formats: ["json"], organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requestDataExport).not.toHaveBeenCalled();
  });
});

describe("dataExport.list", () => {
  it("shows the exports with dates as text and without the storage keys", async () => {
    const requestedAt = new Date("2026-10-17T12:00:00.000Z");
    const listDataExports = vi.fn(() =>
      Promise.resolve([
        {
          errorCode: null,
          expiresAt: new Date("2026-10-18T12:05:00.000Z"),
          files: [
            { name: "polaris-dados-2026-10-17.zip", ordinal: 1, sizeBytes: 10 },
          ],
          formats: ["json"],
          id: "0199c2d0-0000-7000-8000-0000000000aa",
          readyAt: new Date("2026-10-17T12:05:00.000Z"),
          requestedAt,
          status: "ready",
          totalBytes: 10,
        },
      ])
    );
    const seen: string[] = [];
    const client = createClient({
      dataExportRepository: { listDataExports },
      withTenantRequestContext: tenant(seen),
    });
    const result = await client.dataExport.list({ organizationId });
    expect(seen).toEqual(["organization:export"]);
    expect(result.exports).toEqual([
      {
        errorCode: null,
        expiresAt: "2026-10-18T12:05:00.000Z",
        files: [
          { name: "polaris-dados-2026-10-17.zip", ordinal: 1, sizeBytes: 10 },
        ],
        formats: ["json"],
        id: "0199c2d0-0000-7000-8000-0000000000aa",
        readyAt: "2026-10-17T12:05:00.000Z",
        requestedAt: requestedAt.toISOString(),
        status: "ready",
        totalBytes: 10,
      },
    ]);
  });
});
