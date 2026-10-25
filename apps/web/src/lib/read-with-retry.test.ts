import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import { isTransientReadFailure, readWithRetry } from "./read-with-retry";

const unavailable = () => new ORPCError("SERVICE_UNAVAILABLE");

function setup() {
  const waits: number[] = [];
  return {
    options: {
      random: () => 0.5,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    waits,
  };
}

describe("readWithRetry", () => {
  it("a 503 followed by a success hands back the data, and the caller never sees an error", async () => {
    const t = setup();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce("metas");

    await expect(readWithRetry(read, t.options)).resolves.toBe("metas");

    expect(read).toHaveBeenCalledTimes(2);
    expect(t.waits).toEqual([1500]); // ~1.5 s, jittered ±20% (the middle of the range here)
  });

  it("two 503 in a row reach the caller as the error, after exactly two tries", async () => {
    const t = setup();
    const second = unavailable();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(second);

    await expect(readWithRetry(read, t.options)).rejects.toBe(second);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("waits between 1.2 s and 1.8 s", async () => {
    for (const random of [0, 1]) {
      const waits: number[] = [];
      const read = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValueOnce("ok");
      // biome-ignore lint/performance/noAwaitInLoops: one range end at a time
      await readWithRetry(read, {
        random: () => random,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
      expect(waits[0]).toBe(random === 0 ? 1200 : 1800);
    }
  });

  it.each([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
  ])("a %s is the server's answer: it never tries again", async (code) => {
    const t = setup();
    const refusal = new ORPCError(code);
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(refusal);

    await expect(readWithRetry(read, t.options)).rejects.toBe(refusal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.waits).toEqual([]);
  });

  it("with no answer at all it tries once more, and only once", async () => {
    const t = setup();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new NoWorkerAnswerError("unproven"));

    await expect(readWithRetry(read, t.options)).rejects.toBeInstanceOf(
      NoWorkerAnswerError
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("isTransientReadFailure", () => {
  it("is true for no answer, whatever its form", () => {
    expect(isTransientReadFailure(new NoWorkerAnswerError("unproven"))).toBe(
      true
    );
    expect(isTransientReadFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientReadFailure(new DOMException("t", "TimeoutError"))).toBe(
      true
    );
  });

  it("is true for SERVICE_UNAVAILABLE, with the reason server_busy or without any", () => {
    expect(isTransientReadFailure(unavailable())).toBe(true);
    expect(
      isTransientReadFailure(
        new ORPCError("SERVICE_UNAVAILABLE", {
          data: { reason: "server_busy" },
        })
      )
    ).toBe(true);
  });

  it("is true for a 500 with no reason, and false for one with a reason of its own", () => {
    expect(isTransientReadFailure(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(
      true
    );
    expect(
      isTransientReadFailure(
        new ORPCError("INTERNAL_SERVER_ERROR", { data: { reason: "x" } })
      )
    ).toBe(false);
  });

  it("is true for the runtime's page that oRPC could not decode (the CPU limit)", () => {
    expect(
      isTransientReadFailure(
        new Error(
          "Cannot parse response body, please check the response body and content-type."
        )
      )
    ).toBe(true);
    expect(isTransientReadFailure(new Error("boom"))).toBe(false);
  });

  it("is false for what is not an error value", () => {
    expect(isTransientReadFailure(undefined)).toBe(false);
    expect(isTransientReadFailure("x")).toBe(false);
  });
});

const READ_PROCEDURE = /^(get|list|periodSummary|targetChanges)/;
const CALL = /readWithRetry\(\(\) =>\s*orpcClient\s*\.\s*(\w+)\s*\.\s*(\w+)/g;
const SOURCE_FILE = /\.tsx?$/;

/** The procedures `readWithRetry` wraps are reads: a write that got no answer may have been saved, and never runs twice. */
describe("where readWithRetry is used", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));

  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sources(path);
      }
      return SOURCE_FILE.test(entry.name) && !entry.name.includes(".test.")
        ? [path]
        : [];
    });
  }

  it("wraps only the procedures that read, and at least the screens of the task", () => {
    const wrapped = sources(src)
      .filter((path) => !path.endsWith("read-with-retry.ts"))
      .flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(CALL)].map(
          ([, router, procedure]) => `${router}.${procedure}`
        )
      );

    expect(wrapped.length).toBeGreaterThanOrEqual(20);
    expect(
      wrapped.filter((name) => !READ_PROCEDURE.test(name.split(".")[1] ?? ""))
    ).toEqual([]);
  });
});
