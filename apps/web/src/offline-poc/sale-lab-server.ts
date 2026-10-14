import type {
  LocalProductReadModel,
  LocalVariantReadModel,
  SaleListEntryReadModel,
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

/** The version of the payment profile the lab's server has, whatever a device saw. */
const LAB_PROFILE_SERVER_VERSION = 3;

export class SaleLabServer extends FakeStockServer {
  override recentSales() {
    return Promise.resolve(recentSalesWindow);
  }

  constructor() {
    super();
    this.seed(SHIRT, 5, 1);
    this.seed(SOCK, 20, 1);
    const accept = this.push;
    // A sale priced with a profile version that is not the server's is refused, like the real server.
    this.push = (input) => {
      const stale = input.commands.find((command) => {
        const profile = (
          command.payload as {
            paymentProfile?: { expectedVersion: number; id: string };
          }
        ).paymentProfile;
        return (
          command.type === "sale.confirm" &&
          profile !== undefined &&
          profile.expectedVersion !== LAB_PROFILE_SERVER_VERSION
        );
      });
      if (!stale) {
        return accept(input);
      }
      // the queue is ordered: what comes before is processed, the refused one stops it
      const before = input.commands.slice(0, input.commands.indexOf(stale));
      const processed = before.length > 0 ? accept({ commands: before }) : null;
      return (processed ?? Promise.resolve({ results: [] })).then(
        ({ results }) => ({
          results: [
            ...results,
            {
              code: "payment_profile_changed",
              commandId: stale.commandId,
              replayed: false,
              result: null,
              status: "rejected" as const,
            },
            ...input.commands
              .slice(input.commands.indexOf(stale) + 1)
              .map((command) => ({
                code: null,
                commandId: command.commandId,
                replayed: false,
                result: null,
                status: "not_processed" as const,
              })),
          ],
        })
      );
    };
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
