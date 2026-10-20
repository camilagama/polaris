import { Pool } from "pg";
import { guardPoolErrors } from "./pool-errors";

/** An image that was removed from its product: nothing links to its asset anymore. */
export interface UnlinkedMediaAsset {
  assetId: string;
  storageKey: string;
}

export interface MediaCleanupClient {
  claimOrphan: (storageKey: string) => Promise<boolean>;
  close: () => Promise<void>;
  /**
   * Marks the cleanup of a removed image as done, after its objects were
   * deleted from the bucket: the asset row goes and its key is tombstoned.
   * False when the asset is gone already or got a link (nothing was changed).
   */
  finalizeUnlinked: (assetId: string) => Promise<boolean>;
  /**
   * Assets nothing links to, older than `minAgeMs`, oldest first, leaving out
   * the ones in `excludeAssetIds` (those that already failed in this run, so
   * one stuck asset cannot hide the rest).
   */
  listUnlinked: (
    limit: number,
    minAgeMs: number,
    excludeAssetIds: readonly string[]
  ) => Promise<UnlinkedMediaAsset[]>;
}

export function createMediaCleanupClient(
  connectionString: string
): MediaCleanupClient {
  const pool = guardPoolErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 1,
    })
  );

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
    async finalizeUnlinked(assetId) {
      const result = await pool.query<{ finalized: boolean }>(
        "SELECT public.finalize_unlinked_media_cleanup($1::uuid) AS finalized",
        [assetId]
      );
      return result.rows[0]?.finalized === true;
    },
    async listUnlinked(limit, minAgeMs, excludeAssetIds) {
      const result = await pool.query<{
        asset_id: string;
        storage_key: string;
      }>(
        "SELECT asset_id, storage_key FROM public.list_unlinked_media_for_cleanup($1::integer, make_interval(secs => $2::double precision), $3::uuid[])",
        [limit, minAgeMs / 1000, [...excludeAssetIds]]
      );
      return result.rows.map((row) => ({
        assetId: row.asset_id,
        storageKey: row.storage_key,
      }));
    },
  };
}
