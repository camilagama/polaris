import { describe, expect, it, vi } from "vitest";
import {
  createSessionLookup,
  forgetSessionLookups,
  SESSION_MEMORY_MS,
  type SessionLookup,
} from "./session-lookup";

function setup(
  answer: () => Response | Promise<Response> = () =>
    Response.json({ user: { email: "a@b.c", id: "user-1" } })
) {
  let clock = 1_000_000;
  const load = vi.fn(async (_input: string, _init?: RequestInit) => answer());
  const lookup: SessionLookup = createSessionLookup({
    fetch: load,
    now: () => clock,
  });
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    load,
    lookup,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

/** A server that answers each lookup only when the test says so, in the order they were asked. */
function withGate() {
  const answers: ((response: Response) => void)[] = [];
  const t = setup(
    () =>
      new Promise<Response>((resolve) => {
        answers.push(resolve);
      })
  );
  return { answers, t };
}

describe("the session lookup of a tab", () => {
  it("asks the server once for the shell, the runtime and the Assinatura that follow", async () => {
    const t = setup();
    const [shell, runtime] = await Promise.all([
      t.lookup.read(),
      t.lookup.read(),
    ]);
    const assinatura = await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(1);
    expect(t.load.mock.calls[0]?.[0]).toBe("/api/auth/get-session");
    expect(shell).toEqual({
      body: { user: { email: "a@b.c", id: "user-1" } },
      status: 200,
    });
    expect(runtime).toBe(shell);
    expect(assinatura).toBe(shell);
  });

  it("remembers the answer for 10 s and goes to the server at 10 s + 1 ms", async () => {
    expect(SESSION_MEMORY_MS).toBe(10_000);
    const t = setup();
    await t.lookup.read();
    t.advance(10_000);
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("counts the 10 s from the start of the lookup, not from its end", async () => {
    const gate = withGate();
    const first = gate.t.lookup.read();
    gate.t.advance(6000);
    gate.answers[0]?.(Response.json({ user: { id: "user-1" } }));
    await first;
    gate.t.advance(4001);
    gate.t.lookup.read();
    expect(gate.t.load).toHaveBeenCalledTimes(2);
  });

  it("a fresh read always goes to the server and becomes the one remembered", async () => {
    const t = setup();
    await t.lookup.read();
    await t.lookup.read({ fresh: true });
    expect(t.load).toHaveBeenCalledTimes(2);
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("joinInFlight without a lookup going opens a new one", async () => {
    const t = setup();
    await t.lookup.read({ joinInFlight: true });
    expect(t.load).toHaveBeenCalledTimes(1);
  });

  it("joinInFlight does not use a valid memory when no lookup is going", async () => {
    const t = setup();
    await t.lookup.read();
    t.advance(1000);
    await t.lookup.read({ joinInFlight: true });
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("joinInFlight joins a lookup that is still going", async () => {
    const gate = withGate();
    const first = gate.t.lookup.read();
    const joined = gate.t.lookup.read({ joinInFlight: true });
    expect(gate.t.load).toHaveBeenCalledTimes(1);
    gate.answers[0]?.(Response.json({ user: { id: "user-1" } }));
    expect(await joined).toBe(await first);
  });

  it("a fresh read opens its own lookup even with one going", async () => {
    const gate = withGate();
    const going = gate.t.lookup.read();
    const own = gate.t.lookup.read({ fresh: true });
    expect(gate.t.load).toHaveBeenCalledTimes(2);
    gate.answers[0]?.(Response.json({ user: { id: "old" } }));
    gate.answers[1]?.(Response.json({ user: { id: "new" } }));
    expect(await going).not.toBe(await own);
  });

  it("does not remember a failure, a refusal, the 'no session' answer or a body it cannot read", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response("{}", { status: 401 }),
      () => new Response("busy", { status: 503 }),
      () => Response.json(null),
      () => new Response("<html>", { status: 200 }),
    ];
    for (const answer of answers) {
      const t = setup(answer);
      // biome-ignore lint/performance/noAwaitInLoops: each answer is its own lookup
      await t.lookup.read().catch(() => undefined);
      await t.lookup.read().catch(() => undefined);
      expect(t.load).toHaveBeenCalledTimes(2);
    }
  });

  it("gives the status of a refusal and nothing for a body it could not read", async () => {
    expect(
      await setup(() => new Response("{}", { status: 401 })).lookup.read()
    ).toEqual({ body: undefined, status: 401 });
    expect(
      await setup(() => new Response("<html>", { status: 200 })).lookup.read()
    ).toEqual({ body: undefined, status: 200 });
  });

  it("forget drops the answer and does not let a lookup begun before it be remembered", async () => {
    const gate = withGate();
    const before = gate.t.lookup.read();
    gate.t.lookup.forget();
    gate.answers[0]?.(Response.json({ user: { id: "old" } }));
    await before;
    gate.t.lookup.read();
    expect(gate.t.load).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["401", () => new Response("{}", { status: 401 })],
    ["403", () => new Response("{}", { status: 403 })],
    ["the 'no session' answer", () => Response.json(null)],
  ])(
    "a fresh read that proves there is no session (%s) drops the remembered one",
    async (_name, ended) => {
      let answer: () => Response = () =>
        Response.json({ user: { id: "user-1" } });
      const t = setup(() => answer());
      await t.lookup.read();
      answer = ended;
      await t.lookup.read({ fresh: true });
      expect(t.load).toHaveBeenCalledTimes(2);
      await t.lookup.read();
      expect(t.load).toHaveBeenCalledTimes(3);
    }
  );

  it("a fresh read that fails (no answer) keeps what was remembered", async () => {
    const state: { fail: boolean } = { fail: false };
    const t = setup(() =>
      state.fail
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Response.json({ user: { id: "user-1" } })
    );
    await t.lookup.read();
    state.fail = true;
    await t.lookup.read({ fresh: true }).catch(() => undefined);
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("keeps only the user and the session id of the body, never the session token", async () => {
    const t = setup(() =>
      Response.json({
        session: { id: "session-1", token: "secret" },
        user: { email: "a@b.c", id: "user-1", name: "A", role: "x" },
      })
    );
    expect(await t.lookup.read()).toEqual({
      body: {
        session: { id: "session-1" },
        user: { email: "a@b.c", id: "user-1", name: "A" },
      },
      status: 200,
    });
  });

  it("keeps no session when the body carries no id", async () => {
    const t = setup(() =>
      Response.json({
        session: { token: "secret" },
        user: { email: "a@b.c", id: "user-1", name: "A" },
      })
    );
    expect(await t.lookup.read()).toEqual({
      body: { user: { email: "a@b.c", id: "user-1", name: "A" } },
      status: 200,
    });
  });

  it("forgetSessionLookups drops what every lookup of the tab remembered", async () => {
    const t = setup();
    await t.lookup.read();
    forgetSessionLookups();
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("a clock that went back counts as nothing remembered", async () => {
    const t = setup();
    await t.lookup.read();
    t.setClock(0);
    await t.lookup.read();
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("an older lookup that ends late does not overwrite a newer one", async () => {
    const gate = withGate();
    const slow = gate.t.lookup.read();
    const quick = gate.t.lookup.read({ fresh: true });
    gate.answers[1]?.(Response.json({ user: { id: "new" } }));
    await quick;
    gate.answers[0]?.(Response.json({ user: { id: "old" } }));
    await slow;
    expect(await gate.t.lookup.read()).toMatchObject({
      body: { user: { id: "new" } },
    });
    expect(gate.t.load).toHaveBeenCalledTimes(2);
  });

  it("shares the lookup in flight with whoever asks next, even a failing one", async () => {
    const t = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    const results = await Promise.allSettled([
      t.lookup.read(),
      t.lookup.read(),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(t.load).toHaveBeenCalledTimes(1);
  });
});
