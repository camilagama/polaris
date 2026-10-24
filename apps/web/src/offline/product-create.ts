import type {
  LocalInventoryReadModel,
  LocalProductReadModel,
  LocalVariantReadModel,
} from "@polaris/contracts";
import {
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductVariantSku,
  normalizeVariantListPrice,
} from "@polaris/domain/catalog/product";
import { normalizeOpeningStockInput } from "@polaris/domain/inventory/opening-stock";
import { uuidv7 } from "../lib/uuidv7";
import type { LocalWriter } from "./bootstrap";
import type { OutboxCommand } from "./outbox/command";
import type { Outbox } from "./outbox/outbox";

/**
 * Creating a product (with its default variant and, optionally, the opening
 * stock) without a connection (plan PR55). The device names the product and the
 * variant with UUIDv7s, queues ONE `product.create` command and shows the rows
 * from the local collections at once. The command is the unit of atomicity: the
 * server creates the product, the variant and the stock together or refuses all
 * of it (`sku_conflict`, `product_id_conflict`, ...), so there is never a product
 * without the stock the person typed in the same form.
 *
 * A refused product stays visible and blocks the queue until a person
 * discards it (`discardPendingProduct`), which also removes its local rows.
 */
const PRODUCT_CREATE_COMMAND = "product.create";

interface OfflineProductInput {
  categoryId?: string | null;
  description?: string | null;
  initialStock?: {
    /** Calendar date of the receipt, `YYYY-MM-DD`. */
    occurredOn: string;
    quantity: number;
    /** BRL cost per unit as decimal text; `null` when the person does not know it. */
    unitCost: string | null;
  } | null;
  /** BRL list price as decimal text, if any. */
  listPrice?: string | null;
  name: string;
  sku?: string | null;
}

export interface CreateOfflineProductRequest {
  deviceId: string;
  input: OfflineProductInput;
  /** The signed lease token the device holds for this organization (PR49). */
  lease: string;
  newCommandId?: () => string;
  newProductId?: () => string;
  newVariantId?: () => string;
  now?: () => Date;
  organizationId: string;
  outbox: Outbox;
  writer: LocalWriter;
}

// biome-ignore lint/style/useConsistentTypeDefinitions: unlike an interface, a type alias is assignable to the outbox's JSON payload type
type ProductCreatePayload = {
  categoryId: string | null;
  description: string | null;
  initialStock: {
    occurredOn: string;
    quantity: number;
    unitCost: string | null;
  } | null;
  listPrice: string | null;
  name: string;
  productId: string;
  sku: string | null;
  variantId: string;
};

export interface OfflineProductRows {
  inventory: LocalInventoryReadModel | null;
  product: LocalProductReadModel;
  variant: LocalVariantReadModel;
}

export class ProductHasDependentCommandsError extends Error {
  constructor() {
    super("product_has_dependent_commands");
    this.name = "ProductHasDependentCommandsError";
  }
}

function localRows(
  payload: ProductCreatePayload,
  at: string
): OfflineProductRows {
  return {
    inventory: payload.initialStock
      ? {
          productId: payload.productId,
          quantity: payload.initialStock.quantity,
          updatedAt: at,
          variantId: payload.variantId,
          // The server assigns the real version; this is what a first receipt leaves.
          version: 1,
        }
      : null,
    product: {
      archivedAt: null,
      categoryId: payload.categoryId,
      deletedAt: null,
      description: payload.description,
      id: payload.productId,
      name: payload.name,
      updatedAt: at,
      version: 1,
    },
    variant: {
      id: payload.variantId,
      isDefault: true,
      listPrice: payload.listPrice,
      position: null,
      productId: payload.productId,
      sku: payload.sku,
      values: [],
    },
  };
}

async function writeRows(
  writer: LocalWriter,
  rows: OfflineProductRows
): Promise<void> {
  await writer.upsert("products", [rows.product]);
  await writer.upsert("variants", [rows.variant]);
  if (rows.inventory) {
    await writer.upsert("inventory", [rows.inventory]);
  }
}

/** The same rules the server applies, so a form the device accepts is never refused for its shape. */
function normalizeInput(
  input: OfflineProductInput,
  ids: { productId: string; variantId: string }
): Omit<ProductCreatePayload, "productId" | "variantId"> {
  const initialStock = input.initialStock ?? null;
  if (initialStock) {
    // Throws the stock domain errors for a quantity, cost or date the server would refuse.
    normalizeOpeningStockInput({
      commandId: ids.productId,
      occurredOn: initialStock.occurredOn,
      quantity: initialStock.quantity,
      unitCost: initialStock.unitCost,
      variantId: ids.variantId,
    });
  }
  return {
    categoryId: input.categoryId ?? null,
    description: normalizeProductDescription(input.description),
    initialStock: initialStock
      ? {
          occurredOn: initialStock.occurredOn,
          quantity: initialStock.quantity,
          unitCost: initialStock.unitCost?.trim() ?? null,
        }
      : null,
    listPrice: normalizeVariantListPrice(input.listPrice),
    name: normalizeProductName(input.name),
    sku: normalizeProductVariantSku(input.sku),
  };
}

export async function createOfflineProduct(
  request: CreateOfflineProductRequest
): Promise<{ command: OutboxCommand; rows: OfflineProductRows }> {
  const now = (request.now ?? (() => new Date()))();
  const ids = {
    productId: (request.newProductId ?? uuidv7)(),
    variantId: (request.newVariantId ?? uuidv7)(),
  };
  const payload: ProductCreatePayload = {
    ...normalizeInput(request.input, ids),
    ...ids,
  };
  const command = await request.outbox.enqueue({
    baseVersion: null,
    commandId: (request.newCommandId ?? crypto.randomUUID.bind(crypto))(),
    deviceId: request.deviceId,
    lease: request.lease,
    organizationId: request.organizationId,
    payload,
    type: PRODUCT_CREATE_COMMAND,
  });
  const rows = localRows(payload, now.toISOString());
  await writeRows(request.writer, rows);
  return { command, rows };
}

function isProductPayload(value: unknown): value is ProductCreatePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.productId === "string" &&
    typeof row.variantId === "string" &&
    typeof row.name === "string"
  );
}

/** What the interface shows next to each pending product. */
export interface PendingProduct {
  code: string | null;
  commandId: string;
  productId: string;
  state: "pending" | "sending" | "rejected";
  variantId: string;
}

export async function pendingProducts(
  outbox: Outbox
): Promise<PendingProduct[]> {
  const { commands } = await outbox.snapshot();
  return commands
    .filter((command) => command.type === PRODUCT_CREATE_COMMAND)
    .flatMap((command) =>
      isProductPayload(command.payload)
        ? [
            {
              code: command.rejection?.code ?? null,
              commandId: command.commandId,
              productId: command.payload.productId,
              state: command.status,
              variantId: command.payload.variantId,
            },
          ]
        : []
    );
}

/**
 * Writes the local rows of every product still queued, again. Idempotent: it
 * restores rows lost to a crash between queueing and writing, and keeps a
 * rejected product visible (needing attention) after a bootstrap.
 */
export async function restorePendingProducts(
  outbox: Outbox,
  writer: LocalWriter
): Promise<number> {
  const { commands } = await outbox.snapshot();
  const queued = commands.filter(
    (command) => command.type === PRODUCT_CREATE_COMMAND
  );
  let restored = 0;
  for (const command of queued) {
    if (isProductPayload(command.payload)) {
      // biome-ignore lint/performance/noAwaitInLoops: rows are restored in queue order
      await writeRows(writer, localRows(command.payload, command.createdAt));
      restored += 1;
    }
  }
  return restored;
}

/**
 * The explicit "throw this product away" action for one that was refused (or
 * that the person no longer wants): removes the command and its local rows.
 * Refused while a later queued command refers to the product or its variant,
 * because discarding would leave that command pointing at nothing.
 */
export async function discardPendingProduct(
  outbox: Outbox,
  writer: LocalWriter,
  commandId: string
): Promise<void> {
  const { commands } = await outbox.snapshot();
  const target = commands.find((command) => command.commandId === commandId);
  if (
    !(
      target &&
      target.type === PRODUCT_CREATE_COMMAND &&
      isProductPayload(target.payload)
    )
  ) {
    throw new Error("not_a_pending_product");
  }
  if (target.status === "sending") {
    // the server may already have created it: wait for the answer
    throw new Error("product_is_sending");
  }
  const { productId, variantId } = target.payload;
  const dependent = commands.some(
    (command) =>
      command.commandId !== commandId &&
      (JSON.stringify(command.payload).includes(productId) ||
        JSON.stringify(command.payload).includes(variantId))
  );
  if (dependent) {
    throw new ProductHasDependentCommandsError();
  }
  await outbox.discard(commandId);
  await writer.remove("inventory", [variantId]);
  await writer.remove("variants", [variantId]);
  await writer.remove("products", [productId]);
}
