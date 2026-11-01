import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureLogging,
  type LogFields,
  logger,
  type OpaqueId,
  opaqueId,
} from "./logger";

type Spy = ReturnType<typeof vi.spyOn>;

const leakedData = /joao@example|hunter2|98888-7777/;

function lastCall(spy: Spy): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  expect(call).toBeDefined();
  expect(call).toHaveLength(1);
  return (call as [Record<string, unknown>])[0];
}

describe("logger", () => {
  let info: Spy;
  let warn: Spy;
  let error: Spy;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureLogging({ service: "polaris-test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one object per call on the console method of the level", () => {
    logger.info("job_done", { durationMs: 12, job: "outbox.dispatch" });
    logger.warn("job_skipped", { reason: "busy" });
    logger.error("job_failed", { errorClass: "Error" });

    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(lastCall(info)).toMatchObject({
      durationMs: 12,
      event: "job_done",
      job: "outbox.dispatch",
      level: "info",
      service: "polaris-test",
    });
    expect(lastCall(warn)).toMatchObject({
      event: "job_skipped",
      level: "warn",
    });
    expect(lastCall(error)).toMatchObject({
      event: "job_failed",
      level: "error",
    });
  });

  it("emits an event without fields", () => {
    logger.warn("not_configured");

    expect(lastCall(warn)).toMatchObject({ event: "not_configured" });
  });

  it("drops undefined fields and keeps nested allow-listed values", () => {
    logger.info("report", {
      causes: [{ code: "23505", name: "DatabaseError" }],
      missing: undefined,
      removed: 3,
    });

    const event = lastCall(info);
    expect(event).toMatchObject({
      causes: [{ code: "23505", name: "DatabaseError" }],
      removed: 3,
    });
    expect("missing" in event).toBe(false);
  });

  it("does not let a caller override the keys evlog owns", () => {
    const forged = {
      event: "forged",
      level: "debug",
      service: "forged",
      timestamp: "1970-01-01T00:00:00.000Z",
    } as unknown as LogFields;

    logger.info("real_event", forged);

    expect(lastCall(info)).toMatchObject({
      event: "real_event",
      level: "info",
      service: "polaris-test",
    });
    expect(lastCall(info).timestamp).not.toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects reserved keys at type level", () => {
    // @ts-expect-error `event` belongs to the logger, not to the fields.
    const fields: LogFields = { event: "x" };
    expect(fields).toBeDefined();
  });

  it("does not let a caller forge the audit trail key of evlog", () => {
    logger.info("with_audit", {
      audit: { action: "x" },
    } as unknown as LogFields);

    expect("audit" in lastCall(info)).toBe(false);
  });

  it("masks personal data that slips into a value", () => {
    logger.info("leaky", { note: "contact maria@example.com" });

    expect(JSON.stringify(lastCall(info))).not.toContain("maria@example.com");
  });

  it("works before configureLogging with the default service", async () => {
    vi.resetModules();
    const fresh = await import("./logger");

    fresh.logger.info("early");

    expect(lastCall(info)).toMatchObject({
      event: "early",
      service: "polaris",
    });
  });

  it("rejects the forbidden aliases at type level", () => {
    // @ts-expect-error `orgId` is an alias of `organizationId`.
    const orgId: LogFields = { orgId: "org-1" };
    // @ts-expect-error `duration` is an alias of `durationMs`.
    const duration: LogFields = { duration: 12 };
    // @ts-expect-error `errorName` is an alias of `errorClass`.
    const errorName: LogFields = { errorName: "Error" };
    // @ts-expect-error `outcome` takes the known values only.
    const outcome: LogFields = { outcome: "ok" };
    expect([orgId, duration, errorName, outcome]).toHaveLength(4);
  });

  it("drops an alias that a cast or a loose record lets through, and names it", () => {
    const loose: Record<string, string> = {
      org_id: "org-1",
      reqId: "req-1",
      requestId: "req-2",
    };

    logger.info("aliased", loose);

    const event = lastCall(info);
    expect(event).toMatchObject({
      ignoredFields: ["org_id", "reqId"],
      requestId: "req-2",
    });
    expect("org_id" in event).toBe(false);
    expect("reqId" in event).toBe(false);
  });

  it("drops an opaque id that holds personal data", () => {
    logger.info("leaky", {
      // a cast gets past the brand; the shape check still drops it
      actorId: "maria@example.com" as unknown as OpaqueId,
      organizationId: opaqueId("org-1"),
    });

    const event = lastCall(info);
    expect(JSON.stringify(event)).not.toContain("maria@example.com");
    expect(event).toMatchObject({
      ignoredFields: ["actorId"],
      organizationId: "org-1",
    });
  });

  it("takes an organization, actor or device only as an OpaqueId", () => {
    const text: string = "org-1";
    // @ts-expect-error a plain string is not an OpaqueId.
    const organization: LogFields = { organizationId: text };
    // @ts-expect-error a plain string is not an OpaqueId.
    const actor: LogFields = { actorId: text };
    // @ts-expect-error a plain string is not an OpaqueId.
    const device: LogFields = { deviceId: text };
    expect([organization, actor, device]).toHaveLength(3);

    const minted: LogFields = {
      actorId: opaqueId("usr-1"),
      deviceId: opaqueId("dev_1"),
      organizationId: opaqueId("org-1"),
    };
    expect(minted.organizationId).toBe("org-1");
  });

  it("makes an OpaqueId only from an id-shaped value", () => {
    expect(opaqueId("0190b2c4-7d5a-7e2f-9a11-123456789012")).toBeDefined();
    expect(opaqueId("maria@example.com")).toBeUndefined();
    expect(opaqueId("two words")).toBeUndefined();
    expect(opaqueId("+5511999998888")).toBeUndefined();
    expect(opaqueId("a".repeat(129))).toBeUndefined();
    expect(opaqueId(42)).toBeUndefined();
    expect(opaqueId(undefined)).toBeUndefined();
  });

  it("runs every event through the redaction policy", () => {
    logger.error("leaky", {
      causes: [{ code: "x", name: "joao@example.com" }],
      password: "hunter2",
      note: "ligar para (11) 98888-7777",
    });

    const event = lastCall(error);
    expect(JSON.stringify(event)).not.toMatch(leakedData);
    expect(event).toMatchObject({ password: "[REDACTED:secret]" });
  });

  it("fails closed, and never throws, when a value cannot be read", () => {
    const hostile = {
      get boom(): string {
        throw new Error("maria@example.com");
      },
    };

    expect(() =>
      logger.error("unreadable", hostile as unknown as LogFields)
    ).not.toThrow();
    expect(lastCall(error)).toMatchObject({
      event: "unreadable",
      redactionFailed: true,
    });
    expect(JSON.stringify(lastCall(error))).not.toContain("maria@example.com");
  });

  it("keeps a field named like a prototype slot as data", () => {
    const hostile = JSON.parse('{"__proto__": {"x": 1}, "ok": 1}');

    logger.info("proto", hostile);

    expect(lastCall(info)).toMatchObject({ ok: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("masks personal data in the event name too", () => {
    logger.info("login maria@example.com");

    expect(lastCall(info).event).toBe("login [REDACTED:email]");
  });

  it("keeps an id-shaped value whole under any key that is not sensitive", () => {
    const ids = [
      "0190f3c2-a1b7-4d5e-8f6a-7b8c9d0e1f2a",
      "org_0190f3c2a1b74d5e8f6a7b8c9d0e1f2a",
      "cmd-9f8e7d6c",
      "01J8Z3K5M7N9P2Q4R6S8T0V1WX",
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "ch_1234567890123456",
      "1234567890123456",
    ];

    for (const id of ids) {
      logger.info("ids", {
        commandId: id,
        organizationId: opaqueId(id),
        reference: id,
      });

      expect(lastCall(info)).toMatchObject({
        commandId: id,
        organizationId: id,
        reference: id,
      });
    }
  });

  it("keeps masking a key that ends in token even when the value is an opaque id", () => {
    logger.info("tokens", {
      csrfToken: "0190f3c2-a1b7-4d5e-8f6a-7b8c9d0e1f2a",
      sessionToken: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      token: "cmd-9f8e7d6c",
    });

    expect(lastCall(info)).toMatchObject({
      csrfToken: "[REDACTED:secret]",
      sessionToken: "[REDACTED:secret]",
      token: "[REDACTED:secret]",
    });
  });

  it("masks a 16-digit number that passes the Luhn check, an accepted false positive", () => {
    logger.info("digits", { reference: "4111111111111111" });

    expect(lastCall(info).reference).toBe("[REDACTED:card]");
  });

  it("lists a reserved key forged by a cast in ignoredFields instead of dropping it silently", () => {
    logger.info("forged", {
      environment: "production",
      ok: 1,
      service: "other",
    } as unknown as LogFields);

    const event = lastCall(info);
    expect(event).toMatchObject({
      ignoredFields: ["environment", "service"],
      ok: 1,
      service: "polaris-test",
    });
    expect(event.environment).not.toBe("production");
  });

  it("replaces an ignoredFields value the caller sent with the names it dropped", () => {
    logger.info("forged", {
      ignoredFields: ["x"],
      org_id: "org-1",
    } as unknown as LogFields);

    expect(lastCall(info).ignoredFields).toEqual(["ignoredFields", "org_id"]);
  });
});

describe("logging environment", () => {
  let info: Spy;

  beforeEach(() => {
    vi.resetModules();
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels the events with the staging or production the Worker variable names", async () => {
    const fresh = await import("./logger");
    fresh.configureLogging({ service: "polaris-test" });

    fresh.useLoggingEnvironment("staging");
    fresh.logger.info("a");
    expect(lastCall(info)).toMatchObject({
      environment: "staging",
      service: "polaris-test",
    });

    fresh.useLoggingEnvironment("production");
    fresh.logger.info("b");
    expect(lastCall(info)).toMatchObject({
      environment: "production",
      service: "polaris-test",
    });
  });

  it("does not turn an absent or unknown variable into an environment", async () => {
    const fresh = await import("./logger");
    fresh.configureLogging({ service: "polaris-test" });
    fresh.logger.info("before");
    const initial = lastCall(info).environment;

    for (const value of [undefined, "", "Staging", "prod", "development", 1]) {
      fresh.useLoggingEnvironment(value);
      fresh.logger.info("after");
      expect(lastCall(info).environment).toBe(initial);
    }
    expect(initial).not.toBe("staging");
    expect(initial).not.toBe("production");
  });

  it("keeps the service and the version when it reconfigures for the environment", async () => {
    const fresh = await import("./logger");
    fresh.configureLogging({ service: "polaris-test", version: "v1" });

    fresh.useLoggingEnvironment("staging");
    fresh.useLoggingEnvironment("staging");
    fresh.logger.info("a");

    expect(lastCall(info)).toMatchObject({
      environment: "staging",
      service: "polaris-test",
      version: "v1",
    });
  });
});
