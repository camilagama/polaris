import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ownerRole = "polaris_outbox_owner";

/**
 * What the scheduler remembers about each job (plan PR112, ADR 0086): one row per job, by its name in the
 * registry of `@polaris/domain/scheduling/scheduled-jobs`. `covered_at` is the instant the last
 * successful run **started** (the reference of the job's windows: a run that started in one window and
 * ended in the next covered the first); `last_success_at` is when it ended. A run holds a lease with a
 * token, so only its holder records the outcome and a run that died is taken over once the lease ends.
 *
 * It holds job names, instants, a counter and no organization, so no personal data and no tenant:
 * nobody reaches it but the functions of `polaris_outbox_owner` (the role the dispatcher already uses).
 */
export const scheduledJobState = pgTable(
  "scheduled_job_state",
  {
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    coveredAt: timestamp("covered_at", { withTimezone: true }),
    jobId: text("job_id").primaryKey(),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    token: uuid("token"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "scheduled_job_state_job_id_format",
      sql`${table.jobId} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$' AND length(${table.jobId}) <= 64`
    ),
    check(
      "scheduled_job_state_lease_coherent",
      sql`(${table.token} IS NULL) = (${table.leaseUntil} IS NULL)`
    ),
    check(
      "scheduled_job_state_failures_non_negative",
      sql`${table.consecutiveFailures} >= 0`
    ),
    pgPolicy("scheduled_job_state_outbox_owner_all", {
      for: "all",
      to: ownerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
