-- The trial per person and the provider's subscription ID (ADR 0101, billing PR 2). Expand only (ADR 0096): a new table
-- the previous Worker never reads, two nullable columns, one price turned off, and the purge function recreated with two
-- more kept keys of the billing fact. Nothing is dropped, renamed or made NOT NULL.
--
-- * `billing_trial_claims`: one row per user who opted into a trial, reserved for an organization by `startTrial` and
--   consumed by the fact that starts the trial, in the same statement that records `trial_started_at`. RLS forced, no
--   tenant policy: only `polaris_billing_runtime` reads, inserts and updates it (never deletes). It outlives the purge
--   of the organization (anti-abuse: the foreign key to the organization restricts, and organizations are never
--   deleted) and goes with the account (cascade). Retention class `billing_trial_claims`.
-- * `provider_subscription_id` (Asaas `sub_`) on the inbox and on the record: stored from the first fact that matched
--   `provider_ref`. The tenant keeps reading the ledger's old columns only (column grant) and never the new one.
-- * The semiannual Pro price stops being sold (Q12); it comes back by migration.
-- * `purge_organization_data` keeps `amount` and `currency` in a pseudonymized fact (Filipe V2): the money facts now
--   carry the amount, which the fiscal record needs. The rest of the function is the one of migration 0080, unchanged.
CREATE TABLE "billing_trial_claims" (
	"consumed_at" timestamp with time zone,
	"organization_id" text NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_trial_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
ALTER TABLE "billing_trial_claims" ADD CONSTRAINT "billing_trial_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_trial_claims" ADD CONSTRAINT "billing_trial_claims_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_trial_claims_organization_idx" ON "billing_trial_claims" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_provider_subscription_length" CHECK ("billing_events"."provider_subscription_id" IS NULL OR char_length("billing_events"."provider_subscription_id") BETWEEN 1 AND 128);--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_provider_subscription_coherent" CHECK ("organization_billing"."provider_subscription_id" IS NULL OR ("organization_billing"."provider_ref" IS NOT NULL AND char_length("organization_billing"."provider_subscription_id") BETWEEN 1 AND 128));--> statement-breakpoint
CREATE POLICY "billing_trial_claims_billing_runtime_select" ON "billing_trial_claims" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "billing_trial_claims_billing_runtime_insert" ON "billing_trial_claims" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "billing_trial_claims_billing_runtime_update" ON "billing_trial_claims" AS PERMISSIVE FOR UPDATE TO "polaris_billing_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE public.billing_trial_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.billing_trial_claims FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
-- the billing role reserves, moves and consumes a claim; nobody deletes one (only the account's cascade does)
GRANT SELECT, INSERT ON TABLE public.billing_trial_claims TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (organization_id, reserved_at, consumed_at) ON TABLE public.billing_trial_claims TO polaris_billing_runtime;--> statement-breakpoint
-- the trials already used: the oldest owner of each organization whose trial started (or was waived) gets a consumed
-- claim, dated by that start. A person who is the oldest owner of two such organizations keeps the earliest one; an
-- organization without an owner left (a purged one) gives none
INSERT INTO public.billing_trial_claims (user_id, organization_id, reserved_at, consumed_at)
SELECT DISTINCT ON (owner.user_id) owner.user_id, owner.organization_id, owner.trial_started_at, owner.trial_started_at
  FROM (
    SELECT DISTINCT ON (billing.organization_id)
           membership.user_id, billing.organization_id, billing.trial_started_at
      FROM public.organization_billing AS billing
      JOIN public.memberships AS membership ON membership.organization_id = billing.organization_id
     WHERE billing.trial_started_at IS NOT NULL
       AND membership.role = 'owner'
     ORDER BY billing.organization_id, membership.created_at, membership.user_id
  ) AS owner
 ORDER BY owner.user_id, owner.trial_started_at, owner.organization_id
ON CONFLICT (user_id) DO NOTHING;--> statement-breakpoint
-- the subscription ID is written by the billing role only, from a matched fact or cleared by a new link
GRANT UPDATE (provider_subscription_id) ON TABLE public.organization_billing TO polaris_billing_runtime;--> statement-breakpoint
-- the tenant reads the ledger of its organization as before, column by column: a new column starts invisible to it
REVOKE SELECT ON TABLE public.billing_events FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT (attempts, fact, fact_type, id, occurred_at, organization_id, outcome_code, processed_at, provider, provider_event_id, provider_ref, received_at, state_after, state_before, status)
  ON TABLE public.billing_events TO polaris_pr11_runtime;--> statement-breakpoint
-- Q12: the semiannual cycle is not offered; a checkout for it is refused (no live price). It comes back by migration
UPDATE public.billing_prices SET active = false WHERE plan_id = 'pro' AND interval_months = 6;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
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
    'data_exports', 'public_catalog_profiles', 'event_outbox', 'queue_processing',
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
  -- locks only `purge_pending` rows, so a purged one is not found and is read again without the lock)
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
  -- the completion is audited in the same transaction (IDs only; the operator who scheduled it is the principal)
  INSERT INTO public.platform_audit_events
    (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail)
  VALUES
    (plan.scheduled_by, 'organization.purge_completed', p_organization, plan.support_case_id,
     'organization', p_organization, NULL);
  RETURN pg_catalog.jsonb_build_object(
    'alreadyPurged', false, 'deletedRows', total, 'pseudonymizedBillingEvents', pseudonymized, 'scrubbedTexts', scrubbed
  );
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;
