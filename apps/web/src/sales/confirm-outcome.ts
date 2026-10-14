import type { RuntimeContext } from "../offline/runtime/offline-runtime";
import type { ConfirmedLinePrices } from "./last-prices-model";
import {
  DeviceSaleNotCarriableError,
  queueOfflineSale,
} from "./queue-offline-sale";
import {
  localDay,
  type PreparedConfirmation,
  queuedSubmission,
  rejectSubmission,
  type SaleAttempt,
  type SubmissionState,
} from "./sale-form-model";

export type Prepared = Extract<PreparedConfirmation, { ok: true }>;

/** What the page does after a confirmation was tried, online or on the device. */
export interface ConfirmationOutcome {
  /** The attempt to remember afterwards (null once the sale is settled). */
  attempt: SaleAttempt | null;
  /** The sale is done: the form starts over. */
  completed: boolean;
  /** Prices to suggest on the next sale, when the sale was recorded. */
  prices: { day: string; lines: readonly ConfirmedLinePrices[] } | null;
  submission: SubmissionState;
}

const NOT_CARRIABLE =
  "Esta venda tem data própria, e o aparelho não a guarda: ela só pode ser confirmada com conexão.";

const QUEUE_FAILURE =
  "Não foi possível guardar a venda neste aparelho. Confira a validade da autorização offline e o espaço do aparelho, e tente de novo. Nada foi guardado.";

/**
 * Keeps the sale on this device (no connection). A failure here is definite:
 * nothing was queued, so editing stays allowed and the same attempt can be tried again.
 */
export async function confirmOnDevice(
  prepared: Prepared,
  stores: RuntimeContext,
  labels: ReadonlyMap<string, string>
): Promise<ConfirmationOutcome> {
  try {
    const queued = await queueOfflineSale({
      labels,
      request: prepared.request,
      stores,
    });
    return {
      attempt: null,
      completed: true,
      prices: {
        day: localDay(prepared.request.occurredAt),
        lines: prepared.request.items,
      },
      submission: queuedSubmission(queued),
    };
  } catch (error) {
    return {
      attempt: prepared.attempt,
      completed: false,
      prices: null,
      submission: rejectSubmission(
        error instanceof DeviceSaleNotCarriableError
          ? NOT_CARRIABLE
          : QUEUE_FAILURE
      ),
    };
  }
}
