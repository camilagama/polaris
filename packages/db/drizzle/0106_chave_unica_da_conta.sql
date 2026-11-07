-- One account per key, `(provider_id, account_id)` (t435, upgrade of Better Auth to 1.7). Better Auth 1.7 finds an
-- account by that key and refuses a key held by two rows ("Multiple accounts match the same accountId"), where 1.6 took
-- the first one: a duplicate, which the table allowed (two first sign-ins with Google at once), would lock its person
-- out for good. The index makes the second insert fail instead, once. Better Auth 1.7.3+ keeps the 1.6 account schema
-- (the `issuer` column of 1.7.0 was withdrawn upstream, better-auth#11153), so no column is added, renamed or filled.
-- Expand only (ADR 0096): one new index. The previous Worker (Better Auth 1.6) never writes a duplicate on purpose and
-- reads the same columns; with the index it gets a unique violation where it would have written the duplicate.
-- A duplicate already there fails the migration with a named error before the index is built, and nothing changes:
-- which person owns that sign-in is a case for a human, never for a migration. The migrator has BYPASSRLS (ADR 0093), so
-- the check sees every row under the forced row security of `account`; the index build would see them anyway.
-- CREATE UNIQUE INDEX holds a SHARE lock (reads go on; sign-ups and Google links wait) while it builds. The table is
-- small before go-live; the lock_timeout makes the migration fail, instead of queueing sign-ins behind it, if the lock
-- is not had in 10 s.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.account IN SHARE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.account GROUP BY provider_id, account_id HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'account_key_duplicates'
      USING ERRCODE = '23505',
            DETAIL = 'Two or more rows of account share (provider_id, account_id); resolve them before this migration.';
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
RESET lock_timeout;
