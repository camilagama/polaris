/**
 * The shapes the page reads, as the routes of this cut answer them. Types only: nothing of a server package enters
 * the script. The diagnostics are the domain's own report; the list and `whoami` are written here because their types
 * live next to the database, and `src/ui/ui-types.test.ts` fails if the two drift apart.
 */

export type { OrganizationDiagnostics } from "@polaris/domain/admin/organization-diagnostics";

export interface OrganizationSummary {
  accessEndsAt: string | null;
  billingState: string;
  createdAt: string;
  id: string;
  name: string;
  planInForce: string;
  status: string;
}

export interface OrganizationPage {
  next: string | null;
  organizations: OrganizationSummary[];
}

export interface WhoAmI {
  capabilities: string[];
  principal: { emailSnapshot: string | null; id: string; role: string };
}
