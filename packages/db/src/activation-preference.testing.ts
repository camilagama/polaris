import type { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

/**
 * The text and the parameters of a statement as the driver receives them, read through the public dialect so that a
 * test of a caller outside this package can inspect what reached the transaction without importing drizzle. It lives
 * apart from the production module so that the dialect is never instantiated when the runtime loads it.
 */
export function renderActivationStatement(query: ReturnType<typeof sql>): {
  params: unknown[];
  sql: string;
} {
  const { params, sql: text } = dialect.sqlToQuery(query);
  return { params, sql: text };
}
