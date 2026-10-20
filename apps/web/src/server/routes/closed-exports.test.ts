import { TenantAuthorizationError } from "@polaris/db/tenant-transaction";
import { DataExportUnavailableError } from "@polaris/domain/privacy/data-export";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ServerEnv, WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import { createClosedExportRoutes } from "./closed-exports";

const exportId = "0199c2d0-0000-7000-8000-0000000000aa";
const url = (path: string) => `https://polaris.example.invalid${path}`;
const file = {
  name: "polaris-dados-2026-10-17.zip",
  sizeBytes: 4,
  storageKey: `exports/v1/org_1/${exportId}/polaris-dados-2026-10-17.zip`,
};
const session = { user: { id: "user_1" } };

interface AuthenticatedInput {
  operation: (database: unknown, current: typeof session) => Promise<unknown>;
}

function build(input: {
  authenticated?: (request: AuthenticatedInput) => Promise<unknown>;
  bucket?: unknown;
  download?: ReturnType<typeof vi.fn>;
}) {
  const opened: string[] = [];
  const download = input.download ?? vi.fn(() => Promise.resolve(file));
  const routes = createClosedExportRoutes({
    getClosedDataExportDownload: download as never,
    withAuthenticatedRequestContext: ((request: AuthenticatedInput) => {
      opened.push("opened");
      return input.authenticated
        ? input.authenticated(request)
        : request.operation({}, session);
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
    opened,
  };
}

const good = `/api/closed-exports/${exportId}/files/1`;

describe("the closed organization export download", () => {
  it("streams the private object for the session user with headers that keep it out of caches", async () => {
    const t = build({});
    const response = await t.get(good);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${file.name}"`
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4])
    );
    expect(t.download).toHaveBeenCalledWith({}, "user_1", {
      exportId,
      ordinal: 1,
      requestId: "req-1",
    });
  });

  it("answers 404 for a malformed id or file number without opening a transaction", async () => {
    const t = build({});
    for (const path of [
      "/api/closed-exports/not-a-uuid/files/1",
      `/api/closed-exports/${exportId}/files/0`,
      `/api/closed-exports/${exportId}/files/abc`,
      `/api/closed-exports/${exportId}/files/1000`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      expect((await t.get(path)).status).toBe(404);
    }
    expect(t.opened).toEqual([]);
    expect(t.download).not.toHaveBeenCalled();
  });

  it("refuses HEAD without running the download or auditing it", async () => {
    const t = build({});
    const response = await t.app.fetch(
      new Request(url(good), { method: "HEAD" }),
      t.bindings
    );
    expect(response.status).toBe(405);
    expect(t.download).not.toHaveBeenCalled();
    expect(t.opened).toEqual([]);
  });

  it("answers 404 when the copy is not available (never says why)", async () => {
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
    expect(t.opened).toEqual([]);
  });

  it("answers 401 without a session", async () => {
    const t = build({
      authenticated: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    const response = await t.get(good);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 403 tenant_access_denied for any authorization refusal", async () => {
    for (const code of ["tenant_access_denied", "capability_denied"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time.
      const response = await build({
        authenticated: () => Promise.reject(new TenantAuthorizationError(code)),
      }).get(good);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "tenant_access_denied" },
      });
    }
  });

  it("answers 500 for an unexpected failure without leaking it", async () => {
    const t = build({
      download: vi.fn(() => Promise.reject(new Error("db exploded"))),
    });
    const response = await t.get(good);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("db exploded");
  });
});
