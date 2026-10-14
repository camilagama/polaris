import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const cleanupOwnerRole = "polaris_media_cleanup_owner";

export const mediaCleanupClaims = pgTable(
  "media_cleanup_claims",
  {
    claimedAt: timestamp("claimed_at").defaultNow().notNull(),
    storageKey: text("storage_key").primaryKey(),
  },
  (table) => [
    check(
      "media_cleanup_claims_storage_key_valid",
      sql`${table.storageKey} ~ '^media/v2/[^/]+/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}/[0-9a-f-]{36}\\.webp$'`
    ),
    pgPolicy("media_cleanup_claims_owner_all", {
      for: "all",
      to: cleanupOwnerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
).enableRLS();
