import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  DeviceLimitError,
  DeviceNotFoundError,
  DeviceNotOwnedError,
  DeviceRevokedError,
  DeviceSessionEndedError,
  FreshSessionRequiredError,
} from "@polaris/db/device-repository";
import { InvalidDeviceLabelError } from "@polaris/domain/offline/offline-grant";
import {
  buildOfflineLeaseClaims,
  OfflineLeaseNotAvailableError,
} from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { verifyOfflineLease } from "../../lib/offline-lease-token";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TenantRequestContextError } from "../request-context-error";
import { createRpcRouter } from "./router";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const grantId = "0199c2d0-0000-7000-8000-0000000000a1";
const sessionId = "session-row-17";
const session = {
  session: { createdAt: new Date(), id: sessionId },
  user: { emailVerified: true, id: "session-user-17" },
};
const identity = {
  capability: "offline:manage",
  organizationId,
  role: "owner",
  userId: "session-user-17",
};
const leaseSecret = "s".repeat(40);
const bindings = {
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
  OFFLINE_LEASE_SECRET: leaseSecret,
  ONBOARDING_HYPERDRIVE: {
    connectionString: "postgresql://onboarding.invalid/neondb",
  },
} satisfies WorkerBindings;

type Overrides = NonNullable<Parameters<typeof createRpcRouter>[0]>;

interface DeviceView {
  createdAt: string;
  id: string;
  label: string | null;
  lastSeenAt: string;
  revokedAt: string | null;
}

function createClient(
  overrides: Record<string, unknown>,
  workerBindings: WorkerBindings = bindings,
  headers: Record<string, string> = {}
) {
  const app = createServerApp({
    rpcRouter: createRpcRouter(overrides as unknown as Overrides),
  });
  const link = new RPCLink({
    fetch: (request) => Promise.resolve(app.fetch(request, workerBindings)),
    headers: { origin: "https://polaris.example.invalid", ...headers },
    method: "POST",
    url: new URL("/rpc", "https://polaris.example.invalid"),
  });
  return createORPCClient(link) as unknown as {
    device: {
      check: (input: unknown) => Promise<{ device: DeviceView }>;
      list: () => Promise<{ devices: DeviceView[] }>;
      register: (input: unknown) => Promise<{ device: DeviceView }>;
      revoke: (input: unknown) => Promise<{
        device: DeviceView;
        endedCurrentSession: boolean;
        endedSessionCount: number;
        revokedGrantIds: string[];
      }>;
      revokeCurrent: (input: unknown) => Promise<{
        alreadyRevoked: boolean;
        endedCurrentSession: boolean;
        revokedGrantCount: number;
      }>;
    };
    offline: {
      issueLease: (input: unknown) => Promise<{
        expiresAt: string;
        grantId: string;
        issuedAt: string;
        lease: string;
      }>;
    };
  };
}

const authenticated =
  () =>
  (input: {
    operation: (database: unknown, current: typeof session) => Promise<unknown>;
  }) =>
    input.operation({}, session);

const record = (overrides: Partial<Record<string, unknown>> = {}) => ({
  createdAt: new Date("2026-10-14T12:00:00.000Z"),
  id: deviceId,
  label: "Balcão",
  lastSeenAt: new Date("2026-10-14T12:00:00.000Z"),
  revokedAt: null,
  userId: session.user.id,
  ...overrides,
});

describe("device procedures", () => {
  it("answer 401 without a session and never reach the repository", async () => {
    const registerDevice = vi.fn();
    const client = createClient({
      registerDevice,
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(client.device.register({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(registerDevice).not.toHaveBeenCalled();
  });

  it("register uses the session user and returns the read model", async () => {
    const registerDevice = vi.fn(() => Promise.resolve(record()));
    const client = createClient({
      registerDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    const result = await client.device.register({ label: "Balcão" });
    expect(registerDevice).toHaveBeenCalledWith({}, "session-user-17", {
      label: "Balcão",
      sessionId,
    });
    expect(result.device).toEqual({
      createdAt: "2026-10-14T12:00:00.000Z",
      id: deviceId,
      label: "Balcão",
      lastSeenAt: "2026-10-14T12:00:00.000Z",
      revokedAt: null,
    });
    // The read model carries no user id and no fingerprint of any kind.
    expect(Object.keys(result.device).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "lastSeenAt",
      "revokedAt",
    ]);
  });

  it("ignores a user id smuggled in the input", async () => {
    const registerDevice = vi.fn(() => Promise.resolve(record()));
    const client = createClient({
      registerDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    await client.device.register({ label: null, userId: "someone-else" });
    expect(registerDevice).toHaveBeenCalledWith({}, "session-user-17", {
      label: null,
      sessionId,
    });
  });

  it("list returns the session user's devices", async () => {
    const listDevices = vi.fn(() =>
      Promise.resolve([record(), record({ id: grantId, label: null })])
    );
    const client = createClient({
      listDevices,
      withAuthenticatedRequestContext: authenticated(),
    });
    const result = await client.device.list();
    expect(listDevices).toHaveBeenCalledWith({}, "session-user-17");
    expect(result.devices.map((device) => device.id)).toEqual([
      deviceId,
      grantId,
    ]);
  });

  it("revoke returns the device and the revoked grants", async () => {
    const revokeDevice = vi.fn(() =>
      Promise.resolve({
        device: record({ revokedAt: new Date("2026-10-14T13:00:00.000Z") }),
        endedCurrentSession: true,
        endedSessionCount: 2,
        revokedGrantIds: [grantId],
      })
    );
    const client = createClient({
      revokeDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    const result = await client.device.revoke({ deviceId });
    expect(revokeDevice).toHaveBeenCalledWith({}, "session-user-17", deviceId, {
      actingSession: { fresh: true, id: sessionId },
      endOtherSessions: false,
      requestId: expect.any(String),
    });
    expect(result.device.revokedAt).toBe("2026-10-14T13:00:00.000Z");
    expect(result.revokedGrantIds).toEqual([grantId]);
    expect(result.endedSessionCount).toBe(2);
    expect(result.endedCurrentSession).toBe(true);
  });

  const revokeResult = () => ({
    device: record({ revokedAt: new Date("2026-10-14T13:00:00.000Z") }),
    endedCurrentSession: false,
    endedSessionCount: 0,
    revokedGrantIds: [],
  });

  it("revoke marks a session signed in 16 minutes ago as not fresh", async () => {
    const revokeDevice = vi.fn(() => Promise.resolve(revokeResult()));
    const staleSession = {
      ...session,
      session: {
        createdAt: new Date(Date.now() - 16 * 60 * 1000),
        id: sessionId,
      },
    };
    const client = createClient({
      revokeDevice,
      withAuthenticatedRequestContext: (input: {
        operation: (database: unknown, current: unknown) => Promise<unknown>;
      }) => input.operation({}, staleSession),
    });
    await client.device.revoke({ deviceId });
    expect(revokeDevice).toHaveBeenCalledWith(
      {},
      "session-user-17",
      deviceId,
      expect.objectContaining({
        actingSession: { fresh: false, id: sessionId },
      })
    );
  });

  it("revoke passes endOtherSessions through", async () => {
    const revokeDevice = vi.fn(() => Promise.resolve(revokeResult()));
    const client = createClient({
      revokeDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    await client.device.revoke({ deviceId, endOtherSessions: true });
    expect(revokeDevice).toHaveBeenCalledWith(
      {},
      "session-user-17",
      deviceId,
      expect.objectContaining({ endOtherSessions: true })
    );
  });

  it("a stale session revoking another device is FORBIDDEN with the fresh_session_required reason", async () => {
    const client = createClient({
      revokeDevice: () => Promise.reject(new FreshSessionRequiredError()),
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(client.device.revoke({ deviceId })).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "fresh_session_required" },
    });
  });

  it("a session ended by a device revocation is UNAUTHORIZED on register", async () => {
    const client = createClient({
      registerDevice: () => Promise.reject(new DeviceSessionEndedError()),
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(client.device.register({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("check touches the device with the session user and session, ignoring a smuggled user id", async () => {
    const touchDevice = vi.fn(() => Promise.resolve(record()));
    const client = createClient({
      touchDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    const result = await client.device.check({
      deviceId,
      userId: "someone-else",
    });
    expect(touchDevice).toHaveBeenCalledWith({}, "session-user-17", deviceId, {
      freshSession: true,
      sessionId,
    });
    expect(result.device.id).toBe(deviceId);
  });

  it("check tells the repository a session signed in 16 minutes ago is not fresh (no promotion to its own device)", async () => {
    const touchDevice = vi.fn(() => Promise.resolve(record()));
    const client = createClient({
      touchDevice,
      withAuthenticatedRequestContext: (input: {
        operation: (database: unknown, current: unknown) => Promise<unknown>;
      }) =>
        input.operation(
          {},
          {
            ...session,
            session: {
              createdAt: new Date(Date.now() - 16 * 60 * 1000),
              id: sessionId,
            },
          }
        ),
    });
    await client.device.check({ deviceId });
    expect(touchDevice).toHaveBeenCalledWith({}, "session-user-17", deviceId, {
      freshSession: false,
      sessionId,
    });
  });

  it("check answers CONFLICT for a revoked device and NOT_FOUND for an unknown one", async () => {
    const revoked = createClient({
      touchDevice: () => Promise.reject(new DeviceRevokedError()),
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(revoked.device.check({ deviceId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const unknown = createClient({
      touchDevice: () => Promise.reject(new DeviceNotFoundError()),
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(unknown.device.check({ deviceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("check answers 401 without a session and rejects a malformed device id", async () => {
    const touchDevice = vi.fn();
    const anonymous = createClient({
      touchDevice,
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(anonymous.device.check({ deviceId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const client = createClient({
      touchDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(
      client.device.check({ deviceId: "not-a-uuid" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(touchDevice).not.toHaveBeenCalled();
  });

  it("rejects a malformed device id before the repository", async () => {
    const revokeDevice = vi.fn();
    const client = createClient({
      revokeDevice,
      withAuthenticatedRequestContext: authenticated(),
    });
    await expect(
      client.device.revoke({ deviceId: "not-a-uuid" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it("maps domain errors to client errors", async () => {
    const cases = [
      [new InvalidDeviceLabelError(), "BAD_REQUEST"],
      [new DeviceNotFoundError(), "NOT_FOUND"],
      [new DeviceRevokedError(), "CONFLICT"],
      [new DeviceLimitError(), "CONFLICT"],
    ] as const;
    for (const [error, code] of cases) {
      const client = createClient({
        registerDevice: () => Promise.reject(error),
        withAuthenticatedRequestContext: authenticated(),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each mapping is verified on its own
      await expect(client.device.register({})).rejects.toMatchObject({ code });
    }
  });
});

describe("device.register names a device the person did not name (U-51)", () => {
  const chromeOnAndroid = {
    "sec-ch-ua":
      '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "user-agent":
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  };

  it.each([
    ["null", null],
    ["absent", undefined],
    ["blank", "   "],
  ])(
    "with the label %s, keeps the browser and the system from the closed table",
    async (_name, label) => {
      const registerDevice = vi.fn(() => Promise.resolve(record()));
      const client = createClient(
        { registerDevice, withAuthenticatedRequestContext: authenticated() },
        bindings,
        chromeOnAndroid
      );
      await client.device.register(label === undefined ? {} : { label });
      expect(registerDevice).toHaveBeenCalledWith({}, "session-user-17", {
        label: "Chrome no Android",
        sessionId,
      });
    }
  );

  it("keeps the name the person typed", async () => {
    const registerDevice = vi.fn(() => Promise.resolve(record()));
    const client = createClient(
      { registerDevice, withAuthenticatedRequestContext: authenticated() },
      bindings,
      chromeOnAndroid
    );
    await client.device.register({ label: "Caixa da loja" });
    expect(registerDevice).toHaveBeenCalledWith({}, "session-user-17", {
      label: "Caixa da loja",
      sessionId,
    });
  });
});

describe("device.revokeCurrent (Sair revokes this device)", () => {
  const requestId = "5f0a6c1e-3b9d-4f5e-8a7b-1c2d3e4f5a6b";
  const clientIp = "203.0.113.7";
  const authConnection = { query: vi.fn() };
  const ownResult = {
    alreadyRevoked: false,
    endedCurrentSession: true,
    revokedGrantCount: 2,
  };
  /** The real context hands the operation its authentication connection; the fake does the same. */
  const withAuthentication =
    (current: typeof session = session) =>
    (input: {
      operation: (
        database: unknown,
        value: typeof session,
        connection: unknown
      ) => Promise<unknown>;
    }) =>
      input.operation({}, current, authConnection);
  const staleSession = {
    ...session,
    session: {
      createdAt: new Date(Date.now() - 16 * 60 * 1000),
      id: sessionId,
    },
  };

  function revokeCurrentClient(overrides: Record<string, unknown>) {
    return createClient(overrides, bindings, {
      "cf-connecting-ip": clientIp,
      "x-request-id": requestId,
    });
  }

  it("revokes the session's own device without a fresh session, never ending the other sessions", async () => {
    const revokeOwnDevice = vi.fn(() => Promise.resolve(ownResult));
    const revokeDevice = vi.fn();
    const client = revokeCurrentClient({
      accessLogWriter: () => () => Promise.resolve(true),
      revokeDevice,
      revokeOwnDevice,
      withAuthenticatedRequestContext: withAuthentication(staleSession),
    });
    await expect(client.device.revokeCurrent({ deviceId })).resolves.toEqual(
      ownResult
    );
    expect(revokeOwnDevice).toHaveBeenCalledWith(
      {},
      "session-user-17",
      deviceId,
      { actingSessionId: sessionId, requestId }
    );
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it("ignores a user id or an endOtherSessions smuggled in the input", async () => {
    const revokeOwnDevice = vi.fn(() => Promise.resolve(ownResult));
    const client = revokeCurrentClient({
      accessLogWriter: () => () => Promise.resolve(true),
      revokeOwnDevice,
      withAuthenticatedRequestContext: withAuthentication(),
    });
    await client.device.revokeCurrent({
      deviceId,
      endOtherSessions: true,
      userId: "someone-else",
    });
    expect(revokeOwnDevice).toHaveBeenCalledWith(
      {},
      "session-user-17",
      deviceId,
      { actingSessionId: sessionId, requestId }
    );
  });

  it("another device of the user is FORBIDDEN with not_current_device, even for a recent session, and the refusal is counted without the device or the user", async () => {
    const { logger } = await import("@polaris/observability/logger");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const accessLog = vi.fn(() => Promise.resolve(true));
    try {
      const client = revokeCurrentClient({
        accessLogWriter: () => accessLog,
        revokeOwnDevice: () => Promise.reject(new DeviceNotOwnedError()),
        withAuthenticatedRequestContext: withAuthentication(),
      });
      await expect(
        client.device.revokeCurrent({ deviceId })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "not_current_device" },
      });
      expect(warn).toHaveBeenCalledWith("device_revoke_current_refused", {
        reason: "not_current_device",
      });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(deviceId);
      expect(logged).not.toContain("session-user-17");
      expect(logged).not.toContain(sessionId);
      expect(accessLog).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("an unknown device (or another user's) is NOT_FOUND, a malformed id BAD_REQUEST, and no session 401", async () => {
    const notFound = revokeCurrentClient({
      revokeOwnDevice: () => Promise.reject(new DeviceNotFoundError()),
      withAuthenticatedRequestContext: withAuthentication(),
    });
    await expect(
      notFound.device.revokeCurrent({ deviceId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const revokeOwnDevice = vi.fn();
    const malformed = revokeCurrentClient({
      revokeOwnDevice,
      withAuthenticatedRequestContext: withAuthentication(),
    });
    await expect(
      malformed.device.revokeCurrent({ deviceId: "not-a-uuid" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const signedOut = revokeCurrentClient({
      revokeOwnDevice,
      withAuthenticatedRequestContext: () =>
        Promise.reject(new TenantRequestContextError("session_required")),
    });
    await expect(
      signedOut.device.revokeCurrent({ deviceId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(revokeOwnDevice).not.toHaveBeenCalled();
  });

  it("a repetition answers alreadyRevoked and stays harmless", async () => {
    const client = revokeCurrentClient({
      accessLogWriter: () => () => Promise.resolve(true),
      revokeOwnDevice: () =>
        Promise.resolve({
          alreadyRevoked: true,
          endedCurrentSession: false,
          revokedGrantCount: 0,
        }),
      withAuthenticatedRequestContext: withAuthentication(),
    });
    await expect(client.device.revokeCurrent({ deviceId })).resolves.toEqual({
      alreadyRevoked: true,
      endedCurrentSession: false,
      revokedGrantCount: 0,
    });
  });

  it("records the logout once, on the authentication connection, with the session user, the whole IP and the request id of the audit", async () => {
    const accessLog = vi.fn(() => Promise.resolve(true));
    const accessLogWriter = vi.fn(() => accessLog);
    const revokeOwnDevice = vi.fn(() => Promise.resolve(ownResult));
    const client = revokeCurrentClient({
      accessLogWriter,
      revokeOwnDevice,
      withAuthenticatedRequestContext: withAuthentication(staleSession),
    });
    await client.device.revokeCurrent({ deviceId });
    expect(accessLogWriter).toHaveBeenCalledWith(authConnection);
    expect(accessLog).toHaveBeenCalledTimes(1);
    expect(accessLog).toHaveBeenCalledWith({
      event: "logout",
      ip: clientIp,
      requestId,
      userId: "session-user-17",
    });
    expect(revokeOwnDevice).toHaveBeenCalledWith(
      {},
      "session-user-17",
      deviceId,
      expect.objectContaining({ requestId })
    );
  });

  it("records nothing when the session did not end with the device (the sign-out records it)", async () => {
    const accessLog = vi.fn(() => Promise.resolve(true));
    const client = revokeCurrentClient({
      accessLogWriter: () => accessLog,
      revokeOwnDevice: () =>
        Promise.resolve({ ...ownResult, endedCurrentSession: false }),
      withAuthenticatedRequestContext: withAuthentication(),
    });
    await client.device.revokeCurrent({ deviceId });
    expect(accessLog).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("pool down"))],
    [
      "throws",
      () => {
        throw new Error("broken writer");
      },
    ],
    ["answers false", () => Promise.resolve(false)],
  ])("a writer that %s never fails the command", async (_name, write) => {
    const { logger } = await import("@polaris/observability/logger");
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const client = revokeCurrentClient({
        accessLogWriter: () => write,
        revokeOwnDevice: () => Promise.resolve(ownResult),
        withAuthenticatedRequestContext: withAuthentication(),
      });
      await expect(client.device.revokeCurrent({ deviceId })).resolves.toEqual(
        ownResult
      );
    } finally {
      error.mockRestore();
    }
  });

  it("the default writer gives up after 300 ms on a connection that never answers, and the command still succeeds", async () => {
    const { logger } = await import("@polaris/observability/logger");
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const hanging = { query: vi.fn(() => new Promise(() => undefined)) };
    try {
      const client = revokeCurrentClient({
        revokeOwnDevice: () => Promise.resolve(ownResult),
        withAuthenticatedRequestContext: (input: {
          operation: (
            database: unknown,
            value: typeof session,
            connection: unknown
          ) => Promise<unknown>;
        }) => input.operation({}, session, hanging),
      });
      const started = Date.now();
      await expect(client.device.revokeCurrent({ deviceId })).resolves.toEqual(
        ownResult
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(2000);
      expect(hanging.query).toHaveBeenCalledWith(
        expect.objectContaining({
          query_timeout: 300,
          values: ["logout", "session-user-17", clientIp, requestId],
        })
      );
      expect(error).toHaveBeenCalledWith(
        "auth_access_log_write_failed",
        expect.objectContaining({ reason: "timeout" })
      );
    } finally {
      error.mockRestore();
    }
  });

  it("a request from another origin is refused before the handler (CSRF)", async () => {
    const revokeOwnDevice = vi.fn(() => Promise.resolve(ownResult));
    const app = createServerApp({
      rpcRouter: createRpcRouter({
        revokeOwnDevice,
        withAuthenticatedRequestContext: withAuthentication(),
      } as unknown as Overrides),
    });
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/rpc/device/revokeCurrent", {
        body: JSON.stringify({ json: { deviceId } }),
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        method: "POST",
      }),
      bindings
    );
    expect(response.status).toBe(403);
    expect(revokeOwnDevice).not.toHaveBeenCalled();
  });

  it("counts against the same rate limit as device.revoke", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: vi.fn((input: { key: string }) => {
        keys.push(input.key);
        return Promise.resolve({ success: false });
      }),
    };
    const revokeOwnDevice = vi.fn(() => Promise.resolve(ownResult));
    const revokeDevice = vi.fn();
    const app = createServerApp({
      rpcRouter: createRpcRouter({
        revokeDevice,
        revokeOwnDevice,
        withAuthenticatedRequestContext: withAuthentication(),
      } as unknown as Overrides),
    });
    const call = (procedure: string) =>
      app.fetch(
        new Request(`https://polaris.example.invalid/rpc/device/${procedure}`, {
          body: JSON.stringify({ json: { deviceId } }),
          headers: {
            "cf-connecting-ip": "203.0.113.9",
            "content-type": "application/json",
            origin: "https://polaris.example.invalid",
          },
          method: "POST",
        }),
        { ...bindings, RPC_MUTATION_RATE_LIMIT: limiter }
      );
    const current = await call("revokeCurrent");
    const other = await call("revoke");
    expect(current.status).toBe(429);
    expect(other.status).toBe(429);
    // the same bucket of the same scope: one key per call, and the same key for both procedures
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(revokeOwnDevice).not.toHaveBeenCalled();
    expect(revokeDevice).not.toHaveBeenCalled();
  });
});

describe("offline.issueLease", () => {
  const claims = buildOfflineLeaseClaims({
    capabilities: ["catalog:read", "sale:create"],
    deviceId,
    epoch: 0,
    expiresAt: new Date("2026-10-17T12:00:00.000Z"),
    grantId,
    issuedAt: new Date("2026-10-14T12:00:00.000Z"),
    organizationId,
    userId: session.user.id,
  });
  const grant = {
    authorizationEpoch: 0,
    deviceId,
    expiresAt: new Date("2026-10-17T12:00:00.000Z"),
    id: grantId,
    issuedAt: new Date("2026-10-14T12:00:00.000Z"),
    organizationId,
    revokedAt: null,
    revokedReason: null,
    userId: session.user.id,
  };

  function tenantContext() {
    return vi.fn(
      (input: {
        capability: string;
        operation: (
          transaction: unknown,
          authorized: typeof identity
        ) => Promise<unknown>;
        requestedOrganizationId: string;
      }) => input.operation({}, identity)
    );
  }

  it("issues a signed lease for the requested organization and device", async () => {
    const withTenantRequestContext = tenantContext();
    const issueOfflineLeaseGrant = vi.fn(() =>
      Promise.resolve({ claims, grant })
    );
    const client = createClient({
      issueOfflineLeaseGrant,
      withTenantRequestContext,
    });
    const result = await client.offline.issueLease({
      deviceId,
      organizationId,
    });

    expect(withTenantRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "offline:manage",
        requestedOrganizationId: organizationId,
      })
    );
    expect(issueOfflineLeaseGrant).toHaveBeenCalledWith(
      {},
      identity,
      expect.objectContaining({ deviceId })
    );
    expect(result.grantId).toBe(grantId);
    expect(result.expiresAt).toBe("2026-10-17T12:00:00.000Z");
    await expect(
      verifyOfflineLease(
        result.lease,
        [{ id: "k1", secret: leaseSecret }],
        new Date("2026-10-14T12:30:00.000Z")
      )
    ).resolves.toEqual(claims);
  });

  it("fails closed, writing nothing, when no lease secret is configured", async () => {
    const issueOfflineLeaseGrant = vi.fn();
    const { OFFLINE_LEASE_SECRET: _omitted, ...withoutSecret } = bindings;
    const client = createClient(
      { issueOfflineLeaseGrant, withTenantRequestContext: tenantContext() },
      withoutSecret
    );
    await expect(
      client.offline.issueLease({ deviceId, organizationId })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(issueOfflineLeaseGrant).not.toHaveBeenCalled();
  });

  it("fails closed when the secret is too short to sign", async () => {
    const client = createClient(
      {
        issueOfflineLeaseGrant: () => Promise.resolve({ claims, grant }),
        withTenantRequestContext: tenantContext(),
      },
      { ...bindings, OFFLINE_LEASE_SECRET: "short" }
    );
    await expect(
      client.offline.issueLease({ deviceId, organizationId })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("requires the previous key id when rotating and never reuses an id", async () => {
    const client = createClient(
      {
        issueOfflineLeaseGrant: () => Promise.resolve({ claims, grant }),
        withTenantRequestContext: tenantContext(),
      },
      {
        ...bindings,
        OFFLINE_LEASE_PREVIOUS_SECRET: "p".repeat(40),
      }
    );
    await expect(
      client.offline.issueLease({ deviceId, organizationId })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("maps a revoked device and an ended entitlement to conflicts", async () => {
    for (const error of [
      new DeviceRevokedError(),
      new OfflineLeaseNotAvailableError(),
    ]) {
      const client = createClient({
        issueOfflineLeaseGrant: () => Promise.reject(error),
        withTenantRequestContext: tenantContext(),
      });
      // biome-ignore lint/performance/noAwaitInLoops: each mapping is verified on its own
      await expect(
        client.offline.issueLease({ deviceId, organizationId })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    const missing = createClient({
      issueOfflineLeaseGrant: () => Promise.reject(new DeviceNotFoundError()),
      withTenantRequestContext: tenantContext(),
    });
    await expect(
      missing.offline.issueLease({ deviceId, organizationId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps a session ended by a device revocation to UNAUTHORIZED", async () => {
    const client = createClient({
      issueOfflineLeaseGrant: () =>
        Promise.reject(new DeviceSessionEndedError()),
      withTenantRequestContext: tenantContext(),
    });
    await expect(
      client.offline.issueLease({ deviceId, organizationId })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
