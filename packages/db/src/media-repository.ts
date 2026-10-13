import {
  MAX_PRODUCT_MEDIA,
  MediaUploadCommandConflictError,
  ProductMediaLimitError,
} from "@polaris/domain/catalog/media";
import {
  MAX_PRODUCT_VARIANTS,
  ProductDeletedError,
  ProductNotFoundError,
  ProductVariantNotFoundError,
} from "@polaris/domain/catalog/product";
import { and, asc, count, eq, inArray, max } from "drizzle-orm";
import { mediaAssets, productMedia, variantMedia } from "./schema/media";
import { products, productVariants } from "./schema/product";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

export interface ProductMediaReadModel {
  assetId: string;
  byteSize: number;
  contentType: "image/webp";
  createdAt: string;
  height: number;
  position: number;
  variantIds: string[];
  width: number;
}

export interface MediaAssetStorageRecord {
  assetId: string;
  byteSize: number;
  contentType: "image/webp";
  height: number;
  storageKey: string;
  width: number;
}

export interface CreateProductMediaAssetInput {
  byteSize: number;
  height: number;
  inputFingerprint: string;
  productId: string;
  requestId?: string | null;
  storageKey: string;
  uploadCommandId: string;
  variantIds: readonly string[];
  width: number;
}

function mediaReadModel(
  row: {
    assetId: string;
    byteSize: number;
    contentType: string;
    createdAt: Date;
    height: number;
    position: number;
    width: number;
  },
  variantIds: string[] = []
): ProductMediaReadModel {
  if (row.contentType !== "image/webp") {
    throw new Error("media_asset_content_type_invalid");
  }
  return {
    assetId: row.assetId,
    byteSize: row.byteSize,
    contentType: "image/webp",
    createdAt: row.createdAt.toISOString(),
    height: row.height,
    position: row.position,
    variantIds,
    width: row.width,
  };
}

async function productMediaForCommand(
  transaction: TenantRequestTransaction,
  organizationId: string,
  uploadCommandId: string
) {
  const [row] = await transaction
    .select({
      assetId: mediaAssets.id,
      byteSize: mediaAssets.byteSize,
      contentType: mediaAssets.contentType,
      createdAt: mediaAssets.createdAt,
      height: mediaAssets.height,
      inputFingerprint: mediaAssets.inputFingerprint,
      position: productMedia.position,
      productId: productMedia.productId,
      uploadCommandId: mediaAssets.uploadCommandId,
      width: mediaAssets.width,
    })
    .from(mediaAssets)
    .innerJoin(
      productMedia,
      and(
        eq(productMedia.organizationId, mediaAssets.organizationId),
        eq(productMedia.mediaAssetId, mediaAssets.id)
      )
    )
    .where(
      and(
        eq(mediaAssets.organizationId, organizationId),
        eq(mediaAssets.uploadCommandId, uploadCommandId)
      )
    )
    .limit(1);
  return row;
}

async function replayProductMediaUpload(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductMediaAssetInput,
  existing: NonNullable<Awaited<ReturnType<typeof productMediaForCommand>>>
): Promise<{ asset: ProductMediaReadModel; replayed: true }> {
  if (
    existing.inputFingerprint !== input.inputFingerprint ||
    existing.productId !== input.productId
  ) {
    throw new MediaUploadCommandConflictError();
  }

  const variantRows = await transaction
    .select({ variantId: variantMedia.variantId })
    .from(variantMedia)
    .where(
      and(
        eq(variantMedia.organizationId, identity.organizationId),
        eq(variantMedia.productId, input.productId),
        eq(variantMedia.mediaAssetId, existing.assetId)
      )
    );
  return {
    asset: mediaReadModel(
      existing,
      variantRows.map((row) => row.variantId)
    ),
    replayed: true,
  };
}

async function productPosition(
  transaction: TenantRequestTransaction,
  organizationId: string,
  productId: string
): Promise<number> {
  const [row] = await transaction
    .select({ position: max(productMedia.position) })
    .from(productMedia)
    .where(
      and(
        eq(productMedia.organizationId, organizationId),
        eq(productMedia.productId, productId)
      )
    );
  const next = (row?.position ?? -1) + 1;
  if (!Number.isSafeInteger(next) || next > 2_147_483_647) {
    throw new Error("media_position_limit_reached");
  }
  return next;
}

// Technical ceiling per product, enforced under the product row lock so
// concurrent uploads cannot overshoot it.
async function assertProductMediaCapacity(
  transaction: TenantRequestTransaction,
  organizationId: string,
  productId: string
): Promise<void> {
  const [row] = await transaction
    .select({ total: count() })
    .from(productMedia)
    .where(
      and(
        eq(productMedia.organizationId, organizationId),
        eq(productMedia.productId, productId)
      )
    );
  if ((row?.total ?? 0) >= MAX_PRODUCT_MEDIA) {
    throw new ProductMediaLimitError();
  }
}

export async function findMediaUploadCommand(
  transaction: TenantRequestTransaction,
  organizationId: string,
  uploadCommandId: string
) {
  const existing = await productMediaForCommand(
    transaction,
    organizationId,
    uploadCommandId
  );
  if (!existing) {
    return null;
  }
  const media = await listProductMedia(
    transaction,
    organizationId,
    existing.productId
  );
  const asset = media.find((entry) => entry.assetId === existing.assetId);
  if (!asset) {
    throw new Error("media_upload_command_link_missing");
  }
  return {
    asset,
    inputFingerprint: existing.inputFingerprint,
    productId: existing.productId,
  };
}

export async function assertProductCanReceiveMedia(
  transaction: TenantRequestTransaction,
  organizationId: string,
  productId: string,
  variantIds: readonly string[] = []
): Promise<void> {
  const [product] = await transaction
    .select({ deletedAt: products.deletedAt })
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.id, productId)
      )
    )
    .for("update");

  if (!product) {
    throw new ProductNotFoundError();
  }
  if (product.deletedAt) {
    throw new ProductDeletedError();
  }

  await assertProductMediaCapacity(transaction, organizationId, productId);

  const uniqueVariantIds = [...new Set(variantIds)];
  if (
    uniqueVariantIds.length !== variantIds.length ||
    uniqueVariantIds.length > MAX_PRODUCT_VARIANTS
  ) {
    throw new ProductVariantNotFoundError();
  }
  if (uniqueVariantIds.length > 0) {
    const variants = await transaction
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          eq(productVariants.productId, productId),
          inArray(productVariants.id, uniqueVariantIds)
        )
      );
    if (variants.length !== uniqueVariantIds.length) {
      throw new ProductVariantNotFoundError();
    }
  }
}

export async function createProductMediaAsset(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateProductMediaAssetInput
): Promise<{ asset: ProductMediaReadModel; replayed: boolean }> {
  const { organizationId } = identity;
  let existing = await productMediaForCommand(
    transaction,
    organizationId,
    input.uploadCommandId
  );
  if (existing) {
    return await replayProductMediaUpload(
      transaction,
      identity,
      input,
      existing
    );
  }

  const [product] = await transaction
    .select({ deletedAt: products.deletedAt })
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.id, input.productId)
      )
    )
    .for("update");
  if (!product) {
    throw new ProductNotFoundError();
  }

  // A command may have committed while this request waited for the product lock.
  existing = await productMediaForCommand(
    transaction,
    organizationId,
    input.uploadCommandId
  );
  if (existing) {
    return await replayProductMediaUpload(
      transaction,
      identity,
      input,
      existing
    );
  }
  if (product.deletedAt) {
    throw new ProductDeletedError();
  }

  const variantIds = [...new Set(input.variantIds)].sort();
  if (variantIds.length !== input.variantIds.length) {
    throw new ProductVariantNotFoundError();
  }
  if (variantIds.length > MAX_PRODUCT_VARIANTS) {
    throw new ProductVariantNotFoundError();
  }
  if (variantIds.length > 0) {
    const variants = await transaction
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          eq(productVariants.productId, input.productId),
          inArray(productVariants.id, variantIds)
        )
      )
      .orderBy(asc(productVariants.id));
    if (variants.length !== variantIds.length) {
      throw new ProductVariantNotFoundError();
    }
  }

  await assertProductMediaCapacity(
    transaction,
    organizationId,
    input.productId
  );

  const [asset] = await transaction
    .insert(mediaAssets)
    .values({
      byteSize: input.byteSize,
      contentType: "image/webp",
      height: input.height,
      inputFingerprint: input.inputFingerprint,
      organizationId,
      storageKey: input.storageKey,
      uploadCommandId: input.uploadCommandId,
      width: input.width,
    })
    .onConflictDoNothing({
      target: [mediaAssets.organizationId, mediaAssets.uploadCommandId],
    })
    .returning({ createdAt: mediaAssets.createdAt, id: mediaAssets.id });

  if (!asset) {
    const racedUpload = await productMediaForCommand(
      transaction,
      organizationId,
      input.uploadCommandId
    );
    if (!racedUpload) {
      throw new MediaUploadCommandConflictError();
    }
    return await replayProductMediaUpload(
      transaction,
      identity,
      input,
      racedUpload
    );
  }

  const nextProductPosition = await productPosition(
    transaction,
    organizationId,
    input.productId
  );
  await transaction.insert(productMedia).values({
    mediaAssetId: asset.id,
    organizationId,
    position: nextProductPosition,
    productId: input.productId,
  });

  const linkedVariantIds = variantIds;
  if (variantIds.length > 0) {
    const currentPositions = await transaction
      .select({
        position: max(variantMedia.position),
        variantId: variantMedia.variantId,
      })
      .from(variantMedia)
      .where(
        and(
          eq(variantMedia.organizationId, organizationId),
          eq(variantMedia.productId, input.productId),
          inArray(variantMedia.variantId, variantIds)
        )
      )
      .groupBy(variantMedia.variantId);
    const positionByVariant = new Map(
      currentPositions.map((row) => [row.variantId, row.position])
    );
    const variantLinks = variantIds.map((variantId) => {
      const nextPosition = (positionByVariant.get(variantId) ?? -1) + 1;
      if (!Number.isSafeInteger(nextPosition) || nextPosition > 2_147_483_647) {
        throw new Error("media_position_limit_reached");
      }
      return {
        mediaAssetId: asset.id,
        organizationId,
        position: nextPosition,
        productId: input.productId,
        variantId,
      };
    });
    await transaction.insert(variantMedia).values(variantLinks);
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: input.productId,
    entityType: "product",
    eventType: "product.media_uploaded",
    requestId: input.requestId ?? null,
  });

  return {
    asset: {
      assetId: asset.id,
      byteSize: input.byteSize,
      contentType: "image/webp",
      createdAt: asset.createdAt.toISOString(),
      height: input.height,
      position: nextProductPosition,
      variantIds: linkedVariantIds,
      width: input.width,
    },
    replayed: false,
  };
}

export async function listProductMedia(
  transaction: TenantRequestTransaction,
  organizationId: string,
  productId: string
): Promise<ProductMediaReadModel[]> {
  const rows = await transaction
    .select({
      assetId: mediaAssets.id,
      byteSize: mediaAssets.byteSize,
      contentType: mediaAssets.contentType,
      createdAt: mediaAssets.createdAt,
      height: mediaAssets.height,
      position: productMedia.position,
      width: mediaAssets.width,
    })
    .from(productMedia)
    .innerJoin(
      mediaAssets,
      and(
        eq(mediaAssets.organizationId, productMedia.organizationId),
        eq(mediaAssets.id, productMedia.mediaAssetId)
      )
    )
    .where(
      and(
        eq(productMedia.organizationId, organizationId),
        eq(productMedia.productId, productId)
      )
    )
    .orderBy(asc(productMedia.position));

  if (rows.length === 0) {
    return [];
  }

  const links = await transaction
    .select({
      assetId: variantMedia.mediaAssetId,
      variantId: variantMedia.variantId,
    })
    .from(variantMedia)
    .where(
      and(
        eq(variantMedia.organizationId, organizationId),
        eq(variantMedia.productId, productId),
        inArray(
          variantMedia.mediaAssetId,
          rows.map((row) => row.assetId)
        )
      )
    );
  const variantIdsByAsset = new Map<string, string[]>();
  for (const link of links) {
    const variantIds = variantIdsByAsset.get(link.assetId) ?? [];
    variantIds.push(link.variantId);
    variantIdsByAsset.set(link.assetId, variantIds);
  }

  return rows.map((row) =>
    mediaReadModel(row, variantIdsByAsset.get(row.assetId) ?? [])
  );
}

export async function getMediaAssetForDelivery(
  transaction: TenantRequestTransaction,
  organizationId: string,
  assetId: string
): Promise<MediaAssetStorageRecord | null> {
  const [row] = await transaction
    .select({
      assetId: mediaAssets.id,
      byteSize: mediaAssets.byteSize,
      contentType: mediaAssets.contentType,
      height: mediaAssets.height,
      storageKey: mediaAssets.storageKey,
      width: mediaAssets.width,
    })
    .from(mediaAssets)
    .innerJoin(
      productMedia,
      and(
        eq(productMedia.organizationId, mediaAssets.organizationId),
        eq(productMedia.mediaAssetId, mediaAssets.id)
      )
    )
    .where(
      and(
        eq(mediaAssets.organizationId, organizationId),
        eq(mediaAssets.id, assetId)
      )
    )
    .limit(1);

  if (!row) {
    return null;
  }
  if (row.contentType !== "image/webp") {
    throw new Error("media_asset_content_type_invalid");
  }
  return { ...row, contentType: "image/webp" };
}
