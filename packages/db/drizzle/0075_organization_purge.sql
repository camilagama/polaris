-- The full purge of a closed organization (plan PR107, ADR 0081). An operator schedules it on a
-- `closed` organization (an open case, the recovery window over, no live tenant access, no paid access
-- running); the privacy job claims it, removes the storage, and calls one function that writes the
-- deletion ledger tombstone and deletes every row of the tenant in one transaction. The organization's
-- row stays as a tombstone (status `purged`, name replaced), so the support and privacy cases, the
-- platform audit, the billing records and the deletion ledger survive it. The purge functions belong to
-- a role of their own that is never a login; only the privacy runtime executes them. The decisions of
-- 18/10/2026 (ADR 0081): the purge runs only once the organization has been closed for 30 days and never
-- while a legal hold is in force; it removes the tenant's operational data (Polaris is its processor), keeps
-- the billing events with the payer's data taken out, and removes the free text of the cases it keeps.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_purge_owner') THEN
    EXECUTE 'CREATE ROLE polaris_purge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one deletes tenant data and is never a login
  EXECUTE 'ALTER ROLE polaris_purge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
CREATE TABLE "organization_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"placed_by" uuid NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"support_case_id" uuid NOT NULL,
	CONSTRAINT "organization_legal_holds_release_coherent" CHECK (("organization_legal_holds"."released_at" IS NULL) = ("organization_legal_holds"."released_by" IS NULL)
        AND ("organization_legal_holds"."released_at" IS NULL OR "organization_legal_holds"."released_at" >= "organization_legal_holds"."placed_at"))
);
--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_purge_cancellations" (
	"cancelled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"support_case_id" uuid NOT NULL,
	CONSTRAINT "organization_purge_cancellations_reason_format" CHECK (char_length("organization_purge_cancellations"."reason") BETWEEN 1 AND 500 AND "organization_purge_cancellations"."reason" = btrim("organization_purge_cancellations"."reason") AND "organization_purge_cancellations"."reason" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "organization_purge_cancellations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_purges" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"locked_until" timestamp with time zone,
	"not_before" timestamp with time zone NOT NULL,
	"organization_id" text PRIMARY KEY NOT NULL,
	"privacy_case_id" uuid NOT NULL,
	"purged_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_by" uuid NOT NULL,
	"storage_touched_at" timestamp with time zone,
	"support_case_id" uuid NOT NULL,
	"swept_at" timestamp with time zone,
	CONSTRAINT "organization_purges_attempts_allowed" CHECK ("organization_purges"."attempts" >= 0),
	CONSTRAINT "organization_purges_error_code_format" CHECK ("organization_purges"."last_error_code" IS NULL OR "organization_purges"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "organization_purges_progress_coherent" CHECK (("organization_purges"."swept_at" IS NULL OR "organization_purges"."purged_at" IS NOT NULL)
        AND "organization_purges"."privacy_case_id" = "organization_purges"."support_case_id")
);
--> statement-breakpoint
ALTER TABLE "organization_purges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ADD CONSTRAINT "organization_legal_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ADD CONSTRAINT "organization_legal_holds_placed_by_platform_principals_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ADD CONSTRAINT "organization_legal_holds_released_by_platform_principals_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ADD CONSTRAINT "organization_legal_holds_support_case_id_support_cases_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purge_cancellations" ADD CONSTRAINT "organization_purge_cancellations_cancelled_by_platform_principals_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purge_cancellations" ADD CONSTRAINT "organization_purge_cancellations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purge_cancellations" ADD CONSTRAINT "organization_purge_cancellations_support_case_id_support_cases_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_scheduled_by_platform_principals_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_purges" ADD CONSTRAINT "organization_purges_support_case_id_support_cases_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_legal_holds_active_unique" ON "organization_legal_holds" USING btree ("organization_id") WHERE "organization_legal_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_purge_cancellations_organization_idx" ON "organization_purge_cancellations" USING btree ("organization_id","cancelled_at");--> statement-breakpoint
CREATE INDEX "organization_purges_due_idx" ON "organization_purges" USING btree ("not_before");--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released'));--> statement-breakpoint
CREATE POLICY "platform_audit_events_purge_owner_insert" ON "platform_audit_events" AS PERMISSIVE FOR INSERT TO "polaris_purge_owner" WITH CHECK (event_type = 'organization.purge_completed'
        AND entity_type = 'organization'
        AND entity_id = organization_id
        AND detail IS NULL
        AND EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = platform_audit_events.organization_id AND purge_scope.status = 'purged')
        AND EXISTS (SELECT 1 FROM public.organization_purges AS purge_plan WHERE purge_plan.organization_id = platform_audit_events.organization_id AND purge_plan.scheduled_by = platform_audit_events.principal_id AND purge_plan.support_case_id = platform_audit_events.support_case_id));--> statement-breakpoint
CREATE POLICY "organization_legal_holds_admin_owner_select" ON "organization_legal_holds" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_legal_holds_admin_owner_insert" ON "organization_legal_holds" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_legal_holds_admin_owner_update" ON "organization_legal_holds" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_legal_holds_purge_owner_select" ON "organization_legal_holds" AS PERMISSIVE FOR SELECT TO "polaris_purge_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purge_cancellations_admin_owner_select" ON "organization_purge_cancellations" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purge_cancellations_admin_owner_insert" ON "organization_purge_cancellations" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_purges_purge_owner_select" ON "organization_purges" AS PERMISSIVE FOR SELECT TO "polaris_purge_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purges_purge_owner_update" ON "organization_purges" AS PERMISSIVE FOR UPDATE TO "polaris_purge_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_select" ON "organization_purges" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_insert" ON "organization_purges" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_purges_admin_owner_update" ON "organization_purges" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "organization_purge_cancellations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_purges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_legal_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- the legal holds: the owner of the Admin functions places (INSERT) and releases (only the release columns)
-- them, the purge owner only reads whether one is in force, and nobody deletes one
REVOKE ALL ON TABLE public.organization_legal_holds FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner, polaris_purge_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.organization_legal_holds TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (released_at, released_by) ON TABLE public.organization_legal_holds TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT (organization_id, released_at) ON TABLE public.organization_legal_holds TO polaris_purge_owner;--> statement-breakpoint
-- a released hold is final, and no hold is ever deleted, even around the functions
CREATE FUNCTION public.organization_legal_holds_release_is_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'organization legal holds are never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.support_case_id IS DISTINCT FROM OLD.support_case_id
     OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
     OR NEW.placed_by IS DISTINCT FROM OLD.placed_by THEN
    RAISE EXCEPTION 'a legal hold only changes when it is released, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_legal_holds_release_is_final() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER organization_legal_holds_release_is_final
  BEFORE UPDATE OR DELETE ON public.organization_legal_holds
  FOR EACH ROW EXECUTE FUNCTION public.organization_legal_holds_release_is_final();--> statement-breakpoint
CREATE TRIGGER organization_legal_holds_no_truncate
  BEFORE TRUNCATE ON public.organization_legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION public.organization_legal_holds_release_is_final();--> statement-breakpoint
REVOKE ALL ON TABLE public.organization_purges FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (attempts, locked_until, last_error_code, purged_at, swept_at, storage_touched_at) ON TABLE public.organization_purges TO polaris_purge_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.organization_purges TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before, attempts, locked_until, last_error_code, purged_at, swept_at, storage_touched_at) ON TABLE public.organization_purges TO polaris_admin_owner;--> statement-breakpoint
-- the cancellations are append-only: the owner of the Admin functions writes and reads them, never changes or deletes
REVOKE ALL ON TABLE public.organization_purge_cancellations FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner, polaris_purge_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.organization_purge_cancellations TO polaris_admin_owner;--> statement-breakpoint
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
    'data_exports', 'public_catalog_profiles', 'tenant_audit_event', 'event_outbox', 'queue_processing',
    'queue_dead_letters', 'organization_closures', 'memberships'
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
-- The decisions of 18/10/2026 (ADR 0081). The billing events of the organization stay (fiscal period) with
-- their fact reduced to the keys the lifecycle writes: the purge owner reads and rewrites only `fact`, only
-- while the organization's purge is scheduled.
GRANT SELECT (id, organization_id, fact) ON TABLE public.billing_events TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (fact) ON TABLE public.billing_events TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY billing_events_purge_owner_select ON public.billing_events
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = billing_events.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY billing_events_purge_owner_update ON public.billing_events
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = billing_events.organization_id AND purge_scope.status = 'purge_pending'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = billing_events.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
-- the support and privacy cases (and the purge cancellations) stay as the record of the case; their free text
-- is removed: the purge owner reads and rewrites only those text columns, only for an organization being purged
GRANT SELECT (id, organization_id, reason, context, resolution) ON TABLE public.support_cases TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (reason, context, resolution) ON TABLE public.support_cases TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY support_cases_purge_owner_select ON public.support_cases
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = support_cases.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY support_cases_purge_owner_update ON public.support_cases
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = support_cases.organization_id AND purge_scope.status = 'purge_pending'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = support_cases.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
GRANT SELECT (support_case_id, note, decision_note) ON TABLE public.privacy_cases TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (note, decision_note) ON TABLE public.privacy_cases TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY privacy_cases_purge_owner_select ON public.privacy_cases
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.support_cases AS purge_case JOIN public.organizations AS purge_scope ON purge_scope.id = purge_case.organization_id WHERE purge_case.id = privacy_cases.support_case_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY privacy_cases_purge_owner_update ON public.privacy_cases
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.support_cases AS purge_case JOIN public.organizations AS purge_scope ON purge_scope.id = purge_case.organization_id WHERE purge_case.id = privacy_cases.support_case_id AND purge_scope.status = 'purge_pending'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.support_cases AS purge_case JOIN public.organizations AS purge_scope ON purge_scope.id = purge_case.organization_id WHERE purge_case.id = privacy_cases.support_case_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
GRANT SELECT (organization_id, reason) ON TABLE public.organization_purge_cancellations TO polaris_purge_owner;--> statement-breakpoint
GRANT UPDATE (reason) ON TABLE public.organization_purge_cancellations TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY organization_purge_cancellations_purge_owner_select ON public.organization_purge_cancellations
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_purge_cancellations.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY organization_purge_cancellations_purge_owner_update ON public.organization_purge_cancellations
  AS PERMISSIVE FOR UPDATE TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_purge_cancellations.organization_id AND purge_scope.status = 'purge_pending'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_purge_cancellations.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
-- a purge reapplied after a restore (runbook) finds its own tombstone: the purge owner reads only the purge
-- tombstones, to know the organization was already purged once after its closure period
GRANT SELECT (organization_id, entity_type, entity_id, operation) ON TABLE public.deletion_ledger TO polaris_purge_owner;--> statement-breakpoint
CREATE POLICY deletion_ledger_organization_purge_select ON public.deletion_ledger
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner USING (entity_type = 'organization' AND operation = 'purge');--> statement-breakpoint
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
-- the Admin reads the recovery window and when the closure was asked for before scheduling
GRANT SELECT (organization_id, recover_until, requested_at, closed_at) ON TABLE public.organization_closures TO polaris_admin_owner;--> statement-breakpoint
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
-- A closed support case stays closed for everyone (the body is otherwise unchanged); the one exception is the
-- purge owner taking the free text out of the cases of an organization whose purge was scheduled (decision of
-- 18/10/2026, ADR 0081): the reason becomes the fixed text, the context and the resolution go, nothing else moves.
CREATE OR REPLACE FUNCTION public.support_cases_closed_is_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF current_user = 'polaris_purge_owner'
     AND NEW.reason = 'Texto removido pelo purge da organização.' AND NEW.context IS NULL AND NEW.resolution IS NULL
     AND (pg_catalog.to_jsonb(NEW) - ARRAY['reason', 'context', 'resolution'])
       = (pg_catalog.to_jsonb(OLD) - ARRAY['reason', 'context', 'resolution'])
     AND EXISTS (
       SELECT 1 FROM public.organizations AS purge_scope
        WHERE purge_scope.id = OLD.organization_id AND purge_scope.status = 'purge_pending'
     ) THEN
    RETURN NEW;
  END IF;
  IF current_user = 'polaris_purge_owner' THEN
    RAISE EXCEPTION 'the purge only takes the free text out of a case' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed support case cannot change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
-- A privacy case moves forward one step at a time and a resolved one is final (the body is otherwise
-- unchanged); the one exception is the purge owner removing the note and the decision note of the cases of an
-- organization whose purge was scheduled, and nothing else (decision of 18/10/2026, ADR 0081).
CREATE OR REPLACE FUNCTION public.privacy_cases_forward_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  stages text[] := ARRAY['requested', 'identity_checked', 'role_determined', 'scoped', 'decided', 'executed', 'resolved'];
BEGIN
  IF current_user = 'polaris_purge_owner'
     AND NEW.note IS NULL AND NEW.decision_note IS NULL
     AND (pg_catalog.to_jsonb(NEW) - ARRAY['note', 'decision_note'])
       = (pg_catalog.to_jsonb(OLD) - ARRAY['note', 'decision_note'])
     AND EXISTS (
       SELECT 1 FROM public.support_cases AS purge_case
         JOIN public.organizations AS purge_scope ON purge_scope.id = purge_case.organization_id
        WHERE purge_case.id = OLD.support_case_id AND purge_scope.status = 'purge_pending'
     ) THEN
    RETURN NEW;
  END IF;
  IF current_user = 'polaris_purge_owner' THEN
    RAISE EXCEPTION 'the purge only takes the free text out of a case' USING ERRCODE = '23514';
  END IF;
  IF OLD.stage = 'resolved' THEN
    RAISE EXCEPTION 'a resolved privacy case cannot change' USING ERRCODE = '23514';
  END IF;
  -- one step at a time: the next stage; an action keeps the case at executed; a refusal or a redirect goes
  -- straight to resolved (it has nothing to carry out)
  IF NOT (
    pg_catalog.array_position(stages, NEW.stage) = pg_catalog.array_position(stages, OLD.stage) + 1
    OR (OLD.stage = 'executed' AND NEW.stage = 'executed')
    OR (OLD.stage = 'decided' AND NEW.stage = 'resolved' AND OLD.decision IN ('reject', 'redirect_to_controller'))
  ) THEN
    RAISE EXCEPTION 'a privacy case moves one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.request_type IS DISTINCT FROM OLD.request_type
     OR NEW.requester_kind IS DISTINCT FROM OLD.requester_kind
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.note IS DISTINCT FROM OLD.note
     OR (OLD.identity_status IS NOT NULL AND (NEW.identity_status IS DISTINCT FROM OLD.identity_status OR NEW.identity_method IS DISTINCT FROM OLD.identity_method))
     OR (OLD.polaris_role IS NOT NULL AND NEW.polaris_role IS DISTINCT FROM OLD.polaris_role)
     OR (OLD.scope_categories IS NOT NULL AND (NEW.scope_categories IS DISTINCT FROM OLD.scope_categories OR NEW.subject_reference IS DISTINCT FROM OLD.subject_reference))
     OR (OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.decision_note IS DISTINCT FROM OLD.decision_note)) THEN
    RAISE EXCEPTION 'a step of a privacy case is recorded once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
-- After the purge, free text written in a case of the organization is not kept either (decision of 18/10/2026,
-- ADR 0081): the privacy case that started the purge is resolved after it, with a resolution, and a case can be
-- opened or closed on a purged organization. Whatever the Admin writes there, the row keeps only the record of
-- the case: the reason becomes the fixed text, the context, the resolution and the notes go. These run after the
-- guards (by name), as the role that writes the case.
CREATE FUNCTION public.support_cases_no_text_after_purge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations AS purged_scope
     WHERE purged_scope.id = NEW.organization_id AND purged_scope.status = 'purged'
  ) THEN
    NEW.reason := 'Texto removido pelo purge da organização.';
    NEW.context := NULL;
    NEW.resolution := NULL;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.support_cases_no_text_after_purge() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER support_cases_no_text_after_purge
  BEFORE INSERT OR UPDATE ON public.support_cases
  FOR EACH ROW EXECUTE FUNCTION public.support_cases_no_text_after_purge();--> statement-breakpoint
CREATE FUNCTION public.privacy_cases_no_text_after_purge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.support_cases AS purged_case
      JOIN public.organizations AS purged_scope ON purged_scope.id = purged_case.organization_id
     WHERE purged_case.id = NEW.support_case_id AND purged_scope.status = 'purged'
  ) THEN
    NEW.note := NULL;
    NEW.decision_note := NULL;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.privacy_cases_no_text_after_purge() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER privacy_cases_no_text_after_purge
  BEFORE INSERT OR UPDATE ON public.privacy_cases
  FOR EACH ROW EXECUTE FUNCTION public.privacy_cases_no_text_after_purge();--> statement-breakpoint
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
-- `partially_accept`), with a scope that is exactly the whole tenant: every category the purge removes
-- and none it keeps (account, authentication and billing stay, so a case that claims them is refused). A
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
  closure_requested timestamptz;
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
  -- exactly what the purge removes: a case that also covers data the purge keeps (account, authentication,
  -- billing) would record a decision the purge does not carry out
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
  -- the closure period of 30 days (decision of 18/10/2026, ADR 0081), whatever window the closure had: the owner
  -- could export (by recovering) during it, and the purge never starts before it is over
  IF closure_requested + interval '30 days' > pg_catalog.now() THEN
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
  due := GREATEST(window_end, closure_requested + interval '30 days') + p_delay_seconds * interval '1 second';
  UPDATE public.organizations SET status = 'purge_pending', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'closed';
  -- a purge scheduled again (after a cancellation, or a restore that brought the organization back) starts from
  -- nothing; the reason of an earlier cancellation stays in organization_purge_cancellations
  INSERT INTO public.organization_purges
    (organization_id, scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before)
  VALUES (target, pg_catalog.now(), p_principal, p_case, privacy_case, due)
  ON CONFLICT (organization_id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at, scheduled_by = EXCLUDED.scheduled_by,
        support_case_id = EXCLUDED.support_case_id, privacy_case_id = EXCLUDED.privacy_case_id,
        not_before = EXCLUDED.not_before, attempts = 0, locked_until = NULL,
        last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = NULL;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_scheduled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'purge_pending', 'notBefore', due);
END;
$function$;--> statement-breakpoint
-- The way back from `purge_pending`, for an operator who scheduled it by mistake or whose request was
-- withdrawn: the same capability, an open case of the organization named, and a reason that goes to the
-- append-only history of cancellations (never in the audit event, which carries no free text). It works
-- only while no run holds the purge and before the first object left the storage: a lease still running
-- means the storage may be going, and `storage_touched_at` means it started going, and then nothing is
-- undone (a failed attempt that never reached the storage does not stop it). It takes the organization
-- lock first, like the purge, and the purge row after it, so a run that claims at the same moment either
-- gets the row first (and the cancel is refused) or finds the organization `closed` again.
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
  IF plan.storage_touched_at IS NOT NULL THEN
    RAISE EXCEPTION 'purge_storage_touched' USING ERRCODE = '55000';
  END IF;
  UPDATE public.organizations SET status = 'closed', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'purge_pending';
  UPDATE public.organization_purges SET locked_until = NULL WHERE organization_id = target;
  INSERT INTO public.organization_purge_cancellations
    (organization_id, support_case_id, cancelled_by, reason, scheduled_at)
  VALUES (target, p_case, p_principal, clean_reason, plan.scheduled_at);
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_cancelled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'closed');
END;
$function$;--> statement-breakpoint
-- A legal hold (decision of 18/10/2026, ADR 0081): while one is in force, the purge of the organization is
-- neither scheduled nor run. An operator with the capability places it under an open case of the organization
-- named (a confirmation, as in the purge), on any organization not yet purged; placing it again changes nothing.
-- It takes the organization's lock, the one the purge's database step takes first, so either the hold comes
-- first and the purge refuses, or the purge comes first and the hold is refused (`purge_already_done`). It has
-- no free text: why it exists is the case.
CREATE FUNCTION public.admin_place_organization_legal_hold(p_principal uuid, p_case uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
  current_status text;
  created uuid;
  storage_touched boolean;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  IF current_status = 'purged' THEN
    RAISE EXCEPTION 'purge_already_done' USING ERRCODE = '55000';
  END IF;
  storage_touched := EXISTS (
    SELECT 1 FROM public.organization_purges AS purge
     WHERE purge.organization_id = target AND purge.storage_touched_at IS NOT NULL AND purge.purged_at IS NULL
  );
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = target AND hold.released_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'held', true, 'storageTouched', storage_touched);
  END IF;
  INSERT INTO public.organization_legal_holds (organization_id, support_case_id, placed_by)
  VALUES (target, p_case, p_principal)
  RETURNING id INTO created;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.legal_hold_placed', target, p_case, 'organization_legal_hold', created::text, NULL
  );
  -- the operator learns whether a purge already removed objects from the storage: those do not come back
  RETURN pg_catalog.jsonb_build_object('changed', true, 'held', true, 'storageTouched', storage_touched);
END;
$function$;--> statement-breakpoint
-- Ends the legal hold in force (the row stays, released); with none in force it changes nothing. A purge that was
-- scheduled runs again from the next run on.
CREATE FUNCTION public.admin_release_organization_legal_hold(p_principal uuid, p_case uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
  PERFORM public.admin_record_audit(
    p_principal, 'organization.legal_hold_released', target, p_case, 'organization_legal_hold', released::text, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'held', false);
END;
$function$;--> statement-breakpoint
-- the history of cancellations is append-only for everyone, the table's owner included: no UPDATE, DELETE or
-- TRUNCATE, the same rule the platform audit has (the grants already give the Admin no more than INSERT and SELECT).
-- The one exception is the purge owner taking the free text out (decision of 18/10/2026, ADR 0081): only the
-- reason, only to the fixed text, only while the organization's purge runs.
CREATE FUNCTION public.organization_purge_cancellations_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'polaris_purge_owner'
     AND NEW.reason = 'Texto removido pelo purge da organização.'
     AND (pg_catalog.to_jsonb(NEW) - 'reason') = (pg_catalog.to_jsonb(OLD) - 'reason')
     AND EXISTS (
       SELECT 1 FROM public.organizations AS purge_scope
        WHERE purge_scope.id = OLD.organization_id AND purge_scope.status = 'purge_pending'
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'organization purge cancellations are append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_purge_cancellations_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER organization_purge_cancellations_no_change
  BEFORE UPDATE OR DELETE ON public.organization_purge_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.organization_purge_cancellations_immutable();--> statement-breakpoint
CREATE TRIGGER organization_purge_cancellations_no_truncate
  BEFORE TRUNCATE ON public.organization_purge_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION public.organization_purge_cancellations_immutable();--> statement-breakpoint
-- What stops a scheduled purge from running now, as a code, or null (decisions of 18/10/2026, ADR 0081): a
-- legal hold in force, or a closure that is not 30 days old (or whose window is not over). A purge reapplied
-- after a restore (runbook) finds its own tombstone in the deletion ledger, which proves the period was over
-- when it first ran: the restored organization may not even have its closure back. Internal to the purge
-- functions; nobody else executes it.
CREATE FUNCTION public.organization_purge_blocker(p_organization text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
  ) THEN
    RETURN 'legal_hold_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deletion_ledger AS tombstone
     WHERE tombstone.organization_id = p_organization AND tombstone.entity_type = 'organization'
       AND tombstone.entity_id = p_organization AND tombstone.operation = 'purge'
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_closures AS closure
     WHERE closure.organization_id = p_organization AND closure.closed_at IS NOT NULL
       AND closure.recover_until <= pg_catalog.now()
       AND closure.requested_at + interval '30 days' <= pg_catalog.now()
  ) THEN
    RETURN 'closure_period_not_elapsed';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- a run takes the oldest due purge (or a purged organization whose second sweep did not finish) and holds
-- it for a while; an organization with an export run still holding its lease waits for the next run, and
-- one that a legal hold or the closure period still stops is not taken at all
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
         )
         AND public.organization_purge_blocker(purge.organization_id) IS NULL)
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
  -- a cancellation that committed between the scan and the row lock leaves the organization `closed`
  -- again (and invisible to this role): nothing is claimed, and the storage is not touched
  IF picked_status IS NULL OR picked_status NOT IN ('purge_pending', 'purged') THEN
    RETURN NULL;
  END IF;
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
    'data_exports', 'public_catalog_profiles', 'tenant_audit_event', 'event_outbox', 'queue_processing',
    'queue_dead_letters', 'organization_closures', 'memberships'
  ];
  target text;
  removed bigint;
  total bigint := 0;
  blocker text;
  anonymized bigint;
  scrubbed bigint := 0;
  -- the keys the billing lifecycle writes in a fact (`serializeBillingFact` and the ledger's commands): values,
  -- dates, types and opaque references, and only as plain values (a nested object or list goes too). Anything
  -- else (a payer's name, document, e-mail, phone, address or ID at the provider) is taken out;
  -- `PURGE_BILLING_FACT_KEYS` in `purge-datasets.ts` holds the same list
  kept_fact_keys text[] := ARRAY[
    'type', 'occurredAt', 'cycleMonths', 'periodEndsAt', 'transition', 'grantId', 'key', 'startsAt', 'expiresAt', 'actor'
  ];
BEGIN
  -- the lock comes first: a run that waited behind another one sees the organization it left (this role
  -- locks only `purge_pending` rows, so a purged one is not found and is read again without the lock)
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = p_organization FOR UPDATE;
  IF NOT FOUND THEN
    SELECT organization.status INTO current_status
      FROM public.organizations AS organization WHERE organization.id = p_organization;
    IF current_status = 'purged' THEN
      RETURN pg_catalog.jsonb_build_object(
        'alreadyPurged', true, 'deletedRows', 0, 'anonymizedBillingEvents', 0, 'scrubbedTexts', 0
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
  -- a legal hold, or a closure younger than 30 days: nothing is removed
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
  -- the billing events stay for the fiscal period, without the payer: values, dates, types and opaque references
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
  GET DIAGNOSTICS anonymized = ROW_COUNT;
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
    'alreadyPurged', false, 'deletedRows', total, 'anonymizedBillingEvents', anonymized, 'scrubbedTexts', scrubbed
  );
END;
$function$;--> statement-breakpoint
-- the purge is about to remove its first object from the storage: from now on it cannot be cancelled. The run
-- that holds the lease calls it once, before its first storage step, and the first call (of any run) is the one
-- that counts. A run whose lease ended, or whose purge was cancelled, is refused and goes no further: the cancel
-- waits for this row lock, or this update finds the lease gone. The function does not tell two runs apart, so a
-- run that lost its lease to a newer one can still pass; the mark is idempotent and so are the removals.
CREATE FUNCTION public.mark_organization_purge_storage_touched(p_organization text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  blocker text;
BEGIN
  -- the organization's lock first, the one a legal hold takes: the hold and this check are ordered, so a hold
  -- that committed is seen here and one placed after waits for this run's check to end
  PERFORM 1 FROM public.organizations AS organization
   WHERE organization.id = p_organization AND organization.status = 'purge_pending'
     FOR UPDATE;
  -- a legal hold, or a closure younger than 30 days: the storage is not touched either
  blocker := public.organization_purge_blocker(p_organization);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  UPDATE public.organization_purges AS purge
     SET storage_touched_at = COALESCE(purge.storage_touched_at, pg_catalog.now())
   WHERE purge.organization_id = p_organization AND purge.locked_until > pg_catalog.now()
     AND EXISTS (
       SELECT 1 FROM public.organizations AS organization
        WHERE organization.id = purge.organization_id AND organization.status = 'purge_pending'
     );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_not_claimed' USING ERRCODE = '55000';
  END IF;
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
ALTER FUNCTION public.admin_place_organization_legal_hold(uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_release_organization_legal_hold(uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_schedule_organization_purge(uuid, uuid, text, bigint) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_schedule_organization_purge(uuid, uuid, text, bigint) TO polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_cancel_organization_purge(uuid, uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_cancel_organization_purge(uuid, uuid, text, text) TO polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_place_organization_legal_hold(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_place_organization_legal_hold(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_release_organization_legal_hold(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_release_organization_legal_hold(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.organization_purge_blocker(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_organization_purge(integer) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.list_organization_purge_media(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.mark_organization_purge_storage_touched(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.purge_organization_data(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.record_organization_purge_failure(text, text) OWNER TO polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.complete_organization_purge_sweep(text) OWNER TO polaris_purge_owner;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_purge_blocker(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_organization_purge(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_organization_purge_media(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_organization_purge_storage_touched(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_organization_data(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_organization_purge_failure(text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_organization_purge_sweep(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_organization_purge(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_organization_purge_media(text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_organization_purge_storage_touched(text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_organization_data(text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_organization_purge_failure(text, text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.complete_organization_purge_sweep(text) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;
