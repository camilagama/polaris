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
const UNPRICED = "0199c2d0-0000-7000-8000-0000000000b3";

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

const unpricedVariant: LocalVariantReadModel = {
  id: UNPRICED,
  isDefault: false,
  listPrice: null,
  position: 2,
  productId: PRODUCT_ID,
  sku: "CAM-VD-M",
  values: [{ optionName: "color", optionValueName: "Verde" }],
};

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
export const LAB_PROFILE_SERVER_VERSION = 3;

export const LAB_SECOND_PROFILE_ID = "0199c2d0-0000-7000-8000-0000000000c2";

/** The second profile of the lab is at a version other than the first, so a part cannot borrow the version of another. */
export const LAB_SECOND_PROFILE_SERVER_VERSION = 5;

const serverVersionOf = (profileId: string): number =>
  profileId === LAB_SECOND_PROFILE_ID
    ? LAB_SECOND_PROFILE_SERVER_VERSION
    : LAB_PROFILE_SERVER_VERSION;

interface PricedProfile {
  expectedVersion: number;
  id: string;
}

/** The profiles a sale command was priced with: the one of the sale, or the one of each part that has one. */
function pricedProfiles(payload: unknown): PricedProfile[] {
  const { paymentProfile, payments } = payload as {
    paymentProfile?: PricedProfile | null;
    payments?: { paymentProfile?: PricedProfile | null }[];
  };
  return [
    paymentProfile,
    ...(payments ?? []).map((part) => part.paymentProfile),
  ].filter(
    (profile): profile is PricedProfile =>
      profile !== undefined && profile !== null
  );
}

export class SaleLabServer extends FakeStockServer {
  override recentSales() {
    return Promise.resolve(recentSalesWindow);
  }

  private readonly catalog: LocalVariantReadModel[];

  /** `withUnpricedVariant` adds a variant with no list price (Verde), which the other screens of the lab do not list. */
  constructor(withUnpricedVariant = false) {
    super();
    this.catalog = withUnpricedVariant
      ? [...variants, unpricedVariant]
      : variants;
    this.seed(SHIRT, 5, 1);
    this.seed(SOCK, 20, 1);
    if (withUnpricedVariant) {
      this.seed(UNPRICED, 8, 1);
    }
    const accept = this.push;
    // A sale priced with a profile version that is not the server's is refused, like the real server: the sale-level profile and the profile of each part.
    this.push = (input) => {
      const stale = input.commands.find(
        (command) =>
          command.type === "sale.confirm" &&
          pricedProfiles(command.payload).some(
            (profile) => profile.expectedVersion !== serverVersionOf(profile.id)
          )
      );
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
        rows: this.catalog.filter(
          (row) => !request.ids || request.ids.includes(row.productId)
        ) as unknown as LocalRows[K][],
      });
    }
    return super.page(collection, request);
  }
}
