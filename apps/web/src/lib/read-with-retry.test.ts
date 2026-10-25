import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { describe, expect, it, vi } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import { isTransientReadFailure, readWithRetry } from "./read-with-retry";

const unavailable = () => new ORPCError("SERVICE_UNAVAILABLE");

function setup() {
  const waits: number[] = [];
  return {
    options: {
      isOnline: () => true,
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
        isOnline: () => true,
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

  it("does not wait nor try again when the screen no longer wants the answer", async () => {
    const t = setup();
    const failure = unavailable();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(
      readWithRetry(read, { ...t.options, isCurrent: () => false })
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.waits).toEqual([]);
  });

  it("drops the second try when the screen moved on during the wait", async () => {
    let current = true;
    const failure = unavailable();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(
      readWithRetry(read, {
        isCurrent: () => current,
        isOnline: () => true,
        random: () => 0.5,
        wait: () => {
          current = false;
          return Promise.resolve();
        },
      })
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not wait while the tab is known offline: the return to the network reads again", async () => {
    const t = setup();
    const failure = new NoWorkerAnswerError("unproven");
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(
      readWithRetry(read, { ...t.options, isOnline: () => false })
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
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

  it("is false for an error that is neither oRPC's nor a failed network call", () => {
    expect(isTransientReadFailure(new Error("boom"))).toBe(false);
  });

  it("is false for what is not an error value", () => {
    expect(isTransientReadFailure(undefined)).toBe(false);
    expect(isTransientReadFailure("x")).toBe(false);
  });
});

describe("what the real client throws for the runtime's own page", () => {
  const client = (response: () => Response) =>
    createORPCClient<{ goal: { list: () => Promise<unknown> } }>(
      new RPCLink({
        fetch: () => Promise.resolve(response()),
        url: "http://localhost/rpc",
      })
    );
  const runtimePage = (status: number) => () =>
    new Response("<html>Error 1102 Worker exceeded resource limits</html>", {
      headers: { "cf-ray": "abc-GRU", "content-type": "text/html" },
      status,
    });
  const thrownBy = (response: () => Response) =>
    client(response)
      .goal.list()
      .catch((caught: unknown) => caught);

  it.each([500, 502, 503, 504, 520, 522, 524])(
    "a %s page with no mark is a failure to try again",
    async (status) => {
      expect(isTransientReadFailure(await thrownBy(runtimePage(status)))).toBe(
        true
      );
    }
  );

  it.each([400, 404, 429])(
    "a %s page is the answer: it is not tried again",
    async (status) => {
      expect(isTransientReadFailure(await thrownBy(runtimePage(status)))).toBe(
        false
      );
    }
  );

  it("a 500 the server named with a reason is not tried again", async () => {
    const named = () =>
      new Response(
        JSON.stringify({
          json: {
            code: "INTERNAL_SERVER_ERROR",
            data: { reason: "something_named" },
            defined: false,
            message: "x",
            status: 500,
          },
          meta: [],
        }),
        { headers: { "content-type": "application/json" }, status: 500 }
      );
    expect(isTransientReadFailure(await thrownBy(named))).toBe(false);
  });
});

const READ_PROCEDURE = /^(get|list|periodSummary|setup|targetChanges)/;
const CALL =
  /readWithRetry\(\s*\(\) =>\s*orpcClient\s*\.\s*(\w+)\s*\.\s*(\w+)/g;
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
