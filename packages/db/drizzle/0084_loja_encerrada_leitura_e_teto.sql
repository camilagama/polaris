-- The closed organization, read-only until the purge (ADR 0081, decision 1 and the read-only requirement; ADR 0078
-- amended; design of 19/10/2026 with the consolidation of 21:25), and the ceiling of organizations per person (ADR 0074
-- amended, decision L6). Expand only (ADR 0096): two new columns with a default, a new role, new functions, new
-- policies and grants; three functions are recreated with the same signature (`claim_data_export`,
-- `claim_data_export_by_id`, `recover_organization_closure`), plus `create_initial_organization` and the trigger
-- function of `data_export_files`. The previous Worker keeps working: the claims answer what they answered (two more
-- keys it does not read), the tenant runtime reads its requests by column (every column but the new lease token; the
-- previous Worker names its columns), and the ceiling only refuses what it refused before or what did not exist (a
-- second organization next to a closed one). During a rolling deploy a previous Worker that claims a closed export
-- reads it as the person who asked, which the tenant refuses: the export fails for good (`export_not_authorized`, one of
-- the owner's three a day). Ask for closed exports only once the previous Worker is gone.
--
-- 1. The owner of a closed organization (`closing`, `closed`, `purge_pending`) reads its state and asks for a copy
--    through functions of the privacy owner (ADR 0093) that check the owner themselves; the tenant policies
--    (`status = 'active'`) do not change, so every capability of the tenant still fails closed.
-- 2. The copy is read by `polaris_closed_export_reader` (NOLOGIN, NOINHERIT, NOBYPASSRLS, no CREATE, no TEMPORARY),
--    which only the privacy runtime may become (SET, never INHERIT). It holds SELECT on exactly the columns a data
--    export writes (`EXPORT_DATASETS` minus `omit`, column by column), one policy per table that compares the
--    organization with `(SELECT public.closed_export_organization())` (one InitPlan per query, never a SubPlan per row),
--    and EXECUTE on that function only. The function answers an organization only inside a READ ONLY transaction
--    that names a closed export which is running, whose lease has not ended and whose lease token is the one the
--    claim gave, of an organization still in closure. Two barriers against a write: no write privilege, and the
--    read-only transaction.
-- 3. The file of a closed export is recorded only while its run holds the lease and the organization is in closure;
--    an active export only while the organization is active (the narrow change of the trigger of 0075).
-- 4. D (when the data may be deleted) is the local date of the request plus 90 days, from the first instant of that
--    local day in the organization's time zone (`closure_deadlines`); `closureDeadlines` in the domain is the same
--    rule and a gate compares them at the edges.
-- 5. At most one open organization (active or suspended) and two in closure per person, counted by owner membership
--    and under the per-user key `create_initial_organization` already takes; undoing a closure is refused while any
--    owner of the organization has another open one (`another_organization_active`).
ALTER TABLE "data_exports" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "data_exports" ADD COLUMN "mode" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_mode_allowed" CHECK ("data_exports"."mode" IN ('active', 'closed'));--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_closed_export_reader') THEN
    EXECUTE 'CREATE ROLE polaris_closed_export_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one is never a login and never bypasses a policy
  EXECUTE 'ALTER ROLE polaris_closed_export_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_closed_export_reader;--> statement-breakpoint
-- the privacy runtime becomes the reader with SET ROLE for one transaction, and never inherits what it holds
GRANT polaris_closed_export_reader TO polaris_privacy_runtime WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;--> statement-breakpoint
-- what the privacy owner needs besides what it had: the organization's time zone (the dates), the closed request
-- (only its four columns, only `closed`), the lease token of a claim, the outbox event of a closed request, whether
-- a purge was claimed, and the images of an organization in closure (the keys of a closed export's images)
-- the tenant runtime reads its requests column by column, every column but the lease token of a run (the previous
-- Worker names its columns, none of them new)
REVOKE SELECT ON TABLE public.data_exports FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT (attempts, error_code, expires_at, files_deleted_at, formats, id, locked_until, mode, organization_id, ready_at, requested_at, requested_by_user_id, started_at, status, total_bytes) ON TABLE public.data_exports TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT (timezone) ON TABLE public.organizations TO polaris_privacy_owner;--> statement-breakpoint
GRANT INSERT (organization_id, requested_by_user_id, formats, mode) ON TABLE public.data_exports TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (lease_token) ON TABLE public.data_exports TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY data_exports_privacy_owner_insert_closed ON public.data_exports
  AS PERMISSIVE FOR INSERT TO polaris_privacy_owner
  WITH CHECK (mode = 'closed' AND status = 'requested' AND attempts = 0
    AND EXISTS (SELECT 1 FROM public.organizations AS closure_scope
                 WHERE closure_scope.id = data_exports.organization_id
                   AND closure_scope.status IN ('closing', 'closed', 'purge_pending')));--> statement-breakpoint
GRANT INSERT (organization_id, type, event, idempotency_key, correlation_id) ON TABLE public.event_outbox TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY event_outbox_privacy_owner_insert_closed ON public.event_outbox
  AS PERMISSIVE FOR INSERT TO polaris_privacy_owner
  WITH CHECK (type = 'data_export.requested' AND status = 'pending' AND attempts = 0
    AND idempotency_key = type || ':' || (event ->> 'exportId')
    AND EXISTS (SELECT 1 FROM public.data_exports AS export_scope
                 WHERE export_scope.id::text = event_outbox.event ->> 'exportId'
                   AND export_scope.organization_id = event_outbox.organization_id
                   AND export_scope.mode = 'closed' AND export_scope.status = 'requested')
    AND EXISTS (SELECT 1 FROM public.organizations AS closure_scope
                 WHERE closure_scope.id = event_outbox.organization_id
                   AND closure_scope.status IN ('closing', 'closed', 'purge_pending')));--> statement-breakpoint
GRANT SELECT (organization_id, locked_until, purged_at, storage_touched_at) ON TABLE public.organization_purges TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY organization_purges_privacy_owner_select ON public.organization_purges
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner USING (true);--> statement-breakpoint
GRANT SELECT (id, organization_id, byte_size, storage_key) ON TABLE public.media_assets TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY media_assets_privacy_owner_select_closed ON public.media_assets
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS closure_scope
                  WHERE closure_scope.id = media_assets.organization_id
                    AND closure_scope.status IN ('closing', 'closed', 'purge_pending')));--> statement-breakpoint
-- D and the milestones before it (the domain's `closureDeadlines`): plain functions, not definer, executed only by
-- the privacy owner's functions. The first instant of a local day: PostgreSQL reads a midnight that did not exist
-- (daylight saving time began at it) as the first instant after the gap, which is right, and a midnight that happened
-- twice as the second one, so the hour before is taken when it is still the same local day.
CREATE FUNCTION public.closure_local_day_start(p_day date, p_timezone text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
           WHEN ((day_start.at - interval '1 hour') AT TIME ZONE p_timezone)::date >= p_day
             THEN day_start.at - interval '1 hour'
           ELSE day_start.at
         END
    FROM (SELECT (p_day::timestamp AT TIME ZONE p_timezone) AS at) AS day_start
$function$;--> statement-breakpoint
CREATE FUNCTION public.closure_deadlines(p_requested_at timestamptz, p_timezone text)
RETURNS TABLE (deletion_date date, d30_at timestamptz, d7_at timestamptz, deletable_from timestamptz)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT deadline.day,
         public.closure_local_day_start(deadline.day - 30, p_timezone),
         public.closure_local_day_start(deadline.day - 7, p_timezone),
         public.closure_local_day_start(deadline.day, p_timezone)
    FROM (SELECT (p_requested_at AT TIME ZONE p_timezone)::date + 90 AS day) AS deadline
$function$;--> statement-breakpoint
-- the domain's `closurePhaseAt`, by dates only: never a legal hold, a privacy case or the status of a purge
CREATE FUNCTION public.closure_phase_at(p_requested_at timestamptz, p_recover_until timestamptz, p_timezone text, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
           WHEN p_at < p_recover_until THEN 'closing'
           WHEN p_at >= deadline.deletable_from THEN 'deletable'
           WHEN p_at >= deadline.d7_at THEN 'deletion_scheduled'
           ELSE 'closed'
         END
    FROM public.closure_deadlines(p_requested_at, p_timezone) AS deadline
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_local_day_start(date, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_deadlines(timestamptz, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_phase_at(timestamptz, timestamptz, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_local_day_start(date, text) TO polaris_privacy_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_deadlines(timestamptz, text) TO polaris_privacy_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_phase_at(timestamptz, timestamptz, text, timestamptz) TO polaris_privacy_owner;--> statement-breakpoint
-- The scope of the closed organization's reader: the organization of the closed export the transaction names, or
-- NULL. Only inside a READ ONLY transaction, only for a closed export that is running, whose lease has not ended and
-- whose lease token is the one of the transaction (the run that holds it, not one whose lease ran out), only while
-- the organization is in closure. A malformed setting is NULL, never an error. The policies call it as an InitPlan.
CREATE FUNCTION public.closed_export_organization()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  export_setting text := NULLIF(pg_catalog.current_setting('app.closed_export_id', true), '');
  lease_setting text := NULLIF(pg_catalog.current_setting('app.closed_export_lease', true), '');
  scoped text;
BEGIN
  IF pg_catalog.current_setting('transaction_read_only') <> 'on'
     OR export_setting IS NULL OR lease_setting IS NULL
     OR export_setting !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR lease_setting !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT export_row.organization_id INTO scoped
    FROM public.data_exports AS export_row
    JOIN public.organizations AS organization ON organization.id = export_row.organization_id
   WHERE export_row.id = export_setting::uuid
     AND export_row.lease_token = lease_setting::uuid
     AND export_row.mode = 'closed'
     AND export_row.status = 'running'
     AND export_row.locked_until > pg_catalog.now()
     AND organization.status IN ('closing', 'closed', 'purge_pending');
  RETURN scoped;
END;
$function$;--> statement-breakpoint
-- The closed organizations of the authenticated user (owner membership), with the dates the owner reads: never the
-- status (a scheduled purge looks like any closed organization), a legal hold or a privacy case. An organization of
-- someone else, or one that does not exist, is simply not there.
CREATE FUNCTION public.list_my_closed_organizations()
RETURNS TABLE (
  id text,
  name text,
  timezone text,
  phase text,
  requested_at timestamptz,
  recover_until timestamptz,
  can_recover boolean,
  deletion_date date,
  d30_at timestamptz,
  d7_at timestamptz,
  deletable_from timestamptz,
  export_open_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT organization.id, organization.name, organization.timezone,
         public.closure_phase_at(closure.requested_at, closure.recover_until, organization.timezone, pg_catalog.now()),
         closure.requested_at, closure.recover_until,
         organization.status = 'closing' AND closure.recover_until > pg_catalog.now(),
         deadline.deletion_date, deadline.d30_at, deadline.d7_at, deadline.deletable_from, deadline.deletable_from
    FROM public.memberships AS member
    JOIN public.organizations AS organization ON organization.id = member.organization_id
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
   WHERE member.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')
     AND member.status = 'active'
     AND member.role = 'owner'
     AND organization.status IN ('closing', 'closed', 'purge_pending')
   ORDER BY closure.requested_at, organization.id
$function$;--> statement-breakpoint
CREATE FUNCTION public.closed_organization_status(p_organization text)
RETURNS TABLE (
  id text,
  name text,
  timezone text,
  phase text,
  requested_at timestamptz,
  recover_until timestamptz,
  can_recover boolean,
  deletion_date date,
  d30_at timestamptz,
  d7_at timestamptz,
  deletable_from timestamptz,
  export_open_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT item.* FROM public.list_my_closed_organizations() AS item WHERE item.id = p_organization
$function$;--> statement-breakpoint
-- The owner of a closed organization asks for a copy (ADR 0078 limits: one in flight and three a day, by the same
-- index and trigger) until D, and never once a purge was claimed. The request, its audit and its outbox event are
-- written together, as the tenant's request does.
CREATE FUNCTION public.request_closed_data_export(p_organization text, p_formats text[], p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  actor text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  current_status text;
  zone text;
  requested timestamptz;
  open_until timestamptz;
  created uuid;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'tenant_context_required' USING ERRCODE = '42501';
  END IF;
  IF p_organization IS NULL OR p_organization = '' OR NOT EXISTS (
    SELECT 1 FROM public.memberships AS member
     WHERE member.organization_id = p_organization AND member.user_id = actor
       AND member.status = 'active' AND member.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  -- the organization's row is held while the request is written: a recovery or a purge waits for it
  SELECT organization.status, organization.timezone, closure.requested_at
    INTO current_status, zone, requested
    FROM public.organizations AS organization
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
   WHERE organization.id = p_organization
     FOR SHARE OF organization;
  IF NOT FOUND OR current_status NOT IN ('closing', 'closed', 'purge_pending') THEN
    RAISE EXCEPTION 'closed_export_unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT deadline.deletable_from INTO open_until FROM public.closure_deadlines(requested, zone) AS deadline;
  IF pg_catalog.now() >= open_until OR EXISTS (
    SELECT 1 FROM public.organization_purges AS purge
     WHERE purge.organization_id = p_organization
       AND (purge.locked_until > pg_catalog.now() OR purge.purged_at IS NOT NULL OR purge.storage_touched_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'closed_export_unavailable' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.data_exports (organization_id, requested_by_user_id, formats, mode)
  VALUES (p_organization, actor, p_formats, 'closed')
  RETURNING data_exports.id INTO created;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type, request_id)
  VALUES (p_organization, actor, 'data_export', created::text, 'data_export.requested', p_request_id);
  INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
  VALUES (
    p_organization, 'data_export.requested', pg_catalog.jsonb_build_object('exportId', created::text),
    'data_export.requested:' || created::text, COALESCE(p_request_id::text, pg_catalog.gen_random_uuid()::text)
  );
  RETURN pg_catalog.jsonb_build_object('id', created);
END;
$function$;--> statement-breakpoint
-- The latest requests of a closed organization, newest first, for its owner; the files only of a closed export that is
-- ready and not expired (the only kind the closed download hands over). Someone else's organization is empty.
CREATE FUNCTION public.list_closed_data_exports(p_organization text)
RETURNS TABLE (
  id uuid,
  mode text,
  status text,
  formats text[],
  requested_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  error_code text,
  total_bytes bigint,
  files jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT export_row.id, export_row.mode, export_row.status, export_row.formats, export_row.requested_at,
         export_row.ready_at, export_row.expires_at, export_row.error_code, export_row.total_bytes,
         COALESCE((
           SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object('name', file_row.name, 'ordinal', file_row.ordinal, 'sizeBytes', file_row.size_bytes)
                    ORDER BY file_row.ordinal)
             FROM public.data_export_files AS file_row
            WHERE file_row.export_id = export_row.id
              AND export_row.mode = 'closed' AND export_row.status = 'ready' AND export_row.expires_at > pg_catalog.now()
         ), '[]'::jsonb)
    FROM public.data_exports AS export_row
   WHERE export_row.organization_id = p_organization
     AND EXISTS (SELECT 1 FROM public.closed_organization_status(p_organization))
   ORDER BY export_row.requested_at DESC, export_row.id DESC
   LIMIT 10
$function$;--> statement-breakpoint
-- The file of a closed export, for its owner, and the audit of the download. Whoever is not the owner of the
-- export's organization (or names an export that does not exist) is refused the same way; inside the organization,
-- every refusal (not closed, not ready, expired, the organization no longer in closure, no such file) is one refusal.
CREATE FUNCTION public.closed_export_download(p_export uuid, p_ordinal integer, p_request_id uuid)
RETURNS TABLE (name text, storage_key text, size_bytes bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  actor text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  target public.data_exports;
  picked public.data_export_files;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'tenant_context_required' USING ERRCODE = '42501';
  END IF;
  SELECT export_row.* INTO target FROM public.data_exports AS export_row WHERE export_row.id = p_export;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.memberships AS member
     WHERE member.organization_id = target.organization_id AND member.user_id = actor
       AND member.status = 'active' AND member.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  IF target.mode <> 'closed' OR target.status <> 'ready' OR target.expires_at <= pg_catalog.now()
     OR NOT EXISTS (
       SELECT 1 FROM public.organizations AS organization
        WHERE organization.id = target.organization_id
          AND organization.status IN ('closing', 'closed', 'purge_pending')
     ) THEN
    RAISE EXCEPTION 'export_unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT file_row.* INTO picked FROM public.data_export_files AS file_row
   WHERE file_row.export_id = p_export AND file_row.ordinal = p_ordinal
     AND file_row.organization_id = target.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_unavailable' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type, request_id)
  VALUES (target.organization_id, actor, 'data_export', p_export::text, 'data_export.downloaded', p_request_id);
  RETURN QUERY SELECT picked.name, picked.storage_key, picked.size_bytes;
END;
$function$;--> statement-breakpoint
-- The images of a closed export, for the run that holds it (its export and lease token): the reader does not read
-- the storage key, which the archive never holds.
CREATE FUNCTION public.list_closed_export_media(p_export uuid, p_lease uuid, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, byte_size bigint, storage_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  scoped text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.organization_id INTO scoped
    FROM public.data_exports AS export_row
    JOIN public.organizations AS organization ON organization.id = export_row.organization_id
   WHERE export_row.id = p_export AND export_row.lease_token = p_lease
     AND export_row.mode = 'closed' AND export_row.status = 'running'
     AND export_row.locked_until > pg_catalog.now()
     AND organization.status IN ('closing', 'closed', 'purge_pending');
  IF scoped IS NULL THEN
    RAISE EXCEPTION 'export_not_running' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT asset.id, asset.byte_size::bigint, asset.storage_key FROM public.media_assets AS asset
     WHERE asset.organization_id = scoped AND (p_after IS NULL OR asset.id > p_after)
     ORDER BY asset.id
     LIMIT p_limit;
END;
$function$;--> statement-breakpoint
-- The reader of a closed organization: SELECT on exactly the columns a data export writes (`EXPORT_DATASETS` in
-- `export-datasets.ts`, minus each dataset's `omit`), granted column by column, and one policy per table that compares
-- the organization with the scope, evaluated once per query. A column added later is not read until a migration grants
-- it, and the gate fails until then (it compares every column of every table with the datasets).
DO $reader$
DECLARE
  datasets text[] := ARRAY[
    'organizations', 'categories', 'products', 'product_options', 'product_option_values', 'product_variants',
    'variant_option_values', 'media_assets', 'product_media', 'variant_media', 'customers', 'inventory_balances',
    'stock_movements', 'sales', 'sale_items', 'sale_adjustments', 'sale_payments', 'sale_cancellations', 'sale_returns',
    'sale_return_items', 'sale_customer_links', 'expense_categories', 'expense_recurring_rules', 'expenses', 'goals',
    'goal_target_changes', 'payment_profiles', 'payment_profile_rules', 'public_catalog_profiles',
    'product_publications', 'operational_variant_selections'
  ];
  omitted text[] := ARRAY['media_assets.storage_key', 'media_assets.input_fingerprint', 'media_assets.upload_command_id'];
  target text;
  readable text;
BEGIN
  FOREACH target IN ARRAY datasets LOOP
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO readable
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = pg_catalog.format('public.%I', target)::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
       AND (target || '.' || attribute.attname) <> ALL (omitted);
    EXECUTE pg_catalog.format('GRANT SELECT (%s) ON TABLE public.%I TO polaris_closed_export_reader', readable, target);
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO polaris_closed_export_reader USING (%I = (SELECT public.closed_export_organization()))',
      target || '_closed_export_select', target,
      CASE WHEN target = 'organizations' THEN 'id' ELSE 'organization_id' END
    );
  END LOOP;
END
$reader$;--> statement-breakpoint
-- One run of an export starts (both claims): what a run before left is not kept, the lease and its token are new. A
-- closed export starts only while its organization is in closure and no purge was claimed, with the organization's
-- row held so a purge that is removing the rows waits for it or is waited for; otherwise it fails for good
-- (`export_not_authorized`, as a tenant export whose person can no longer read), so it never holds the one export in
-- flight of an organization that was recovered. Executed only by the claims (their owner).
CREATE FUNCTION public.start_data_export_run(p_picked public.data_exports, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  token uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_picked.mode = 'closed' THEN
    PERFORM 1 FROM public.organizations AS organization
      WHERE organization.id = p_picked.organization_id
        AND organization.status IN ('closing', 'closed', 'purge_pending')
        FOR SHARE OF organization;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.organization_purges AS purge
       WHERE purge.organization_id = p_picked.organization_id
         AND (purge.locked_until > pg_catalog.now() OR purge.purged_at IS NOT NULL OR purge.storage_touched_at IS NOT NULL)
    ) THEN
      UPDATE public.data_exports
         SET status = 'failed', error_code = 'export_not_authorized', locked_until = NULL
       WHERE id = p_picked.id;
      INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type)
      VALUES (p_picked.organization_id, p_picked.requested_by_user_id, 'data_export', p_picked.id::text, 'data_export.failed');
      RETURN NULL;
    END IF;
  END IF;
  DELETE FROM public.data_export_files WHERE export_id = p_picked.id;
  UPDATE public.data_exports
     SET status = 'running', attempts = p_picked.attempts + 1, started_at = pg_catalog.now(),
         locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second', lease_token = token
   WHERE id = p_picked.id;
  RETURN pg_catalog.jsonb_build_object(
    'id', p_picked.id, 'organizationId', p_picked.organization_id, 'requestedBy', p_picked.requested_by_user_id,
    'formats', pg_catalog.to_jsonb(p_picked.formats), 'attempt', p_picked.attempts + 1,
    'mode', p_picked.mode, 'leaseToken', token
  );
END;
$function$;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.start_data_export_run(public.data_exports, integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- a run takes the oldest request (or one whose run stopped), as before (0071); the run starts as above
CREATE OR REPLACE FUNCTION public.claim_data_export(p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  picked public.data_exports;
  started jsonb;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  -- a closed export that may no longer start fails at once; the next request in line is taken instead (a few at most)
  FOR attempt IN 1..10 LOOP
    SELECT export_row.* INTO picked
      FROM public.data_exports AS export_row
     WHERE ((export_row.status = 'requested' AND (export_row.locked_until IS NULL OR export_row.locked_until <= pg_catalog.now()))
            OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
       AND export_row.attempts < 3
     ORDER BY export_row.requested_at, export_row.id
     LIMIT 1
       FOR UPDATE OF export_row SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    started := public.start_data_export_run(picked, p_lease_seconds);
    IF started IS NOT NULL THEN
      RETURN started;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- the queue consumer takes the one export its event names, by ID and organization, under the same rules (0071)
CREATE OR REPLACE FUNCTION public.claim_data_export_by_id(p_export uuid, p_organization text, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  picked public.data_exports;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO picked
    FROM public.data_exports AS export_row
   WHERE export_row.id = p_export AND export_row.organization_id = p_organization
     AND ((export_row.status = 'requested' AND (export_row.locked_until IS NULL OR export_row.locked_until <= pg_catalog.now()))
          OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
     AND export_row.attempts < 3
     FOR UPDATE OF export_row SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.start_data_export_run(picked, p_lease_seconds);
END;
$function$;--> statement-breakpoint
-- Undoing a closure (0065), now under the ceiling: under the per-user key of `create_initial_organization`, for every
-- owner of the organization in a fixed order, and refused (nothing changed) while any of them has another open
-- organization, active or suspended (decision L6: one open organization per person, a suspension included).
CREATE OR REPLACE FUNCTION public.recover_organization_closure(p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  actor text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'tenant_context_required' USING ERRCODE = '42501';
  END IF;
  IF p_organization IS NULL OR p_organization = '' OR p_organization <> pg_catalog.btrim(p_organization) THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships AS member
     WHERE member.organization_id = p_organization AND member.user_id = actor
       AND member.status = 'active' AND member.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1347374145, pg_catalog.hashtext(owner_row.user_id))
     FROM (
       SELECT member.user_id FROM public.memberships AS member
        WHERE member.organization_id = p_organization AND member.status = 'active' AND member.role = 'owner'
        ORDER BY member.user_id
     ) AS owner_row;
  UPDATE public.organizations AS organization
     SET status = 'active', updated_at = pg_catalog.now()
    FROM public.organization_closures AS closure
   WHERE organization.id = p_organization
     AND closure.organization_id = organization.id
     AND organization.status = 'closing'
     AND closure.recover_until > pg_catalog.now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'closure_not_recoverable' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.memberships AS owner_member
      JOIN public.memberships AS other_member
        ON other_member.user_id = owner_member.user_id
       AND other_member.organization_id <> p_organization
       AND other_member.status = 'active' AND other_member.role = 'owner'
      JOIN public.organizations AS other ON other.id = other_member.organization_id
     WHERE owner_member.organization_id = p_organization
       AND owner_member.status = 'active' AND owner_member.role = 'owner'
       AND other.status IN ('active', 'suspended')
  ) THEN
    RAISE EXCEPTION 'another_organization_active' USING ERRCODE = '55000';
  END IF;
  UPDATE public.organization_closures SET recovered_at = pg_catalog.now()
   WHERE organization_id = p_organization;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type)
  VALUES (p_organization, actor, 'organization', p_organization, 'organization.closure_recovered');
  RETURN pg_catalog.jsonb_build_object('status', 'active');
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
ALTER FUNCTION public.closed_export_organization() OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.list_my_closed_organizations() OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.closed_organization_status(text) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.request_closed_data_export(text, text[], uuid) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.list_closed_data_exports(text) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.closed_export_download(uuid, integer, uuid) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.list_closed_export_media(uuid, uuid, uuid, integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.start_data_export_run(public.data_exports, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closed_export_organization() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_my_closed_organizations() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closed_organization_status(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.request_closed_data_export(text, text[], uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_closed_data_exports(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closed_export_download(uuid, integer, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_closed_export_media(uuid, uuid, uuid, integer) FROM PUBLIC;--> statement-breakpoint
-- the reader executes its scope and nothing else; the request runtime reads the state, asks, lists and downloads;
-- the privacy runtime lists the images of the run it holds
GRANT EXECUTE ON FUNCTION public.closed_export_organization() TO polaris_closed_export_reader;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_my_closed_organizations() TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closed_organization_status(text) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.request_closed_data_export(text, text[], uuid) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_closed_data_exports(text) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closed_export_download(uuid, integer, uuid) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_closed_export_media(uuid, uuid, uuid, integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;--> statement-breakpoint
-- The file of an export is recorded only by the run that may hold it (the narrow change of 0075): an active export
-- while its organization is active, as before; a closed export while it is running, its lease has not ended and its
-- organization is in closure. Anything else (the closure of an active organization in the middle of a run, the
-- recovery of a closed one, a lease that ran out) leaves no copy on record.
CREATE OR REPLACE FUNCTION public.data_export_files_require_active_organization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.data_exports AS export_row
      JOIN public.organizations AS organization ON organization.id = export_row.organization_id
     WHERE export_row.id = NEW.export_id
       AND export_row.organization_id = NEW.organization_id
       AND ((export_row.mode = 'active' AND organization.status = 'active')
         OR (export_row.mode = 'closed' AND export_row.status = 'running'
             AND export_row.locked_until > pg_catalog.now()
             AND organization.status IN ('closing', 'closed', 'purge_pending')))
  ) THEN
    RAISE EXCEPTION 'organization_not_active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
-- Opening an organization (0012, 0039), now under the ceiling: whoever has an open organization gets it back as before
-- (or `organization_not_available` while it is suspended); whoever has only organizations in closure may open another
-- one, up to two in closure (`organization_limit_reached` with the second); the per-user key it already took also
-- serializes it with the recovery of a closure. Same signature, owner, search_path and grant.
CREATE OR REPLACE FUNCTION public.create_initial_organization(p_user_id text, p_organization_id text, p_name text, p_timezone text, p_request_id uuid)
 RETURNS TABLE(created boolean, id text, name text, timezone text, currency text, status text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_email_verified boolean;
  v_open_count integer;
  v_closed_count integer;
  v_existing_organization_id text;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_user_id <> btrim(p_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_user_id';
  END IF;

  IF p_organization_id IS NULL OR p_organization_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_organization_id';
  END IF;

  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_organization_name';
  END IF;

  IF p_timezone IS NULL OR char_length(btrim(p_timezone)) NOT BETWEEN 1 AND 64
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names AS timezone_name
       WHERE timezone_name.name = p_timezone
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_timezone';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    1347374145,
    pg_catalog.hashtext(p_user_id)
  );

  SELECT identity.email_verified
  INTO v_email_verified
  FROM public."user" AS identity
  WHERE identity.id = p_user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'user_not_found';
  END IF;

  IF v_email_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'email_not_verified';
  END IF;

  -- the ceiling (decision L6): one open organization (active or suspended: a suspension is not dodged by opening
  -- another) and two in closure, counted by owner membership; a purged organization has no membership left
  SELECT count(*) FILTER (WHERE organization.status IN ('active', 'suspended'))::integer,
         count(*) FILTER (WHERE organization.status IN ('closing', 'closed', 'purge_pending'))::integer,
         min(organization.id) FILTER (WHERE organization.status IN ('active', 'suspended'))
  INTO v_open_count, v_closed_count, v_existing_organization_id
  FROM public.memberships AS membership
  JOIN public.organizations AS organization ON organization.id = membership.organization_id
  WHERE membership.user_id = p_user_id
    AND membership.role = 'owner'
    AND membership.status = 'active';

  IF v_open_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'multiple_existing_organizations';
  END IF;

  IF v_open_count = 1 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.organizations AS organization
      WHERE organization.id = v_existing_organization_id
        AND organization.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'polaris_initial_organization_error',
        DETAIL = 'organization_not_available';
    END IF;

    RETURN QUERY
    SELECT false, organization.id, organization.name, organization.timezone,
           organization.currency, organization.status,
           organization.created_at, organization.updated_at
    FROM public.organizations AS organization
    WHERE organization.id = v_existing_organization_id;
    RETURN;
  END IF;

  IF v_closed_count >= 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'organization_limit_reached';
  END IF;

  INSERT INTO public.organizations (id, name, timezone)
  VALUES (p_organization_id, btrim(p_name), p_timezone);

  INSERT INTO public.memberships (organization_id, user_id)
  VALUES (p_organization_id, p_user_id);

  INSERT INTO public.tenant_audit_event (
    organization_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    request_id
  )
  VALUES (
    p_organization_id,
    p_user_id,
    'organization.created',
    'organization',
    p_organization_id,
    p_request_id
  );

  RETURN QUERY
  SELECT true, organization.id, organization.name, organization.timezone,
         organization.currency, organization.status,
         organization.created_at, organization.updated_at
  FROM public.organizations AS organization
  WHERE organization.id = p_organization_id
    AND organization.status = 'active';
  RETURN;
END;
$function$;
