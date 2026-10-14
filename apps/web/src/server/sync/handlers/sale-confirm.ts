import {
  type OfflineSalePayload,
  offlineSalePayloadSchema,
} from "@polaris/contracts";
import { confirmSale } from "@polaris/db/sale-repository";
import {
  InsufficientStockError,
  InventoryQuantityLimitError,
  InventoryVariantNotFoundError,
} from "@polaris/domain/inventory/inventory";
import {
  InvalidConfirmSaleCommandError,
  normalizeConfirmSaleCommand,
  SaleCommandConflictError,
  SaleOccurredInFutureError,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import { InvalidSaleSnapshotError } from "@polaris/domain/sales/sale";
import {
  InvalidSaleAdjustmentError,
  SaleAdjustmentLimitError,
  SaleDiscountExceedsSubtotalError,
} from "@polaris/domain/sales/sale-adjustments";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { InvalidSalePaymentError } from "@polaris/domain/sales/sale-payment";
import { InvalidSyncPayloadError, type SyncCommandHandler } from "../push";
import { withCapability } from "./identity";

/**
 * `sale.confirm` (plan PR57): a sale made without a connection, confirmed by the
 * same `confirmSale` the online screen uses. The sale already carries what makes
 * it safe to replay (the command ID, the commercial time and the device's
 * `recordedAt` as evidence), so this handler only translates the payload and
 * names the refusals.
 *
 * Stock is server-authoritative: the sale takes its stock under the ledger's
 * locks and is refused whole (`insufficient_stock`) if any line does not fit,
 * leaving no sale, no payment and no movement. A device never decides that a sale
 * fits; it only learns it after syncing.
 */
const SALE_CREATE = "sale:create";

const SALE_REFUSAL = {
  commandConflict: "sale_command_conflict",
  dateInFuture: "sale_occurred_in_future",
  insufficientStock: "insufficient_stock",
  invalidPayload: "invalid_payload",
  productUnavailable: "sale_product_unavailable",
  tooOld: "sale_occurred_too_old",
  variantNotFound: "variant_not_found",
} as const;

const payloadErrors = [
  InvalidConfirmSaleCommandError,
  InvalidSaleAdjustmentError,
  InvalidSalePaymentError,
  InvalidSaleSnapshotError,
  InventoryQuantityLimitError,
  SaleAdjustmentLimitError,
  SaleDiscountExceedsSubtotalError,
];

const placeholderCommandId = "00000000-0000-7000-8000-000000000000";
const skipClockCheck = new Date("2200-01-01T00:00:00.000Z");

function classify(error: unknown): string | null {
  if (error instanceof InsufficientStockError) {
    return SALE_REFUSAL.insufficientStock;
  }
  if (error instanceof SaleProductUnavailableError) {
    return SALE_REFUSAL.productUnavailable;
  }
  if (error instanceof InventoryVariantNotFoundError) {
    return SALE_REFUSAL.variantNotFound;
  }
  if (error instanceof SaleOccurredTooOldError) {
    return SALE_REFUSAL.tooOld;
  }
  if (error instanceof SaleOccurredInFutureError) {
    return SALE_REFUSAL.dateInFuture;
  }
  if (error instanceof SaleCommandConflictError) {
    return SALE_REFUSAL.commandConflict;
  }
  return payloadErrors.some((type) => error instanceof type)
    ? SALE_REFUSAL.invalidPayload
    : null;
}

function parsePayload(payload: unknown): OfflineSalePayload {
  const parsed = offlineSalePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidSyncPayloadError({ cause: parsed.error });
  }
  try {
    // The same normalization the repository runs: a sale it would refuse for its
    // shape or its amounts is refused here as an invalid payload.
    // The clock check is skipped here (a far-future "now"): a sale dated ahead
    // of the server clock is its own refusal at execution, `sale_occurred_in_future`.
    normalizeConfirmSaleCommand(
      {
        ...parsed.data,
        commandId: placeholderCommandId,
        commandVersion: 1,
        paymentProfile: null,
      },
      skipClockCheck
    );
  } catch (error) {
    if (payloadErrors.some((type) => error instanceof type)) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new InvalidSyncPayloadError({ cause: error });
    }
    throw error;
  }
  return parsed.data;
}

export function createSaleConfirmHandler(
  dependencies: { confirmSale: typeof confirmSale } = { confirmSale }
): SyncCommandHandler {
  return {
    capability: SALE_CREATE,
    classify,
    async execute(transaction, identity, payload, context) {
      const input = payload as OfflineSalePayload;
      const result = await dependencies.confirmSale(
        transaction,
        withCapability(identity, SALE_CREATE),
        {
          adjustments: input.adjustments,
          commandId: context.commandId,
          commandVersion: 1,
          items: input.items,
          occurredAt: input.occurredAt,
          payment: input.payment,
          paymentProfile: null,
          recordedAt: input.recordedAt,
          requestId: context.commandId,
        }
      );
      return {
        confirmedAt: result.sale.confirmedAt.toISOString(),
        saleId: result.sale.id,
        totalDue: result.totals.totalDue,
      };
    },
    parse: parsePayload,
    type: "sale.confirm",
  };
}
