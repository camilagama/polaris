-- The delivery window of a billing notice counts from its first attempt, not from when it was due (ADR 0104, decision 7
-- as amended; t356). Expand only (ADR 0096): one nullable column and one column grant; nothing is changed, dropped or
-- recreated, and the previous Worker neither reads nor writes it.
--
-- * `billing_notices.first_attempted_at`: when the consumer first went to send the notice, on the database's clock,
--   written before the send. Null: never tried. No backfill (a notice owed now is simply "never tried": it goes out if
--   it is still true) and no index (the owed notices are few; the hourly list sorts them in memory).
-- * The billing role (`polaris_billing_runtime`) already reads the whole table; it gets `UPDATE (first_attempted_at)` and
--   nothing else. The update policy already limits it to a notice still owed.
ALTER TABLE "billing_notices" ADD COLUMN "first_attempted_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE (first_attempted_at) ON TABLE public.billing_notices TO polaris_billing_runtime;
