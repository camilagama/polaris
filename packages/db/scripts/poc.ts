import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/client";
import { dbPocOperations } from "../src/schema/poc";

// This POC creates a TEMP TABLE, so it only runs with the database owner on a disposable database, never with a runtime
// role: since migration 0077 no runtime role has TEMPORARY on the database (ADR 0093).
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Set DATABASE_URL to a disposable PostgreSQL 18 database before running this POC."
  );
}

const { db, pool } = createDatabase(connectionString, { maxConnections: 1 });
const tokenPrefix = `pr10-${randomUUID()}`;
const tokens = {
  committed: `${tokenPrefix}-committed`,
  query: `${tokenPrefix}-query`,
  rollback: `${tokenPrefix}-rollback`,
};

async function backendPid() {
  const client = await pool.connect();

  try {
    const result = await client.query("SELECT pg_backend_pid() AS pid");
    return Number(result.rows[0]?.pid);
  } finally {
    client.release();
  }
}

try {
  const versionResult = await pool.query("SHOW server_version");
  const serverVersion = String(
    versionResult.rows[0]?.server_version ?? "unknown"
  );
  const serverMajor = Number.parseInt(serverVersion.split(".")[0] ?? "", 10);

  if (serverMajor !== 18) {
    throw new Error(
      `This POC requires PostgreSQL 18; connected to ${serverVersion}.`
    );
  }

  const migrationPath = fileURLToPath(
    new URL("../drizzle/0000_watery_ravenous.sql", import.meta.url)
  );
  const migrationSql = await readFile(migrationPath, "utf8");
  const temporaryTableSql = migrationSql
    .replace(
      'CREATE TABLE "db_poc_operations"',
      'CREATE TEMP TABLE "db_poc_operations"'
    )
    .replace(/;\s*$/, " ON COMMIT PRESERVE ROWS;");

  if (temporaryTableSql === migrationSql) {
    throw new Error("The POC migration did not match the expected table name.");
  }

  await pool.query(temporaryTableSql);

  await db.insert(dbPocOperations).values({ token: tokens.query });
  const queryRows = await db
    .select({ token: dbPocOperations.token })
    .from(dbPocOperations)
    .where(eq(dbPocOperations.token, tokens.query));

  if (queryRows.length !== 1) {
    throw new Error("The POC query did not read back its inserted row.");
  }

  await db.transaction(async (transaction) => {
    await transaction
      .insert(dbPocOperations)
      .values({ token: tokens.committed });
  });
  const committedRows = await db
    .select({ token: dbPocOperations.token })
    .from(dbPocOperations)
    .where(eq(dbPocOperations.token, tokens.committed));

  if (committedRows.length !== 1) {
    throw new Error("The POC transaction did not commit its row.");
  }

  const rollbackSignal = new Error("Expected POC rollback");

  try {
    await db.transaction(async (transaction) => {
      await transaction
        .insert(dbPocOperations)
        .values({ token: tokens.rollback });
      throw rollbackSignal;
    });
  } catch (error) {
    if (error !== rollbackSignal) {
      throw error;
    }
  }

  const rolledBackRows = await db
    .select({ token: dbPocOperations.token })
    .from(dbPocOperations)
    .where(eq(dbPocOperations.token, tokens.rollback));

  if (rolledBackRows.length !== 0) {
    throw new Error("The POC rollback left a row committed.");
  }

  const firstPid = await backendPid();
  const secondPid = await backendPid();

  if (!firstPid || firstPid !== secondPid) {
    throw new Error(
      "The node-postgres pool did not reuse its single connection."
    );
  }

  console.log(
    JSON.stringify({
      poolConnectionReuse: "passed",
      postgresMajor: serverMajor,
      query: "passed",
      temporaryTable: "session-only",
      transactionCommit: "passed",
      transactionRollback: "passed",
    })
  );
} finally {
  await pool.end();
}
