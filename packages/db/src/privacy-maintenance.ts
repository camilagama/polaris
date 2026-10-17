import { Pool } from "pg";

/**
 * What time itself causes in the closure of organizations (plan PR101, ADR 0074).
 * It runs under its own database role, which can execute one function and read
 * nothing: a closing organization whose recovery window ended becomes closed.
 */
export interface PrivacyMaintenanceClient {
  close: () => Promise<void>;
  /** Marks expired recovery windows as closed, at most `limit` organizations; returns how many. */
  finalizeExpiredClosures: (limit: number) => Promise<number>;
}

export function createPrivacyMaintenanceClient(
  connectionString: string
): PrivacyMaintenanceClient {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    max: 1,
  });
  return {
    async close() {
      await pool.end();
    },
    async finalizeExpiredClosures(limit) {
      const result = await pool.query<{ finalized: number }>(
        "SELECT public.finalize_expired_closures($1::integer) AS finalized",
        [limit]
      );
      return Number(result.rows[0]?.finalized ?? 0);
    },
  };
}
