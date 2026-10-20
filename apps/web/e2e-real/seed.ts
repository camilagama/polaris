import { randomBytes } from "node:crypto";
import type { PolarisRpcClient } from "@polaris/contracts";
import { uuidV5 } from "./journey-names";

/**
 * The starting data of a journey, through the Worker's own commands (the same `/rpc` the screens call), never
 * by SQL: ledger, snapshot and RLS apply to it like to anything the user does.
 */

const seedPattern = /^[a-f0-9]{16}$/;

/**
 * The seed of the command ids: `E2E_SEED` (16 lowercase hex digits) reproduces them; without it the global setup
 * draws one for the run. The fixtures print it when a test fails.
 */
export function commandSeed(): string {
  const given = process.env.E2E_SEED;
  if (given !== undefined && !seedPattern.test(given)) {
    throw new Error("E2E_SEED must be 16 hexadecimal digits (lowercase).");
  }
  process.env.E2E_SEED = given ?? randomBytes(8).toString("hex");
  return process.env.E2E_SEED;
}

let scope = "";
let issued = 0;

/** Starts the ids of one test attempt (the journey name): the same seed and scope give the same ids, in order. */
export function startCommandIds(name: string): void {
  scope = name;
  issued = 0;
}

/** The next `commandId`: a UUID v5 of the seed, the scope and a counter, never `randomUUID()`. */
export function nextCommandId(): string {
  issued += 1;
  return uuidV5(`${commandSeed()}/${scope}/${issued}`);
}

export interface SeededVariant {
  productId: string;
  productName: string;
  variantId: string;
}

export async function seedProduct(
  rpc: PolarisRpcClient,
  organizationId: string,
  name: string,
  listPrice: string | null = null
): Promise<SeededVariant> {
  const product = await rpc.product.create({ name, organizationId });
  const configuration = await rpc.product.getVariants({
    id: product.id,
    organizationId,
  });
  const [variant] = configuration.variants;
  if (!variant) {
    throw new Error(`The product ${name} has no default variant.`);
  }
  if (listPrice !== null) {
    await rpc.product.setVariantListPrice({
      expectedVersion: configuration.productVersion,
      listPrice,
      organizationId,
      productId: product.id,
      variantId: variant.id,
    });
  }
  return { productId: product.id, productName: name, variantId: variant.id };
}

export async function seedStock(
  rpc: PolarisRpcClient,
  organizationId: string,
  variantId: string,
  quantity: number,
  unitCost: string,
  occurredOn: string
): Promise<void> {
  await rpc.inventory.receiveStock({
    commandId: nextCommandId(),
    commandVersion: 1,
    occurredOn,
    organizationId,
    quantity,
    unitCost,
    variantId,
  });
}

export async function seedCashSale(
  rpc: PolarisRpcClient,
  organizationId: string,
  items: { variantId: string; quantity: number; price: string }[],
  occurredAt: string
): Promise<string> {
  const result = await rpc.sale.confirm({
    adjustments: [],
    commandId: nextCommandId(),
    commandVersion: 1,
    items: items.map((item) => ({
      chargedUnitPrice: item.price,
      listedUnitPrice: item.price,
      quantity: item.quantity,
      variantId: item.variantId,
    })),
    occurredAt,
    organizationId,
    payment: {
      anticipationRequested: false,
      installmentPlan: null,
      installments: null,
      method: "cash",
    },
    paymentProfile: null,
  });
  return result.sale.id;
}
