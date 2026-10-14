import type {
  LocalProductReadModel,
  LocalVariantReadModel,
} from "@polaris/contracts";
import type { BootstrapCollectionName, LocalRows } from "../offline/bootstrap";
import { FakeStockServer } from "../offline/test-support";

/**
 * The simulated server of the sale lab: the stock server (sales take stock from
 * every line or are refused whole) plus a small synthetic catalog, so the device
 * can bootstrap products and variants and sell from them. Synthetic data only.
 */
const AT = "2026-10-14T12:00:00.000Z";
// FakeStockServer puts every balance under this product.
const PRODUCT_ID = "0199c2d0-0000-7000-8000-0000000000f1";
const SHIRT = "0199c2d0-0000-7000-8000-0000000000b1";
const SOCK = "0199c2d0-0000-7000-8000-0000000000b2";

const products: LocalProductReadModel[] = [
  {
    archivedAt: null,
    categoryId: null,
    deletedAt: null,
    description: null,
    id: PRODUCT_ID,
    name: "Camiseta do laboratório",
    updatedAt: AT,
    version: 1,
  },
];
const variants: LocalVariantReadModel[] = [
  {
    id: SHIRT,
    isDefault: false,
    listPrice: "50.00",
    position: 0,
    productId: PRODUCT_ID,
    sku: "CAM-AZ-M",
    values: [{ optionName: "color", optionValueName: "Azul" }],
  },
  {
    id: SOCK,
    isDefault: false,
    listPrice: "10.00",
    position: 1,
    productId: PRODUCT_ID,
    sku: "CAM-VM-M",
    values: [{ optionName: "color", optionValueName: "Vermelha" }],
  },
];

export class SaleLabServer extends FakeStockServer {
  constructor() {
    super();
    this.seed(SHIRT, 5, 1);
    this.seed(SOCK, 20, 1);
  }

  override page<K extends BootstrapCollectionName>(
    collection: K,
    request: { ids?: string[] }
  ) {
    if (collection === "products") {
      return Promise.resolve({
        nextAfterId: null,
        rows: products as unknown as LocalRows[K][],
      });
    }
    if (collection === "variants") {
      return Promise.resolve({
        nextAfterId: null,
        rows: variants.filter(
          (row) => !request.ids || request.ids.includes(row.productId)
        ) as unknown as LocalRows[K][],
      });
    }
    return super.page(collection, request);
  }
}
