import { readFile } from "node:fs/promises";
import { Pool } from "pg";

/**
 * `rls_poc_operations` lives only while the gate that proves RLS on it runs: the app's database does not have it.
 * The statements are migration 0001's, the ones the Neon bootstrap runs on an empty project. Only for a database the
 * gate has already confirmed is disposable.
 */

const fixtureMigration = new URL(
  "../drizzle/0001_typical_jackpot.sql",
  import.meta.url
);

const rlsGateSeeds = [
  {
    organizationId: "org_a",
    token: "seed-a",
    value: "synthetic data for org_a",
  },
  {
    organizationId: "org_b",
    token: "seed-b",
    value: "synthetic data for org_b",
  },
] as const;

export async function recreateRlsGateFixture(pool: Pool): Promise<void> {
  const statements = await readFile(fixtureMigration, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP TABLE IF EXISTS public.rls_poc_operations");
    await client.query(statements);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function seedRlsGateFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const seed of rlsGateSeeds) {
      // biome-ignore lint/performance/noAwaitInLoops: one connection, one statement at a time
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        seed.organizationId,
      ]);
      await client.query(
        "INSERT INTO public.rls_poc_operations (organization_id, token, value) VALUES ($1, $2, $3)",
        [seed.organizationId, seed.token, seed.value]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function dropRlsGateFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // a connection left inside a transaction on the table would hold the drop until the runner's time limit
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("DROP TABLE IF EXISTS public.rls_poc_operations");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The seeded fixture lives exactly while `run` runs, on the owner URL given. */
export async function withSeededRlsGateFixture<T>(
  adminUrl: string,
  run: () => Promise<T>
): Promise<T> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await recreateRlsGateFixture(pool);
    await seedRlsGateFixture(pool);
    return await run();
  } finally {
    try {
      await dropRlsGateFixture(pool);
    } finally {
      await pool.end();
    }
  }
}
