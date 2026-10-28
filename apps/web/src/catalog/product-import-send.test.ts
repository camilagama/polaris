import { readFileSync } from "node:fs";
import {
  PRODUCT_IMPORT_BATCH_MAX_ROWS,
  type ProductImportRowInput,
  type ProductImportRowResult,
} from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ImportReadyRow } from "./product-import-rows";
import {
  createImportRun,
  IMPORT_CALL_INTERVAL_MS,
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

  it("never sends more than one row, and keeps 2.5 s between any two calls (fake clock)", async () => {
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
    expect(IMPORT_CALL_INTERVAL_MS).toBe(2500);
    expect(sentAt).toEqual(
      Array.from({ length: 25 }, (_, index) => index * 2500)
    );
    expect(time.waits).toEqual(Array.from({ length: 24 }, () => 2500));
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

  it("sends the same row again with the same IDs after a 1102 of one row, at the pace, and goes on", async () => {
    const productIds: string[] = [];
    const send = vi.fn((input: SendInput) => {
      productIds.push(input.rows[0]?.productId ?? "");
      // the CPU limit of the platform kills the first call: no answer, the row may have entered
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
    expect(time.waits).toEqual([2500, 2500, 2500]);
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
    // the 1 s of the floor, and then the rest of the pace of 2.5 s since the call refused
    expect(time.waits).toEqual([1000, 1500, 120_000, 2500]);
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

    // 2.5 s between any two calls: the row sent again after the 429, and the first call of the continued run
    expect(sentAt).toEqual([0, 2500, 5000, 7500, 10_000, 12_500]);
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
