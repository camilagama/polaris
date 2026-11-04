/**
 * The operator's provider commands (cancel the renewal, refund the period in force), given from the Admin under an
 * open case of the store. What the operator types as the reason goes to the billing ledger with the actor, never to
 * the audit; the purge replaces it, as it does every free text of the store.
 */

export type OperatorCommandKind = "cancel_renewal" | "refund";

export const OPERATOR_REASON_MAX_LENGTH = 300;

/** The reason as it is kept (trimmed), or null when it is empty, longer than 300 characters or has a control character. */
export function normalizeOperatorReason(reason: string): string | null {
  const text = reason.trim();
  const { length } = [...text];
  if (length < 1 || length > OPERATOR_REASON_MAX_LENGTH) {
    return null;
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return null;
    }
  }
  return text;
}

const COMMAND_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ledger ID of the operator's decision: one per command ID, so a repeat of the same command writes no second row. */
export function operatorDecisionEventId(
  kind: OperatorCommandKind,
  commandId: string
): string {
  const id = commandId.toLowerCase();
  if (!COMMAND_ID.test(id)) {
    throw new TypeError("invalid_command_id");
  }
  return `command:operator_${kind}:${id}`;
}

/** The `type` of the ledger row of the decision. */
export function operatorDecisionFactType(kind: OperatorCommandKind): string {
  return kind === "refund"
    ? "operator_refund_requested"
    : "operator_renewal_cancel_requested";
}
