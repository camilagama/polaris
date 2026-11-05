import type {
  LocalCategoryReadModel,
  LocalProductReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  listLocalCategories,
  listLocalProducts,
  toLocalProductRow,
  toProductReadModel,
} from "./local-products";

const ORG = "org-1";
const AT = "2026-10-14T12:00:00.000Z";
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const product = (
  n: number,
  overrides: Partial<LocalProductReadModel> = {}
): LocalProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  deletedAt: null,
  description: null,
  id: uuid(n),
  name: `Produto ${n}`,
  updatedAt: AT,
  version: 1,
  ...overrides,
});
const category = (
  n: number,
  overrides: Partial<LocalCategoryReadModel> = {}
): LocalCategoryReadModel => ({
  archivedAt: null,
  deletedAt: null,
  id: uuid(100 + n),
  name: `Categoria ${n}`,
  updatedAt: AT,
  ...overrides,
});

describe("local products", () => {
  it("rebuilds the screen's shape and back without losing a field", () => {
    const local = product(1, {
      categoryId: uuid(101),
      description: "Algodão",
      version: 4,
    });
    const model = toProductReadModel(local, ORG);
    expect(model).toMatchObject({
      organizationId: ORG,
      status: "active",
      version: 4,
    });
    expect(toLocalProductRow(model)).toEqual(local);
  });

  it("keeps the cover both ways, and a row without one stays without one", () => {
    const covered = product(1, { coverAssetId: uuid(201) });
    const model = toProductReadModel(covered, ORG);
    expect(model.coverAssetId).toBe(uuid(201));
    expect(toLocalProductRow(model)).toEqual(covered);
    const noImage = product(2, { coverAssetId: null });
    expect(toLocalProductRow(toProductReadModel(noImage, ORG))).toEqual(
      noImage
    );
    // a copy written before the field existed: not known yet, never "no image"
    const older = toProductReadModel(product(3), ORG);
    expect(older).not.toHaveProperty("coverAssetId");
    expect(toLocalProductRow(older)).not.toHaveProperty("coverAssetId");
  });

  it("derives the state from the archive and delete marks", () => {
    expect(toProductReadModel(product(1, { archivedAt: AT }), ORG).status).toBe(
      "archived"
    );
    expect(
      toProductReadModel(product(2, { archivedAt: AT, deletedAt: AT }), ORG)
        .status
    ).toBe("deleted");
  });

  it("lists one state by name, never the deleted ones", () => {
    const rows = [
      product(1, { name: "Zíper" }),
      product(2, { name: "Bolsa" }),
      product(3, { archivedAt: AT, name: "Antiga" }),
      product(4, { deletedAt: AT, name: "Apagada" }),
      product(5, {
        archivedAt: AT,
        deletedAt: AT,
        name: "Apagada e arquivada",
      }),
    ];
    expect(listLocalProducts(rows, ORG, "active").map((p) => p.name)).toEqual([
      "Bolsa",
      "Zíper",
    ]);
    expect(listLocalProducts(rows, ORG, "archived").map((p) => p.name)).toEqual(
      ["Antiga"]
    );
  });

  it("lists every category with its state, by name", () => {
    const rows = [
      category(2, { archivedAt: AT, name: "Verão" }),
      category(1, { name: "Inverno" }),
      category(3, { deletedAt: AT, name: "Outono" }),
    ];
    expect(
      listLocalCategories(rows, ORG).map((c) => [c.name, c.status])
    ).toEqual([
      ["Inverno", "active"],
      ["Outono", "deleted"],
      ["Verão", "archived"],
    ]);
  });
});
