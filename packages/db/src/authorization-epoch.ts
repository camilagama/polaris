import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";

type Database = ReturnType<typeof createDatabase>["db"];

/**
 * Invalidates every offline lease of a user after a security event such as a
 * password reset: the epoch of each membership is bumped and every live grant
 * is revoked (reason security_event, audited per grant). It runs as the auth
 * runtime through one narrow SECURITY DEFINER function; returns how many grants
 * were revoked.
 */
export async function bumpUserAuthorizationEpoch(
  database: Database,
  userId: string
): Promise<number> {
  const result = await database.execute<{ revoked: number }>(
    sql`SELECT public.bump_user_authorization_epoch(${userId}) AS revoked`
  );
  return Number(result.rows[0]?.revoked ?? 0);
}
