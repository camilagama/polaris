import { polarisContract } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connection";
import { callKind, createReadGate, READ_PROCEDURES } from "./read-gate";

const MARK = "0199c2d0-0000-7000-8000-000000000001";

async function flush() {
  for (let i = 0; i < 40; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the next microtask run
    await Promise.resolve();
  }
}

/** A fake clock with timers that run only when the test moves it. */
function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const [due] = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, a], [, b]) => a.at - b.at);
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // biome-ignore lint/performance/noAwaitInLoops: each timer lets the promises it settles run
        await flush();
      }
      now = until;
      await flush();
    },
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      nextId += 1;
      const id = nextId;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
}

/**
 * A connection over a fake network where every call waits until the test answers it: what is in flight, in what
 * order the calls left, and how to answer each.
 */
function network() {
  const time = clock();
  const pending: {
    path: string;
    reply: (response: Response) => void;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const sent: string[] = [];
  const connection = createConnection({
    browserOnline: () => true,
    fetch: (input, init) => {
      const path =
        typeof input === "string"
          ? input
          : new URL(input instanceof URL ? input.href : input.url).pathname;
      if (path !== "/health") {
        sent.push(path); // the probe of a call in doubt (4 s) is the connection's, not the gate's
      }
      return new Promise<Response>((resolve, reject) => {
        const entry = { path, reply: resolve, signal: init?.signal };
        pending.push(entry);
        init?.signal?.addEventListener("abort", () => {
          pending.splice(pending.indexOf(entry), 1);
          reject(init.signal?.reason);
        });
      });
    },
    isVisible: () => true,
    now: time.now,
    schedule: time.schedule,
  });
  const answer = async (
    path: string,
    response: Response = new Response("{}", {
      headers: { "x-request-id": MARK },
    })
  ) => {
    await flush();
    const index = pending.findIndex((open) => open.path === path);
    const [entry] = pending.splice(index, 1);
    entry?.reply(response);
    await flush();
  };
  const call = (path: string, signal?: AbortSignal) => {
    const result = connection.fetch(path, signal ? { signal } : {});
    result.catch(() => undefined);
    return result;
  };
  return { answer, call, connection, pending, sent, time };
}

describe("what a call is", () => {
  it("the reads of the closed list, the session lookup, and the rest (writes)", () => {
    expect(callKind("/rpc/report/periodSummary")).toBe("read");
    expect(callKind(new Request("http://x/rpc/sync/pull"))).toBe("read");
    expect(callKind("/api/auth/get-session")).toBe("session");
    expect(callKind("/rpc/sync/push")).toBe("other");
    expect(callKind("/rpc/sale/confirm")).toBe("other");
    expect(callKind("/health")).toBe("other");
  });

  it("every read of the list is a procedure of the contract", () => {
    const contract = polarisContract as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const missing = [...READ_PROCEDURES].filter((path) => {
      const [router, procedure] = path.split("/");
      return contract[router ?? ""]?.[procedure ?? ""] === undefined;
    });
    expect(missing).toEqual([]);
  });

  it("no write of the outbox or of a screen is in the list", () => {
    for (const write of [
      "sync/push",
      "sale/confirm",
      "sale/cancel",
      "goal/create",
      "device/register",
      "offline/issueLease",
    ]) {
      expect(READ_PROCEDURES.has(write), write).toBe(false);
    }
  });
});

describe("at most 4 reads in flight", () => {
  it("the fifth waits for a slot, in arrival order", async () => {
    const t = network();
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      t.call(`/rpc/report/periodSummary?${name}`);
    }
    await flush();
    expect(t.pending).toHaveLength(4);

    t.pending[1]?.reply(
      new Response("{}", { headers: { "x-request-id": MARK } })
    );
    t.pending.splice(1, 1);
    await flush();
    expect(t.pending).toHaveLength(4);
    expect(t.sent.at(-1)).toBe("/rpc/report/periodSummary?e");
  });

  it("writes are never held: the push goes out with 4 reads in flight", async () => {
    const t = network();
    for (let i = 0; i < 4; i += 1) {
      t.call("/rpc/sale/list");
    }
    t.call("/rpc/sync/push");
    await flush();
    expect(t.pending.map((entry) => entry.path)).toContain("/rpc/sync/push");
    expect(t.pending).toHaveLength(5);
  });

  it("a read given up while it waits leaves the line, and is never sent", async () => {
    const t = network();
    for (let i = 0; i < 4; i += 1) {
      t.call("/rpc/sale/list");
    }
    const controller = new AbortController();
    const left = t.call("/rpc/goal/list", controller.signal);
    controller.abort(new DOMException("left", "AbortError"));
    await expect(left).rejects.toMatchObject({ name: "AbortError" });

    await t.answer("/rpc/sale/list");
    expect(t.sent).not.toContain("/rpc/goal/list");
  });

  it("a read cancelled in flight frees its slot at once", async () => {
    const t = network();
    const controller = new AbortController();
    t.call("/rpc/goal/list", controller.signal);
    for (let i = 0; i < 4; i += 1) {
      t.call("/rpc/sale/list");
    }
    await flush();
    expect(t.sent.filter((path) => path === "/rpc/sale/list")).toHaveLength(3);

    controller.abort(new DOMException("left", "AbortError"));
    await flush();
    expect(t.sent.filter((path) => path === "/rpc/sale/list")).toHaveLength(4);
  });
});

describe("a hung read", () => {
  it("holds its slot 15 s at most: the line moves on while the call itself goes on", async () => {
    const t = network();
    for (let i = 0; i < 4; i += 1) {
      t.call("/rpc/sale/list");
    }
    t.call("/rpc/goal/list");
    await t.time.advance(14_999);
    expect(t.sent).not.toContain("/rpc/goal/list");
    await t.time.advance(1);
    expect(t.sent).toContain("/rpc/goal/list");
    // the four hung calls were never cancelled
    expect(
      t.pending.filter((entry) => entry.path === "/rpc/sale/list")
    ).toHaveLength(4);
  });
});

describe("the session first", () => {
  it("the reads asked while the first get-session is on its way leave only after it", async () => {
    const t = network();
    t.call("/api/auth/get-session");
    t.call("/rpc/report/periodSummary");
    t.call("/rpc/goal/list");
    await flush();
    expect(t.sent).toEqual(["/api/auth/get-session"]);

    await t.answer("/api/auth/get-session");
    expect(t.sent).toEqual([
      "/api/auth/get-session",
      "/rpc/report/periodSummary",
      "/rpc/goal/list",
    ]);
  });

  it("a lookup outside the connection's fetch (the shell's e-mail) holds them too, and its answer is not classified", async () => {
    const t = network();
    let answer: (response: Response) => void = () => undefined;
    const lookup = t.connection.sessionFirst(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    t.call("/rpc/report/periodSummary");
    await flush();
    expect(t.sent).toEqual([]);

    // a portal's page: no mark, and still no doubt about the connection
    answer(new Response("<html></html>", { status: 200 }));
    await expect(lookup).resolves.toBeInstanceOf(Response);
    await flush();
    expect(t.sent).toEqual(["/rpc/report/periodSummary"]);
    expect(t.connection.isOnline()).toBe(true);
  });

  it("a session lookup that hangs holds the reads 5 s at most", async () => {
    const t = network();
    t.call("/api/auth/get-session");
    t.call("/rpc/report/periodSummary");
    await t.time.advance(4999);
    expect(t.sent).toEqual(["/api/auth/get-session"]);
    await t.time.advance(1);
    expect(t.sent).toContain("/rpc/report/periodSummary");
  });

  it("only the first lookup of the tab holds them: the sync's later ones do not", async () => {
    const t = network();
    t.call("/api/auth/get-session");
    await t.answer("/api/auth/get-session");
    t.call("/api/auth/get-session");
    t.call("/rpc/sale/list");
    await flush();
    expect(t.sent).toContain("/rpc/sale/list");
  });
});

describe("a 429 pauses the reads of the tab until its Retry-After", () => {
  const limited = () =>
    new Response("{}", {
      headers: { "retry-after": "30", "x-request-id": MARK },
      status: 429,
    });

  it("no read and no pull leaves before it ends; a write still does", async () => {
    const t = network();
    t.call("/rpc/report/periodSummary");
    await flush();
    await t.answer("/rpc/report/periodSummary", limited());

    t.call("/rpc/goal/list");
    t.call("/rpc/sync/pull");
    t.call("/rpc/sync/push");
    await t.time.advance(29_999);
    expect(t.sent).toEqual(["/rpc/report/periodSummary", "/rpc/sync/push"]);

    await t.time.advance(1);
    expect(t.sent).toEqual([
      "/rpc/report/periodSummary",
      "/rpc/sync/push",
      "/rpc/goal/list",
      "/rpc/sync/pull",
    ]);
  });

  it("a Retry-After of minutes pauses 60 s at most", async () => {
    const t = network();
    t.call("/rpc/report/periodSummary");
    await t.answer(
      "/rpc/report/periodSummary",
      new Response("{}", {
        headers: { "retry-after": "300", "x-request-id": MARK },
        status: 429,
      })
    );
    t.call("/rpc/sync/pull");
    await t.time.advance(59_999);
    expect(t.sent).not.toContain("/rpc/sync/pull");
    await t.time.advance(1);
    expect(t.sent).toContain("/rpc/sync/pull");
  });

  it("without a Retry-After nothing is paused", async () => {
    const t = network();
    t.call("/rpc/report/periodSummary");
    await flush();
    await t.answer(
      "/rpc/report/periodSummary",
      new Response("{}", { headers: { "x-request-id": MARK }, status: 429 })
    );
    t.call("/rpc/goal/list");
    await flush();
    expect(t.sent).toContain("/rpc/goal/list");
  });
});

describe("the brakes on retries", () => {
  it("8 retries in any 10 s; the ninth fails at once, and the window moves on", () => {
    const time = clock();
    const gate = createReadGate(time);
    const allowed = Array.from({ length: 9 }, () => gate.mayRetry());
    expect(allowed).toEqual([...new Array(8).fill(true), false]);
    // biome-ignore lint/complexity/noVoid: the clock only moves
    void time.advance(10_000);
    expect(gate.mayRetry()).toBe(true);
  });

  it("more than half of the last 20 calls died on the platform: no retry for 15 s", async () => {
    const time = clock();
    const gate = createReadGate(time);
    for (let i = 0; i < 9; i += 1) {
      gate.record(false);
    }
    for (let i = 0; i < 10; i += 1) {
      gate.record(true);
    }
    expect(gate.mayRetry()).toBe(true); // 10 of 19: not more than half of 20
    gate.record(true); // 11 of 20
    expect(gate.mayRetry()).toBe(false);
    await time.advance(14_999);
    expect(gate.mayRetry()).toBe(false);
    await time.advance(1);
    expect(gate.mayRetry()).toBe(true);
  });

  it("the connection counts the platform's deaths of the RPC (cf-ray, no mark)", async () => {
    const t = network();
    for (let i = 0; i < 11; i += 1) {
      t.call("/rpc/sale/list");
      // biome-ignore lint/performance/noAwaitInLoops: one call at a time
      await t.answer(
        "/rpc/sale/list",
        new Response("<html>1102</html>", {
          headers: { "cf-ray": "abc-GRU" },
          status: 503,
        })
      );
    }
    expect(t.connection.mayRetryRead()).toBe(false);
    expect(t.connection.isOnline()).toBe(true);
  });
});
