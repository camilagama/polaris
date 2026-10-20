import { randomUUID } from "node:crypto";
import type { PolarisRpcClient } from "@polaris/contracts";

/**
 * The starting data of a journey, through the Worker's own commands (the same `/rpc` the screens call), never
 * by SQL: ledger, snapshot and RLS apply to it like to anything the user does.
 */

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
    commandId: randomUUID(),
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
    commandId: randomUUID(),
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
