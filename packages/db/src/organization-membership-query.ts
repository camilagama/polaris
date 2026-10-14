import { and, asc, eq, sql } from "drizzle-orm";
import type { createDatabase } from "./client";
import { memberships, organizations } from "./schema/organization";
import { TenantAuthorizationError } from "./tenant-transaction";

type Database = ReturnType<typeof createDatabase>["db"];

export interface UserOrganization {
  id: string;
  name: string;
  role: string;
  timezone: string;
}

/**
 * Lists the active organizations of the authenticated user. The caller must
 * pass the user ID of a server-verified Better Auth session; nothing here
 * accepts an organization from the client.
 *
 * The memberships policy lets a user read their own rows while
 * app.organization_id is empty. The organization row is only visible under the
 * organization policy, so each membership scopes the transaction to its own
 * organization before reading the name and time zone. The organization must be
 * active. The scope is transaction-local and discarded with the transaction.
 */
export function listUserOrganizations(
  database: Database,
  authenticatedUserId: string
): Promise<UserOrganization[]> {
  if (
    !authenticatedUserId.trim() ||
    authenticatedUserId !== authenticatedUserId.trim()
  ) {
    return Promise.reject(new TenantAuthorizationError("tenant_access_denied"));
  }

  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('app.user_id', ${authenticatedUserId}, true)`
      );

      const activeMemberships = await transaction
        .select({
          organizationId: memberships.organizationId,
          role: memberships.role,
        })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, authenticatedUserId),
            eq(memberships.status, "active")
          )
        )
        .orderBy(asc(memberships.createdAt), asc(memberships.organizationId));

      const result: UserOrganization[] = [];
      for (const membership of activeMemberships) {
        // The organization row is only readable under its own scope, so each
        // membership must be scoped and read in order on this connection.
        // biome-ignore lint/performance/noAwaitInLoops: sequential by design.
        await transaction.execute(
          sql`SELECT set_config('app.organization_id', ${membership.organizationId}, true)`
        );
        const [organization] = await transaction
          .select({
            id: organizations.id,
            name: organizations.name,
            status: organizations.status,
            timezone: organizations.timezone,
          })
          .from(organizations)
          .where(eq(organizations.id, membership.organizationId))
          .limit(1);

        if (organization?.status === "active") {
          result.push({
            id: organization.id,
            name: organization.name,
            role: membership.role,
            timezone: organization.timezone,
          });
        }
      }

      return result;
    },
    { isolationLevel: "read committed" }
  );
}
