ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_event_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD COLUMN "event_class" text GENERATED ALWAYS AS (CASE WHEN event_type IN ('customer.anonymized', 'data_export.downloaded', 'data_export.failed', 'data_export.ready', 'data_export.requested', 'offline_grant.issued', 'offline_grant.revoked', 'organization.closure_recovered', 'organization.closure_requested', 'organization.created', 'product.published_to_catalog', 'product.unpublished_from_catalog', 'public_catalog.profile_created', 'public_catalog.profile_updated', 'public_catalog.published', 'public_catalog.unpublished') THEN 'security' ELSE 'operational' END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_event_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_event_type_registered" CHECK ("tenant_audit_event"."event_type" IN ('customer.anonymized', 'data_export.downloaded', 'data_export.failed', 'data_export.ready', 'data_export.requested', 'offline_grant.issued', 'offline_grant.revoked', 'organization.closure_recovered', 'organization.closure_requested', 'organization.created', 'product.published_to_catalog', 'product.unpublished_from_catalog', 'public_catalog.profile_created', 'public_catalog.profile_updated', 'public_catalog.published', 'public_catalog.unpublished', 'category.archived', 'category.created', 'category.deleted', 'category.renamed', 'category.restored', 'customer.archived', 'customer.created', 'customer.restored', 'customer.updated', 'expense.created', 'expense.restored', 'expense.updated', 'expense.voided', 'expense_category.archived', 'expense_category.created', 'expense_category.renamed', 'expense_category.restored', 'expense_rule.archived', 'expense_rule.created', 'expense_rule.generated', 'expense_rule.restored', 'expense_rule.updated', 'goal.cancelled', 'goal.completed', 'goal.created', 'goal.missed', 'goal.target_changed', 'goal.updated', 'inventory.movement_recorded', 'operational_selection.changed', 'payment_profile.archived', 'payment_profile.created', 'payment_profile.restored', 'payment_profile.updated', 'product.archived', 'product.created', 'product.deleted', 'product.media_removed', 'product.media_reordered', 'product.media_uploaded', 'product.restored', 'product.updated', 'product.variants_configured', 'product_variant.list_price_changed', 'product_variant.sku_changed', 'sale.cancelled', 'sale.confirmed', 'sale.returned', 'sale_customer_link.assigned', 'sale_customer_link.reassigned', 'sale_customer_link.unassigned'));--> statement-breakpoint
-- The audit of the tenant survives the purge, is immutable, and leaves only by a period (decision of 19/10/2026, ADR 0081
-- amended). `tenant_audit_event` leaves the purge: the foreign key to the organization restricts (the purge keeps the
-- organization's row as a tombstone, so nothing breaks), the purge owner loses its SELECT, DELETE and policies on the
-- table, and `purge_organization_data` no longer deletes from it. Every `event_type` is registered in the domain
-- (`packages/domain/src/privacy/tenant-audit-events.ts`): the CHECK below and the generated `event_class` are built from
-- that registry, and a type without a class fails at the INSERT. A trigger refuses UPDATE, DELETE and TRUNCATE on
-- `tenant_audit_event`, `auth_security_audit_event` and `deletion_ledger` (and the platform audit's triggers become ALWAYS
-- too): ENABLE ALWAYS, so they fire also under session_replication_role = replica. The only removal is by period, by
-- `expire_tenant_audit_events`, a SECURITY DEFINER function of the role `polaris_retention_owner` (NOLOGIN): the trigger of
-- `tenant_audit_event` lets through a DELETE made by that role and only for a row that is expired by its class and whose
-- organization has no legal hold (the same predicate the function uses). Nothing calls the function yet: no job, and no
-- role can execute it.
-- the purge no longer reads or deletes the audit of the tenant
REVOKE SELECT, DELETE ON TABLE public.tenant_audit_event FROM polaris_purge_owner;--> statement-breakpoint
DROP POLICY tenant_audit_event_purge_owner_select ON public.tenant_audit_event;--> statement-breakpoint
DROP POLICY tenant_audit_event_purge_owner_delete ON public.tenant_audit_event;--> statement-breakpoint
-- the role of the retention: it deletes only expired audit rows and is never a login
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_retention_owner') THEN
    EXECUTE 'CREATE ROLE polaris_retention_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one deletes audit rows and is never a login
  -- no NOSUPERUSER here: PostgreSQL refuses it to a role that is not a superuser itself (Neon), and a role made by one never is;
  -- the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_retention_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_retention_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_retention_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_retention_owner;--> statement-breakpoint
-- what the retention owner may see: the keys of the audit rows, the date of the purge and whether a legal hold is in force
GRANT SELECT (id, organization_id, event_class, created_at) ON TABLE public.tenant_audit_event TO polaris_retention_owner;--> statement-breakpoint
GRANT DELETE ON TABLE public.tenant_audit_event TO polaris_retention_owner;--> statement-breakpoint
GRANT SELECT (organization_id, purged_at) ON TABLE public.organization_purges TO polaris_retention_owner;--> statement-breakpoint
GRANT SELECT (organization_id, released_at) ON TABLE public.organization_legal_holds TO polaris_retention_owner;--> statement-breakpoint
CREATE POLICY organization_purges_retention_owner_select ON public.organization_purges
  AS PERMISSIVE FOR SELECT TO polaris_retention_owner USING (true);--> statement-breakpoint
CREATE POLICY organization_legal_holds_retention_owner_select ON public.organization_legal_holds
  AS PERMISSIVE FOR SELECT TO polaris_retention_owner USING (true);--> statement-breakpoint
-- when an audit row is expired (internal: the trigger and the retention function ask the same thing, so they cannot
-- disagree). `security`: 60 months after the event; `operational`: 6 months after the purge of the organization, never
-- before it; and never while the organization has a legal hold. The periods are proposed, with the legal review pending
-- (`TENANT_AUDIT_RETENTION` in `retention.ts`); the audit gate proves the behavior at their edges.
CREATE FUNCTION public.tenant_audit_event_expired(p_organization text, p_class text, p_created_at timestamp with time zone)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT NOT EXISTS (
           SELECT 1 FROM public.organization_legal_holds AS hold
            WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
         )
     AND CASE p_class
           WHEN 'security' THEN
             (p_created_at AT TIME ZONE 'UTC' + interval '60 months') AT TIME ZONE 'UTC' <= pg_catalog.now()
           WHEN 'operational' THEN
             EXISTS (
               SELECT 1 FROM public.organization_purges AS purge
                WHERE purge.organization_id = p_organization AND purge.purged_at IS NOT NULL
                  AND (purge.purged_at AT TIME ZONE 'UTC' + interval '6 months') AT TIME ZONE 'UTC' <= pg_catalog.now()
             )
           ELSE false
         END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_audit_event_expired(text, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.tenant_audit_event_expired(text, text, timestamp with time zone) TO polaris_retention_owner;--> statement-breakpoint
CREATE POLICY tenant_audit_event_retention_owner_select ON public.tenant_audit_event
  AS PERMISSIVE FOR SELECT TO polaris_retention_owner USING (true);--> statement-breakpoint
CREATE POLICY tenant_audit_event_retention_owner_delete ON public.tenant_audit_event
  AS PERMISSIVE FOR DELETE TO polaris_retention_owner USING (public.tenant_audit_event_expired(organization_id, event_class, created_at));--> statement-breakpoint
-- the triggers: nobody changes, deletes or truncates the rows, whatever the role (the owner of the table included)
CREATE FUNCTION public.audit_record_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_record_is_immutable() FROM PUBLIC;--> statement-breakpoint
-- the one exception, on the audit of the tenant: a DELETE by the retention owner of a row that is expired. An UPDATE and a
-- TRUNCATE have no exception for anybody
CREATE FUNCTION public.tenant_audit_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    IF current_user = 'polaris_retention_owner' THEN
      IF public.tenant_audit_event_expired(OLD.organization_id, OLD.event_class, OLD.created_at) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'tenant_audit_event is append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_audit_event_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tenant_audit_event_no_change
  BEFORE UPDATE OR DELETE ON public.tenant_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.tenant_audit_event_guard();--> statement-breakpoint
CREATE TRIGGER tenant_audit_event_no_truncate
  BEFORE TRUNCATE ON public.tenant_audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_audit_event_guard();--> statement-breakpoint
ALTER TABLE public.tenant_audit_event ENABLE ALWAYS TRIGGER tenant_audit_event_no_change;--> statement-breakpoint
ALTER TABLE public.tenant_audit_event ENABLE ALWAYS TRIGGER tenant_audit_event_no_truncate;--> statement-breakpoint
CREATE TRIGGER auth_security_audit_event_no_change
  BEFORE UPDATE OR DELETE ON public.auth_security_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER auth_security_audit_event_no_truncate
  BEFORE TRUNCATE ON public.auth_security_audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
ALTER TABLE public.auth_security_audit_event ENABLE ALWAYS TRIGGER auth_security_audit_event_no_change;--> statement-breakpoint
ALTER TABLE public.auth_security_audit_event ENABLE ALWAYS TRIGGER auth_security_audit_event_no_truncate;--> statement-breakpoint
CREATE TRIGGER deletion_ledger_no_change
  BEFORE UPDATE OR DELETE ON public.deletion_ledger
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER deletion_ledger_no_truncate
  BEFORE TRUNCATE ON public.deletion_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
ALTER TABLE public.deletion_ledger ENABLE ALWAYS TRIGGER deletion_ledger_no_change;--> statement-breakpoint
ALTER TABLE public.deletion_ledger ENABLE ALWAYS TRIGGER deletion_ledger_no_truncate;--> statement-breakpoint
-- the platform audit already refused the change; its triggers fire under session_replication_role = replica now too
ALTER TABLE public.platform_audit_events ENABLE ALWAYS TRIGGER platform_audit_events_no_change;--> statement-breakpoint
ALTER TABLE public.platform_audit_events ENABLE ALWAYS TRIGGER platform_audit_events_no_truncate;--> statement-breakpoint
ALTER FUNCTION public.platform_audit_events_immutable() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
-- the schedule of the purge: the audit logs are no longer in what the purge removes (the scope of the case is the exact scope)
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
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
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
-- the purge without the audit
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
  -- `organization_billing.provider_ref` stay, and they still find the payer at the provider
  kept_fact_keys text[] := ARRAY[
    'type', 'occurredAt', 'cycleMonths', 'periodEndsAt', 'transition', 'grantId', 'key', 'startsAt', 'expiresAt', 'actor'
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
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;--> statement-breakpoint
-- the expiry by period: the only caller will be the job of the retention, which a later migration grants (EXECUTE: nobody now)
GRANT polaris_retention_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_retention_owner;--> statement-breakpoint
SET ROLE polaris_retention_owner;--> statement-breakpoint
CREATE FUNCTION public.expire_tenant_audit_events(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  removed_security bigint;
  removed_operational bigint;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  -- only what is expired by its class and has no legal hold on its organization; the trigger asks the same question again
  WITH due AS (
    SELECT audit.id
      FROM public.tenant_audit_event AS audit
     WHERE public.tenant_audit_event_expired(audit.organization_id, audit.event_class, audit.created_at)
     ORDER BY audit.created_at, audit.id
     LIMIT p_limit
  ), removed AS (
    DELETE FROM public.tenant_audit_event AS audit
     USING due
     WHERE audit.id = due.id
     RETURNING audit.event_class
  )
  SELECT pg_catalog.count(*) FILTER (WHERE removed.event_class = 'security'),
         pg_catalog.count(*) FILTER (WHERE removed.event_class = 'operational')
    INTO removed_security, removed_operational
    FROM removed;
  RETURN pg_catalog.jsonb_build_object('security', removed_security, 'operational', removed_operational);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_tenant_audit_events(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_retention_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_retention_owner;
