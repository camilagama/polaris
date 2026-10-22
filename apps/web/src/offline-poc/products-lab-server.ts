import type {
  LocalCategoryReadModel,
  LocalProductReadModel,
} from "@polaris/contracts";
import type { BootstrapCollectionName, LocalRows } from "../offline/bootstrap";
import { FakeCatalogServer } from "../offline/test-support";

/**
 * The simulated server of the products screen when the lab opens with `&catalog=seeded`: the catalog server of the
 * offline tests (it accepts the products the device creates) with a small synthetic catalog already on it, two
 * categories among them, so the screen can be seen and measured with a list. Without the parameter the lab keeps
 * the empty catalog the offline tests count on. Synthetic data only.
 */
const AT = "2026-10-14T12:00:00.000Z";
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;

const CLOTHES = id(11);
const ACCESSORIES = id(12);

const categories: LocalCategoryReadModel[] = [
  {
    archivedAt: null,
    deletedAt: null,
    id: CLOTHES,
    name: "Roupas",
    updatedAt: AT,
  },
  {
    archivedAt: null,
    deletedAt: null,
    id: ACCESSORIES,
    name: "Acessórios",
    updatedAt: AT,
  },
];

const product = (
  n: number,
  name: string,
  overrides: Partial<LocalProductReadModel> = {}
): LocalProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  deletedAt: null,
  description: null,
  id: id(20 + n),
  name,
  updatedAt: AT,
  version: 1,
  ...overrides,
});

const catalog: LocalProductReadModel[] = [
  product(1, "Camiseta do teste", {
    categoryId: CLOTHES,
    description: "Algodão, corte reto.",
  }),
  product(2, "Calça jeans", { categoryId: CLOTHES }),
  product(3, "Boné aba reta", { categoryId: ACCESSORIES }),
  product(
    4,
    "Cinto de couro legítimo com fivela dourada, tamanho único ajustável",
    {
      categoryId: ACCESSORIES,
    }
  ),
  product(5, "Meia esportiva (par)"),
  product(6, "Jaqueta de inverno", {
    archivedAt: AT,
    categoryId: CLOTHES,
  }),
];

export class ProductsLabServer extends FakeCatalogServer {
  constructor() {
    super();
    for (const row of catalog) {
      this.products.set(row.id, row);
    }
  }

  override page<K extends BootstrapCollectionName>(
    collection: K,
    request: { ids?: string[] }
  ) {
    if (collection === "categories") {
      return Promise.resolve({
        nextAfterId: null,
        rows: categories as LocalRows[K][],
      });
    }
    return super.page(collection, request);
  }
}
