import { Pool } from "pg";

export interface MediaCleanupClient {
  claimOrphan: (storageKey: string) => Promise<boolean>;
  close: () => Promise<void>;
}

export function createMediaCleanupClient(
  connectionString: string
): MediaCleanupClient {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    max: 1,
  });

  return {
    async claimOrphan(storageKey) {
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 35035))",
          [storageKey]
        );
        const result = await client.query<{ claimed: boolean }>(
          "SELECT public.claim_media_storage_key_for_cleanup($1) AS claimed",
          [storageKey]
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return result.rows[0]?.claimed === true;
      } catch (error: unknown) {
        if (transactionStarted) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
