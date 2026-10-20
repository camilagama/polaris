import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/**
 * What the background job does to the lock of the sign-in by password (ADR 0100): it removes the rows
 * untouched for a day, through `expire_auth_login_lock`, which the authentication runtime executes. The
 * runtime reads nothing from `auth_login_lock`; the function is the whole interface.
 */
export interface AuthLoginLockMaintenanceClient {
  close: () => Promise<void>;
  /** Removes the rows untouched for a day and says how many. */
  expire: () => Promise<number>;
}

export function createAuthLoginLockMaintenanceClient(
  connectionString: string
): AuthLoginLockMaintenanceClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );
  return {
    async close() {
      await pool.end();
    },
    async expire() {
      const result = await pool.query<{ removed: number }>(
        "SELECT public.expire_auth_login_lock() AS removed"
      );
      return Number(result.rows[0]?.removed ?? 0);
    },
  };
}
