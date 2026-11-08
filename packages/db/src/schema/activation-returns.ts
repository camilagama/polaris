import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  pgPolicy,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

const activationOwnerRole = "polaris_activation_owner";

/** The smallest group of stores a frozen cell may show (ADR 0106, D9; the k of the funnel). */
export const ACTIVATION_RETURN_K = 5;

/**
 * The M3 of ADR 0106 (D9), frozen once per cohort week: of the stores that did not sell in their first 14 days, how
 * many owners came back to the app (a session of theirs touched on a later day of São Paulo, up to the 14th) and how
 * many never did. Only counts already suppressed: both cells, each with k stores or more, or neither (a week frozen
 * below k is a row with both null, so "frozen and hidden" differs from "not frozen", which the reader shows as
 * unavailable, never 0). No store, person or ID; append-only by trigger (in the migration), and the owner of the
 * measure is the only role that reaches it.
 */
export const activationReturnWeeks = pgTable(
  "activation_return_weeks",
  {
    cohortWeek: date("cohort_week").primaryKey(),
    frozenAt: timestamp("frozen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    neverReturned: integer("never_returned"),
    returned: integer("returned"),
  },
  (table) => [
    check(
      "activation_return_weeks_monday",
      sql`extract(isodow from ${table.cohortWeek}) = 1`
    ),
    check(
      "activation_return_weeks_suppressed",
      sql`(${table.returned} IS NULL AND ${table.neverReturned} IS NULL) OR (${table.returned} IS NOT NULL AND ${table.neverReturned} IS NOT NULL AND ${table.returned} >= ${sql.raw(String(ACTIVATION_RETURN_K))} AND ${table.neverReturned} >= ${sql.raw(String(ACTIVATION_RETURN_K))})`
    ),
    pgPolicy("activation_return_weeks_owner_select", {
      for: "select",
      to: activationOwnerRole,
      using: sql`true`,
    }),
    pgPolicy("activation_return_weeks_owner_insert", {
      for: "insert",
      to: activationOwnerRole,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
