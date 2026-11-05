import { Client } from "pg";
import { CURRENT_CHARGE_RECONCILE_SQL } from "./current-charge-reconcile-sql";
import { poolerPattern, requiredEnvironment } from "./sales-gate-support";

/**
 * Runs the backfill of migration 0118 again (ADR 0104, §7), once after the deploy of the Worker that writes the
 * charge in force: a renewal applied by the previous Worker in the expand window left the columns behind. Only the
 * migrator runs it (the owner of `organization_billing`, which bypasses its forced row security), through the direct
 * URL; any other login is refused before writing. It prints counts only: how many rows it wrote, and how many records
 * with an active or grace link still have no amount in force (each one to explain, `billing-providers.md`).
 */
async function main() {
  const url = requiredEnvironment("POLARIS_MIGRATOR_DATABASE_URL");
  if (poolerPattern.test(new URL(url).hostname)) {
    throw new Error("Use the direct URL, never the pooler.");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const who = await client.query<{ allowed: boolean }>(
      `SELECT (r.rolbypassrls OR r.rolsuper) AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS allowed
         FROM pg_catalog.pg_roles AS r, pg_catalog.pg_class AS c
        WHERE r.rolname = current_user AND c.oid = 'public.organization_billing'::regclass`
    );
    if (who.rows[0]?.allowed !== true) {
      throw new Error(
        "Only the migrator (owner of organization_billing, with BYPASSRLS) runs the reconciliation."
      );
    }
    await client.query("BEGIN");
    const written = await client.query(CURRENT_CHARGE_RECONCILE_SQL);
    const missing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.organization_billing
        WHERE state IN ('active', 'grace') AND provider IS NOT NULL AND current_charge_amount IS NULL`
    );
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        paidWithoutAmount: Number(missing.rows[0]?.count ?? 0),
        written: written.rowCount ?? 0,
      })
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "reconcile_failed");
  process.exitCode = 1;
});
