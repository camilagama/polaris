import { afterEach, describe, expect, it } from "vitest";
import { createAuthDatabase, createDatabase } from "./client";

const url = "postgresql://client.invalid/neondb";
const pools: { end: () => Promise<void> }[] = [];

function queryMap(db: { query: unknown }) {
  return db.query as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("the authentication connection", () => {
  it("carries the relational map that the single read of the session goes through", () => {
    const { db, pool } = createAuthDatabase(url, { maxConnections: 1 });
    pools.push(pool);

    expect(queryMap(db).session).toBeDefined();
    expect(queryMap(db).user).toBeDefined();
    expect(queryMap(db).account).toBeDefined();
  });

  it("is what createDatabase lacks when it is given no schema", () => {
    const { db, pool } = createDatabase(url, { maxConnections: 1 });
    pools.push(pool);

    expect(queryMap(db).session).toBeUndefined();
  });

  it("keeps the schema even if a caller forces one past the types", () => {
    const { db, pool } = createAuthDatabase(url, {
      schema: {},
    } as Parameters<typeof createAuthDatabase>[1]);
    pools.push(pool);

    expect(queryMap(db).session).toBeDefined();
  });
});
