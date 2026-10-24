-- The notices of the billing cycle and the welcome, the database part (ADR 0104, decision 7; PR F of design t268 v2:
-- §8 "0101" and §9). Expand only (ADR 0096): a new table, new policies and grants, two new functions and one recreated
-- with the same signature, owner and grants (`purge_organization_data`, one table more in its list; the gate
-- `purge-functions` compares it with `PURGE_DELETE_ORDER`). The previous Worker never writes the new table nor the new
-- event type, and calls nothing that changed.
--
-- * `billing_notices`: one row per notice (the eight of the billing cycle, the yearly renewal and the welcome), one per
--   store, kind and `dedupe_key`, and one welcome per person (`UNIQUE (user_id) WHERE kind = 'welcome'`). IDs, dates and
--   short codes, never the e-mail. Forced row security, no policy for the tenant. The billing role records, reads and
--   marks the outcome (column grants); the welcome's person by a foreign key in cascade (the purge of the users who never
--   verified the e-mail takes the row with the account); the purge of the store deletes them with its data.
-- * The outbox of the billing role (decision 11): `INSERT` on five columns of `event_outbox`, and a policy that takes
--   only `billing.notice`, pending and untouched, the body with the notice's ID and nothing else, the key built from it,
--   and a notice of the same store.
-- * `billing_notice_recipient(p_organization, p_notice)`, as `closure_notice_recipient`: the e-mail of the welcome's
--   person, or of the oldest active owner of the store for a notice of the billing cycle, only for a notice still owed,
--   only while that person is an active owner, and only whether the address is verified; never the name. Owned by
--   `polaris_notice_recipient_owner` (the owner of the closure notices' recipient), executed only by the authentication
--   role; its policy on `"user"` sees only the user of the notice of the call.
-- * `welcome_notice_candidates(p_limit)`: for the hourly sweep of the welcome (decision 6), the stores created in the
--   last 24 hours, active, whose oldest active owner has no welcome and no older store as owner (AC-26: the welcome is
--   for the first store). Owned by `polaris_billing_owner`, executed only by the billing role, which records the notices.
-- Each new policy takes an ACCESS EXCLUSIVE lock on a busy table: the four are taken first, in one fixed order, and a
-- lock not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.organizations, public.memberships, public."user", public.event_outbox IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "billing_notices" (
	"dedupe_key" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"skipped_reason" text,
	"user_id" text,
	CONSTRAINT "billing_notices_dedupe_unique" UNIQUE("organization_id","kind","dedupe_key"),
	CONSTRAINT "billing_notices_kind_allowed" CHECK ("billing_notices"."kind" IN ('trial_started', 'trial_charge_eve', 'first_charge_failed', 'renewal_failed', 'access_ended', 'charge_receipt', 'renewal_cancelled', 'refund_confirmed', 'annual_renewal_reminder', 'welcome')),
	CONSTRAINT "billing_notices_user_only_for_welcome" CHECK (("billing_notices"."kind" = 'welcome') = ("billing_notices"."user_id" IS NOT NULL)),
	CONSTRAINT "billing_notices_dedupe_key_format" CHECK (char_length("billing_notices"."dedupe_key") BETWEEN 1 AND 200 AND "billing_notices"."dedupe_key" !~ '[[:space:][:cntrl:]@]'),
	CONSTRAINT "billing_notices_outcome_coherent" CHECK ((CASE WHEN "billing_notices"."sent_at" IS NULL THEN 0 ELSE 1 END
          + CASE WHEN "billing_notices"."failed_at" IS NULL THEN 0 ELSE 1 END
          + CASE WHEN "billing_notices"."skipped_reason" IS NULL THEN 0 ELSE 1 END) <= 1
        AND (("billing_notices"."failed_at" IS NULL) = ("billing_notices"."failure_code" IS NULL))),
	CONSTRAINT "billing_notices_codes_format" CHECK (("billing_notices"."failure_code" IS NULL OR "billing_notices"."failure_code" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("billing_notices"."skipped_reason" IS NULL OR "billing_notices"."skipped_reason" ~ '^[a-z][a-z0-9_]{0,63}$'))
);
--> statement-breakpoint
ALTER TABLE "billing_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notices_welcome_user_unique" ON "billing_notices" USING btree ("user_id") WHERE "billing_notices"."kind" = 'welcome';--> statement-breakpoint
CREATE INDEX "billing_notices_user_idx" ON "billing_notices" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "user_notice_recipient_owner_select_billing" ON "user" AS PERMISSIVE FOR SELECT TO "polaris_notice_recipient_owner" USING (EXISTS (SELECT 1 FROM public.billing_notices AS n WHERE n.id = (CASE WHEN pg_catalog.current_setting('app.owner_scope.billing_notice_recipient_notice_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.owner_scope.billing_notice_recipient_notice_id', true)::uuid END) AND (n.user_id = "user"."id" OR (n.user_id IS NULL AND EXISTS (SELECT 1 FROM public.memberships AS m WHERE m.organization_id = n.organization_id AND m.user_id = "user"."id" AND m.role = 'owner' AND m.status = 'active')))));--> statement-breakpoint
CREATE POLICY "billing_notices_billing_runtime_select" ON "billing_notices" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "billing_notices_billing_runtime_insert" ON "billing_notices" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK ("billing_notices"."sent_at" IS NULL AND "billing_notices"."failed_at" IS NULL AND "billing_notices"."skipped_reason" IS NULL);--> statement-breakpoint
CREATE POLICY "billing_notices_billing_runtime_update" ON "billing_notices" AS PERMISSIVE FOR UPDATE TO "polaris_billing_runtime" USING ("billing_notices"."sent_at" IS NULL AND "billing_notices"."failed_at" IS NULL AND "billing_notices"."skipped_reason" IS NULL) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "billing_notices_billing_owner_select_welcome" ON "billing_notices" AS PERMISSIVE FOR SELECT TO "polaris_billing_owner" USING ("billing_notices"."kind" = 'welcome');--> statement-breakpoint
CREATE POLICY "billing_notices_recipient_owner_select_owed" ON "billing_notices" AS PERMISSIVE FOR SELECT TO "polaris_notice_recipient_owner" USING ("billing_notices"."sent_at" IS NULL AND "billing_notices"."failed_at" IS NULL AND "billing_notices"."skipped_reason" IS NULL);--> statement-breakpoint
CREATE POLICY "billing_notices_purge_owner_select" ON "billing_notices" AS PERMISSIVE FOR SELECT TO "polaris_purge_owner" USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = "billing_notices"."organization_id" AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY "billing_notices_purge_owner_delete" ON "billing_notices" AS PERMISSIVE FOR DELETE TO "polaris_purge_owner" USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = "billing_notices"."organization_id" AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
-- as the other tables of notices: the policies bind the owner of the table too
ALTER TABLE public.billing_notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.billing_notices FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
-- the billing role records a notice owed, reads the notices and writes the outcome of one still owed, once
GRANT SELECT ON TABLE public.billing_notices TO polaris_billing_runtime;--> statement-breakpoint
GRANT INSERT (organization_id, kind, dedupe_key, due_at, user_id) ON TABLE public.billing_notices TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (sent_at, failed_at, failure_code, skipped_reason) ON TABLE public.billing_notices TO polaris_billing_runtime;--> statement-breakpoint
-- the purge deletes the notices of the store it purges, with the rest of its data
GRANT SELECT, DELETE ON TABLE public.billing_notices TO polaris_purge_owner;--> statement-breakpoint
-- the owner of the recipient's function: the notices still owed, and when a membership began (the oldest owner)
GRANT SELECT (id, organization_id, user_id, kind, sent_at, failed_at, skipped_reason) ON TABLE public.billing_notices TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT SELECT (created_at) ON TABLE public.memberships TO polaris_notice_recipient_owner;--> statement-breakpoint
-- the owner of the welcome's sweep: who already has a welcome, the stores of the last 24 hours and their owners
GRANT SELECT (kind, user_id) ON TABLE public.billing_notices TO polaris_billing_owner;--> statement-breakpoint
GRANT SELECT (id, status, created_at) ON TABLE public.organizations TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY organizations_billing_owner_select_recent ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (status = 'active' AND created_at > pg_catalog.now() - interval '24 hours');--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status, created_at) ON TABLE public.memberships TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY memberships_billing_owner_select_owner ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (role = 'owner' AND status = 'active');--> statement-breakpoint
-- The outbox of the billing role (decision 11): only this type, only pending and untouched, the body with the notice's ID
-- and nothing else, the key the body names, and a notice of the same store. The body is the domain's
-- (`OUTBOX_EVENT_KEYS`), as the closure notices' policy (0088). The ID is taken only in the form PostgreSQL writes a
-- uuid (lower case, with hyphens), so one notice has one key, a malformed ID is a refusal and never an error, and the
-- notice is found by its primary key.
GRANT INSERT (organization_id, type, event, idempotency_key, correlation_id) ON TABLE public.event_outbox TO polaris_billing_runtime;--> statement-breakpoint
CREATE POLICY event_outbox_billing_runtime_insert_notice ON public.event_outbox
  AS PERMISSIVE FOR INSERT TO polaris_billing_runtime
  WITH CHECK (type = 'billing.notice' AND status = 'pending' AND attempts = 0
    AND (event - 'noticeId') = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(event -> 'noticeId') = 'string'
    AND idempotency_key = type || ':' || (event ->> 'noticeId')
    AND EXISTS (SELECT 1 FROM public.billing_notices AS n
                 WHERE n.id = (CASE WHEN event_outbox.event ->> 'noticeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (event_outbox.event ->> 'noticeId')::uuid END)
                   AND n.organization_id = event_outbox.organization_id));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT polaris_notice_recipient_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_notice_recipient_owner;--> statement-breakpoint
-- The address of a billing notice, for the consumer that sends it (ADR 0104, decision 7), in the mould of
-- `closure_notice_recipient`: only for a notice still owed (neither sent, failed nor skipped), by its ID and store. The
-- welcome goes to its person while that person is an active owner of a store; a notice of the billing cycle goes to the
-- oldest active owner of its store, read now (never the payer of the Pix). A person whose e-mail is not verified gets
-- `{"verified": false}` and no address (the consumer marks it `email_not_verified`); a notice not owed, or with nobody to
-- send it to (the store purged, the person gone), null. The name is never read, and nothing is written. Volatile, so no
-- cache answers it. Only the authentication runtime executes it. The owner's policy on `"user"` sees only the user of the
-- notice of the scope written first.
CREATE FUNCTION public.billing_notice_recipient(p_organization text, p_notice uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  verified boolean;
  address text;
BEGIN
  -- the owner's policy on "user" sees only the user of this notice
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_recipient_notice_id', COALESCE(p_notice::text, ''), true);
  SELECT account.email_verified, account.email INTO verified, address
    FROM public.billing_notices AS notice
    JOIN public."user" AS account ON account.id = COALESCE(notice.user_id, (
      SELECT founder.user_id FROM public.memberships AS founder
       WHERE founder.organization_id = notice.organization_id AND founder.role = 'owner' AND founder.status = 'active'
       ORDER BY founder.created_at, founder.user_id
       LIMIT 1
    ))
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.skipped_reason IS NULL
     AND EXISTS (
       SELECT 1 FROM public.memberships AS membership
        WHERE membership.user_id = account.id AND membership.role = 'owner' AND membership.status = 'active'
          AND (notice.user_id IS NOT NULL OR membership.organization_id = notice.organization_id)
     );
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF verified THEN
    RETURN pg_catalog.jsonb_build_object('verified', true, 'email', address);
  END IF;
  RETURN pg_catalog.jsonb_build_object('verified', false);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_notice_recipient(text, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_notice_recipient(text, uuid) TO polaris_auth_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_notice_recipient_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_notice_recipient_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_billing_owner;--> statement-breakpoint
GRANT polaris_billing_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_billing_owner;--> statement-breakpoint
-- The welcome's candidates (decision 6, AC-26): the stores created in the last 24 hours and still active, each with its
-- oldest active owner, when that person has no welcome and was not an owner of another store before (the welcome is for
-- the first store; a store purged took its memberships with it, so the person who opens another is welcomed again, the
-- effect accepted in §8). Only the IDs, oldest store first, at most `p_limit`. The billing role records the notices.
CREATE FUNCTION public.welcome_notice_candidates(p_limit integer)
RETURNS TABLE (organization_id text, user_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT store.id, founder.user_id
    FROM public.organizations AS store
    CROSS JOIN LATERAL (
      SELECT membership.user_id, membership.created_at
        FROM public.memberships AS membership
       WHERE membership.organization_id = store.id AND membership.role = 'owner' AND membership.status = 'active'
       ORDER BY membership.created_at, membership.user_id
       LIMIT 1
    ) AS founder
   WHERE store.status = 'active' AND store.created_at > pg_catalog.now() - interval '24 hours'
     AND NOT EXISTS (
       SELECT 1 FROM public.memberships AS earlier
        WHERE earlier.user_id = founder.user_id AND earlier.organization_id <> store.id
          AND earlier.role = 'owner' AND earlier.status = 'active' AND earlier.created_at < founder.created_at
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.billing_notices AS notice
        WHERE notice.kind = 'welcome' AND notice.user_id = founder.user_id
     )
   ORDER BY store.created_at, store.id
   LIMIT p_limit;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.welcome_notice_candidates(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.welcome_notice_candidates(integer) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_billing_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
-- The purge as in 0087, with one change: the notices of the billing cycle and the welcome of the store go with its data
-- (`billing_notices`, before the outbox events that name them). The person who opens another store afterwards is
-- welcomed again (the effect accepted in §8 of the design).
CREATE OR REPLACE FUNCTION public.purge_organization_data(p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  current_status text;
  plan public.organization_purges;
  deleted_tables text[] := ARRAY[
    'sale_return_items', 'sale_returns', 'sale_payments', 'sale_adjustments', 'sale_cancellations',
    'sale_customer_links', 'expenses', 'sale_items', 'sales', 'stock_movements', 'inventory_balances',
    'variant_media', 'product_media', 'product_publications', 'operational_variant_selections',
    'products', 'media_assets', 'categories', 'customers', 'goal_target_changes', 'goals',
    'expense_recurring_rules', 'expense_categories', 'payment_profile_rules', 'payment_profiles',
    'sync_commands', 'sync_changes', 'sync_cursors', 'offline_grants', 'data_export_files',
    'data_exports', 'public_catalog_profiles', 'billing_notices', 'event_outbox', 'queue_processing',
    'queue_dead_letters', 'organization_closures', 'memberships'
  ];
  target text;
  removed bigint;
  total bigint := 0;
  blocker text;
  pseudonymized bigint;
  scrubbed bigint := 0;
  -- the keys the billing lifecycle writes in a fact (`serializeBillingFact` and the ledger's commands): values,
  -- dates, types and opaque references, and only as plain values (a nested object or list goes too). Anything
  -- else in the fact (a payer's name, document, e-mail, phone, address or ID) is taken out;
  -- `PURGE_BILLING_FACT_KEYS` in `purge-datasets.ts` holds the same list. This is pseudonymization, not
  -- anonymization: the columns `billing_events.provider_ref` and `provider_event_id` and
  -- `organization_billing.provider_ref` stay (and `provider_subscription_id` of both, since migration 0084), and they
  -- still find the payer at the provider. The amount and its currency of a money fact stay: they are the fiscal record
  kept_fact_keys text[] := ARRAY[
    'type', 'occurredAt', 'cycleMonths', 'periodEndsAt', 'transition', 'grantId', 'key', 'startsAt', 'expiresAt', 'actor',
    'amount', 'currency'
  ];
BEGIN
  -- the audit of the tenant is not in the list: it survives the purge (ADR 0081, amended 19/10/2026)
  -- the lock comes first: a run that waited behind another one sees the organization it left (this role
  -- locks only `closed` and `purge_pending` rows, so a purged one is not found and is read again without the lock)
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = p_organization FOR UPDATE;
  IF NOT FOUND THEN
    SELECT organization.status INTO current_status
      FROM public.organizations AS organization WHERE organization.id = p_organization;
    IF current_status = 'purged' THEN
      RETURN pg_catalog.jsonb_build_object(
        'alreadyPurged', true, 'deletedRows', 0, 'pseudonymizedBillingEvents', 0, 'scrubbedTexts', 0
      );
    END IF;
    RAISE EXCEPTION 'organization_not_purge_pending' USING ERRCODE = '55000';
  END IF;
  IF current_status IS DISTINCT FROM 'purge_pending' THEN
    RAISE EXCEPTION 'organization_not_purge_pending' USING ERRCODE = '55000';
  END IF;
  SELECT purge.* INTO plan FROM public.organization_purges AS purge
   WHERE purge.organization_id = p_organization FOR UPDATE;
  IF NOT FOUND OR plan.locked_until IS NULL OR plan.locked_until <= pg_catalog.now() THEN
    RAISE EXCEPTION 'purge_not_claimed' USING ERRCODE = '55000';
  END IF;
  IF plan.not_before > pg_catalog.now() THEN
    RAISE EXCEPTION 'purge_not_due' USING ERRCODE = '55000';
  END IF;
  -- a legal hold, or a closure younger than 90 days: nothing is removed
  blocker := public.organization_purge_blocker(p_organization);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.data_exports AS export_row
     WHERE export_row.organization_id = p_organization
       AND export_row.status = 'running' AND export_row.locked_until > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'export_running' USING ERRCODE = '55000';
  END IF;
  -- before and in the same transaction as the rows (ADR 0080); a purge reapplied after a restore finds it
  INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation, privacy_case_id)
  VALUES (p_organization, 'organization', p_organization, 'purge', plan.privacy_case_id)
  ON CONFLICT DO NOTHING;
  FOREACH target IN ARRAY deleted_tables LOOP
    EXECUTE pg_catalog.format('DELETE FROM public.%I WHERE organization_id = $1', target) USING p_organization;
    GET DIAGNOSTICS removed = ROW_COUNT;
    total := total + removed;
  END LOOP;
  -- the billing events stay for the fiscal period, pseudonymized: values, dates, types and opaque references in the
  -- fact (the provider's references stay in their columns, ADR 0081)
  UPDATE public.billing_events AS billing
     SET fact = (
       SELECT COALESCE(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM pg_catalog.jsonb_each(billing.fact) AS entry
        WHERE entry.key = ANY (kept_fact_keys)
          AND pg_catalog.jsonb_typeof(entry.value) IN ('string', 'number', 'boolean')
     )
   WHERE billing.organization_id = p_organization
     AND EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(billing.fact) AS fact_entry
        WHERE fact_entry.key <> ALL (kept_fact_keys)
           OR pg_catalog.jsonb_typeof(fact_entry.value) NOT IN ('string', 'number', 'boolean')
     );
  GET DIAGNOSTICS pseudonymized = ROW_COUNT;
  -- the cases stay as the record of the case (dates, kind, decision, opaque IDs); the free text goes
  UPDATE public.support_cases AS support_case
     SET reason = 'Texto removido pelo purge da organização.', context = NULL, resolution = NULL
   WHERE support_case.organization_id = p_organization
     AND (support_case.reason <> 'Texto removido pelo purge da organização.'
          OR support_case.context IS NOT NULL OR support_case.resolution IS NOT NULL);
  GET DIAGNOSTICS removed = ROW_COUNT;
  scrubbed := scrubbed + removed;
  UPDATE public.privacy_cases AS privacy
     SET note = NULL, decision_note = NULL
   WHERE privacy.support_case_id IN (
           SELECT support_case.id FROM public.support_cases AS support_case
            WHERE support_case.organization_id = p_organization
         )
     AND (privacy.note IS NOT NULL OR privacy.decision_note IS NOT NULL);
  GET DIAGNOSTICS removed = ROW_COUNT;
  scrubbed := scrubbed + removed;
  UPDATE public.organization_purge_cancellations AS cancellation
     SET reason = 'Texto removido pelo purge da organização.'
   WHERE cancellation.organization_id = p_organization
     AND cancellation.reason <> 'Texto removido pelo purge da organização.';
  GET DIAGNOSTICS removed = ROW_COUNT;
  scrubbed := scrubbed + removed;
  -- the grants stay (billing record); the operator's reason is free text and becomes the fixed text
  UPDATE public.entitlement_grants AS grant_row
     SET reason = 'Texto removido pelo purge da organização.'
   WHERE grant_row.organization_id = p_organization
     AND grant_row.reason <> 'Texto removido pelo purge da organização.';
  GET DIAGNOSTICS removed = ROW_COUNT;
  scrubbed := scrubbed + removed;
  -- the deferred checks of the variants run here, while the rows are still visible to this role
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE public.organizations
     SET name = 'Organização removida', status = 'purged', updated_at = pg_catalog.now()
   WHERE id = p_organization AND status = 'purge_pending';
  UPDATE public.organization_purges
     SET purged_at = pg_catalog.now(), last_error_code = NULL
   WHERE organization_id = p_organization;
  -- the completion is audited in the same transaction (IDs only): the operator who scheduled it and the case, or the
  -- system with neither when the closure period scheduled it (ADR 0102)
  INSERT INTO public.platform_audit_events
    (actor, principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail)
  VALUES
    (CASE plan.trigger WHEN 'closure_period' THEN 'system' ELSE 'principal' END, plan.scheduled_by,
     'organization.purge_completed', p_organization, plan.support_case_id, 'organization', p_organization, NULL);
  RETURN pg_catalog.jsonb_build_object(
    'alreadyPurged', false, 'deletedRows', total, 'pseudonymizedBillingEvents', pseudonymized, 'scrubbedTexts', scrubbed
  );
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;--> statement-breakpoint
-- The end state, as 0100 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): the two new
-- functions and the recreated one have their owners, no owner keeps CREATE on public, and the migrator keeps no SET or
-- INHERIT on them.
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE (p.oid = 'public.billing_notice_recipient(text, uuid)'::regprocedure AND p.proowner = 'polaris_notice_recipient_owner'::regrole)
          OR (p.oid = 'public.welcome_notice_candidates(integer)'::regprocedure AND p.proowner = 'polaris_billing_owner'::regrole)
          OR (p.oid = 'public.purge_organization_data(text)'::regprocedure AND p.proowner = 'polaris_purge_owner'::regrole)) <> 3 THEN
    RAISE EXCEPTION 'the new functions do not have their owners';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.billing_notice_recipient(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.welcome_notice_candidates(integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_auth_runtime', 'public.billing_notice_recipient(text, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.welcome_notice_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the new functions do not have their executors';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_notice_recipient_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_billing_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_purge_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'an owner role kept CREATE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid IN ('polaris_notice_recipient_owner'::regrole, 'polaris_billing_owner'::regrole, 'polaris_purge_owner'::regrole)
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on an owner role';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
