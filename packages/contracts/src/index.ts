import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import {
  MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS,
  WRITE_OFF_REASON_CODES,
} from "@polaris/domain/inventory/write-off-stock";
import { z } from "zod";

export function categoryNameCodePointLength(name: string): number {
  return [...name.trim()].length;
}

export const categoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => categoryNameCodePointLength(name) <= 100, {
    message: "invalid_category_name",
  });

export const productNameSchema = z.string().trim().min(1);

const category = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["active", "archived", "deleted"]),
  updatedAt: z.string(),
});

export type CategoryReadModel = z.infer<typeof category>;

const product = z.object({
  archivedAt: z.string().nullable(),
  categoryId: z.string().uuid().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  description: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["active", "archived", "deleted"]),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

export type ProductReadModel = z.infer<typeof product>;

const customerProfileFields = z.object({
  email: z
    .union([z.string().trim().email(), z.string().trim().length(0)])
    .nullable(),
  name: z.string().trim().min(1),
  notes: z.string().trim().nullable(),
  phone: z.string().trim().nullable(),
});

function requireCustomerContact(
  input: {
    email?: string | null | undefined;
    phone?: string | null | undefined;
  },
  ctx: z.RefinementCtx
) {
  if (!(input.phone || input.email)) {
    ctx.addIssue({
      code: "custom",
      message: "customer_contact_required",
      path: ["phone"],
    });
  }
}

const customer = z.object({
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  email: z.string().nullable(),
  id: z.string().uuid(),
  name: z.string().min(1),
  notes: z.string().nullable(),
  organizationId: z.string().min(1),
  phone: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
});

export type CustomerReadModel = z.infer<typeof customer>;

const customerDuplicateSearchFields = z
  .object({
    email: customerProfileFields.shape.email.optional(),
    phone: customerProfileFields.shape.phone.optional(),
  })
  .superRefine(requireCustomerContact);

const customerDuplicateMatch = z.object({
  customer,
  matchedBy: z.array(z.enum(["email", "phone"])).min(1),
});

export type CustomerDuplicateMatchReadModel = z.infer<
  typeof customerDuplicateMatch
>;

export const productMediaAssetReadModelSchema = z.object({
  assetId: z.string().uuid(),
  byteSize: z.number().int().positive().max(20_000_000),
  contentType: z.literal("image/webp"),
  createdAt: z.string().datetime(),
  height: z.number().int().positive().max(1200),
  position: z.number().int().nonnegative(),
  variantIds: z.array(z.string().uuid()),
  width: z.number().int().positive().max(1200),
});

export type ProductMediaAssetReadModel = z.infer<
  typeof productMediaAssetReadModelSchema
>;

export const productMediaUploadResponseSchema = z.object({
  asset: productMediaAssetReadModelSchema,
  replayed: z.boolean(),
  requestId: z.string().uuid(),
});

export type ProductMediaUploadResponse = z.infer<
  typeof productMediaUploadResponseSchema
>;

export const productMediaListResponseSchema = z.object({
  media: z.array(productMediaAssetReadModelSchema),
  requestId: z.string().uuid(),
});

export type ProductMediaListResponse = z.infer<
  typeof productMediaListResponseSchema
>;

const productVariantOptionName = z.enum(["model", "color", "size"]);

const productVariantOptionValue = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
});

const productVariantOption = z.object({
  id: z.string().uuid(),
  name: productVariantOptionName,
  position: z.number().int().nonnegative(),
  values: z.array(productVariantOptionValue),
});

const productVariantOptionAssignment = z.object({
  optionName: productVariantOptionName,
  optionValueId: z.string().uuid(),
  optionValueName: z.string().min(1),
});

const productVariant = z.object({
  id: z.string().uuid(),
  isDefault: z.boolean(),
  position: z.number().int().nonnegative().nullable(),
  sku: z.string().nullable(),
  values: z.array(productVariantOptionAssignment),
});

const productVariantConfiguration = z.object({
  configured: z.boolean(),
  options: z.array(productVariantOption),
  productVersion: z.number().int().positive(),
  variants: z.array(productVariant),
});

export type ProductVariantOptionName = z.infer<typeof productVariantOptionName>;
export type ProductVariantConfigurationReadModel = z.infer<
  typeof productVariantConfiguration
>;

const normalizedBrlCost = z.string().regex(/^\d{1,18}\.\d{6}$/);
const writeOffReasonNote = z
  .string()
  .trim()
  .min(1)
  .refine((note) => [...note].length <= MAX_WRITE_OFF_REASON_NOTE_CODE_POINTS, {
    message: "invalid_write_off_reason_note",
  });

const inventoryBalance = z.object({
  movingAverageCost: normalizedBrlCost.nullable(),
  quantity: z.number().int().nonnegative().max(2_147_483_647),
  variantId: z.string().uuid(),
  version: z.number().int().nonnegative().max(2_147_483_647),
});

const stockReceiptMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  id: z.string().uuid(),
  movementType: z.literal("receipt"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().positive().max(2_147_483_647),
  unitCost: normalizedBrlCost,
  variantId: z.string().uuid(),
});

const stockWriteOffMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  id: z.string().uuid(),
  movementType: z.literal("write_off"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().negative().min(-2_147_483_647),
  reasonCode: z.enum(WRITE_OFF_REASON_CODES),
  reasonNote: writeOffReasonNote.nullable(),
  unitCost: normalizedBrlCost.nullable(),
  variantId: z.string().uuid(),
});

export type InventoryBalanceReadModel = z.infer<typeof inventoryBalance>;
export type StockReceiptMovementReadModel = z.infer<
  typeof stockReceiptMovement
>;
export type StockWriteOffMovementReadModel = z.infer<
  typeof stockWriteOffMovement
>;

const inventoryCountMovement = z.object({
  commandId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  commandVersion: z.number().int().positive(),
  createdAt: z.string(),
  expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  id: z.string().uuid(),
  movementType: z.literal("inventory_count"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  organizationId: z.string().trim().min(1),
  physicalQuantity: z.number().int().nonnegative().max(2_147_483_647),
  productId: z.string().uuid(),
  quantityDelta: z.number().int().min(-2_147_483_647).max(2_147_483_647),
  unitCost: normalizedBrlCost.nullable(),
  variantId: z.string().uuid(),
});

export type InventoryCountMovementReadModel = z.infer<
  typeof inventoryCountMovement
>;

const organization = z.object({
  currency: z.literal("BRL"),
  id: z.string().uuid(),
  name: z.string().min(1),
  status: z.enum(["active", "suspended", "closed"]),
  timezone: z.string().min(1),
});

export const polarisContract = {
  category: {
    archive: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    create: oc
      .input(
        z.object({
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(category),
    delete: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ categories: z.array(category) })),
    rename: oc
      .input(
        z.object({
          id: z.string().uuid(),
          name: categoryNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
    restore: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ category, changed: z.boolean() })),
  },
  customer: {
    archive: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    create: oc
      .input(
        customerProfileFields
          .extend({ organizationId: z.string().trim().min(1) })
          .superRefine(requireCustomerContact)
      )
      .output(customer),
    findPossibleDuplicates: oc
      .input(
        customerDuplicateSearchFields.extend({
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ matches: z.array(customerDuplicateMatch) })),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z.enum(["active", "archived", "all"]).default("active"),
        })
      )
      .output(z.object({ customers: z.array(customer) })),
    restore: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), customer })),
    update: oc
      .input(
        customerProfileFields
          .extend({
            expectedVersion: z.number().int().positive(),
            id: z.string().uuid(),
            organizationId: z.string().trim().min(1),
          })
          .superRefine(requireCustomerContact)
      )
      .output(z.object({ changed: z.boolean(), customer })),
  },
  inventory: {
    getBalance: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          variantId: z.string().uuid(),
        })
      )
      .output(inventoryBalance),
    inventoryCount: oc
      .input(
        z
          .object({
            commandId: z.string().uuid(),
            commandVersion: z.literal(1),
            expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            organizationId: z.string().trim().min(1),
            physicalQuantity: z.number().int().nonnegative().max(2_147_483_647),
            valuationUnitCost: z.string().trim().min(1).optional(),
            variantId: z.string().uuid(),
          })
          .superRefine((input, ctx) => {
            if (
              input.physicalQuantity === 0 &&
              input.valuationUnitCost !== undefined
            ) {
              ctx.addIssue({
                code: "custom",
                message: "inventory_count_zero_cannot_set_unit_cost",
                path: ["valuationUnitCost"],
              });
            }
          })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: inventoryCountMovement,
          replayed: z.boolean(),
        })
      ),
    receiveStock: oc
      .input(
        z.object({
          commandId: z.string().uuid(),
          commandVersion: z.literal(1),
          occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          organizationId: z.string().trim().min(1),
          quantity: z.number().int().positive().max(2_147_483_647),
          unitCost: z.string().trim().min(1),
          variantId: z.string().uuid(),
        })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: stockReceiptMovement,
          replayed: z.boolean(),
        })
      ),
    writeOffStock: oc
      .input(
        z
          .object({
            commandId: z.string().uuid(),
            commandVersion: z.literal(1),
            occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            organizationId: z.string().trim().min(1),
            quantity: z.number().int().positive().max(2_147_483_647),
            reasonCode: z.enum(WRITE_OFF_REASON_CODES),
            reasonNote: writeOffReasonNote.nullable().optional(),
            variantId: z.string().uuid(),
          })
          .superRefine((input, ctx) => {
            if (input.reasonCode === "other" && !input.reasonNote) {
              ctx.addIssue({
                code: "custom",
                message: "write_off_reason_note_required",
                path: ["reasonNote"],
              });
            }
          })
      )
      .output(
        z.object({
          balance: inventoryBalance,
          movement: stockWriteOffMovement,
          replayed: z.boolean(),
        })
      ),
  },
  organization: {
    createInitial: oc
      .input(
        z.object({
          name: z.string().trim().min(1).max(128),
          timezone: z.string().trim().min(1).max(64),
        })
      )
      .output(z.object({ created: z.boolean(), organization })),
  },
  product: {
    archive: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    configureVariants: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          options: z
            .array(
              z.object({
                name: productVariantOptionName,
                values: z.array(z.string().trim().min(1)).min(1),
              })
            )
            .min(1)
            .max(3),
          organizationId: z.string().trim().min(1),
          variants: z
            .array(
              z.object({
                values: z
                  .object({
                    color: z.string().trim().min(1).optional(),
                    model: z.string().trim().min(1).optional(),
                    size: z.string().trim().min(1).optional(),
                  })
                  .strict(),
              })
            )
            .min(1)
            .max(50),
        })
      )
      .output(
        z.object({
          configuration: productVariantConfiguration,
          product,
        })
      ),
    create: oc
      .input(
        z.object({
          categoryId: z.string().uuid().nullable().optional(),
          description: z.string().nullable().optional(),
          name: productNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(product),
    delete: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    getVariants: oc
      .input(
        z.object({
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(productVariantConfiguration),
    list: oc
      .input(
        z.object({
          organizationId: z.string().trim().min(1),
          status: z
            .enum(["active", "archived", "deleted", "all"])
            .default("active"),
        })
      )
      .output(z.object({ products: z.array(product) })),
    restore: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
    setVariantSku: oc
      .input(
        z.object({
          expectedVersion: z.number().int().positive(),
          organizationId: z.string().trim().min(1),
          productId: z.string().uuid(),
          sku: z.string().nullable(),
          variantId: z.string().uuid(),
        })
      )
      .output(
        z.object({
          changed: z.boolean(),
          configuration: productVariantConfiguration,
          product,
        })
      ),
    update: oc
      .input(
        z.object({
          categoryId: z.string().uuid().nullable(),
          description: z.string().nullable(),
          expectedVersion: z.number().int().positive(),
          id: z.string().uuid(),
          name: productNameSchema,
          organizationId: z.string().trim().min(1),
        })
      )
      .output(z.object({ changed: z.boolean(), product })),
  },
  system: {
    ping: oc.output(z.object({ message: z.literal("pong") })),
  },
};

export type PolarisRpcClient = ContractRouterClient<typeof polarisContract>;
