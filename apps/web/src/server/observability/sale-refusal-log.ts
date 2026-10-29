import { logger, opaqueId } from "@polaris/observability/logger";

/**
 * A sale the stock did not cover, counted by store. Said where the refusal is known (the confirmation or the sync of
 * a queued sale), not in the error mapping, which the stock write-off shares. No product and no amount: the count
 * is all it carries.
 */
export function logSaleRefusedInsufficientStock(fields: {
  organizationId: string;
  origin: "online" | "sync";
  requestId: string | undefined;
}): void {
  logger.info("sale_refused_insufficient_stock", {
    organizationId: opaqueId(fields.organizationId),
    origin: fields.origin,
    requestId: fields.requestId,
  });
}
