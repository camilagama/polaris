import { describe, expect, it } from "vitest";
import { PRODUCT_IMPORT_BATCH_MAX_ROWS, polarisContract } from "./index";

const input = polarisContract.product.importBatch["~orpc"].inputSchema;

const row = (rowNumber: number) => ({
  categoryId: null,
  description: null,
  initialStock: null,
  listPrice: "10.00",
  name: `Produto ${rowNumber}`,
  productId: `0199c2d0-0000-7000-8000-0000000a${String(rowNumber).padStart(4, "0")}`,
  rowNumber,
  variantId: `0199c2d0-0000-7000-8000-0000000b${String(rowNumber).padStart(4, "0")}`,
});

const call = (rows: unknown[]) => ({
  importId: "0199c2d0-0000-7000-8000-00000000f001",
  organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
  rows,
});

async function issues(value: unknown) {
  const result = await input?.["~standard"].validate(value);
  return result && "issues" in result ? (result.issues ?? []) : [];
}

describe("the input of product.importBatch", () => {
  it("takes one row per call", async () => {
    expect(PRODUCT_IMPORT_BATCH_MAX_ROWS).toBe(1);
    expect(await issues(call([row(2)]))).toEqual([]);
  });

  it("refuses two rows, whole", async () => {
    const found = await issues(call([row(2), row(3)]));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((issue) => issue.path?.join(".") === "rows")).toBe(true);
  });

  it("refuses no row", async () => {
    expect((await issues(call([]))).length).toBeGreaterThan(0);
  });
});
