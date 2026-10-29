import { readFileSync } from "node:fs";
import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ImportReadyRow } from "./product-import-rows";
import {
  CUTS_AT_CEILING_TO_SKIP,
  createImportRun,
  IMPORT_CALL_INTERVAL_MS,
  PACE_BACK_AFTER_ANSWERS,
  REGIME_PAUSE_STEPS_MS,
  type ImportRun,
  type ImportSendDependencies,
  runImport,
  skipStuckRow,
  summarizeImport,
} from "./product-import-send";

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";

type SendInput = Parameters<ImportSendDependencies["send"]>[0];

function readyRows(count: number): ImportReadyRow[] {
  return Array.from({ length: count }, (_, index) => ({
    categoryId: null,
    description: null,
    initialStock: index % 2 === 0 ? { quantity: 2, unitCost: null } : null,
    listPrice: "10.00",
    name: `Produto ${index + 1}`,
    rowNumber: index + 2,
    source: {
      category: "",
      description: "",
      listPrice: "10,00",
      name: `Produto ${index + 1}`,
      quantity: "",
      unitCost: "",
    },
  }));
}

let counter = 0;
const newId = () => {
  counter += 1;
  return `0199c2d0-0000-7000-8000-${String(counter).padStart(12, "0")}`;
};

const created = (rows: ProductImportRowInput[]): ProductImportRowResult[] =>
  rows.map((row) => ({
    productId: row.productId,
    rowNumber: row.rowNumber,
    status: "created",
  }));

const rpcError = (code: string) =>
  Object.assign(new Error(code), { code, defined: false });

/** What oRPC throws for the platform's page of a Worker it killed (1102: a 503 with `cf-ray` and no mark). */
const platformCut = () =>
  Object.assign(new Error("cut"), {
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "platform_cut" },
    defined: false,
    status: 503,
  });

/** The 503 the Worker itself gives an unexpected fault (`unexpectedRpcError`): it carries the mark. */
const workerBusy = () =>
  Object.assign(new Error("busy"), {
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "server_busy" },
    defined: false,
    status: 503,
  });

/** A clock that only moves when the run waits, and a record of every wait. */
function fakeTime() {
  let clock = 0;
  const waits: number[] = [];
  return {
    now: () => clock,
    wait: (ms: number) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    waits,
  };
}

function setup(
  count: number,
  send: ImportSendDependencies["send"],
  extra: Partial<ImportSendDependencies> = {}
) {
  const run = createImportRun(readyRows(count), newId);
  const time = fakeTime();
  const dependencies: ImportSendDependencies = {
    now: time.now,
    organizationId,
    retryAfterMs: () => null,
    send,
    wait: time.wait,
    ...extra,
  };
  return { dependencies, run, time };
}

interface RatelimitBlock {
  ratelimits?: { name: string; simple: { limit: number; period: number } }[];
}

// wrangler.jsonc is JSON with comments and trailing commas, which is also a valid JavaScript expression
const wrangler = new Function(
  `return (${readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")});`
)() as RatelimitBlock & { env?: Record<string, RatelimitBlock> };

describe("the pace of the import against the bulk bucket", () => {
  const environments: [string, RatelimitBlock][] = [
    ["local", wrangler],
    ...Object.entries(wrangler.env ?? {}),
  ];

  it("has the three environments of the bucket", () => {
    expect(environments.map(([name]) => name)).toEqual([
      "local",
      "staging",
      "production",
    ]);
  });

  it.each(environments)(
    "has a pace under the bucket, with 20 percent of margin, in %s",
    (_name, block) => {
      const bucket = block.ratelimits?.filter(
        (limiter) => limiter.name === "RPC_BULK_RATE_LIMIT"
      );
      expect(bucket).toHaveLength(1);
      const { limit, period } = bucket?.[0]?.simple ?? { limit: 0, period: 0 };
      expect(period).toBe(60);
      const callsPerMinute = 60_000 / IMPORT_CALL_INTERVAL_MS;
      expect(callsPerMinute).toBeLessThanOrEqual(0.8 * limit);
      // one row per call: the bucket counts calls, so its rows per minute stay under the write bucket's
      const writes = block.ratelimits?.find(
        (limiter) => limiter.name === "RPC_MUTATION_RATE_LIMIT"
      );
      expect(limit * PRODUCT_IMPORT_BATCH_MAX_ROWS).toBeLessThan(
        writes?.simple.limit ?? 0
      );
    }
  );
});

describe("the IDs of an import", () => {
  it("names every product, variant and stock command once, all different", () => {
    const run = createImportRun(readyRows(4), newId);
    const ids = run.rows.flatMap((row) => [
      row.productId,
      row.variantId,
      ...(row.initialStock ? [row.initialStock.commandId] : []),
    ]);
    expect(new Set([...ids, run.importId]).size).toBe(ids.length + 1);
    expect(run.rows[1]?.initialStock).toBeNull();
    expect(run.rows[0]).toMatchObject({
      initialStock: { quantity: 2, unitCost: null },
      listPrice: "10.00",
      name: "Produto 1",
      rowNumber: 2,
    });
    // nothing of the file goes with the row: only the fields of product.create and the row number
    expect(Object.keys(run.rows[0] ?? {}).sort()).toEqual([
      "categoryId",
      "description",
      "initialStock",
      "listPrice",
      "name",
      "productId",
      "rowNumber",
      "variantId",
    ]);
  });
});

describe("one row per call, by the measure of the Free plan", () => {
  it("the server's cap is 1 row", () => {
    expect(PRODUCT_IMPORT_BATCH_MAX_ROWS).toBe(1);
  });

  it("never sends more than one row, and keeps 7 s between any two calls (fake clock)", async () => {
    const sent: number[] = [];
    const sentAt: number[] = [];
    const time = fakeTime();
    const send = vi.fn((input: SendInput) => {
      sent.push(input.rows.length);
      sentAt.push(time.now());
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run } = setup(25, send, {
      now: time.now,
      wait: time.wait,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(sent).toEqual(Array.from({ length: 25 }, () => 1));
    expect(IMPORT_CALL_INTERVAL_MS).toBe(7000);
    expect(sentAt).toEqual(
      Array.from({ length: 25 }, (_, index) => index * 7000)
    );
    expect(time.waits).toEqual(Array.from({ length: 24 }, () => 7000));
    expect(
      send.mock.calls.every(([input]) => input.importId === run.importId)
    ).toBe(true);
    expect(summarizeImport(run)).toEqual({
      entered: 25,
      existing: 0,
      failed: 0,
      limitReached: 0,
      pending: 0,
    });
  });

  it("sends the same row again with the same IDs after a 500 with no reason, at the pace, and goes on", async () => {
    const productIds: string[] = [];
    const send = vi.fn((input: SendInput) => {
      productIds.push(input.rows[0]?.productId ?? "");
      // a fault of the server nobody named, that is not the platform's: the row may have entered
      return productIds.length === 1
        ? Promise.reject(rpcError("INTERNAL_SERVER_ERROR"))
        : Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(3, send);
    const progress: number[] = [];
    dependencies.onProgress = (current) => progress.push(current.nextIndex);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(productIds).toEqual([
      run.rows[0]?.productId,
      run.rows[0]?.productId,
      run.rows[1]?.productId,
      run.rows[2]?.productId,
    ]);
    expect(time.waits).toEqual([7000, 7000, 7000]);
    // the failure is no step of the progress: the screen sees only the rows answered
    expect(progress).toEqual([1, 2, 3]);
    expect(summarizeImport(run)).toMatchObject({ entered: 3, pending: 0 });
  });
});

describe("runImport", () => {
  it("pauses for the Retry-After of a 429 and only then sends the same row, once", async () => {
    const calls: ProductImportRowInput[][] = [];
    let refused = false;
    const send = vi.fn((input: SendInput) => {
      calls.push(input.rows);
      if (!refused) {
        refused = true;
        return Promise.reject(rpcError("TOO_MANY_REQUESTS"));
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(1, send, {
      retryAfterMs: () => 42_000,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(time.waits).toEqual([42_000]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("waits a minute after a 429 without Retry-After, and stops after three in a row", async () => {
    const send = vi.fn(() => Promise.reject(rpcError("TOO_MANY_REQUESTS")));
    const { dependencies, run, time } = setup(3, send);

    expect(await runImport(run, dependencies)).toEqual({
      kind: "rate_limited",
    });
    expect(time.waits).toEqual([60_000, 60_000]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(run.nextIndex).toBe(0);
  });

  it("stops where it was after a lost answer, and continues from that row with the same IDs", async () => {
    const stored = new Set<string>();
    let online = true;
    const sent: ProductImportRowInput[][] = [];
    const send = vi.fn((input: SendInput) => {
      sent.push(input.rows);
      // the second row is saved, and then the connection drops before the answer
      const results = input.rows.map(
        (row): ProductImportRowResult => ({
          productId: row.productId,
          rowNumber: row.rowNumber,
          status: stored.has(row.productId) ? "repeated" : "created",
        })
      );
      for (const row of input.rows) {
        stored.add(row.productId);
      }
      if (sent.length >= 2 && !online) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (sent.length === 1) {
        online = false;
      }
      return Promise.resolve({ results });
    });
    const { dependencies, run } = setup(4, send);

    const stop = await runImport(run, dependencies);
    expect(stop.kind).toBe("interrupted");
    // the row that failed is tried again twice, and the run stays at it
    expect(sent.map((rows) => rows[0]?.rowNumber)).toEqual([2, 3, 3, 3]);
    expect(run.nextIndex).toBe(1);
    expect(summarizeImport(run)).toMatchObject({ entered: 1, pending: 3 });

    online = true;
    const resumedAt = sent.length;
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    expect(sent.slice(resumedAt).map((rows) => rows[0]?.productId)).toEqual(
      run.rows.slice(1).map((row) => row.productId)
    );
    expect(run.results.get(3)?.status).toBe("repeated");
    expect(stored.size).toBe(4);
    expect(summarizeImport(run)).toMatchObject({ entered: 4, pending: 0 });
  });

  it("never sends again right away on Retry-After: 0, and never waits past two minutes", async () => {
    const retryAfter = [0, 3_600_000];
    let calls = 0;
    const send = vi.fn((input: SendInput) => {
      calls += 1;
      return calls <= 2
        ? Promise.reject(rpcError("TOO_MANY_REQUESTS"))
        : Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(2, send, {
      retryAfterMs: () => retryAfter.shift() ?? null,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    // the 1 s of the floor, and then the rest of the pace of 7 s since the call refused
    expect(time.waits).toEqual([1000, 6000, 120_000, 7000]);
  });

  it("keeps the pace after a 429 and across a continued run", async () => {
    // a 429 that asks 1 s, an answer, a refusal that stops the run, and then every answer
    const script = ["TOO_MANY_REQUESTS", null, "FORBIDDEN"];
    const sentAt: number[] = [];
    const time = fakeTime();
    const send = vi.fn((input: SendInput) => {
      sentAt.push(time.now());
      const code = script.shift();
      return code
        ? Promise.reject(rpcError(code))
        : Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run } = setup(4, send, {
      now: time.now,
      retryAfterMs: () => 1000,
      wait: time.wait,
    });

    expect((await runImport(run, dependencies)).kind).toBe("refused");
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    // 7 s between any two calls: the row sent again after the 429, and the first call of the continued run
    expect(sentAt).toEqual([0, 7000, 14_000, 21_000, 28_000, 35_000]);
  });

  it("takes an answer without every row sent as no answer: nothing moves", async () => {
    const send = vi.fn((input: SendInput) =>
      Promise.resolve({ results: created(input.rows.slice(1)) })
    );
    const { dependencies, run } = setup(3, send);

    const stop = await runImport(run, dependencies);
    expect(stop.kind).toBe("interrupted");
    expect(run.nextIndex).toBe(0);
    expect(run.results.size).toBe(0);
  });

  it("finds a row that keeps failing, and goes on past it once it is left out", async () => {
    const sent: number[][] = [];
    const stuck = 5;
    const send = vi.fn((input: SendInput) => {
      sent.push(input.rows.map((row) => row.rowNumber));
      return input.rows.some((row) => row.rowNumber === stuck)
        ? Promise.reject(rpcError("INTERNAL_SERVER_ERROR"))
        : Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run } = setup(6, send);

    expect((await runImport(run, dependencies)).kind).toBe("interrupted");
    expect(sent).toEqual([[2], [3], [4], [5], [5], [5]]);
    expect(run.nextIndex).toBe(3);

    skipStuckRow(run);
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    expect(summarizeImport(run)).toEqual({
      entered: 5,
      existing: 0,
      failed: 1,
      limitReached: 0,
      pending: 0,
    });
    expect(run.skipped).toEqual(new Set([stuck]));
  });

  it("takes the screen giving up during a call as an abort, never as a failure", async () => {
    const controller = new AbortController();
    const send = vi.fn(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const { dependencies, run } = setup(3, send, {
      signal: controller.signal,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "aborted" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("stops at the plan's limit, sends nothing more and says why the rest did not enter", async () => {
    const send = vi.fn((input: SendInput) =>
      Promise.resolve({
        results: input.rows.map(
          (row): ProductImportRowResult => ({
            rowNumber: row.rowNumber,
            status: "limit_reached",
          })
        ),
      })
    );
    const { dependencies, run } = setup(60, send);

    expect(await runImport(run, dependencies)).toEqual({
      kind: "limit_reached",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(summarizeImport(run)).toEqual({
      entered: 0,
      existing: 0,
      failed: 0,
      limitReached: 60,
      pending: 0,
    });
  });

  it.each(["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"])(
    "stops at a refusal of the call itself (%s), without sending it again",
    async (code) => {
      const send = vi.fn(() => Promise.reject(rpcError(code)));
      const { dependencies, run } = setup(3, send);

      const stop = await runImport(run, dependencies);

      expect(stop.kind).toBe("refused");
      expect(send).toHaveBeenCalledOnce();
      expect(summarizeImport(run).pending).toBe(3);
    }
  );

  it("counts each answer of the server for the summary", async () => {
    const statuses: ProductImportRowResult["status"][] = [
      "created",
      "repeated",
      "exists_by_name",
      "invalid",
      "conflict",
    ];
    const send = vi.fn((input: SendInput) => {
      const row = input.rows[0] as ProductImportRowInput;
      const status = statuses[row.rowNumber - 2] ?? "created";
      let result: ProductImportRowResult;
      if (status === "invalid") {
        result = {
          field: "listPrice",
          reason: "invalid_variant_list_price",
          rowNumber: row.rowNumber,
          status,
        };
      } else if (status === "conflict") {
        result = {
          reason: "product_create_conflict",
          rowNumber: row.rowNumber,
          status,
        };
      } else if (status === "exists_by_name") {
        result = { rowNumber: row.rowNumber, status };
      } else {
        result = {
          productId: row.productId,
          rowNumber: row.rowNumber,
          status,
        };
      }
      return Promise.resolve({ results: [result] });
    });
    const progress: number[] = [];
    const { dependencies, run } = setup(5, send, {
      onProgress: (current: ImportRun) => progress.push(current.nextIndex),
    });

    await runImport(run, dependencies);

    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(summarizeImport(run)).toEqual({
      entered: 2,
      existing: 1,
      failed: 2,
      limitReached: 0,
      pending: 0,
    });
  });

  it("stops when the screen gives up, between calls", async () => {
    const controller = new AbortController();
    const send = vi.fn((input: SendInput) => {
      controller.abort();
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run } = setup(30, send, {
      signal: controller.signal,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "aborted" });
    expect(send).toHaveBeenCalledOnce();
    expect(run.nextIndex).toBe(1);
  });
});

describe("the regime of the Free plan", () => {
  const [FIRST, SECOND, CEILING] = REGIME_PAUSE_STEPS_MS;

  it("has the steps of the pause: 2, 5 and 10 minutes, each past the ~6 min the regime takes to end", () => {
    expect(REGIME_PAUSE_STEPS_MS).toEqual([120_000, 300_000, 600_000]);
    expect(PACE_BACK_AFTER_ANSWERS).toBe(20);
    expect(CUTS_AT_CEILING_TO_SKIP).toBe(3);
  });

  it("pauses 2, 5 and 10 min after three cuts in a row, sends the same row with the same IDs, and ends with every row answered", async () => {
    const sent: ProductImportRowInput[] = [];
    let cuts = 3;
    const send = vi.fn((input: SendInput) => {
      sent.push(...input.rows);
      if (input.rows[0]?.rowNumber === 3 && cuts > 0) {
        cuts -= 1;
        return Promise.reject(platformCut());
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const pauses: (number | null)[] = [];
    const { dependencies, run, time } = setup(4, send);
    dependencies.onPause = (resumeAt) => pauses.push(resumeAt);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(time.waits).toEqual([
      IMPORT_CALL_INTERVAL_MS,
      FIRST,
      SECOND,
      CEILING,
      2 * IMPORT_CALL_INTERVAL_MS,
      2 * IMPORT_CALL_INTERVAL_MS,
    ]);
    // the screen hears when each pause ends: the hour it says, and the end
    const firstCut = IMPORT_CALL_INTERVAL_MS;
    expect(pauses).toEqual([
      firstCut + FIRST,
      null,
      firstCut + FIRST + SECOND,
      null,
      firstCut + FIRST + SECOND + CEILING,
      null,
    ]);
    const third = sent.filter((row) => row.rowNumber === 3);
    expect(third).toHaveLength(4);
    expect(new Set(third.map((row) => JSON.stringify(row))).size).toBe(1);
    expect(third[0]).toEqual(run.rows[1]);
    expect(summarizeImport(run)).toEqual({
      entered: 4,
      existing: 0,
      failed: 0,
      limitReached: 0,
      pending: 0,
    });
  });

  it("never gives up by itself on cuts: they are no try of the row, and the first row is never left out", async () => {
    let cuts = 8;
    const send = vi.fn((input: SendInput) => {
      if (cuts > 0) {
        cuts -= 1;
        return Promise.reject(platformCut());
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(2, send);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(time.waits.slice(0, 8)).toEqual([
      FIRST,
      SECOND,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
    ]);
    expect(run.skipped.size).toBe(0);
    expect(summarizeImport(run)).toMatchObject({ entered: 2, pending: 0 });
  });

  it("goes at twice the interval after a pause, and back to 7 s after 20 answers in a row", async () => {
    let cut = false;
    const send = vi.fn((input: SendInput) => {
      if (input.rows[0]?.rowNumber === 3 && !cut) {
        cut = true;
        return Promise.reject(platformCut());
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(26, send);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    // the row cut goes again right after the pause; it and the next 19 rows are the 20 answers at half pace
    expect(time.waits).toEqual([
      IMPORT_CALL_INTERVAL_MS,
      FIRST,
      ...Array.from({ length: 19 }, () => 2 * IMPORT_CALL_INTERVAL_MS),
      ...Array.from({ length: 5 }, () => IMPORT_CALL_INTERVAL_MS),
    ]);
  });

  it("starts the pauses over once the pace came back, and grows them while the regime comes back sooner", async () => {
    // cut at rows 3 and 6 (the pace not back yet: 5 min), then at row 30 (20 answers later: 2 min again)
    const cutRows = new Set([3, 6, 30]);
    const send = vi.fn((input: SendInput) => {
      const rowNumber = input.rows[0]?.rowNumber ?? 0;
      if (cutRows.delete(rowNumber)) {
        return Promise.reject(platformCut());
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(30, send);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    expect(time.waits.filter((ms) => ms >= 60_000)).toEqual([
      FIRST,
      SECOND,
      FIRST,
    ]);
  });

  it("holds the send in a pause while the tab's own work is failing, and sends nothing meanwhile", async () => {
    const busy = [true, true];
    const send = vi.fn((input: SendInput) =>
      Promise.resolve({ results: created(input.rows) })
    );
    const { dependencies, run, time } = setup(2, send, {
      busy: () => busy.shift() ?? false,
    });
    const calledAt: number[] = [];
    send.mockImplementation((input: SendInput) => {
      calledAt.push(time.now());
      return Promise.resolve({ results: created(input.rows) });
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(time.waits).toEqual([FIRST, SECOND, 2 * IMPORT_CALL_INTERVAL_MS]);
    expect(calledAt[0]).toBe(FIRST + SECOND);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("leaves out the row cut 3 times after pauses at the ceiling, when the row before it went through, and goes on", async () => {
    const stuck = 3;
    const sent: number[] = [];
    const send = vi.fn((input: SendInput) => {
      const rowNumber = input.rows[0]?.rowNumber ?? 0;
      sent.push(rowNumber);
      // cut every time; past 20 tries the row would go through, so a run that never leaves it out still ends
      return rowNumber === stuck && sent.length < 20
        ? Promise.reject(platformCut())
        : Promise.resolve({ results: created(input.rows) });
    });
    const progress: number[] = [];
    const { dependencies, run, time } = setup(4, send, {
      onProgress: (current: ImportRun) => progress.push(current.nextIndex),
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    // three cuts to reach the ceiling, then three more after it
    expect(sent).toEqual([2, 3, 3, 3, 3, 3, 3, 4, 5]);
    expect(time.waits.filter((ms) => ms >= 60_000)).toEqual([
      FIRST,
      SECOND,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
    ]);
    expect(run.skipped).toEqual(new Set([stuck]));
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(summarizeImport(run)).toEqual({
      entered: 3,
      existing: 0,
      failed: 1,
      limitReached: 0,
      pending: 0,
    });
  });

  it("counts a cut on the send after an answer for nothing: the row is left out only after 3 pauses at the ceiling", async () => {
    // row 3 brings the pauses to the ceiling and goes through; row 4 is then cut on every send
    let cutsOfThird = 3;
    const sent: number[] = [];
    const send = vi.fn((input: SendInput) => {
      const rowNumber = input.rows[0]?.rowNumber ?? 0;
      sent.push(rowNumber);
      if (rowNumber === 3 && cutsOfThird > 0) {
        cutsOfThird -= 1;
        return Promise.reject(platformCut());
      }
      return rowNumber === 4 && sent.length < 30
        ? Promise.reject(platformCut())
        : Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(4, send);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    // row 4: the send at the pace after row 3 answered, then one send after each of 3 pauses at the ceiling
    expect(sent.filter((rowNumber) => rowNumber === 4)).toHaveLength(4);
    expect(time.waits.filter((ms) => ms >= 60_000)).toEqual([
      FIRST,
      SECOND,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
      CEILING,
    ]);
    expect(run.skipped).toEqual(new Set([4]));
    expect(summarizeImport(run)).toMatchObject({ entered: 3, failed: 1 });
  });

  it("does not count the send after a pause at the ceiling that the screen cut short", async () => {
    // rows 2 and 3 answer; row 4 is cut on every send
    const sent: number[] = [];
    const send = vi.fn((input: SendInput) => {
      const rowNumber = input.rows[0]?.rowNumber ?? 0;
      sent.push(rowNumber);
      return rowNumber === 4 && sent.length < 40
        ? Promise.reject(platformCut())
        : Promise.resolve({ results: created(input.rows) });
    });
    const time = fakeTime();
    let controller = new AbortController();
    let ceilings = 0;
    const { dependencies, run } = setup(4, send, {
      now: time.now,
      wait: (ms: number) => {
        if (ms === CEILING) {
          ceilings += 1;
          // the person stops during the second pause at the ceiling
          if (ceilings === 2) {
            controller.abort();
          }
        }
        return time.wait(ms);
      },
    });
    dependencies.signal = controller.signal;

    expect(await runImport(run, dependencies)).toEqual({ kind: "aborted" });
    controller = new AbortController();
    dependencies.signal = controller.signal;
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    // counted: the cuts after the 1st, the 3rd and the 4th pauses at the ceiling (the 2nd was cut short, and the send
    // after the continue is no send after a pause); the row is left out, and the pause after that cut still goes
    expect(ceilings).toBe(5);
    expect(run.skipped).toEqual(new Set([4]));
  });

  it("takes the Worker's own 503 server_busy as a failure of the row, never as the regime: no pause, it stops after the tries", async () => {
    let calls = 0;
    // the fault repeats on every send; past 10 the row would go through, so a run that pauses on it still ends
    const send = vi.fn((input: SendInput) => {
      calls += 1;
      return input.rows[0]?.rowNumber === 2 && calls <= 10
        ? Promise.reject(workerBusy())
        : Promise.resolve({ results: created(input.rows) });
    });
    const pauses: (number | null)[] = [];
    const { dependencies, run, time } = setup(3, send, {
      onPause: (resumeAt) => pauses.push(resumeAt),
    });

    const stop = await runImport(run, dependencies);

    expect(stop.kind).toBe("interrupted");
    expect(send).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([]);
    expect(time.waits.every((ms) => ms < 60_000)).toBe(true);
    expect(run.nextIndex).toBe(0);
  });

  it("stops at once when the screen gives up during a pause", async () => {
    const controller = new AbortController();
    const send = vi.fn(() => Promise.reject(platformCut()));
    const time = fakeTime();
    const { dependencies, run } = setup(3, send, {
      now: time.now,
      signal: controller.signal,
      wait: (ms: number) => {
        if (ms >= 60_000) {
          controller.abort();
        }
        return time.wait(ms);
      },
    });

    const pauses: (number | null)[] = [];
    dependencies.onPause = (resumeAt) => pauses.push(resumeAt);

    expect(await runImport(run, dependencies)).toEqual({ kind: "aborted" });
    expect(send).toHaveBeenCalledOnce();
    expect(run.nextIndex).toBe(0);
    // the pause never says it ended: the screen goes straight to the stop
    expect(pauses).toEqual([FIRST]);
  });

  it("takes a response with no mark of the Worker as no answer, never as a cut: it still stops after the tries", async () => {
    const noAnswer = Object.assign(new Error("no_worker_answer_unproven"), {
      name: "NoWorkerAnswerError",
    });
    const send = vi.fn(() => Promise.reject(noAnswer));
    const { dependencies, run, time } = setup(2, send);

    expect((await runImport(run, dependencies)).kind).toBe("interrupted");
    expect(send).toHaveBeenCalledTimes(3);
    expect(time.waits.every((ms) => ms < 60_000)).toBe(true);
  });
});
