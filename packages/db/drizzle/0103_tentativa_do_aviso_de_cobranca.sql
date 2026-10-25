-- The delivery window of a billing notice counts from its first attempt, not from when it was due (ADR 0104, decision 7
-- as amended; t356), and the hourly queue rotates by the last attempt (t366). Expand only (ADR 0096): two nullable
-- columns and two column grants; nothing is changed, dropped or recreated, and the previous Worker neither reads nor
-- writes them.
--
-- * `billing_notices.first_attempted_at`: when the consumer first went to send the notice, on the database's clock,
--   written before the send. Null: never tried. The window of 23 hours counts from it, and only from it.
-- * `billing_notices.last_attempted_at`: the latest such attempt, written by the same statement. The hourly list orders
--   by it (never tried first, then the one tried longest ago), so a notice that has just failed goes to the back instead
--   of holding the batch. Null: never tried.
-- No backfill (a notice owed now is simply "never tried": it goes out if it is still true) and no index (the owed notices
-- are few; the hourly list sorts them in memory).
-- * The billing role (`polaris_billing_runtime`) already reads the whole table; it gets `UPDATE (first_attempted_at)` and
--   `UPDATE (last_attempted_at)` and nothing else. The update policy already limits it to a notice still owed.
-- The ALTER TABLE takes an ACCESS EXCLUSIVE lock: one not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "billing_notices" ADD COLUMN "first_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_notices" ADD COLUMN "last_attempted_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (first_attempted_at, last_attempted_at) ON TABLE public.billing_notices TO polaris_billing_runtime;--> statement-breakpoint
RESET lock_timeout;
