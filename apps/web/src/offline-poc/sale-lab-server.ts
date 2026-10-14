import type {
  LocalProductReadModel,
  SaleListEntryReadModel,
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

const recent = (
  n: number,
  overrides: Partial<SaleListEntryReadModel> = {}
): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:00.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: `0199c2d0-0000-7000-8000-${String(900 + n).padStart(12, "0")}`,
  itemCount: 1,
  occurredAt: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00.000Z`,
  occurredOn: `2026-10-${String(10 + n).padStart(2, "0")}`,
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "50.00",
  ...overrides,
});

const recentSalesWindow: SaleListEntryReadModel[] = [
  recent(1, { customerId: PRODUCT_ID, customerName: "Ângela Souza" }),
  recent(2, {
    cancelledAt: "2026-10-13T12:00:00.000Z",
    status: "cancelled",
    totalDue: "20.00",
  }),
  recent(3, { hasReturns: true, totalDue: "30.00" }),
];

export class SaleLabServer extends FakeStockServer {
  override recentSales() {
    return Promise.resolve(recentSalesWindow);
  }

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
