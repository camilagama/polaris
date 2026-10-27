import type {
  ProductImportRowInput,
  ProductImportRowResult,
} from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ImportReadyRow } from "./product-import-rows";
import {
  createImportRun,
  IMPORT_SLICE_INTERVAL_MS,
  type ImportRun,
  type ImportSendDependencies,
  runImport,
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

describe("runImport", () => {
  it("sends slices of 10, one after the answer to the other, at the pace of the bucket", async () => {
    const sent: number[] = [];
    const send = vi.fn((input: SendInput) => {
      sent.push(input.rows.length);
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(60, send);

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(sent).toEqual([10, 10, 10, 10, 10, 10]);
    expect(
      send.mock.calls.every(
        ([input]) => input.importId === run.importId
      )
    ).toBe(true);
    // never more than one slice in 6 s: 10 per minute, below the 12 of the bucket
    expect(time.waits).toEqual(
      Array.from({ length: 5 }, () => IMPORT_SLICE_INTERVAL_MS)
    );
    expect(summarizeImport(run)).toEqual({
      entered: 60,
      existing: 0,
      failed: 0,
      limitReached: 0,
      pending: 0,
    });
  });

  it("pauses for the Retry-After of a 429 and only then sends the same slice, once", async () => {
    const slices: ProductImportRowInput[][] = [];
    let refused = false;
    const send = vi.fn((input: SendInput) => {
      slices.push(input.rows);
      if (!refused) {
        refused = true;
        return Promise.reject(rpcError("TOO_MANY_REQUESTS"));
      }
      return Promise.resolve({ results: created(input.rows) });
    });
    const { dependencies, run, time } = setup(3, send, {
      retryAfterMs: () => 42_000,
    });

    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });

    expect(time.waits).toEqual([42_000]);
    expect(slices).toHaveLength(2);
    expect(slices[1]).toEqual(slices[0]);
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

  it("stops where it was after a lost answer, and continues from that slice with the same IDs", async () => {
    const stored = new Set<string>();
    let online = true;
    const sent: ProductImportRowInput[][] = [];
    const send = vi.fn((input: SendInput) => {
      sent.push(input.rows);
      // the second slice is saved, and then the connection drops before the answer
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
    const { dependencies, run } = setup(40, send);

    const stop = await runImport(run, dependencies);
    expect(stop.kind).toBe("interrupted");
    // the slice was tried again twice, and the run stays at it
    expect(sent).toHaveLength(4);
    expect(run.nextIndex).toBe(10);
    expect(summarizeImport(run)).toMatchObject({ entered: 10, pending: 30 });

    online = true;
    const resumedAt = sent.length;
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    // the first slice sent on continuing is the one that was cut, with the same IDs
    expect(sent[resumedAt]).toEqual(sent[1]);
    expect(
      [...run.results.values()].slice(10, 20).map((result) => result.status)
    ).toEqual(Array.from({ length: 10 }, () => "repeated"));
    expect(stored.size).toBe(40);
    expect(summarizeImport(run)).toMatchObject({ entered: 40, pending: 0 });
  });

  it("stops at the plan's limit, sends nothing more and says why the rest did not enter", async () => {
    const send = vi.fn((input: SendInput) =>
      Promise.resolve({
        results: input.rows.map(
          (row, index): ProductImportRowResult =>
            index < 5
              ? {
                  productId: row.productId,
                  rowNumber: row.rowNumber,
                  status: "created",
                }
              : { rowNumber: row.rowNumber, status: "limit_reached" }
        ),
      })
    );
    const { dependencies, run } = setup(60, send);

    expect(await runImport(run, dependencies)).toEqual({
      kind: "limit_reached",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(summarizeImport(run)).toEqual({
      entered: 5,
      existing: 0,
      failed: 0,
      limitReached: 55,
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
    const send = vi.fn((input: SendInput) =>
      Promise.resolve({
        results: input.rows.map((row, index): ProductImportRowResult => {
          const status = statuses[index];
          if (status === "invalid") {
            return {
              field: "listPrice",
              reason: "invalid_variant_list_price",
              rowNumber: row.rowNumber,
              status,
            };
          }
          if (status === "conflict") {
            return {
              reason: "product_create_conflict",
              rowNumber: row.rowNumber,
              status,
            };
          }
          if (status === "exists_by_name") {
            return { rowNumber: row.rowNumber, status };
          }
          return {
            productId: row.productId,
            rowNumber: row.rowNumber,
            status: status === "repeated" ? "repeated" : "created",
          };
        }),
      })
    );
    const progress: number[] = [];
    const { dependencies, run } = setup(5, send, {
      onProgress: (current: ImportRun) => progress.push(current.nextIndex),
    });

    await runImport(run, dependencies);

    expect(progress).toEqual([5]);
    expect(summarizeImport(run)).toEqual({
      entered: 2,
      existing: 1,
      failed: 2,
      limitReached: 0,
      pending: 0,
    });
  });

  it("stops when the screen gives up, between slices", async () => {
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
    expect(run.nextIndex).toBe(10);
  });
});
