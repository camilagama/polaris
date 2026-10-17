import type { BillingAuditEvent } from "@polaris/db/admin-support-repository";
import type {
  GrantEntitlementInput,
  StoredEntitlementGrant,
} from "@polaris/db/billing-store";
import { hasControlCharacters } from "@polaris/domain/admin/support-access";
import {
  type GrantRequest,
  InvalidEntitlementGrantError,
  isRepeatOfGrant,
  type NormalizedGrant,
  normalizeGrant,
} from "@polaris/domain/billing/grants";

/**
 * Billing commands an operator may give (plan PR99): semantic commands, never a
 * status dropdown. The billing role is the only writer of billing, so the Admin
 * writes down what it is about to do (in the administrative audit, which needs an
 * open case for the organization), then the billing store does it, then the
 * outcome is written down. Nothing happens that was not first recorded; a command
 * that fails after its request leaves the request in the audit with no outcome.
 */

export interface BillingCommandPorts {
  audit: (
    principalId: string,
    caseId: string,
    event: BillingAuditEvent,
    entityId: string | null,
    detail: string | null
  ) => Promise<string | null>;
  /** The grant already stored under this ID, or null. */
  find: (id: string) => Promise<StoredEntitlementGrant | null>;
  grant: (
    input: GrantEntitlementInput
  ) => Promise<{ created: boolean; id: string }>;
  newId: () => string;
  revoke: (input: {
    actor: string;
    id: string;
    organizationId: string;
  }) => Promise<{ revoked: boolean }>;
}

export interface GrantCommand {
  /** The caller's own ID for the grant: asking twice with the same ID is one grant, not two. */
  id?: string;
  /** How long it lasts, from now. */
  hours: number;
  key: string;
  reason: string;
  value: boolean | number;
}

/** Who a billing command is attributed to in the ledger: a stable identifier, never an e-mail. */
export function operatorActor(principalId: string): string {
  return `admin:${principalId}`;
}

const HOUR_MS = 3_600_000;

export async function grantEntitlementCommand(
  ports: BillingCommandPorts,
  principalId: string,
  caseId: string,
  command: GrantCommand,
  now: Date
): Promise<{
  created: boolean;
  id: string;
  organizationId: string;
  /** False when the grant was given but the record of its outcome could not be written (the request is recorded). */
  outcomeRecorded: boolean;
}> {
  // text an operator types is shown to other operators: no control characters
  if (hasControlCharacters(command.reason)) {
    throw new InvalidEntitlementGrantError("invalid_reason");
  }
  const request: GrantRequest = {
    actor: operatorActor(principalId),
    expiresAt: new Date(now.getTime() + command.hours * HOUR_MS),
    key: command.key,
    reason: command.reason,
    // the start is the command's own clock, like the end, so the length stored is exactly the hours asked
    startsAt: now,
    value: command.value,
  };
  // refused here when it is not a valid grant, before anything is recorded or done
  const normalized = normalizeGrant(request, now);
  const id = command.id ?? ports.newId();
  const organizationId = await ports.audit(
    principalId,
    caseId,
    "billing.entitlement_grant_requested",
    id,
    `key=${normalized.key}`
  );
  if (!organizationId) {
    throw new Error("case_organization_unavailable");
  }
  // The end of a grant is "hours from now", so a repeat a moment later asks for a different instant. The
  // caller's own ID is what makes it the same command: when that ID already holds a grant, the repeat is
  // the same grant if everything but the clock matches (the length asked for included), and a refusal if it
  // is a different one.
  const prior = command.id ? await ports.find(id) : null;
  const result = prior
    ? repeatResult(prior, organizationId, normalized, command.hours, id)
    : await ports.grant({ ...request, id, organizationId });
  const outcomeRecorded = await recorded(() =>
    ports.audit(
      principalId,
      caseId,
      "billing.entitlement_granted",
      result.id,
      `key=${normalized.key}`
    )
  );
  return { ...result, organizationId, outcomeRecorded };
}

function repeatResult(
  prior: StoredEntitlementGrant,
  organizationId: string,
  grant: NormalizedGrant,
  hours: number,
  id: string
): { created: false; id: string } {
  if (!isRepeatOfGrant(prior, { grant, hours, organizationId })) {
    throw new Error("entitlement_grant_id_conflict");
  }
  return { created: false, id };
}

/**
 * The outcome is written after the billing role has acted. If writing it fails
 * (the case closed in between, the operator was disabled), the grant is already
 * given: say so instead of reporting a failure that did not happen. The request
 * stays in the audit.
 */
async function recorded(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch {
    return false;
  }
}

export async function revokeEntitlementCommand(
  ports: BillingCommandPorts,
  principalId: string,
  caseId: string,
  grantId: string
): Promise<{ outcomeRecorded: boolean; revoked: boolean }> {
  const organizationId = await ports.audit(
    principalId,
    caseId,
    "billing.entitlement_revoke_requested",
    grantId,
    null
  );
  if (!organizationId) {
    throw new Error("case_organization_unavailable");
  }
  // only a grant of this case's own organization can be ended through it
  const result = await ports.revoke({
    actor: operatorActor(principalId),
    id: grantId,
    organizationId,
  });
  // nothing ended (another organization's grant, an unknown or already ended one): the request stays alone in the audit
  if (!result.revoked) {
    return { outcomeRecorded: true, revoked: false };
  }
  const outcomeRecorded = await recorded(() =>
    ports.audit(
      principalId,
      caseId,
      "billing.entitlement_revoked",
      grantId,
      null
    )
  );
  return { outcomeRecorded, revoked: true };
}
