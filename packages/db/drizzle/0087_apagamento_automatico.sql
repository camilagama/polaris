-- The automatic purge of a closed organization (ADR 0102, ADR 0081 amended; design t107 §4 with the consolidation of
-- 19/10/2026 21:25). Seven local days before D (the local date of the closure request plus 90 calendar days, the
-- domain's `closureDeadlines` and the database's `closure_deadlines`), the privacy job schedules the purge on its own,
-- with no operator and no privacy case: `schedule_closed_organization_purges`, a function of the purge owner that only
-- the privacy runtime executes, with no argument naming an organization. The purge never runs before the later of D
-- plus 48 hours and the schedule plus 7 days. It is not scheduled while a legal hold is in force, while a temporary
-- access of the Admin is live, after the Admin cancelled a purge of this closure (the cancellation pauses the automatic
-- path until someone places a hold or schedules again) or while the renewal is still alive at a provider (the closure
-- failed to cancel it, L4). A legal hold released after the schedule pushes the purge to the release plus 7 days. The
-- Worker only calls the function when `CLOSURE_AUTO_PURGE_ENABLED` is `true` (off until the go-live).
--
-- Expand only (ADR 0096). Two columns with a default (`organization_purges.trigger`, `platform_audit_events.actor`), the
-- three references of the Admin's purge row and the principal of the platform audit become nullable, with a CHECK each
-- that keeps them filled for an operator (`trigger = 'admin'`, `actor = 'principal'`): the previous Worker only reaches
-- these tables through the functions, and every row it causes is an operator's. New policies, grants and functions;
-- `admin_schedule_organization_purge` (sets the trigger back to `admin` on a row the closure period wrote),
-- `admin_release_organization_legal_hold` (the new notice of 7 days) and `purge_organization_data` (the audit of a
-- system purge, and a closed organization refused by name now that the purge owner sees it) are recreated with the
-- same signature, owner and grants: the gate `purge-functions` compares them with the domain.
ALTER TABLE "organization_purges" ALTER COLUMN "privacy_case_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_purges" ALTER COLUMN "scheduled_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_purges" ALTER COLUMN "support_case_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ALTER COLUMN "principal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD COLUMN "trigger" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "actor" text DEFAULT 'principal' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_trigger_allowed" CHECK ("organization_purges"."trigger" IN ('admin', 'closure_period'));--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_trigger_coherent" CHECK (("organization_purges"."trigger" = 'admin' AND "organization_purges"."scheduled_by" IS NOT NULL AND "organization_purges"."support_case_id" IS NOT NULL AND "organization_purges"."privacy_case_id" IS NOT NULL)
        OR ("organization_purges"."trigger" = 'closure_period' AND "organization_purges"."scheduled_by" IS NULL AND "organization_purges"."support_case_id" IS NULL AND "organization_purges"."privacy_case_id" IS NULL));--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_actor_coherent" CHECK (("platform_audit_events"."actor" = 'principal' AND "platform_audit_events"."principal_id" IS NOT NULL)
        OR ("platform_audit_events"."actor" = 'system' AND "platform_audit_events"."principal_id" IS NULL AND "platform_audit_events"."support_case_id" IS NULL
            AND "platform_audit_events"."event_type" IN ('organization.purge_scheduled', 'organization.purge_completed')));--> statement-breakpoint
CREATE POLICY "organization_purges_purge_owner_insert" ON "organization_purges" AS PERMISSIVE FOR INSERT TO "polaris_purge_owner" WITH CHECK (trigger = 'closure_period');--> statement-breakpoint
ALTER POLICY "platform_audit_events_purge_owner_insert" ON "platform_audit_events" TO polaris_purge_owner WITH CHECK (entity_type = 'organization'
        AND entity_id = organization_id
        AND detail IS NULL
        AND ((event_type = 'organization.purge_completed'
              AND EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = platform_audit_events.organization_id AND purge_scope.status = 'purged')
              AND EXISTS (SELECT 1 FROM public.organization_purges AS purge_plan WHERE purge_plan.organization_id = platform_audit_events.organization_id
                            AND purge_plan.scheduled_by IS NOT DISTINCT FROM platform_audit_events.principal_id
                            AND purge_plan.support_case_id IS NOT DISTINCT FROM platform_audit_events.support_case_id
                            AND platform_audit_events.actor = CASE purge_plan.trigger WHEN 'closure_period' THEN 'system' ELSE 'principal' END))
          OR (event_type = 'organization.purge_scheduled'
              AND actor = 'system'
              AND EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = platform_audit_events.organization_id AND purge_scope.status = 'purge_pending')
              AND EXISTS (SELECT 1 FROM public.organization_purges AS purge_plan WHERE purge_plan.organization_id = platform_audit_events.organization_id
                            AND purge_plan.trigger = 'closure_period' AND purge_plan.purged_at IS NULL))));--> statement-breakpoint
-- What the purge owner reads to schedule, and nothing more: the closed organizations (status and time zone), their
-- closure record, whether a temporary access of the Admin is live, when the Admin cancelled a purge, and whether the
-- renewal is alive (five columns of the billing record). Each policy is only for a `closed` organization.
GRANT SELECT (timezone) ON TABLE public.organizations TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY organizations_purge_owner_select_closed ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (status = 'closed');--> statement-breakpoint
CREATE POLICY organizations_purge_owner_schedule ON public.organizations
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner USING (status = 'closed') WITH CHECK (status = 'purge_pending');--> statement-breakpoint
CREATE POLICY organization_closures_purge_owner_select_closed ON public.organization_closures
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_closures.organization_id AND purge_scope.status = 'closed'));--> statement-breakpoint
GRANT SELECT (organization_id, revoked_at, expires_at) ON TABLE public.tenant_access_grants TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY tenant_access_grants_purge_owner_select_closed ON public.tenant_access_grants
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = tenant_access_grants.organization_id AND purge_scope.status = 'closed'));--> statement-breakpoint
GRANT SELECT (cancelled_at) ON TABLE public.organization_purge_cancellations TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY organization_purge_cancellations_purge_owner_select_closed ON public.organization_purge_cancellations
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_purge_cancellations.organization_id AND purge_scope.status = 'closed'));--> statement-breakpoint
GRANT SELECT (organization_id, state, provider, provider_ref, cancel_at_period_end) ON TABLE public.organization_billing TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY organization_billing_purge_owner_select_closed ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_billing.organization_id AND purge_scope.status = 'closed'));--> statement-breakpoint
-- the purge row of the closure period (the insert policy above admits only `closure_period`), and the columns a schedule
-- writes again over an earlier row (one the Admin cancelled in an earlier cycle)
GRANT INSERT (organization_id, scheduled_at, not_before, trigger) ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before, trigger) ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (trigger) ON TABLE public.organization_purges TO polaris_admin_owner;--> statement-breakpoint
GRANT INSERT (actor) ON TABLE public.platform_audit_events TO polaris_purge_owner;--> statement-breakpoint
-- the dates of D, which the domain repeats (`closureDeadlines`); plain functions of 0085
GRANT EXECUTE ON FUNCTION public.closure_local_day_start(date, text) TO polaris_purge_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_deadlines(timestamptz, text) TO polaris_purge_owner;--> statement-breakpoint
-- The two policies of UPDATE on the organizations add up (closed or purge_pending in, purge_pending or purged out), so
-- they alone would let the purge owner take a closed organization straight to purged, or rename one that waits. This
-- trigger keeps the purge owner to its two moves: closed to purge_pending with nothing else changed, and purge_pending to
-- purged. Every other role is untouched (the WHEN clause), and a refusal leaves the row as it was.
CREATE FUNCTION public.organizations_purge_owner_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF (OLD.status = 'closed' AND NEW.status = 'purge_pending' AND NEW.name IS NOT DISTINCT FROM OLD.name)
     OR (OLD.status = 'purge_pending' AND NEW.status = 'purged') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'purge_transition_not_allowed' USING ERRCODE = '42501';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organizations_purge_owner_transition() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER organizations_purge_owner_transition
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW WHEN (CURRENT_USER = 'polaris_purge_owner')
  EXECUTE FUNCTION public.organizations_purge_owner_transition();--> statement-breakpoint
-- like the immutability triggers of the audit (0080): it fires under session_replication_role = replica too
ALTER TABLE public.organizations ENABLE ALWAYS TRIGGER organizations_purge_owner_transition;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
-- Why the purge of a closed organization waits, as a code, or null: a legal hold in force, a temporary access of the
-- Admin still live, a purge the Admin cancelled after this closure was requested (an earlier cycle does not count), or a
-- renewal still alive at a provider (`renewalAlive` of the domain: a provider and its reference linked, a state that
-- gives Pro and no cancellation at the end of the period). A paid access that only has to run out does not wait: the
-- store cannot be used and nothing is refunded. Internal to the schedule; nobody else executes it.
CREATE FUNCTION public.closed_organization_purge_wait(p_organization text, p_requested_at timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
  ) THEN
    RETURN 'legal_hold_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_access_grants AS access_grant
     WHERE access_grant.organization_id = p_organization AND access_grant.revoked_at IS NULL
       AND access_grant.expires_at > pg_catalog.now()
  ) THEN
    RETURN 'tenant_access_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_purge_cancellations AS cancellation
     WHERE cancellation.organization_id = p_organization AND cancellation.cancelled_at >= p_requested_at
  ) THEN
    RETURN 'purge_cancelled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = p_organization
       AND billing.provider IS NOT NULL AND billing.provider_ref IS NOT NULL
       AND billing.state IN ('trialing', 'active', 'grace')
       AND NOT billing.cancel_at_period_end
  ) THEN
    RETURN 'renewal_alive';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- The schedule of the closure period (ADR 0102): at most `p_limit` closed organizations whose recovery window ended and
-- whose D minus 7 local days arrived, oldest closure first, each under the organization's lock (the one the Admin's
-- schedule, the legal hold and the purge take), skipping one another transaction holds. Each one is checked again under
-- the lock, becomes `purge_pending` with `not_before` = the later of D plus 48 hours and now plus 7 days, and is audited
-- as the system's. An organization already scheduled is no longer `closed`, so a second run, or two at once, schedule it
-- once. It answers how many it scheduled now, how many the closure period scheduled in the last 24 hours (the alert
-- above 5 a day) and how many closed organizations are still waiting 30 days after D with no legal hold (the alert of
-- a store left behind: a cancellation of the Admin, a renewal alive or an access of the Admin keeps it closed).
CREATE FUNCTION public.schedule_closed_organization_purges(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  candidate record;
  requested timestamptz;
  deletable timestamptz;
  due timestamptz;
  scheduled integer := 0;
  last_day integer;
  overdue integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT organization.id
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
      CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
     WHERE organization.status = 'closed'
       AND closure.closed_at IS NOT NULL
       AND closure.recover_until <= pg_catalog.now()
       AND deadline.d7_at <= pg_catalog.now()
       AND public.closed_organization_purge_wait(organization.id, closure.requested_at) IS NULL
     ORDER BY closure.requested_at, organization.id
     LIMIT p_limit
  LOOP
    PERFORM 1 FROM public.organizations AS organization
     WHERE organization.id = candidate.id AND organization.status = 'closed'
       FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    -- under the lock, a new snapshot: what changed since the scan (a hold, a cancellation, a recovery) is seen
    SELECT closure.requested_at, deadline.deletable_from INTO requested, deletable
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
      CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
     WHERE organization.id = candidate.id AND organization.status = 'closed'
       AND closure.closed_at IS NOT NULL
       AND closure.recover_until <= pg_catalog.now()
       AND deadline.d7_at <= pg_catalog.now();
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN public.closed_organization_purge_wait(candidate.id, requested) IS NOT NULL;
    due := GREATEST(deletable + interval '48 hours', pg_catalog.now() + interval '168 hours');
    UPDATE public.organizations SET status = 'purge_pending', updated_at = pg_catalog.now()
     WHERE id = candidate.id AND status = 'closed';
    -- a row of an earlier cycle (the Admin's, cancelled) starts from nothing, as the Admin's schedule does
    INSERT INTO public.organization_purges (organization_id, scheduled_at, not_before, trigger)
    VALUES (candidate.id, pg_catalog.now(), due, 'closure_period')
    ON CONFLICT (organization_id) DO UPDATE
      SET scheduled_at = EXCLUDED.scheduled_at, scheduled_by = NULL, support_case_id = NULL, privacy_case_id = NULL,
          not_before = EXCLUDED.not_before, trigger = 'closure_period', attempts = 0, locked_until = NULL,
          last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = NULL;
    INSERT INTO public.platform_audit_events
      (actor, principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail)
    VALUES
      ('system', NULL, 'organization.purge_scheduled', candidate.id, NULL, 'organization', candidate.id, NULL);
    scheduled := scheduled + 1;
  END LOOP;
  SELECT pg_catalog.count(*)::integer INTO last_day
    FROM public.organization_purges AS purge
   WHERE purge.trigger = 'closure_period' AND purge.scheduled_at > pg_catalog.now() - interval '24 hours';
  SELECT pg_catalog.count(*)::integer INTO overdue
    FROM public.organizations AS organization
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
   WHERE organization.status = 'closed'
     AND closure.closed_at IS NOT NULL
     AND deadline.deletable_from + interval '720 hours' <= pg_catalog.now()
     AND NOT EXISTS (
       SELECT 1 FROM public.organization_legal_holds AS hold
        WHERE hold.organization_id = organization.id AND hold.released_at IS NULL
     );
  RETURN pg_catalog.jsonb_build_object('scheduled', scheduled, 'scheduledLastDay', last_day, 'overdue', overdue);
END;
$function$;--> statement-breakpoint
-- The purge as in 0084, with two changes. A closed organization is now visible to this role (the schedule above reads
-- it), so one that is not `purge_pending` is refused by name before anything else, as it was by not being seen. The
-- audit of the completion names who scheduled it: the operator and the case, or the system with neither (ADR 0102).
-- The tombstone takes the privacy case as before, null for the closure period (the ledger already accepts it).
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
REVOKE ALL ON FUNCTION public.closed_organization_purge_wait(text, timestamptz) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.schedule_closed_organization_purges(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.schedule_closed_organization_purges(integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- The Admin's schedule as in 0080, with one change: scheduled again over a row the closure period wrote (cancelled by
-- the Admin), the row is an operator's again (`trigger = 'admin'`, ADR 0102). The search_path and the rest are unchanged.
CREATE OR REPLACE FUNCTION public.admin_schedule_organization_purge(p_principal uuid, p_case uuid, p_organization text, p_delay_seconds bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  current_status text;
  window_end timestamptz;
  closure_requested timestamptz;
  privacy_case uuid;
  privacy_type text;
  privacy_requester text;
  privacy_stage text;
  privacy_decision text;
  privacy_scope text[];
  whole_organization text[] := ARRAY['organization_profile', 'customers', 'sales', 'inventory_catalog', 'media'];
  due timestamptz;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 315360000 THEN
    RAISE EXCEPTION 'invalid_purge_delay' USING ERRCODE = '22023';
  END IF;
  -- the case comes first: a plain support case is refused whatever the organization's state
  SELECT privacy.support_case_id, privacy.request_type, privacy.requester_kind, privacy.stage, privacy.decision,
         privacy.scope_categories
    INTO privacy_case, privacy_type, privacy_requester, privacy_stage, privacy_decision, privacy_scope
    FROM public.privacy_cases AS privacy WHERE privacy.support_case_id = p_case;
  IF privacy_case IS NULL THEN
    RAISE EXCEPTION 'privacy_case_required' USING ERRCODE = '55000';
  END IF;
  IF privacy_type IS DISTINCT FROM 'deletion' THEN
    RAISE EXCEPTION 'privacy_case_not_deletion' USING ERRCODE = '55000';
  END IF;
  IF privacy_requester IS DISTINCT FROM 'organization_owner' THEN
    RAISE EXCEPTION 'privacy_requester_not_owner' USING ERRCODE = '55000';
  END IF;
  IF privacy_stage NOT IN ('decided', 'executed') OR privacy_decision IS DISTINCT FROM 'accept' THEN
    RAISE EXCEPTION 'privacy_case_not_accepted' USING ERRCODE = '55000';
  END IF;
  IF privacy_scope IS NULL OR NOT (privacy_scope @> whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_incomplete' USING ERRCODE = '55000';
  END IF;
  -- exactly what the purge removes: a case that also covers data the purge keeps (account, authentication,
  -- billing, the audit logs) would record a decision the purge does not carry out
  IF NOT (privacy_scope <@ whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_covers_kept_data' USING ERRCODE = '55000';
  END IF;
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  IF current_status IN ('purge_pending', 'purged') THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'status', current_status);
  END IF;
  IF current_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  SELECT closure.recover_until, closure.requested_at INTO window_end, closure_requested
    FROM public.organization_closures AS closure
   WHERE closure.organization_id = target AND closure.closed_at IS NOT NULL;
  IF window_end IS NULL THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  IF window_end > pg_catalog.now() THEN
    RAISE EXCEPTION 'recovery_window_open' USING ERRCODE = '55000';
  END IF;
  -- the closure period of 90 days (decision of 19/10/2026, ADR 0081), whatever window the closure had: the owner
  -- can recover it only while the window is open, and the purge never starts before the period is over
  IF closure_requested + interval '90 days' > pg_catalog.now() THEN
    RAISE EXCEPTION 'closure_period_not_elapsed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = target AND hold.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_access_grants AS access_grant
     WHERE access_grant.organization_id = target AND access_grant.revoked_at IS NULL
       AND access_grant.expires_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'tenant_access_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = target AND billing.state IN ('trialing', 'active', 'grace')
       AND billing.access_ends_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'paid_access_running' USING ERRCODE = '55000';
  END IF;
  due := GREATEST(window_end, closure_requested + interval '90 days') + p_delay_seconds * interval '1 second';
  UPDATE public.organizations SET status = 'purge_pending', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'closed';
  -- a purge scheduled again (after a cancellation, or a restore that brought the organization back) starts from
  -- nothing, an operator's again even over a row the closure period wrote (ADR 0102); the reason of an earlier
  -- cancellation stays in organization_purge_cancellations
  INSERT INTO public.organization_purges
    (organization_id, scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before)
  VALUES (target, pg_catalog.now(), p_principal, p_case, privacy_case, due)
  ON CONFLICT (organization_id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at, scheduled_by = EXCLUDED.scheduled_by,
        support_case_id = EXCLUDED.support_case_id, privacy_case_id = EXCLUDED.privacy_case_id,
        not_before = EXCLUDED.not_before, trigger = 'admin', attempts = 0, locked_until = NULL,
        last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = NULL;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_scheduled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'purge_pending', 'notBefore', due);
END;
$function$;--> statement-breakpoint
-- The release of a legal hold as in 0075 (search_path of 0077), plus the notice of AC-61: a purge the closure period
-- scheduled does not go on by itself when the hold that held it is released. It is pushed to the release plus 7 days
-- (never earlier than it already was), so the owner has the same notice as at the schedule. A purge of the Admin keeps
-- running from the next run on, as before: the operator who released the hold decides.
CREATE OR REPLACE FUNCTION public.admin_release_organization_legal_hold(p_principal uuid, p_case uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  released uuid;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  UPDATE public.organization_legal_holds AS hold
     SET released_at = pg_catalog.now(), released_by = p_principal
   WHERE hold.organization_id = target AND hold.released_at IS NULL
  RETURNING hold.id INTO released;
  IF released IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'held', false);
  END IF;
  UPDATE public.organization_purges AS purge
     SET not_before = GREATEST(purge.not_before, pg_catalog.now() + interval '168 hours')
   WHERE purge.organization_id = target AND purge.trigger = 'closure_period' AND purge.purged_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.organizations AS organization
        WHERE organization.id = target AND organization.status = 'purge_pending'
     );
  PERFORM public.admin_record_audit(
    p_principal, 'organization.legal_hold_released', target, p_case, 'organization_legal_hold', released::text, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'held', false);
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
