import type { WorkerBindings } from "../environment";

/**
 * `true` turns on the owner's billing self-service (ADR 0104, decision 1): `billing.readPlan`, the owner's commands,
 * the "Assinatura" item (`organization.listMine`) and the billing e-mails. Anything else, and absent, leaves it off.
 */
export function billingSelfServiceEnabled(
  bindings: Pick<WorkerBindings, "BILLING_SELF_SERVICE_ENABLED">
): boolean {
  return bindings.BILLING_SELF_SERVICE_ENABLED === "true";
}
