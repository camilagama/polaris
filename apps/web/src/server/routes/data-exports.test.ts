import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { DataExportUnavailableError } from "@polaris/domain/privacy/data-export";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ServerEnv, WorkerBindings } from "../environment";
import { isExemptFromLegalAcceptance } from "../legal-acceptance";
import { TenantRequestContextError } from "../request-context-error";
import type { TenantRequestContextInput } from "../tenant-request-context";
import { createDataExportRoutes } from "./data-exports";

const exportId = "0199c2d0-0000-7000-8000-0000000000aa";
const organizationId = "org_1";
const url = (path: string) => `https://polaris.example.invalid${path}`;
const file = {
  name: "polaris-dados-2026-10-17.zip",
  sizeBytes: 4,
  storageKey: `exports/v1/${organizationId}/${exportId}/polaris-dados-2026-10-17.zip`,
};

function build(input: {
  bucket?: unknown;
  download?: ReturnType<typeof vi.fn>;
  tenant?: (input: TenantRequestContextInput<unknown>) => Promise<unknown>;
}) {
  const seen: string[] = [];
  const download = input.download ?? vi.fn(() => Promise.resolve(file));
  const routes = createDataExportRoutes({
    getDataExportDownload: download as never,
    withTenantRequestContext: ((
      request: TenantRequestContextInput<unknown>
    ) => {
      seen.push(request.capability);
      return input.tenant
        ? input.tenant(request)
        : request.operation({} as never, {
            capability: request.capability,
            organizationId: request.requestedOrganizationId,
            role: "owner",
            userId: "user_1",
          });
    }) as never,
  });
  const app = new Hono<ServerEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "req-1");
    await next();
  });
  app.route("/", routes);
  const bindings = {
    MEDIA_BUCKET:
      input.bucket === undefined
        ? {
            get: () =>
              Promise.resolve({
                body: new Response(new Uint8Array([80, 75, 3, 4])).body,
                size: 4,
              }),
          }
        : input.bucket,
  } as unknown as WorkerBindings;
  return {
    app,
    bindings,
    download,
    get: (path: string) => app.fetch(new Request(url(path)), bindings),
    seen,
  };
}

const good = `/api/data-exports/${exportId}/files/1?organizationId=${organizationId}`;

describe("the data export download", () => {
  it("streams the private object with headers that keep it out of caches", async () => {
    const t = build({});
    const response = await t.get(good);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${file.name}"`
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4])
    );
    expect(t.seen).toEqual(["organization:export"]);
    expect(t.download).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { exportId, ordinal: 1, requestId: "req-1" }
    );
  });

  it("answers 404 for a malformed id or file number without opening a transaction", async () => {
    const t = build({});
    for (const path of [
      `/api/data-exports/not-a-uuid/files/1?organizationId=${organizationId}`,
      `/api/data-exports/${exportId}/files/0?organizationId=${organizationId}`,
      `/api/data-exports/${exportId}/files/abc?organizationId=${organizationId}`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      expect((await t.get(path)).status).toBe(404);
    }
    expect(t.seen).toEqual([]);
  });

  it("refuses HEAD without running the download or auditing it", async () => {
    const t = build({});
    const response = await t.app.fetch(
      new Request(url(good), { method: "HEAD" }),
      t.bindings
    );
    expect(response.status).toBe(405);
    expect(t.download).not.toHaveBeenCalled();
  });

  it("asks for the organization", async () => {
    const t = build({});
    expect((await t.get(`/api/data-exports/${exportId}/files/1`)).status).toBe(
      400
    );
  });

  it("answers 404 when the export is not available (never says why)", async () => {
    const t = build({
      download: vi.fn(() => Promise.reject(new DataExportUnavailableError())),
    });
    const response = await t.get(good);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 when the object is gone from storage", async () => {
    const t = build({ bucket: { get: () => Promise.resolve(null) } });
    expect((await t.get(good)).status).toBe(404);
  });

  it("answers 503 without storage", async () => {
    const t = build({ bucket: null });
    expect((await t.get(good)).status).toBe(503);
  });

  it("answers 401 without a session and 403 without the capability or membership", async () => {
    expect(
      (
        await build({
          tenant: () =>
            Promise.reject(new TenantRequestContextError("session_required")),
        }).get(good)
      ).status
    ).toBe(401);
    expect(
      (
        await build({
          tenant: () =>
            Promise.reject(new TenantAuthorizationError("capability_denied")),
        }).get(good)
      ).status
    ).toBe(403);
    expect(
      (
        await build({
          tenant: () =>
            Promise.reject(
              new TenantAuthorizationError("tenant_access_denied")
            ),
        }).get(good)
      ).status
    ).toBe(403);
  });

  it("answers 403 legal_acceptance_required (not 401 or 503) while the legal acceptance is pending", async () => {
    const response = await build({
      tenant: () =>
        Promise.reject(
          new TenantRequestContextError("legal_acceptance_required", [
            { document: "terms", version: 1 },
          ])
        ),
    }).get(good);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "legal_acceptance_required" },
      requestId: "req-1",
    });
  });

  it("marks the download exempt from the legal acceptance control before the request context runs", async () => {
    let exemptWhenCalled: boolean | undefined;
    const requests: Request[] = [];
    const t = build({
      tenant: (input) => {
        requests.push(input.request);
        exemptWhenCalled = isExemptFromLegalAcceptance(input.request);
        return Promise.resolve(file);
      },
      download: vi.fn(() => Promise.resolve(file)),
    });
    await t.get(good);
    expect(requests).toHaveLength(1);
    expect(exemptWhenCalled).toBe(true);
  });
});
