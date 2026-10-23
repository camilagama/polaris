import { describe, expect, it, vi } from "vitest";
import {
  Connection,
  type ConnectionDependencies,
  type ConnectionMemory,
  classifyResponse,
  jittered,
  NoWorkerAnswerError,
} from "./connection";

const MARK = "0199c2d0-0000-7000-8000-000000000001";
const START = 1_000_000;

function reply(
  status: number,
  headers: Record<string, string> = {},
  body = ""
): Response {
  return new Response(body, { headers, status });
}

const marked = (status = 200, headers: Record<string, string> = {}) =>
  reply(status, { "x-request-id": MARK, ...headers });

const healthy = () =>
  reply(
    200,
    { "content-type": "application/json", "x-request-id": MARK },
    JSON.stringify({ status: "ok" })
  );

/** A call that never answers; it ends only when its signal aborts. */
function hang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

async function flush() {
  for (let i = 0; i < 40; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each turn lets the next microtask run
    await Promise.resolve();
  }
}

type Route = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response> | Response;

interface Options {
  browserOnline?: boolean;
  lock?: ConnectionDependencies["lock"];
  memory?: ConnectionMemory;
  visible?: boolean;
}

/** A connection on a fake clock and a fake network: nothing real runs. */
function setup(options: Options = {}) {
  let now = START;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const state = {
    browserOnline: options.browserOnline ?? true,
    visible: options.visible ?? true,
  };
  const marks: string[] = [];
  const healthCalls: { at: number; init: RequestInit | undefined }[] = [];
  const routes: { health: Route; rpc: Route } = {
    health: healthy,
    rpc: () => marked(),
  };
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/health") {
        healthCalls.push({ at: now, init });
        return await routes.health(input, init);
      }
      return await routes.rpc(input, init);
    }
  );
  const connection = new Connection({
    browserOnline: () => state.browserOnline,
    fetch: fetchImpl,
    isVisible: () => state.visible,
    ...(options.lock ? { lock: options.lock } : {}),
    mark: (name) => marks.push(name),
    ...(options.memory ? { memory: options.memory } : {}),
    now: () => now,
    schedule: (callback, delayMs) => {
      nextId += 1;
      const id = nextId;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
  });
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const [due] = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due) {
        break;
      }
      now = Math.max(now, due[1].at);
      timers.delete(due[0]);
      due[1].callback();
      // biome-ignore lint/performance/noAwaitInLoops: each timer runs in order, with its promises settled
      await flush();
    }
    now = target;
    await flush();
  };
  const changes = vi.fn();
  connection.subscribe(changes);
  return {
    advance,
    changes,
    connection,
    fetchImpl,
    healthCalls,
    marks,
    now: () => now,
    routes,
    state,
  };
}

function fakeEvents() {
  const target = new EventTarget();
  const page = new EventTarget();
  return {
    emit: (name: string) => target.dispatchEvent(new Event(name)),
    emitPage: (name: string) => page.dispatchEvent(new Event(name)),
    page: page as unknown as Parameters<Connection["attach"]>[1],
    target: target as unknown as Parameters<Connection["attach"]>[0],
  };
}

function fakeMemory(initial: string | null = null) {
  const store = { value: initial };
  const memory: ConnectionMemory = {
    read: () => store.value,
    remove: () => {
      store.value = null;
    },
    write: (value) => {
      store.value = value;
    },
  };
  return { memory, store };
}

describe("classifyResponse", () => {
  it("takes the mark of the Worker (a UUID X-Request-Id) as proof, whatever the status", () => {
    for (const status of [200, 401, 403, 500]) {
      expect(classifyResponse(reply(status, { "x-request-id": MARK }))).toBe(
        "worker"
      );
    }
  });

  it("calls a 5xx with cf-ray and no mark a server that failed", () => {
    expect(classifyResponse(reply(502, { "cf-ray": "abc-GRU" }))).toBe(
      "server_failed"
    );
    expect(classifyResponse(reply(500, { "cf-ray": "abc-GRU" }))).toBe(
      "server_failed"
    );
  });

  it("calls a 401 or 403 with no mark an interception", () => {
    expect(classifyResponse(reply(401))).toBe("intercepted");
    expect(classifyResponse(reply(403))).toBe("intercepted");
  });

  it("leaves the rest unproven: the HTML 200 of a portal, a redirect, a 5xx with no cf-ray", () => {
    expect(
      classifyResponse(reply(200, { "content-type": "text/html" }, "<html>"))
    ).toBe("unproven");
    expect(classifyResponse(reply(302, { location: "http://portal/" }))).toBe(
      "unproven"
    );
    expect(classifyResponse(reply(503))).toBe("unproven");
  });

  it("does not take an X-Request-Id that is not a UUID", () => {
    expect(classifyResponse(reply(200, { "x-request-id": "abc123" }))).toBe(
      "unproven"
    );
    expect(classifyResponse(reply(200, { "x-request-id": `${MARK}x` }))).toBe(
      "unproven"
    );
    expect(classifyResponse(reply(403, { "x-request-id": "" }))).toBe(
      "intercepted"
    );
  });
});

describe("the fetch of the RPC client", () => {
  it("a marked response proves the connection: offline goes to online", async () => {
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    expect(t.connection.isOnline()).toBe(false);

    const response = await t.connection.fetch("/rpc/x");

    expect(response.status).toBe(200);
    expect(t.connection.isOnline()).toBe(true);
    expect(t.changes).toHaveBeenCalledTimes(1);
    // the scheduled probe is gone: nothing was in doubt any more
    await t.advance(60_000);
    expect(t.healthCalls).toHaveLength(0);
  });

  it("an HTML 200 with no mark is thrown as no answer and starts exactly one probe", async () => {
    const t = setup();
    t.routes.rpc = () => reply(200, { "content-type": "text/html" }, "<html>");

    const call = t.connection.fetch("/rpc/x");
    await expect(call).rejects.toBeInstanceOf(NoWorkerAnswerError);
    await expect(call).rejects.toThrow("no_worker_answer_unproven");
    await flush();

    expect(t.healthCalls).toHaveLength(1);
    expect(t.connection.isOnline()).toBe(true); // the probe found the Worker fine
  });

  it("two bad answers while the probe is on its way still make one probe", async () => {
    const t = setup();
    t.routes.rpc = () => reply(200, {}, "<html>");
    t.routes.health = () => hang();

    await Promise.allSettled([
      t.connection.fetch("/rpc/a"),
      t.connection.fetch("/rpc/b"),
    ]);

    expect(t.healthCalls).toHaveLength(1);
  });

  it("a 401 or 403 with no mark is no answer, never a refusal", async () => {
    for (const status of [401, 403]) {
      const t = setup();
      t.routes.rpc = () => reply(status);
      // biome-ignore lint/performance/noAwaitInLoops: each status has its own connection
      await expect(t.connection.fetch("/rpc/x")).rejects.toThrow(
        "no_worker_answer_intercepted"
      );
    }
  });

  it("a 5xx with cf-ray and no mark is handed back and the connection stays online", async () => {
    const t = setup();
    t.routes.rpc = () => reply(502, { "cf-ray": "abc-GRU" });

    const response = await t.connection.fetch("/rpc/x");
    await flush();

    expect(response.status).toBe(502);
    expect(t.connection.isOnline()).toBe(true);
    expect(t.healthCalls).toHaveLength(0);
  });

  it("an isolated network error with /health fine does not change the state", async () => {
    const t = setup();
    t.routes.rpc = () => Promise.reject(new TypeError("Failed to fetch"));

    await expect(t.connection.fetch("/rpc/x")).rejects.toBeInstanceOf(
      TypeError
    );
    await flush();

    expect(t.healthCalls).toHaveLength(1);
    expect(t.connection.isOnline()).toBe(true);
    expect(t.changes).not.toHaveBeenCalled();
  });

  it("a network error is not offline by itself: only the probe failing takes it there", async () => {
    const t = setup();
    t.routes.rpc = () => Promise.reject(new TypeError("Failed to fetch"));
    let failProbe: () => void = () => undefined;
    t.routes.health = () =>
      new Promise<Response>((_resolve, reject) => {
        failProbe = () => reject(new TypeError("Failed to fetch"));
      });

    await expect(t.connection.fetch("/rpc/x")).rejects.toBeInstanceOf(
      TypeError
    );
    await flush();
    expect(t.healthCalls).toHaveLength(1);
    expect(t.connection.isOnline()).toBe(true); // still waiting for the probe

    failProbe();
    await flush();
    expect(t.connection.isOnline()).toBe(false);
  });

  it("a call hanging for 4 s starts a probe, and the call goes on", async () => {
    const t = setup();
    let answer: (response: Response) => void = () => undefined;
    t.routes.rpc = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });

    const call = t.connection.fetch("/rpc/x");
    await t.advance(3999);
    expect(t.healthCalls).toHaveLength(0);
    await t.advance(1);
    expect(t.healthCalls).toHaveLength(1);

    answer(marked());
    expect((await call).status).toBe(200);
  });

  it("a call its caller gave up on says nothing about the network: no probe; a timeout abort does", async () => {
    const { advance, connection, healthCalls, routes } = setup();
    routes.rpc = (_input, init) => hang(init?.signal);
    const left = new AbortController();
    const call = connection.fetch("/rpc/a", { signal: left.signal });
    left.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    await advance(0);
    expect(healthCalls).toHaveLength(0);

    const timedOut = new AbortController();
    const slow = connection.fetch("/rpc/b", { signal: timedOut.signal });
    timedOut.abort(new DOMException("late", "TimeoutError"));
    await expect(slow).rejects.toMatchObject({ name: "TimeoutError" });
    await advance(0);
    expect(healthCalls).toHaveLength(1);
  });

  it("an answered call cancels its slow-call timer", async () => {
    const t = setup();
    await t.connection.fetch("/rpc/x");
    await t.advance(10_000);
    expect(t.healthCalls).toHaveLength(0);
  });

  it("hands the Retry-After of a marked 429 over once, in ms", async () => {
    const t = setup();
    t.routes.rpc = () => marked(429, { "retry-after": "7" });

    const response = await t.connection.fetch("/rpc/x");

    expect(response.status).toBe(429);
    expect(t.connection.takeRetryAfterMs()).toBe(7000);
    expect(t.connection.takeRetryAfterMs()).toBeNull();
  });

  it("ignores a Retry-After that is not a positive number", async () => {
    const t = setup();
    t.routes.rpc = () => marked(429, { "retry-after": "soon" });
    await t.connection.fetch("/rpc/x");
    expect(t.connection.takeRetryAfterMs()).toBeNull();
  });
});

describe("with no network in the browser", () => {
  it("no answer takes it online while navigator.onLine is false; the online event then probes and goes online", async () => {
    const { advance, connection, healthCalls, state } = setup({
      browserOnline: false,
    });
    const events = fakeEvents();
    connection.attach(events.target, events.page);
    await connection.fetch("/rpc/x");
    await advance(0);
    expect(connection.isOnline()).toBe(false);
    state.browserOnline = true;
    const before = healthCalls.length;
    events.emit("online");
    await advance(0);
    expect(healthCalls.length).toBe(before + 1);
    expect(connection.isOnline()).toBe(true);
  });
});

describe("the probe", () => {
  it("is online only for 200, JSON, {status:ok} and the mark, and asks /health as agreed", async () => {
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.routes.health = healthy;

    expect(await t.connection.probeNow()).toBe("online");

    expect(t.fetchImpl).toHaveBeenCalledWith(
      "/health",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
  });

  const bad: [string, () => Response][] = [
    ["a status other than 200", () => reply(503, { "x-request-id": MARK })],
    [
      "no mark",
      () =>
        reply(
          200,
          { "content-type": "application/json" },
          JSON.stringify({ status: "ok" })
        ),
    ],
    [
      "a mark that is not a UUID",
      () =>
        reply(
          200,
          { "content-type": "application/json", "x-request-id": "nope" },
          JSON.stringify({ status: "ok" })
        ),
    ],
    [
      "a content type that is not JSON",
      () =>
        reply(
          200,
          { "content-type": "text/html", "x-request-id": MARK },
          JSON.stringify({ status: "ok" })
        ),
    ],
    [
      "a body that is not {status:ok}",
      () =>
        reply(
          200,
          { "content-type": "application/json", "x-request-id": MARK },
          JSON.stringify({ status: "degraded" })
        ),
    ],
    [
      "a body that is not JSON",
      () =>
        reply(
          200,
          { "content-type": "application/json", "x-request-id": MARK },
          "<html>"
        ),
    ],
  ];

  for (const [name, response] of bad) {
    it(`is offline with ${name}`, async () => {
      const t = setup();
      t.routes.health = response;

      expect(await t.connection.probeNow()).toBe("offline");
    });
  }

  it("is offline when /health cannot be fetched", async () => {
    const t = setup();
    t.routes.health = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await t.connection.probeNow()).toBe("offline");
  });

  it("does not take one timeout for offline, and two in a row do", async () => {
    const t = setup();
    t.routes.health = (_input, init) => hang(init?.signal);

    const first = t.connection.probeNow();
    await t.advance(4000);
    expect(await first).toBe("online");
    expect(t.healthCalls).toHaveLength(1);

    // the second look comes 2 s later, and times out too
    await t.advance(2000);
    expect(t.healthCalls).toHaveLength(2);
    expect(t.connection.isOnline()).toBe(true);
    await t.advance(4000);
    expect(t.connection.isOnline()).toBe(false);
  });

  it("a probe that answers between two timeouts starts the count again", async () => {
    const t = setup();
    t.routes.health = (_input, init) => hang(init?.signal);
    const first = t.connection.probeNow();
    await t.advance(4000);
    await first;

    t.routes.health = healthy;
    await t.advance(2000); // the second look finds the Worker
    expect(t.connection.isOnline()).toBe(true);

    t.routes.health = (_input, init) => hang(init?.signal);
    const third = t.connection.probeNow();
    await t.advance(4000);
    await third;
    expect(t.connection.isOnline()).toBe(true); // one timeout again, not two
  });

  it("a timeout while already offline stays offline", async () => {
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.routes.health = (_input, init) => hang(init?.signal);
    const result = t.connection.probeNow();
    await t.advance(4000);
    expect(await result).toBe("offline");
  });
});

describe("when it looks while offline", () => {
  it("looks at 2, 4, 8, 8, 8... s, and at most 9 times in the first minute", async () => {
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.routes.health = () => reply(503);

    await t.advance(60_000);

    const times = t.healthCalls.map((call) => call.at - START);
    expect(times.slice(0, 6)).toEqual([
      2000, 6000, 14_000, 22_000, 30_000, 38_000,
    ]);
    expect(times.length).toBeLessThanOrEqual(9);
    expect(times.length).toBe(8);
  });

  it("slows to every 60 s after 10 minutes offline", async () => {
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.routes.health = () => reply(503);

    await t.advance(10 * 60_000 + 30_000);
    const before = t.healthCalls.length;
    await t.advance(5 * 60_000);

    const later = t.healthCalls.slice(before).map((call) => call.at);
    expect(later.length).toBeGreaterThanOrEqual(4);
    const gaps = later.slice(1).map((at, index) => at - (later[index] ?? 0));
    expect(gaps).toEqual(gaps.map(() => 60_000));
  });

  it("never looks while online with nothing in doubt", async () => {
    const t = setup();
    await t.advance(10 * 60_000);
    expect(t.healthCalls).toHaveLength(0);
  });

  it("starts the steps again at 2 s each time it goes offline", async () => {
    const t = setup();
    t.routes.health = () => reply(503);
    await t.connection.probeNow(); // offline now; next look in 2 s
    await t.advance(2000);
    expect(t.healthCalls).toHaveLength(2);

    t.routes.health = healthy;
    await t.advance(4000);
    expect(t.connection.isOnline()).toBe(true);

    t.routes.health = () => reply(503);
    const at = t.healthCalls.length;
    await t.connection.probeNow();
    await t.advance(2000);
    expect(t.healthCalls.length).toBe(at + 2);
  });

  it("does not look with the page hidden, and looks at once when it comes back", async () => {
    const events = fakeEvents();
    const t = setup({ browserOnline: false, visible: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.connection.attach(events.target, events.page);
    t.routes.health = () => reply(503);

    await t.advance(10 * 60_000);
    expect(t.healthCalls).toHaveLength(0);

    t.state.visible = true;
    events.emitPage("visibilitychange");
    await t.advance(0);
    expect(t.healthCalls).toHaveLength(1);
  });

  it("stops a look that was waiting when the page is hidden", async () => {
    const events = fakeEvents();
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    t.connection.attach(events.target, events.page);

    await t.advance(1000);
    t.state.visible = false;
    events.emitPage("visibilitychange");
    await t.advance(60_000);

    expect(t.healthCalls).toHaveLength(0);
  });
});

describe("the signals of the browser", () => {
  it("'offline' makes it offline at once, with no probe", () => {
    const events = fakeEvents();
    const t = setup();
    t.connection.attach(events.target, events.page);

    events.emit("offline");

    expect(t.connection.isOnline()).toBe(false);
    expect(t.healthCalls).toHaveLength(0);
    expect(t.changes).toHaveBeenCalledTimes(1);
  });

  for (const name of ["online", "pageshow"]) {
    it(`'${name}' while offline probes at once`, async () => {
      const events = fakeEvents();
      const t = setup({ browserOnline: false });
      t.state.browserOnline = true; // started offline; the network is there now
      t.connection.attach(events.target, events.page);

      events.emit(name);
      await t.advance(0);

      expect(t.healthCalls).toHaveLength(1);
      expect(t.healthCalls[0]?.at).toBe(START);
      expect(t.connection.isOnline()).toBe(true);
    });

    it(`'${name}' while online does nothing`, async () => {
      const events = fakeEvents();
      const t = setup();
      t.connection.attach(events.target, events.page);

      events.emit(name);
      await t.advance(60_000);

      expect(t.healthCalls).toHaveLength(0);
    });
  }

  it("stops listening and looking once detached", async () => {
    const events = fakeEvents();
    const t = setup({ browserOnline: false });
    t.state.browserOnline = true; // started offline; the network is there now
    const detach = t.connection.attach(events.target, events.page);

    detach();
    events.emit("online");
    await t.advance(60_000);

    expect(t.healthCalls).toHaveLength(0);
  });
});

describe("what a reloaded page remembers", () => {
  const remembered = (since: number, seen: number) =>
    JSON.stringify({ seen, since });

  it("opens offline and probes at once when offline was seen 30 s ago", async () => {
    const { memory } = fakeMemory(remembered(START - 120_000, START - 30_000));
    const t = setup({ memory });

    expect(t.connection.isOnline()).toBe(false);
    expect(t.connection.getSnapshot().since).toBe(START - 120_000);
    await t.advance(0);
    expect(t.healthCalls).toHaveLength(1);
    expect(t.healthCalls[0]?.at).toBe(START);
    expect(t.connection.isOnline()).toBe(true); // the probe found the Worker
  });

  it("opens online when offline was seen 90 s ago, and forgets it", async () => {
    const { memory, store } = fakeMemory(
      remembered(START - 300_000, START - 90_000)
    );
    const t = setup({ memory });

    expect(t.connection.isOnline()).toBe(true);
    await t.advance(60_000);
    expect(t.healthCalls).toHaveLength(0);
    expect(store.value).toBeNull();
  });

  it("opens online with nothing remembered, or with garbage in the memory", () => {
    expect(setup({ memory: fakeMemory().memory }).connection.isOnline()).toBe(
      true
    );
    expect(
      setup({ memory: fakeMemory("{nope").memory }).connection.isOnline()
    ).toBe(true);
    expect(
      setup({
        memory: fakeMemory('{"since":"a"}').memory,
      }).connection.isOnline()
    ).toBe(true);
  });

  it("opens offline when the browser says there is no network, and remembers it", () => {
    const { memory, store } = fakeMemory();
    const t = setup({ browserOnline: false, memory });
    t.state.browserOnline = true; // started offline; the network is there now

    expect(t.connection.isOnline()).toBe(false);
    expect(JSON.parse(store.value ?? "null")).toEqual({
      seen: START,
      since: START,
    });
  });

  it("forgets the memory when the Worker answers", async () => {
    const { memory, store } = fakeMemory();
    const t = setup({ browserOnline: false, memory });
    t.state.browserOnline = true; // started offline; the network is there now
    expect(store.value).not.toBeNull();

    await t.connection.fetch("/rpc/x");

    expect(store.value).toBeNull();
  });
});

describe("the lock between tabs", () => {
  it("sends no probe when another tab holds the lock, and looks again later", async () => {
    const lock = vi.fn(async () => false);
    const t = setup({ browserOnline: false, lock });
    t.state.browserOnline = true; // started offline; the network is there now

    await t.advance(2000);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(
      "polaris-connection-probe",
      expect.any(Function)
    );
    expect(t.healthCalls).toHaveLength(0);

    await t.advance(4000); // the next step
    expect(lock).toHaveBeenCalledTimes(2);
    expect(t.healthCalls).toHaveLength(0);
    expect(t.connection.isOnline()).toBe(false);
  });

  it("probes when the lock is free", async () => {
    const lock = vi.fn(async (_name: string, task: () => Promise<void>) => {
      await task();
      return true;
    });
    const t = setup({ browserOnline: false, lock });
    t.state.browserOnline = true; // started offline; the network is there now

    await t.advance(2000);

    expect(t.healthCalls).toHaveLength(1);
    expect(t.connection.isOnline()).toBe(true);
  });
});

describe("jittered", () => {
  it("stays between 80% and 120% of the delay", () => {
    expect(jittered(1000, () => 0)).toBe(800);
    expect(jittered(1000, () => 1)).toBe(1200);
    expect(jittered(1000, () => 0.5)).toBe(1000);
    for (let i = 0; i <= 100; i += 1) {
      const value = jittered(10_000, () => i / 100);
      expect(value).toBeGreaterThanOrEqual(8000);
      expect(value).toBeLessThanOrEqual(12_000);
    }
  });
});

describe("timeline marks", () => {
  it("marks each probe and each change of state", async () => {
    const t = setup();
    t.routes.health = () => reply(503);
    await t.connection.probeNow();
    expect(t.marks).toEqual([
      "connection:probe:start",
      "connection:probe:fail",
      "connection:state:offline",
    ]);

    t.marks.length = 0;
    t.routes.health = healthy;
    await t.connection.probeNow();
    expect(t.marks).toEqual([
      "connection:probe:start",
      "connection:probe:ok",
      "connection:state:online",
    ]);
  });

  it("marks a probe that stays on the same state without a state mark", async () => {
    const t = setup();
    await t.connection.probeNow();
    expect(t.marks).toEqual(["connection:probe:start", "connection:probe:ok"]);
  });
});
