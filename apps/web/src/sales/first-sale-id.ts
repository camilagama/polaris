import { firstSaleConfirmed } from "../app-shell/first-steps";
import type { SubmissionState } from "./sale-form-model";

/**
 * The id of the sale the confirmation panel announces as the first of the store, or null.
 * A sale answered as replayed counts: the answer of the first try never came, and the steps were still open.
 */
export function firstSaleIdOf(
  organizationId: string,
  submission: SubmissionState
): string | null {
  const confirmed = submission.phase === "confirmed" ? submission.sale : null;
  const first = firstSaleConfirmed(organizationId);
  return first && confirmed ? confirmed.saleId : null;
}
