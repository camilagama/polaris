-- The full purge of a closed organization (plan PR107, ADR 0081). An operator schedules it on a
-- `closed` organization (an open case, the recovery window over, no live tenant access, no paid access
-- running); the privacy job claims it, removes the storage, and calls one function that writes the
-- deletion ledger tombstone and deletes every row of the tenant in one transaction. The organization's
-- row stays as a tombstone (status `purged`, name replaced), so the support and privacy cases, the
-- platform audit, the billing records and the deletion ledger survive it. The purge functions belong to
-- a role of their own that is never a login; only the privacy runtime executes them.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_purge_owner') THEN
    EXECUTE 'CREATE ROLE polaris_purge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
CREATE TABLE "organization_purges" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"last_error_code" text,
	"locked_until" timestamp with time zone,
	"not_before" timestamp with time zone NOT NULL,
	"organization_id" text PRIMARY KEY NOT NULL,
	"privacy_case_id" uuid NOT NULL,
	"purged_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_by" uuid NOT NULL,
	"support_case_id" uuid NOT NULL,
	"swept_at" timestamp with time zone,
	CONSTRAINT "organization_purges_attempts_allowed" CHECK ("organization_purges"."attempts" >= 0),
	CONSTRAINT "organization_purges_cancellation_coherent" CHECK ((("organization_purges"."cancelled_at" IS NULL) = ("organization_purges"."cancelled_by" IS NULL))
        AND (("organization_purges"."cancelled_at" IS NULL) = ("organization_purges"."cancel_reason" IS NULL))
        AND ("organization_purges"."cancelled_at" IS NULL OR "organization_purges"."purged_at" IS NULL)
        AND ("organization_purges"."cancel_reason" IS NULL OR (char_length("organization_purges"."cancel_reason") BETWEEN 1 AND 500 AND "organization_purges"."cancel_reason" = btrim("organization_purges"."cancel_reason") AND "organization_purges"."cancel_reason" !~ '[[:cntrl:]]'))),
	CONSTRAINT "organization_purges_error_code_format" CHECK ("organization_purges"."last_error_code" IS NULL OR "organization_purges"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "organization_purges_progress_coherent" CHECK (("organization_purges"."swept_at" IS NULL OR "organization_purges"."purged_at" IS NOT NULL)
        AND "organization_purges"."privacy_case_id" = "organization_purges"."support_case_id")
);
--> statement-breakpoint
ALTER TABLE "organization_purges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_cancelled_by_platform_principals_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_scheduled_by_platform_principals_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_support_case_id_support_cases_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_purges_due_idx" ON "organization_purges" USING btree ("not_before");--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed'));--> statement-breakpoint
CREATE POLICY "organization_purges_purge_owner_select" ON "organization_purges" AS PERMISSIVE FOR SELECT TO "polaris_purge_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purges_purge_owner_update" ON "organization_purges" AS PERMISSIVE FOR UPDATE TO "polaris_purge_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_select" ON "organization_purges" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_insert" ON "organization_purges" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_update" ON "organization_purges" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "organization_purges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.organization_purges FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (attempts, locked_until, last_error_code, purged_at, swept_at) ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.organization_purges TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before, attempts, locked_until, last_error_code, purged_at, swept_at, cancelled_at, cancelled_by, cancel_reason) ON TABLE public.organization_purges TO polaris_admin_owner;--> statement-breakpoint
-- what the purge owner may see and delete: the rows of an organization whose purge was scheduled, and
-- nothing else. The tables it deletes from get SELECT and DELETE; the variant tables, which go with
-- their product through the foreign key cascade, get SELECT only (the deferred variant checks read
-- them). Billing, support, privacy cases, platform audit and the deletion ledger are not here.
GRANT SELECT (id, status) ON TABLE public.organizations TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (name, status, updated_at) ON TABLE public.organizations TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY organizations_purge_owner_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (status IN ('purge_pending', 'purged'));--> statement-breakpoint
CREATE POLICY organizations_purge_owner_update ON public.organizations
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner USING (status = 'purge_pending') WITH CHECK (status = 'purged');--> statement-breakpoint
DO $grants$
DECLARE
  deleted_tables text[] := ARRAY[
    'sale_return_items', 'sale_returns', 'sale_payments', 'sale_adjustments', 'sale_cancellations',
    'sale_customer_links', 'expenses', 'sale_items', 'sales', 'stock_movements', 'inventory_balances',
    'variant_media', 'product_media', 'product_publications', 'operational_variant_selections',
    'products', 'media_assets', 'categories', 'customers', 'goal_target_changes', 'goals',
    'expense_recurring_rules', 'expense_categories', 'payment_profile_rules', 'payment_profiles',
    'sync_commands', 'sync_changes', 'sync_cursors', 'offline_grants', 'data_export_files',
    'data_exports', 'public_catalog_profiles', 'tenant_audit_event', 'event_outbox', 'organization_closures',
    'memberships'
  ];
  cascaded_tables text[] := ARRAY['product_variants', 'product_options', 'product_option_values', 'variant_option_values'];
  target text;
BEGIN
  FOREACH target IN ARRAY deleted_tables || cascaded_tables LOOP
    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE public.%I TO polaris_purge_owner', target);
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = %I.organization_id AND purge_scope.status = %L))',
      target || '_purge_owner_select', target, target, 'purge_pending'
    );
  END LOOP;
  FOREACH target IN ARRAY deleted_tables LOOP
    EXECUTE pg_catalog.format('GRANT DELETE ON TABLE public.%I TO polaris_purge_owner', target);
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR DELETE TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = %I.organization_id AND purge_scope.status = %L))',
      target || '_purge_owner_delete', target, target, 'purge_pending'
    );
  END LOOP;
END
$grants$;--> statement-breakpoint
-- the tombstone of the purge (ADR 0080): only the organization itself, only while its purge runs
GRANT INSERT (organization_id, entity_type, entity_id, operation, privacy_case_id) ON TABLE public.deletion_ledger TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY deletion_ledger_organization_purge_insert ON public.deletion_ledger
  AS PERMISSIVE FOR INSERT TO polaris_purge_owner WITH CHECK (
    entity_type = 'organization'
    AND operation = 'purge'
    AND entity_id = organization_id
    AND EXISTS (
      SELECT 1 FROM public.organizations AS purge_scope
       WHERE purge_scope.id = deletion_ledger.organization_id AND purge_scope.status = 'purge_pending'
    )
  );--> statement-breakpoint
-- the completion of the purge, the one audit event the purge writes itself: the principal is the operator
-- who scheduled it (a job has none), there is no detail, and it is written once the organization is `purged`
GRANT INSERT (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail) ON TABLE public.platform_audit_events TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY "platform_audit_events_purge_owner_insert" ON "platform_audit_events" AS PERMISSIVE FOR INSERT TO "polaris_purge_owner" WITH CHECK (event_type = 'organization.purge_completed'
        AND entity_type = 'organization'
        AND entity_id = organization_id
        AND detail IS NULL
        AND EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = platform_audit_events.organization_id AND purge_scope.status = 'purged'));--> statement-breakpoint
-- the Admin reads the end of the recovery window before scheduling
GRANT SELECT (organization_id, recover_until) ON TABLE public.organization_closures TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY organization_closures_admin_owner_select ON public.organization_closures
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
-- Stock movements stay append-only for everyone; the one exception is the purge owner deleting the
-- movements of an organization whose purge was scheduled (the body is otherwise unchanged).
CREATE OR REPLACE FUNCTION public.prevent_stock_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'polaris_purge_owner' THEN
    IF EXISTS (
      SELECT 1 FROM public.organizations AS purge_scope
       WHERE purge_scope.id = OLD.organization_id AND purge_scope.status = 'purge_pending'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'stock_movements are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'stock_movements_append_only';
END;
$function$;--> statement-breakpoint
-- The media links of a tombstoned product stay frozen for everyone except, again, the purge owner
-- deleting an organization whose purge was scheduled (the exception comes before the product lock).
CREATE OR REPLACE FUNCTION public.guard_media_link_product_not_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_organization_id text;
  target_product_id uuid;
  product_deleted_at timestamp;
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'polaris_purge_owner' THEN
    IF EXISTS (
      SELECT 1 FROM public.organizations AS purge_scope
       WHERE purge_scope.id = OLD.organization_id AND purge_scope.status = 'purge_pending'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (
      TG_TABLE_NAME = 'variant_media'
      AND (to_jsonb(OLD) ->> 'variant_id') IS DISTINCT FROM
          (to_jsonb(NEW) ->> 'variant_id')
    )
  ) THEN
    RAISE EXCEPTION 'media association identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_association_identity_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_product_id := OLD.product_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_product_id := NEW.product_id;
  END IF;

  SELECT product.deleted_at
  INTO product_deleted_at
  FROM public.products AS product
  WHERE product.organization_id = target_organization_id
    AND product.id = target_product_id
  FOR UPDATE;

  IF FOUND AND product_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'media associations cannot change for a tombstoned product'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_product_tombstone_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- An export file is recorded only for an active organization (ADR 0078 and 0081): a run that read before
-- the closure, or a claim of an export whose organization is no longer active, cannot leave a copy on
-- record. The job writes the object before recording it and removes the export's objects when it fails.
CREATE FUNCTION public.data_export_files_require_active_organization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations AS organization
     WHERE organization.id = NEW.organization_id AND organization.status = 'active'
  ) THEN
    RAISE EXCEPTION 'organization_not_active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.data_export_files_require_active_organization() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER data_export_files_require_active_organization
  BEFORE INSERT ON public.data_export_files
  FOR EACH ROW EXECUTE FUNCTION public.data_export_files_require_active_organization();--> statement-breakpoint
-- The explicit trigger of the purge (no job schedules one while the retention of a closed organization
-- is only proposed, ADR 0079). It needs an open case of the organization the operator names (a
-- confirmation, not the authority: the case decides the organization) and that case must be the privacy
-- case of a deletion: requested by the organization's owner, decided `accept` in full (never
-- `partially_accept`), with a scope that covers the whole tenant (every category the purge removes). A
-- plain support case never starts a purge, and neither does a refused, undecided or partial request (ADR
-- 0077 and 0081). Besides, the organization must be `closed` with its recovery window over, with no live
-- temporary access and no trial or paid access running. The delay after the window is an argument because
-- the retention registry owns it (zero while the class is proposed).
CREATE FUNCTION public.admin_schedule_organization_purge(p_principal uuid, p_case uuid, p_organization text, p_delay_seconds bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
  current_status text;
  window_end timestamptz;
  privacy_case uuid;
  privacy_type text;
  privacy_requester text;
  privacy_stage text;
  privacy_decision text;
  privacy_scope text[];
  whole_organization text[] := ARRAY['organization_profile', 'customers', 'sales', 'inventory_catalog', 'media', 'audit_logs'];
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
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  IF current_status IN ('purge_pending', 'purged') THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'status', current_status);
  END IF;
  IF current_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  SELECT closure.recover_until INTO window_end
    FROM public.organization_closures AS closure WHERE closure.organization_id = target;
  IF window_end IS NULL THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  IF window_end > pg_catalog.now() THEN
    RAISE EXCEPTION 'recovery_window_open' USING ERRCODE = '55000';
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
  due := window_end + p_delay_seconds * interval '1 second';
  UPDATE public.organizations SET status = 'purge_pending', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'closed';
  -- a purge scheduled again (after a cancellation, or a restore that brought the organization back) starts from nothing
  INSERT INTO public.organization_purges
    (organization_id, scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before)
  VALUES (target, pg_catalog.now(), p_principal, p_case, privacy_case, due)
  ON CONFLICT (organization_id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at, scheduled_by = EXCLUDED.scheduled_by,
        support_case_id = EXCLUDED.support_case_id, privacy_case_id = EXCLUDED.privacy_case_id,
        not_before = EXCLUDED.not_before, attempts = 0, locked_until = NULL,
        last_error_code = NULL, purged_at = NULL, swept_at = NULL,
        cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_scheduled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'purge_pending', 'notBefore', due);
END;
$function$;--> statement-breakpoint
-- The way back from `purge_pending`, for an operator who scheduled it by mistake or whose request was
-- withdrawn: the same capability, an open case of the organization named, and a reason that stays on the
-- purge row (never in the audit event, which carries no free text). It works only while no run holds the
-- purge: a lease still running means the storage may already be going, and then nothing is undone. It takes
-- the organization lock first, like the purge, and the purge row after it, so a run that claims at the same
-- moment either gets the row first (and the cancel is refused) or finds the organization `closed` again.
CREATE FUNCTION public.admin_cancel_organization_purge(p_principal uuid, p_case uuid, p_organization text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
  clean_reason text := pg_catalog.btrim(p_reason);
  current_status text;
  plan public.organization_purges;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  IF clean_reason IS NULL OR pg_catalog.char_length(clean_reason) NOT BETWEEN 1 AND 500
     OR clean_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_cancel_reason' USING ERRCODE = '22023';
  END IF;
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  IF current_status = 'purged' THEN
    RAISE EXCEPTION 'purge_already_done' USING ERRCODE = '55000';
  END IF;
  IF current_status IS DISTINCT FROM 'purge_pending' THEN
    RAISE EXCEPTION 'purge_not_scheduled' USING ERRCODE = '55000';
  END IF;
  SELECT purge.* INTO plan FROM public.organization_purges AS purge
   WHERE purge.organization_id = target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_not_scheduled' USING ERRCODE = '55000';
  END IF;
  IF plan.locked_until IS NOT NULL AND plan.locked_until > pg_catalog.now() THEN
    RAISE EXCEPTION 'purge_in_progress' USING ERRCODE = '55000';
  END IF;
  UPDATE public.organizations SET status = 'closed', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'purge_pending';
  UPDATE public.organization_purges
     SET cancelled_at = pg_catalog.now(), cancelled_by = p_principal, cancel_reason = clean_reason,
         locked_until = NULL
   WHERE organization_id = target;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_cancelled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'closed');
END;
$function$;--> statement-breakpoint
-- a run takes the oldest due purge (or a purged organization whose second sweep did not finish) and holds
-- it for a while; an organization with an export run still holding its lease waits for the next run
CREATE FUNCTION public.claim_organization_purge(p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  picked public.organization_purges;
  picked_status text;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT purge.* INTO picked
    FROM public.organization_purges AS purge
    JOIN public.organizations AS organization ON organization.id = purge.organization_id
   WHERE (purge.locked_until IS NULL OR purge.locked_until <= pg_catalog.now())
     AND (
       (organization.status = 'purge_pending' AND purge.not_before <= pg_catalog.now()
         AND NOT EXISTS (
           SELECT 1 FROM public.data_exports AS export_row
            WHERE export_row.organization_id = purge.organization_id
              AND export_row.status = 'running' AND export_row.locked_until > pg_catalog.now()
         ))
       OR (organization.status = 'purged' AND purge.purged_at IS NOT NULL AND purge.swept_at IS NULL)
     )
   ORDER BY purge.scheduled_at, purge.organization_id
   LIMIT 1
     FOR UPDATE OF purge SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT organization.status INTO picked_status
    FROM public.organizations AS organization WHERE organization.id = picked.organization_id;
  UPDATE public.organization_purges
     SET attempts = picked.attempts + 1,
         locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second'
   WHERE organization_id = picked.organization_id;
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', picked.organization_id,
    'phase', CASE WHEN picked_status = 'purged' THEN 'sweep' ELSE 'purge' END,
    'attempt', picked.attempts + 1
  );
END;
$function$;--> statement-breakpoint
-- the images to remove from storage, read before the rows go: the derivatives' keys carry only the asset
CREATE FUNCTION public.list_organization_purge_media(p_organization text)
RETURNS TABLE (id uuid, storage_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_purges AS purge
      JOIN public.organizations AS organization ON organization.id = purge.organization_id
     WHERE purge.organization_id = p_organization AND organization.status = 'purge_pending'
       AND purge.locked_until > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'purge_not_claimed' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    SELECT asset.id, asset.storage_key FROM public.media_assets AS asset
     WHERE asset.organization_id = p_organization
     ORDER BY asset.id;
END;
$function$;--> statement-breakpoint
-- Every row of the tenant, in one transaction: the tombstone first, then the tables in an order the
-- restrictive foreign keys accept, then the deferred checks, and only then the organization becomes
-- `purged`. Called again for a purged organization it does nothing.
CREATE FUNCTION public.purge_organization_data(p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
    'data_exports', 'public_catalog_profiles', 'tenant_audit_event', 'event_outbox', 'organization_closures',
    'memberships'
  ];
  target text;
  removed bigint;
  total bigint := 0;
BEGIN
  -- the lock comes first: a run that waited behind another one sees the organization it left (this role
  -- locks only `purge_pending` rows, so a purged one is not found and is read again without the lock)
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = p_organization FOR UPDATE;
  IF NOT FOUND THEN
    SELECT organization.status INTO current_status
      FROM public.organizations AS organization WHERE organization.id = p_organization;
    IF current_status = 'purged' THEN
      RETURN pg_catalog.jsonb_build_object('alreadyPurged', true, 'deletedRows', 0);
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
  RETURN pg_catalog.jsonb_build_object('alreadyPurged', false, 'deletedRows', total);
END;
$function$;--> statement-breakpoint
-- a step that failed is written down; the purge stays held until its lease ends, so the same run does not
-- take it again, and a later run tries again from the start
CREATE FUNCTION public.record_organization_purge_failure(p_organization text, p_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_error_code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.organization_purges SET last_error_code = p_code
   WHERE organization_id = p_organization;
END;
$function$;--> statement-breakpoint
-- the second sweep of the storage is done: nothing of the organization is left to look for
CREATE FUNCTION public.complete_organization_purge_sweep(p_organization text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.organization_purges SET swept_at = pg_catalog.now(), locked_until = NULL, last_error_code = NULL
   WHERE organization_id = p_organization AND purged_at IS NOT NULL AND swept_at IS NULL
     AND locked_until > pg_catalog.now();
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_schedule_organization_purge(uuid, uuid, text, bigint) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_cancel_organization_purge(uuid, uuid, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_schedule_organization_purge(uuid, uuid, text, bigint) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_schedule_organization_purge(uuid, uuid, text, bigint) TO polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_cancel_organization_purge(uuid, uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_cancel_organization_purge(uuid, uuid, text, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_organization_purge(integer) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.list_organization_purge_media(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.purge_organization_data(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.record_organization_purge_failure(text, text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.complete_organization_purge_sweep(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_organization_purge(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_organization_purge_media(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_organization_data(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_organization_purge_failure(text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_organization_purge_sweep(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_organization_purge(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_organization_purge_media(text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_organization_data(text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_organization_purge_failure(text, text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.complete_organization_purge_sweep(text) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;
