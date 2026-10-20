import { env, exports } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { withAdminDatabase } from "@polaris/db/platform-principal-repository";
import worker from "./worker";
import { signAccessToken } from "./workerd-access";

/**
 * The Admin Worker, real, inside workerd (T-121a). Cloudflare Access is
 * simulated (see vitest.workers.config.ts) and there is no database: the
 * Hyperdrive points to a closed port, so a query fails closed.
 */

const EXPECTED_BINDINGS = [
  "ACCESS_AUDIENCE",
  "ACCESS_TEAM_DOMAIN",
  "ADMIN_HYPERDRIVE",
  "TEST_ACCESS_DOWN_TEAM_DOMAIN",
  "TEST_ACCESS_KEY_ID",
  "TEST_ACCESS_PRIVATE_JWK",
];
const CONNECTION_REFUSED = /connection attempt failed/;

const NO_CONTEXT = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

function whoami(token?: string): Promise<Response> {
  return exports.default.fetch("https://admin.test/api/whoami", {
    headers: token === undefined ? {} : { "cf-access-jwt-assertion": token },
  });
}

interface LoggedEvent {
  event?: string;
  reason?: string;
}

/** The events the Worker logged (`admin.<event>` and its `reason`), read from the console. */
function loggedEvents(spy: MockInstance): LoggedEvent[] {
  return spy.mock.calls.map(([entry]: unknown[]) => entry as LoggedEvent);
}

describe("admin worker in workerd", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no binding besides the app's and the test's own", () => {
    // a stray `.dev.vars` or `.env` would add variables here (the plugin's own `__VITEST_POOL_WORKERS_*` are not ours)
    const own = Object.keys(env).filter(
      (name) => !name.startsWith("__VITEST_POOL_WORKERS_")
    );
    expect(own.sort()).toEqual(EXPECTED_BINDINGS);
  });

  it("points the Hyperdrive to the harness database, not to the app's local one", () => {
    // `database` is "harness" only when the closed-port override is in place (the wrangler file names "polaris")
    expect(env.ADMIN_HYPERDRIVE.database).toBe("harness");
  });

  it("answers /health without a login", async () => {
    const response = await exports.default.fetch("https://admin.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers an unknown route with 404 and the security headers", async () => {
    const response = await exports.default.fetch("https://admin.test/nada");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses the API without an Access token", async () => {
    const response = await whoami();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  describe("valid Access token, no database", () => {
    it("cannot connect: the driver reaches the closed port and is refused", async () => {
      // the cause behind the 503 below is a refused connection, not a driver that failed to load
      await expect(
        withAdminDatabase(env.ADMIN_HYPERDRIVE.connectionString, (client) =>
          client.query("select 1", [])
        )
      ).rejects.toThrow(CONNECTION_REFUSED);
    });

    it("passes the token check and fails closed at the principal lookup (503)", async () => {
      const response = await whoami(await signAccessToken());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
      expect(loggedEvents(warn)).toEqual([
        expect.objectContaining({ event: "admin.principal_lookup_failed" }),
      ]);
    });

    it("answers 503 for another cause when the Access keys are unreachable", async () => {
      const request = new Request("https://admin.test/api/whoami", {
        headers: { "cf-access-jwt-assertion": await signAccessToken() },
      });
      const response = await worker.fetch(
        request,
        { ...env, ACCESS_TEAM_DOMAIN: env.TEST_ACCESS_DOWN_TEAM_DOMAIN },
        NO_CONTEXT
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
      expect(loggedEvents(warn)).toEqual([
        expect.objectContaining({
          event: "admin.access_token_rejected",
          reason: "unavailable",
        }),
      ]);
    });
  });

  describe("tampered Access token", () => {
    function flipSignature(token: string): string {
      const [header, payload, signature] = token.split(".");
      const flipped = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
      return `${header}.${payload}.${flipped}`;
    }

    const cases: [string, () => Promise<string>, string][] = [
      [
        "a signature flipped in its first character",
        async () => flipSignature(await signAccessToken()),
        "bad_signature",
      ],
      [
        "wrong audience",
        () => signAccessToken({ audience: "b".repeat(64) }),
        "wrong_audience",
      ],
      [
        "wrong issuer",
        () => signAccessToken({ issuer: "https://other.cloudflareaccess.com" }),
        "wrong_issuer",
      ],
      [
        "expired",
        () => signAccessToken({ expiresInSeconds: -3600 }),
        "expired",
      ],
      [
        "unknown key id",
        () => signAccessToken({ keyId: "unknown-key" }),
        "unknown_key",
      ],
    ];

    it.each(cases)("refuses %s with 401", async (_name, makeToken, reason) => {
      const response = await whoami(await makeToken());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
      expect(loggedEvents(warn)).toEqual([
        expect.objectContaining({
          event: "admin.access_token_rejected",
          reason,
        }),
      ]);
    });
  });
});
