import type {
  CancelRenewalResult,
  OperatorDecision,
  RefundResult,
} from "@polaris/billing/operator-commands";
import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import type { BillingAuditEvent } from "@polaris/db/admin-support-repository";
import { BillingCommandInProgressError } from "@polaris/db/billing-store";
import { normalizeOperatorReason } from "@polaris/domain/billing/operator-commands";
import { describeError } from "@polaris/observability/wide-event";
import { operatorActor } from "./billing-commands";

/**
 * The operator's provider commands from the Admin (ADR 0105): cancel the renewal and refund the period in force of
 * the store of an open case. The pattern of the other billing commands (ADR 0073): the request is written in the
 * administrative audit first (it needs the open case, and for a refund it counts against the operator's hourly limit);
 * if that fails nothing is done. Then the shared command runs (`@polaris/billing/operator-commands`, under the store's
 * lock, with the reason in the billing ledger), then the outcome is written. An outcome nobody knows (the provider did
 * not answer in time, failed, or the command broke after it was asked) is `provider_unavailable`, and the audit keeps
 * the request with no outcome: repeating with the same command ID is safe, because the refund decides by the state of
 * the charge and the cancellation is the same fact. Nothing the provider answers reaches the result or the log.
 */

export type CancelOutcome =
  | CancelRenewalResult
  | "command_in_progress"
  | "provider_unavailable";

export type RefundOutcome =
  | RefundResult
  | "command_in_progress"
  | "provider_unavailable";

export interface ProviderCommandPorts {
  audit: (
    principalId: string,
    caseId: string,
    event: BillingAuditEvent,
    entityId: string | null,
    detail: string | null
  ) => Promise<string | null>;
  cancelRenewal: (input: {
    commandId: string;
    decision: OperatorDecision;
    organizationId: string;
  }) => Promise<CancelRenewalResult>;
  refund: (input: {
    commandId: string;
    decision: OperatorDecision;
    expectedAmount: string;
    organizationId: string;
  }) => Promise<RefundResult>;
  /** The operator's log: codes only. */
  report: (event: string, fields?: Record<string, string>) => void;
}

export interface ProviderCommandResult<T> {
  /** False when the command ran but the record of its outcome could not be written (the request is recorded). */
  outcomeRecorded: boolean;
  result: T;
}

/** The reason was refused before anything was recorded or done. */
export class InvalidOperatorReasonError extends Error {
  readonly code = "invalid_reason";

  constructor() {
    super("invalid_reason");
    this.name = "InvalidOperatorReasonError";
  }
}

function decisionOf(principalId: string, reason: string): OperatorDecision {
  const normalized = normalizeOperatorReason(reason);
  if (normalized === null) {
    throw new InvalidOperatorReasonError();
  }
  return { actor: operatorActor(principalId), reason: normalized };
}

async function requested(
  ports: ProviderCommandPorts,
  principalId: string,
  caseId: string,
  event: BillingAuditEvent,
  commandId: string
): Promise<string> {
  const organizationId = await ports.audit(
    principalId,
    caseId,
    event,
    commandId,
    null
  );
  if (!organizationId) {
    throw new Error("case_organization_unavailable");
  }
  return organizationId;
}

/**
 * What a failure of the command means for the operator. The lock of another command is a refusal (nothing was done);
 * a provider that is not configured here is the deployment's fault and goes up; anything else may have happened at
 * the provider, so it is unknown.
 */
function failureOf(
  error: unknown,
  ports: ProviderCommandPorts,
  operation: string
): "command_in_progress" | "provider_unavailable" {
  if (error instanceof BillingCommandInProgressError) {
    return "command_in_progress";
  }
  if (error instanceof ProviderNotConfiguredError) {
    throw error;
  }
  ports.report("billing_operator_command_unknown", {
    ...stringFields(describeError(error)),
    operation,
  });
  return "provider_unavailable";
}

function stringFields(fields: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

async function recorded(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch {
    return false;
  }
}

export async function cancelRenewalCommand(
  ports: ProviderCommandPorts,
  principalId: string,
  caseId: string,
  command: { commandId: string; reason: string }
): Promise<ProviderCommandResult<CancelOutcome>> {
  const decision = decisionOf(principalId, command.reason);
  const organizationId = await requested(
    ports,
    principalId,
    caseId,
    "billing.operator_renewal_cancel_requested",
    command.commandId
  );
  let result: CancelOutcome;
  try {
    result = await ports.cancelRenewal({
      commandId: command.commandId,
      decision,
      organizationId,
    });
  } catch (error: unknown) {
    result = failureOf(error, ports, "billing.cancel_renewal");
  }
  if (result === "provider_unavailable") {
    // unknown: the request stays alone in the audit, and the same command ID can be sent again
    return { outcomeRecorded: false, result };
  }
  const outcome = result;
  const outcomeRecorded = await recorded(() =>
    ports.audit(
      principalId,
      caseId,
      "billing.operator_renewal_cancel_recorded",
      command.commandId,
      `result=${outcome}`
    )
  );
  return { outcomeRecorded, result };
}

export async function refundCommand(
  ports: ProviderCommandPorts,
  principalId: string,
  caseId: string,
  command: { commandId: string; expectedAmount: string; reason: string }
): Promise<ProviderCommandResult<RefundOutcome>> {
  const decision = decisionOf(principalId, command.reason);
  const organizationId = await requested(
    ports,
    principalId,
    caseId,
    "billing.operator_refund_requested",
    command.commandId
  );
  let result: RefundOutcome;
  try {
    result = await ports.refund({
      commandId: command.commandId,
      decision,
      expectedAmount: command.expectedAmount,
      organizationId,
    });
  } catch (error: unknown) {
    result = failureOf(error, ports, "billing.refund");
  }
  if (result === "provider_unavailable") {
    return { outcomeRecorded: false, result };
  }
  const outcome = result;
  const outcomeRecorded = await recorded(() =>
    ports.audit(
      principalId,
      caseId,
      "billing.operator_refund_recorded",
      command.commandId,
      `result=${outcome};amount=${command.expectedAmount}`
    )
  );
  return { outcomeRecorded, result };
}
