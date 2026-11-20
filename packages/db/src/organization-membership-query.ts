import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";
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
 * `public.list_user_organizations` (migration 0137, SECURITY INVOKER) reads the
 * memberships and then each active organization under its own scope, with the
 * same policies the runtime reads them under, in one statement: the Hyperdrive
 * counts every statement against its daily quota. Its settings are local to
 * this transaction and empty again when it returns.
 */
export async function listUserOrganizations(
  database: Database,
  authenticatedUserId: string
): Promise<UserOrganization[]> {
  if (
    !authenticatedUserId.trim() ||
    authenticatedUserId !== authenticatedUserId.trim()
  ) {
    throw new TenantAuthorizationError("tenant_access_denied");
  }

  const rows = await database.transaction(
    async (transaction) =>
      (
        await transaction.execute<{
          id: string;
          name: string;
          role: string;
          timezone: string;
        }>(
          sql`SELECT id, name, role, timezone FROM public.list_user_organizations(${authenticatedUserId})`
        )
      ).rows,
    { isolationLevel: "read committed" }
  );
  return rows.map(({ id, name, role, timezone }) => ({
    id,
    name,
    role,
    timezone,
  }));
}
