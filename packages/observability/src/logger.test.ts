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
});
