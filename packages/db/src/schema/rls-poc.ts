import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const rlsPocOperations = pgTable(
  "rls_poc_operations",
  {
    organizationId: text().notNull(),
    token: text().notNull(),
    value: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.token],
      name: "rls_poc_operations_pk",
    }),
  ]
);
