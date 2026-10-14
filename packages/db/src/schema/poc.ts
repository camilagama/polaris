import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const dbPocOperations = pgTable("db_poc_operations", {
  id: serial().primaryKey(),
  token: text().notNull().unique(),
});
