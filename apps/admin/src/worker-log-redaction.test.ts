import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDependencies } from "./app";

/**
 * End to end for the Admin Worker's logging: the real `worker.ts` wiring (its
 * `report` helper takes a loose record, the slip PR116 closes) and the real
 * logger, with only the console spied.
 */

const captured = vi.hoisted(() => ({
  dependencies: undefined as unknown,
}));

vi.mock("./app", async (importActual) => {
  const actual = await importActual<typeof import("./app")>();
  return {
    ...actual,
    createAdminApp: (dependencies: AdminDependencies) => {
      captured.dependencies = dependencies;
      return actual.createAdminApp(dependencies);
    },
  };
});

const { default: worker } = await import("./worker");

function warnings(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>
  );
}

describe("the Admin Worker's log", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("masks personal data and secrets that a caller of `report` lets through", () => {
    const { report } = captured.dependencies as AdminDependencies;

    report("probe", {
      authorization: "Bearer abcdef0123456789",
      customerEmail: "maria@example.com",
      note: "CPF 123.456.789-09, telefone (11) 98888-7777, IP 203.0.113.9",
      reason: "ok",
    });

    const [event] = warnings(warn);
    expect(event).toMatchObject({
      event: "admin.probe",
      reason: "ok",
      service: "polaris-admin",
    });
    const json = JSON.stringify(event);
    for (const secret of [
      "abcdef0123456789",
      "maria@example.com",
      "123.456.789-09",
      "98888-7777",
      "203.0.113.9",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("logs a refused request without its token, address or headers", async () => {
    const response = await worker.fetch(
      new Request("https://admin.example.test/api/me", {
        headers: {
          authorization: "Bearer abcdef0123456789",
          "cf-access-jwt-assertion":
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
          "cf-connecting-ip": "203.0.113.9",
        },
      }),
      {} as never,
      { passThroughOnException: vi.fn(), waitUntil: vi.fn() } as never
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const json = JSON.stringify(warnings(warn));
    expect(warn).toHaveBeenCalled();
    expect(json).toContain('"service":"polaris-admin"');
    for (const secret of ["abcdef0123456789", "c2lnbmF0dXJl", "203.0.113.9"]) {
      expect(json).not.toContain(secret);
    }
  });
});
