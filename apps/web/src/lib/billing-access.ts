import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";

/**
 * Whether the person may see the plan of the store: the billing self-service on and `billing:manage` (AS-19). Only
 * what the screen shows: the server refuses the others anyway.
 */
export function canManageBilling(
  billingSelfService: boolean,
  role: string
): boolean {
  return billingSelfService && hasCapabilityForRole(role, "billing:manage");
}
