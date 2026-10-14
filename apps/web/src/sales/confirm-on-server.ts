import { orpcClient } from "../lib/orpc";
import type { ConfirmationOutcome, Prepared } from "./confirm-outcome";
import {
  attemptAfterFailure,
  confirmSubmission,
  failSubmission,
} from "./sale-form-model";

/** Sends the sale to the server, which confirms it before answering. */
export async function confirmOnServer(
  prepared: Prepared
): Promise<ConfirmationOutcome> {
  try {
    const sale = await orpcClient.sale.confirm(prepared.request);
    return {
      attempt: null,
      completed: true,
      prices: { day: sale.sale.occurredOn, lines: sale.items },
      submission: confirmSubmission(sale),
    };
  } catch (error) {
    const submission = failSubmission(error);
    return {
      attempt: attemptAfterFailure(submission, prepared.attempt),
      completed: false,
      prices: null,
      submission,
    };
  }
}
