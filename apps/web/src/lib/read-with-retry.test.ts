import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { traverseContractProcedures } from "@orpc/server";
import type { ProcedureMeta } from "@polaris/contracts";
import { polarisContract } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import { NoWorkerAnswerError } from "./connection";
import { readWithRetry } from "./read-with-retry";
import { isTransientReadFailure } from "./rpc-error";

const unavailable = () => new ORPCError("SERVICE_UNAVAILABLE");

function setup() {
  const waits: number[] = [];
  const retries = { allowed: Number.POSITIVE_INFINITY, asked: 0 };
  return {
    options: {
      isOnline: () => true,
      mayRetry: () => {
        retries.asked += 1;
        return retries.asked <= retries.allowed;
      },
      random: () => 0.5,
      wait: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    retries,
    waits,
  };
}

/** A read that fails with each error given, in order, and then answers "ok". */
function failing(...errors: unknown[]) {
  const read = vi.fn<(signal: AbortSignal) => Promise<string>>();
  for (const error of errors) {
    read.mockRejectedValueOnce(error);
  }
  return read.mockResolvedValue("ok");
}

/** The page the platform answers for a Worker it killed for CPU (1102): HTML, `cf-ray`, no mark of the Worker. */
const platformPage = (status = 503) =>
  new Response("<html>Error 1102 Worker exceeded resource limits</html>", {
    headers: { "cf-ray": "abc-GRU", "content-type": "text/html" },
    status,
  });

/** What the real oRPC client throws for a response. */
function thrownFor(response: () => Response): Promise<unknown> {
  return createORPCClient<{ goal: { list: () => Promise<unknown> } }>(
    new RPCLink({
      fetch: () => Promise.resolve(response()),
      url: "http://localhost/rpc",
    })
  )
    .goal.list()
    .catch((caught: unknown) => caught);
}

describe("readWithRetry", () => {
  it("a 503 followed by a success hands back the data, and the caller never sees an error", async () => {
    const t = setup();
    const read = failing(unavailable());

    await expect(readWithRetry(read, t.options)).resolves.toBe("ok");

    expect(read).toHaveBeenCalledTimes(2);
    expect(t.waits).toEqual([1500]); // ~1.5 s, jittered ±20% (the middle of the range here)
  });

  it("two failures and then the answer: three tries, waiting ~1.5 s and then ~4 s", async () => {
    const t = setup();
    const read = failing(unavailable(), unavailable());

    await expect(readWithRetry(read, t.options)).resolves.toBe("ok");

    expect(read).toHaveBeenCalledTimes(3);
    expect(t.waits).toEqual([1500, 4000]);
  });

  it("three failures in a row reach the caller as the last error, after exactly three tries", async () => {
    const t = setup();
    const last = unavailable();
    const read = failing(unavailable(), unavailable(), last);

    await expect(readWithRetry(read, t.options)).rejects.toBe(last);
    expect(read).toHaveBeenCalledTimes(3);
    expect(t.waits).toEqual([1500, 4000]);
  });

  it("each wait is spread by 20% either way: 1.2 to 1.8 s, then 3.2 to 4.8 s", async () => {
    for (const [random, expected] of [
      [0, [1200, 3200]],
      [1, [1800, 4800]],
    ] as const) {
      const t = setup();
      // biome-ignore lint/performance/noAwaitInLoops: one range end at a time
      await readWithRetry(failing(unavailable(), unavailable()), {
        ...t.options,
        random: () => random,
      });
      expect(t.waits).toEqual(expected);
    }
  });

  it("the platform's page for a Worker killed for CPU (1102, cf-ray, no mark) is tried again", async () => {
    const t = setup();
    const died = await thrownFor(() => platformPage(503));
    const read = failing(died, died);

    await expect(readWithRetry(read, t.options)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["no reason", undefined],
    ["server_busy", "server_busy"],
  ])("our own 503 with %s is tried again", async (_label, reason) => {
    const t = setup();
    const busy = new ORPCError("SERVICE_UNAVAILABLE", {
      data: reason ? { reason } : {},
    });
    const read = failing(busy);

    await expect(readWithRetry(read, t.options)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "TOO_MANY_REQUESTS",
  ])("a %s is the server's answer: it never tries again", async (code) => {
    const t = setup();
    const refusal = new ORPCError(code);
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(refusal);

    await expect(readWithRetry(read, t.options)).rejects.toBe(refusal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.waits).toEqual([]);
  });

  it("a 429 of the Worker (rate_limited) is shown at once: one call, no wait", async () => {
    const t = setup();
    const limited = await thrownFor(
      () =>
        new Response(
          JSON.stringify({
            json: {
              code: "TOO_MANY_REQUESTS",
              data: { reason: "rate_limited" },
              defined: false,
              message: "x",
              status: 429,
            },
            meta: [],
          }),
          {
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
            status: 429,
          }
        )
    );
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(limited);

    await expect(readWithRetry(read, t.options)).rejects.toBe(limited);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.waits).toEqual([]);
    expect(t.retries.asked).toBe(0);
  });

  it("a SERVICE_UNAVAILABLE with a deterministic reason is shown at once: one try, no wait", async () => {
    const t = setup();
    const fixed = new ORPCError("SERVICE_UNAVAILABLE", {
      data: { reason: "billing_not_configured" },
    });
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(fixed);

    await expect(readWithRetry(read, t.options)).rejects.toBe(fixed);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.waits).toEqual([]);
  });

  it("with no answer at all (online) it tries three times", async () => {
    const t = setup();
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new NoWorkerAnswerError("unproven"));

    await expect(readWithRetry(read, t.options)).rejects.toBeInstanceOf(
      NoWorkerAnswerError
    );
    expect(read).toHaveBeenCalledTimes(3);
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

  it("asks the brakes of the tab before each retry, and fails at once when they say no", async () => {
    const t = setup();
    t.retries.allowed = 1;
    const last = unavailable();
    const read = failing(unavailable(), last);

    await expect(readWithRetry(read, t.options)).rejects.toBe(last);
    expect(read).toHaveBeenCalledTimes(2);
    expect(t.retries.asked).toBe(2);
    expect(t.waits).toEqual([1500]);
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

  it("drops the next try when the screen moved on during the wait", async () => {
    let current = true;
    const failure = unavailable();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(
      readWithRetry(read, {
        isCurrent: () => current,
        isOnline: () => true,
        mayRetry: () => true,
        random: () => 0.5,
        wait: () => {
          current = false;
          return Promise.resolve();
        },
      })
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaving the screen cancels the read in flight (its signal aborts) and it is never tried again", async () => {
    vi.useFakeTimers();
    try {
      let current = true;
      const signals: AbortSignal[] = [];
      const read = vi.fn(
        (signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason));
          })
      );
      const t = setup();
      const reading = readWithRetry(read, {
        ...t.options,
        isCurrent: () => current,
      });
      reading.catch(() => undefined);

      current = false;
      await vi.advanceTimersByTimeAsync(300);

      await expect(reading).rejects.toMatchObject({ name: "AbortError" });
      expect(signals[0]?.aborted).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(t.waits).toEqual([]);
      expect(t.retries.asked).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("is false for SERVICE_UNAVAILABLE with a reason other than server_busy", () => {
    for (const reason of [
      "billing_not_configured",
      "billing_provider_unavailable",
      "billing_audit_unavailable",
    ]) {
      expect(
        isTransientReadFailure(
          new ORPCError("SERVICE_UNAVAILABLE", { data: { reason } })
        ),
        reason
      ).toBe(false);
    }
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

/** The procedures the contract declares `kind: "read"`, as `router.procedure`: the source of what may be repeated. */
function readProceduresOfTheContract(): Set<string> {
  const reads = new Set<string>();
  traverseContractProcedures(
    { path: [], router: polarisContract },
    ({ contract, path }) => {
      if ((contract["~orpc"].meta as ProcedureMeta).kind === "read") {
        reads.add(path.join("."));
      }
    }
  );
  return reads;
}
const CONTRACT_READS = readProceduresOfTheContract();

/** The reads `readWithRetry` wraps today, as `router.procedure`: a new one is added here on purpose, and the contract has to call it a read. */
const READ_PROCEDURES = [
  "category.list",
  "customer.list",
  "expense.list",
  "expense.listCategories",
  "expense.listRules",
  "goal.list",
  "goal.targetChanges",
  "inventory.listBalances",
  "paymentProfile.list",
  "product.list",
  "publicCatalog.setup",
  "report.dailySales",
  "report.periodSummary",
  "sale.get",
  "sale.getCustomerLink",
  "sale.list",
];
const MODULE_IMPORT =
  /import\s+([^;]*?)\s+from\s+["'][^"']*read-with-retry(?:\.ts)?["'];?/g;
const PLAIN_SPECIFIERS =
  /^\{\s*(?:type\s+\w+,\s*)*readWithRetry(?:,\s*type\s+\w+)*\s*\}$/;
const USE = /\breadWithRetry\b/g;
const FORM =
  /readWithRetry\(\s*\((?:signal)?\) =>\s*orpcClient\s*\.\s*(\w+)\s*\.\s*(\w+)/y;
const SOURCE_FILE = /\.tsx?$/;
const WHITESPACE = /\s/;
const THE_FORM =
  "escreva como `readWithRetry(() => orpcClient.<rota>.<leitura>(...))` ou `readWithRetry((signal) => orpcClient.<rota>.<leitura>(..., { signal }))`";

/**
 * The index just past the string or comment that opens at `i`, or `i` itself when none opens there. It does not read
 * regex literals or `${}` inside a template: a quote that opens a false string leaves the body unclosed, so the use fails closed.
 */
function skipLiteral(text: string, i: number): number {
  const char = text[i];
  if (char === '"' || char === "'" || char === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== char) {
      j += text[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  if (char === "/" && text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end + 1;
  }
  if (char === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}

/** The text of the call that opens at `start` (a `(`): up to its closing parenthesis, ignoring parentheses in strings and comments. */
function callBody(text: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const next = skipLiteral(text, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
    i += 1;
  }
  return text.slice(start);
}

/** The index of the first character from `from` that is neither a space nor part of a comment. */
function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (WHITESPACE.test(text[i] ?? "")) {
      i += 1;
    } else if (text[i] === "/" && skipLiteral(text, i) !== i) {
      i = skipLiteral(text, i);
    } else {
      break;
    }
  }
  return i;
}

/** Whether the procedure call that the form matched closes the body: after its `)`, only the `)` or `,` of `readWithRetry` follows. */
function closesTheBody(text: string, formEnd: number): boolean {
  const open = skipSpaces(text, formEnd);
  if (text[open] !== "(") {
    return false;
  }
  const body = callBody(text, open);
  const after = text[skipSpaces(text, open + body.length)];
  return body.endsWith(")") && (after === ")" || after === ",");
}

/**
 * Every use of the name `readWithRetry` in a text (an alias, a reference, `?.(`, a generic, a call all count,
 * except the plain import), sorted into the calls in the one form the guard can read (`router.procedure`, with
 * a single `orpcClient` in the body, so a write cannot ride along) and the uses outside it.
 */
function scan(text: string) {
  const recognized: string[] = [];
  let outside = 0;
  const rest = text.replace(MODULE_IMPORT, (_all, clause: string) => {
    outside += PLAIN_SPECIFIERS.test(clause.trim()) ? 0 : 1;
    return "";
  });
  for (const use of rest.matchAll(USE)) {
    FORM.lastIndex = use.index;
    const form = FORM.exec(rest);
    const body = callBody(rest, use.index + "readWithRetry".length);
    if (
      form &&
      body.split("orpcClient").length === 2 &&
      closesTheBody(rest, FORM.lastIndex)
    ) {
      recognized.push(`${form[1]}.${form[2]}`);
    } else {
      outside += 1;
    }
  }
  return { outside, recognized };
}

/** The violations of a set of source texts: uses outside the form, and procedures the contract does not declare a read. */
function check(texts: string[]) {
  const scanned = texts.map(scan);
  const recognized = scanned.flatMap((file) => file.recognized);
  return {
    notReads: recognized.filter((name) => !CONTRACT_READS.has(name)),
    outside: scanned.reduce((sum, file) => sum + file.outside, 0),
    recognized,
  };
}

/** The guard of the writes: only these reads are wrapped, and a use it cannot read fails the test instead of slipping by. */
describe("where readWithRetry is used", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const moduleFile = fileURLToPath(
    new URL("./read-with-retry.ts", import.meta.url)
  );

  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sources(path);
      }
      return SOURCE_FILE.test(entry.name) &&
        !entry.name.includes(".test.") &&
        path !== moduleFile
        ? [path]
        : [];
    });
  }

  const result = check(sources(src).map((path) => readFileSync(path, "utf8")));

  it(`every use is a call in the one form the guard reads: ${THE_FORM}`, () => {
    expect(
      result.outside,
      `há uso de readWithRetry fora da forma; ${THE_FORM}`
    ).toBe(0);
  });

  it("wraps only procedures the contract declares a read, and the list of wrapped ones has no entry left over", () => {
    expect(result.notReads).toEqual([]);
    expect(READ_PROCEDURES.filter((name) => !CONTRACT_READS.has(name))).toEqual(
      []
    );
    expect([...new Set(result.recognized)].sort()).toEqual(
      [...READ_PROCEDURES].sort()
    );
  });

  it("the guard flags what is outside the form, and a write", () => {
    const own = 'import { readWithRetry } from "../lib/read-with-retry";\n';
    const inForm = `${own}await readWithRetry(() => orpcClient.sale.list({ a }), o);`;
    expect(check([inForm])).toEqual({
      notReads: [],
      outside: 0,
      recognized: ["sale.list"],
    });
    for (const outside of [
      "readWithRetry(read)",
      "readWithRetry(() => save(sale))",
      "readWithRetry(() => otherClient.sale.list())",
      "readWithRetry<Sale>(read)",
      "readWithRetry<() => Sale>(read)",
      "readWithRetry (read)",
      "readWithRetry(\n  read\n)",
      "readWithRetry?.(read)",
      "readWithRetry.call(null, read)",
      "const r = readWithRetry; r(read)",
      "readWithRetry(() => orpcClient.sale.list(a).then(() => orpcClient.sale.confirm(b)))",
      "readWithRetry(() => orpcClient.sale.list(a).then(() => save(b)))",
      "readWithRetry(() => orpcClient.sale.list(a).then(confirmar))",
      "readWithRetry(() => orpcClient.sale.list(a).finally(() => save(b)))",
      'import { readWithRetry as rwr } from "./read-with-retry";\nrwr(() => orpcClient.sale.confirm(i))',
      'import * as retry from "./read-with-retry";\nretry.readWithRetry(read)',
    ]) {
      expect(check([`${own}${outside}`]).outside, outside).toBeGreaterThan(0);
    }
    // a parenthesis inside a string or a comment does not close the body early
    for (const read of [
      'readWithRetry(() => orpcClient.sale.list({ note: ")" }))',
      "readWithRetry(() => orpcClient.sale.list({ note: ')' }), o)",
      "readWithRetry(() => orpcClient.sale.list({ note: `)` }))",
      "readWithRetry(() => orpcClient.sale.list({ a } /* ) */))",
      "readWithRetry(() => orpcClient.sale.list({ a }) // )\n)",
      "readWithRetry(() => orpcClient.sale.list({ a }) // x\n, o)",
      'readWithRetry(() => orpcClient.sale.list({ note: "\\")" }))',
    ]) {
      expect(check([`${own}${read}`]), read).toEqual({
        notReads: [],
        outside: 0,
        recognized: ["sale.list"],
      });
    }
    expect(
      check([
        `${own}readWithRetry(() => orpcClient.sale.list({ note: ")" }).then(() => save(b)))`,
      ]).outside
    ).toBe(1);
    // a write in the right form is read, and the closed list refuses it
    const write = check([
      `${own}readWithRetry(() => orpcClient.sale.confirm(input))`,
    ]);
    expect(write.notReads).toEqual(["sale.confirm"]);
    // `device.check` is a write in the contract (it promotes the session's link): a wrapper on it is refused
    expect(
      check([
        `${own}readWithRetry(() => orpcClient.device.check({ deviceId }))`,
      ]).notReads
    ).toEqual(["device.check"]);
  });
});
