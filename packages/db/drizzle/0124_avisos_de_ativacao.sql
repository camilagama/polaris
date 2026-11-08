-- The activation series, the database part, piece 1 (ADR 0106, D1, D2, D8, D11 and D12): where the notices, the opt-out
-- and the suppression live, and the role that will choose who gets an e-mail. Expand only (ADR 0096): three new tables,
-- a new role, new policies and column grants; nothing existing is dropped, altered or recreated, and the previous
-- Worker never touches any of it. Nothing sends: the series stays off (D6).
--
-- * `activation_notices`: one row per person and step (a1, a2, a3), whatever the store; the person and the store are
--   one membership (composite foreign key in cascade), so the purge of the store, which deletes the memberships, takes
--   the row with them, and an account can only go once its memberships are gone (restrictive key). The cascade takes the
--   record of what was sent too: a person whose first store was purged is a candidate again in a new one, as for the
--   welcome of 0101. IDs, dates and short codes: every text column refuses "@". The billing role records, reads and
--   marks the outcome, as for `billing_notices`.
-- * `email_opt_outs`: who asked not to receive the e-mails sent on legitimate interest, and when; it leaves with the
--   account. The billing role and the owner of the series read it; who writes it comes with the opt-out page.
-- * `activation_email_suppressions`: the HMAC-SHA256 of an address after a bounce or a complaint (32 bytes, never the
--   address, no account); it outlives the account. The billing role records, reads and re-keys it (`UPDATE` of the
--   HMAC only, so `recorded_at` keeps the original date; row security cannot compare the old HMAC with the new one, so
--   the re-keying rests on that role). Nobody else, the tenant included, has a policy on it.
-- * `polaris_activation_notice_owner` (NOLOGIN, NOBYPASSRLS): it will own the candidates' function; here it gets only
--   the columns the stop rules read. The stores of the last 14 days, and through them their products, sales, billing
--   record, internal marker and owners' `email_verified`; every active owner's membership (the first store of a person
--   is the oldest one); the notices and the opt-outs. It never reads `session`, `"user".email` nor the suppressions,
--   and writes nothing (the end-state check refuses all of it).
-- Each policy on an existing table and each foreign key takes a lock on a busy table: they are all taken first, in one
-- fixed order, and a lock not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.organizations, public.memberships, public."user", public.products, public.sales, public.organization_billing, public.platform_internal_organizations IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_notice_owner') THEN
    EXECUTE 'CREATE ROLE polaris_activation_notice_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes; NOSUPERUSER is refused to a migrator that is not a superuser
  -- (Neon), so the check below keeps that guarantee
  EXECUTE 'ALTER ROLE polaris_activation_notice_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_notice_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_activation_notice_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
CREATE TABLE "activation_email_suppressions" (
	"address_hmac" "bytea" NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_email_suppressions_pk" PRIMARY KEY("address_hmac","reason"),
	CONSTRAINT "activation_email_suppressions_hmac_length" CHECK (octet_length("activation_email_suppressions"."address_hmac") = 32),
	CONSTRAINT "activation_email_suppressions_reason_allowed" CHECK ("activation_email_suppressions"."reason" IN ('bounce', 'complaint'))
);
--> statement-breakpoint
ALTER TABLE "activation_email_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activation_notices" (
	"due_at" timestamp with time zone NOT NULL,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"first_attempted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"organization_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"skipped_reason" text,
	"step" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "activation_notices_user_step_unique" UNIQUE("user_id","step"),
	CONSTRAINT "activation_notices_step_allowed" CHECK ("activation_notices"."step" IN ('a1', 'a2', 'a3')),
	CONSTRAINT "activation_notices_ids_format" CHECK ("activation_notices"."organization_id" !~ '[[:space:][:cntrl:]@]' AND "activation_notices"."user_id" !~ '[[:space:][:cntrl:]@]'),
	CONSTRAINT "activation_notices_outcome_coherent" CHECK ((CASE WHEN "activation_notices"."sent_at" IS NULL THEN 0 ELSE 1 END
          + CASE WHEN "activation_notices"."failed_at" IS NULL THEN 0 ELSE 1 END
          + CASE WHEN "activation_notices"."skipped_reason" IS NULL THEN 0 ELSE 1 END) <= 1
        AND (("activation_notices"."failed_at" IS NULL) = ("activation_notices"."failure_code" IS NULL))
        AND (("activation_notices"."first_attempted_at" IS NULL) = ("activation_notices"."last_attempted_at" IS NULL))),
	CONSTRAINT "activation_notices_codes_format" CHECK (("activation_notices"."failure_code" IS NULL OR "activation_notices"."failure_code" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("activation_notices"."skipped_reason" IS NULL OR "activation_notices"."skipped_reason" ~ '^[a-z][a-z0-9_]{0,63}$'))
);
--> statement-breakpoint
ALTER TABLE "activation_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_opt_outs" (
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "email_opt_outs_user_format" CHECK ("email_opt_outs"."user_id" !~ '[[:space:][:cntrl:]@]')
);
--> statement-breakpoint
ALTER TABLE "email_opt_outs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activation_notices" ADD CONSTRAINT "activation_notices_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activation_notices_organization_user_idx" ON "activation_notices" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_billing_runtime_select" ON "activation_email_suppressions" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_billing_runtime_insert" ON "activation_email_suppressions" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_billing_runtime_update" ON "activation_email_suppressions" AS PERMISSIVE FOR UPDATE TO "polaris_billing_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_notices_billing_runtime_select" ON "activation_notices" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "activation_notices_billing_runtime_insert" ON "activation_notices" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK ("activation_notices"."sent_at" IS NULL AND "activation_notices"."failed_at" IS NULL AND "activation_notices"."skipped_reason" IS NULL AND "activation_notices"."first_attempted_at" IS NULL);--> statement-breakpoint
CREATE POLICY "activation_notices_billing_runtime_update" ON "activation_notices" AS PERMISSIVE FOR UPDATE TO "polaris_billing_runtime" USING ("activation_notices"."sent_at" IS NULL AND "activation_notices"."failed_at" IS NULL AND "activation_notices"."skipped_reason" IS NULL) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_notices_owner_select" ON "activation_notices" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_notices_purge_owner_select" ON "activation_notices" AS PERMISSIVE FOR SELECT TO "polaris_purge_owner" USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = "activation_notices"."organization_id" AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY "email_opt_outs_billing_runtime_select" ON "email_opt_outs" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "email_opt_outs_owner_select" ON "email_opt_outs" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
-- as the other tables of notices: the policies bind the owner of the table too
ALTER TABLE public.activation_notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.email_opt_outs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.activation_email_suppressions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.activation_notices, public.email_opt_outs, public.activation_email_suppressions FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
-- the billing role records a notice owed, reads the notices and writes the attempts and the outcome of one still owed
GRANT SELECT ON TABLE public.activation_notices TO polaris_billing_runtime;--> statement-breakpoint
GRANT INSERT (organization_id, user_id, step, due_at) ON TABLE public.activation_notices TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (first_attempted_at, last_attempted_at, sent_at, failed_at, failure_code, skipped_reason) ON TABLE public.activation_notices TO polaris_billing_runtime;--> statement-breakpoint
-- it checks the opt-out when it sends, and records, finds and re-keys a suppressed address (the HMAC only)
GRANT SELECT ON TABLE public.email_opt_outs TO polaris_billing_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.activation_email_suppressions TO polaris_billing_runtime;--> statement-breakpoint
GRANT INSERT (address_hmac, reason) ON TABLE public.activation_email_suppressions TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (address_hmac) ON TABLE public.activation_email_suppressions TO polaris_billing_runtime;--> statement-breakpoint
-- the purge owner sees the notices of a store it purges, as it sees every table it empties (the purge gate asks it of
-- the cascaded tables); the cascade from the memberships deletes them, so it gets no DELETE
GRANT SELECT ON TABLE public.activation_notices TO polaris_purge_owner;--> statement-breakpoint
-- The owner of the series: the columns the stop rules of D3 read and nothing else. The stores created in the last 14
-- days (the series ends on day 14), and through them their products, sales, billing record and the internal marker; the
-- active owners (the first store of a person is the oldest membership) and, of the owners of those stores, only whether
-- the e-mail is verified.
GRANT USAGE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id, step, due_at, recorded_at, sent_at, failed_at, skipped_reason) ON TABLE public.activation_notices TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (user_id) ON TABLE public.email_opt_outs TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (id, status, created_at) ON TABLE public.organizations TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY organizations_activation_notice_owner_select_recent ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (created_at > pg_catalog.now() - interval '14 days');--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status, created_at) ON TABLE public.memberships TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY memberships_activation_notice_owner_select_owner ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (role = 'owner' AND status = 'active');--> statement-breakpoint
GRANT SELECT (id, email_verified) ON TABLE public."user" TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY user_activation_notice_owner_select_recent_owner ON public."user"
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.memberships AS m
                   JOIN public.organizations AS o ON o.id = m.organization_id
                  WHERE m.user_id = "user".id AND m.role = 'owner' AND m.status = 'active'));--> statement-breakpoint
GRANT SELECT (organization_id, created_at, deleted_at) ON TABLE public.products TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY products_activation_notice_owner_select_recent ON public.products
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = products.organization_id));--> statement-breakpoint
GRANT SELECT (organization_id, confirmed_at) ON TABLE public.sales TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY sales_activation_notice_owner_select_recent ON public.sales
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = sales.organization_id));--> statement-breakpoint
GRANT SELECT (organization_id, state, trial_started_at) ON TABLE public.organization_billing TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY organization_billing_activation_notice_owner_select_recent ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = organization_billing.organization_id));--> statement-breakpoint
GRANT SELECT (organization_id) ON TABLE public.platform_internal_organizations TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY platform_internal_organizations_activation_notice_owner_select_recent ON public.platform_internal_organizations
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = platform_internal_organizations.organization_id));--> statement-breakpoint
-- The end state (a REVOKE or an ALTER without the right is only a WARNING on Neon): the owner of the series holds
-- exactly the columns above and nothing else (no table privilege, no write, no CREATE), so it reads neither the session
-- nor the address; and of the `polaris_*` groups and owners, only the billing role, the purge owner and it reach the
-- new tables.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner') AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_notices.due_at:SELECT', 'activation_notices.failed_at:SELECT', 'activation_notices.id:SELECT',
    'activation_notices.organization_id:SELECT', 'activation_notices.recorded_at:SELECT',
    'activation_notices.sent_at:SELECT', 'activation_notices.skipped_reason:SELECT', 'activation_notices.step:SELECT',
    'activation_notices.user_id:SELECT', 'email_opt_outs.user_id:SELECT', 'memberships.created_at:SELECT',
    'memberships.organization_id:SELECT', 'memberships.role:SELECT', 'memberships.status:SELECT',
    'memberships.user_id:SELECT', 'organization_billing.organization_id:SELECT', 'organization_billing.state:SELECT',
    'organization_billing.trial_started_at:SELECT', 'organizations.created_at:SELECT', 'organizations.id:SELECT',
    'organizations.status:SELECT', 'platform_internal_organizations.organization_id:SELECT',
    'products.created_at:SELECT', 'products.deleted_at:SELECT', 'products.organization_id:SELECT',
    'sales.confirmed_at:SELECT', 'sales.organization_id:SELECT', 'user.email_verified:SELECT', 'user.id:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_notice_owner')
     OR pg_catalog.has_column_privilege('polaris_activation_notice_owner', 'public."user"', 'email', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_notice_owner', 'public.session', 'SELECT')
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series reads the session or the address, or holds more than columns';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['activation_notices', 'email_opt_outs', 'activation_email_suppressions']) AS t (name)
     CROSS JOIN (
       SELECT 'public'::text AS role
       UNION ALL
       SELECT r.rolname::text FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND (r.rolname LIKE '%\_runtime' OR r.rolname LIKE '%\_owner' OR r.rolname LIKE '%\_reader')
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_purge_owner', 'polaris_activation_notice_owner')
     ) AS r
     WHERE pg_catalog.has_any_column_privilege(r.role, 'public.' || t.name, 'SELECT, INSERT, UPDATE, REFERENCES')
        OR pg_catalog.has_table_privilege(r.role, 'public.' || t.name, 'DELETE, TRUNCATE, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'a tenant or another role reaches the tables of the series';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'polaris_activation_notice_owner'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'polaris_activation_notice_owner has an attribute it must not have';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
