import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "../src/client";
import { dbPocOperations } from "../src/schema/poc";

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
let migrationApplied = false;

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

  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  migrationApplied = true;

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
      transactionCommit: "passed",
      transactionRollback: "passed",
    })
  );
} finally {
  try {
    if (migrationApplied) {
      await db
        .delete(dbPocOperations)
        .where(inArray(dbPocOperations.token, Object.values(tokens)));
    }
  } finally {
    await pool.end();
  }
}
