import { describe, expect, it } from "vitest";
import { polarisContract } from "./index";

const bootstrapOutput =
  polarisContract.sync.bootstrapPage["~orpc"].outputSchema;
const listOutput = polarisContract.product.list["~orpc"].outputSchema;

const AT = "2026-10-14T12:00:00.000Z";
const COVER = "0199c2d0-0000-7000-8000-000000000101";
const localProduct = {
  archivedAt: null,
  categoryId: null,
  deletedAt: null,
  description: null,
  id: "0199c2d0-0000-7000-8000-000000000001",
  name: "Camiseta",
  updatedAt: AT,
  version: 3,
};
const product = {
  ...localProduct,
  createdAt: AT,
  organizationId: "org-1",
  status: "active",
};

async function validateBootstrap(row: Record<string, unknown>) {
  return await bootstrapOutput?.["~standard"].validate({
    collection: "products",
    nextAfterId: null,
    rows: [row],
  });
}

async function validateList(row: Record<string, unknown>) {
  return await listOutput?.["~standard"].validate({ products: [row] });
}

describe("coverAssetId of a product", () => {
  it("is optional: an answer of the previous Worker, without it, still parses and keeps no field", async () => {
    const booted = await validateBootstrap(localProduct);
    expect(booted).not.toHaveProperty("issues");
    expect(booted).toMatchObject({ value: { rows: [localProduct] } });
    expect(
      (booted as { value: { rows: object[] } }).value.rows[0]
    ).not.toHaveProperty("coverAssetId");
    expect(await validateList(product)).not.toHaveProperty("issues");
  });

  it.each([
    [COVER, "an image"],
    [null, "no image"],
  ])(
    "carries %s (%s) through the bootstrap and the list",
    async (cover, _label) => {
      const booted = await validateBootstrap({
        ...localProduct,
        coverAssetId: cover,
      });
      expect(booted).toMatchObject({
        value: { rows: [{ coverAssetId: cover }] },
      });
      const listed = await validateList({ ...product, coverAssetId: cover });
      expect(listed).toMatchObject({
        value: { products: [{ coverAssetId: cover }] },
      });
    }
  );

  it("refuses a cover that is not a UUID", async () => {
    expect(
      await validateBootstrap({ ...localProduct, coverAssetId: "capa.webp" })
    ).toHaveProperty("issues");
    expect(
      await validateList({ ...product, coverAssetId: "capa.webp" })
    ).toHaveProperty("issues");
  });
});
