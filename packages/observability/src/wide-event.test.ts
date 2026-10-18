import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLogging } from "./logger";
import { describeError, startWideEvent, withWideEvent } from "./wide-event";

type Spy = ReturnType<typeof vi.spyOn>;

function events(spy: Spy): Record<string, unknown>[] {
  return spy.mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>
  );
}

function clock(...times: number[]): () => number {
  let index = 0;
  return () => {
    const time = times[Math.min(index, times.length - 1)] ?? 0;
    index += 1;
    return time;
  };
}

describe("wide events", () => {
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

  it("writes one event, at the end, with what was learned on the way", () => {
    const wide = startWideEvent(
      "sale_confirm",
      { requestId: "req-1" },
      { now: clock(1000, 1250) }
    );
    wide.set({ actorId: "usr-1", organizationId: "org-1" });
    wide.set({ lines: 3, operation: "sale.confirm" });

    expect(info).not.toHaveBeenCalled();
    wide.emit();

    expect(events(info)).toEqual([
      expect.objectContaining({
        actorId: "usr-1",
        durationMs: 250,
        event: "sale_confirm",
        level: "info",
        lines: 3,
        operation: "sale.confirm",
        organizationId: "org-1",
        outcome: "success",
        requestId: "req-1",
        service: "polaris-test",
      }),
    ]);
  });

  it("writes it only once", () => {
    const wide = startWideEvent("once");
    wide.emit();
    wide.emit("failure");

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("picks the level from the outcome", () => {
    startWideEvent("a").emit("skipped");
    startWideEvent("b").emit("partial");
    startWideEvent("c").emit("rejected");
    startWideEvent("d").emit("failure");

    expect(events(info).map((e) => e.event)).toEqual(["a"]);
    expect(events(warn).map((e) => e.event)).toEqual(["b", "c"]);
    expect(events(error).map((e) => e.event)).toEqual(["d"]);
  });

  it("uses the outcome set on the way unless emit names one", () => {
    const first = startWideEvent("first");
    first.set({ outcome: "rejected" });
    first.emit();
    const second = startWideEvent("second");
    second.set({ outcome: "rejected" });
    second.emit("success");

    expect(events(warn)[0]).toMatchObject({ outcome: "rejected" });
    expect(events(info)[0]).toMatchObject({ outcome: "success" });
  });

  it("owns durationMs: a caller value is replaced", () => {
    const wide = startWideEvent("timed", {}, { now: clock(0, 40) });
    wide.set({ durationMs: 9999 });
    wide.emit();

    expect(events(info)[0]).toMatchObject({ durationMs: 40 });
  });

  it("never reports a negative duration", () => {
    const wide = startWideEvent("backwards", {}, { now: clock(500, 400) });
    wide.emit();

    expect(events(info)[0]).toMatchObject({ durationMs: 0 });
  });

  it("marks a failure with the class and code of the error, not its message", () => {
    const wide = startWideEvent("failing");
    wide.fail(
      Object.assign(new Error("cliente Maria Souza, 11 99999-0000"), {
        code: "23505",
      })
    );
    wide.emit();

    const [event] = events(error);
    expect(event).toMatchObject({
      errorClass: "Error",
      errorCode: "23505",
      outcome: "failure",
    });
    expect(JSON.stringify(event)).not.toContain("Maria");
  });

  it("ignores an undefined value instead of erasing a field", () => {
    const wide = startWideEvent("keep", { organizationId: "org-1" });
    wide.set({ organizationId: undefined });
    wide.emit();

    expect(events(info)[0]).toMatchObject({ organizationId: "org-1" });
  });

  it("drops a field that is an alias, and says which one", () => {
    const wide = startWideEvent("aliased");
    wide.set({ orgId: "org-1" } as never);
    wide.emit();

    const [event] = events(info);
    expect("orgId" in (event ?? {})).toBe(false);
    expect(event).toMatchObject({ ignoredFields: ["orgId"] });
  });

  it("drops an id field that holds an e-mail and keeps its name in ignoredFields", () => {
    const wide = startWideEvent("leaky_id");
    wide.set({ actorId: "maria@example.com" });
    wide.emit();

    const [event] = events(info);
    expect(JSON.stringify(event)).not.toContain("maria@example.com");
    expect(event).toMatchObject({ ignoredFields: ["actorId"] });
  });

  describe("withWideEvent", () => {
    it("writes the event after the work and returns its value", async () => {
      const value = await withWideEvent("job", { job: "x" }, (wide) => {
        wide.set({ processed: 2 });
        return Promise.resolve("done");
      });

      expect(value).toBe("done");
      expect(events(info)[0]).toMatchObject({
        event: "job",
        job: "x",
        outcome: "success",
        processed: 2,
      });
    });

    it("marks a throw as a failure, writes the event and rethrows", async () => {
      class Boom extends Error {
        override name = "Boom";
      }

      await expect(
        withWideEvent("job", {}, () => Promise.reject(new Boom("secret")))
      ).rejects.toThrow("secret");

      expect(events(error)).toEqual([
        expect.objectContaining({
          errorClass: "Boom",
          event: "job",
          outcome: "failure",
        }),
      ]);
    });
  });
});

describe("describeError", () => {
  it("keeps a safe class and code", () => {
    expect(
      describeError(Object.assign(new TypeError("x"), { code: "ECONNRESET" }))
    ).toEqual({ errorClass: "TypeError", errorCode: "ECONNRESET" });
    expect(
      describeError(Object.assign(new Error("x"), { code: 57_014 }))
    ).toEqual({ errorClass: "Error", errorCode: "57014" });
  });

  it("refuses a class or code that could carry user input", () => {
    const hostile = Object.assign(new Error("x"), {
      code: "maria@example.com",
      name: "Maria Souza",
    });

    expect(describeError(hostile)).toEqual({ errorClass: "UnknownError" });
    expect(describeError("text")).toEqual({ errorClass: "NonObjectError" });
    expect(describeError(null)).toEqual({ errorClass: "NonObjectError" });
  });
});
