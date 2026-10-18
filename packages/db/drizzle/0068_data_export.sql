-- The data export of an organization (plan PR104, ADR 0078): a request the owner inserts, the files of a
-- finished export, and the privacy role's functions that claim a request, record its files and finish,
-- fail or expire it. The tenant runtime asks and reads; it updates and deletes nothing.
CREATE TABLE "data_export_files" (
	"content_type" text DEFAULT 'application/zip' NOT NULL,
	"export_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"ordinal" integer NOT NULL,
	"organization_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	CONSTRAINT "data_export_files_ordinal_allowed" CHECK ("data_export_files"."ordinal" BETWEEN 1 AND 999),
	CONSTRAINT "data_export_files_name_allowed" CHECK ("data_export_files"."name" ~ '^polaris-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}(-parte-[0-9]{3})?\.zip$'),
	CONSTRAINT "data_export_files_size_allowed" CHECK ("data_export_files"."size_bytes" BETWEEN 1 AND 104857600),
	CONSTRAINT "data_export_files_key_allowed" CHECK ("data_export_files"."storage_key" ~ '^exports/v1/[A-Za-z0-9_-]+/[0-9a-f-]{36}/[A-Za-z0-9._-]+$')
);
--> statement-breakpoint
ALTER TABLE "data_export_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "data_exports" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone,
	"files_deleted_at" timestamp with time zone,
	"formats" text[] NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"locked_until" timestamp with time zone,
	"organization_id" text NOT NULL,
	"ready_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"status" text DEFAULT 'requested' NOT NULL,
	"total_bytes" bigint,
	CONSTRAINT "data_exports_status_allowed" CHECK ("data_exports"."status" IN ('requested', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "data_exports_formats_allowed" CHECK (cardinality("data_exports"."formats") BETWEEN 1 AND 3 AND "data_exports"."formats" <@ ARRAY['json', 'csv', 'images']::text[]),
	CONSTRAINT "data_exports_attempts_allowed" CHECK ("data_exports"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "data_exports_error_code_format" CHECK ("data_exports"."error_code" IS NULL OR "data_exports"."error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "data_exports_requester_allowed" CHECK (char_length(btrim("data_exports"."requested_by_user_id")) BETWEEN 1 AND 255),
	CONSTRAINT "data_exports_state_coherent" CHECK (("data_exports"."status" <> 'running' OR ("data_exports"."locked_until" IS NOT NULL AND "data_exports"."started_at" IS NOT NULL))
        AND ("data_exports"."status" <> 'ready' OR ("data_exports"."ready_at" IS NOT NULL AND "data_exports"."expires_at" IS NOT NULL AND "data_exports"."total_bytes" IS NOT NULL AND "data_exports"."error_code" IS NULL))
        AND ("data_exports"."status" <> 'failed' OR "data_exports"."error_code" IS NOT NULL)
        AND ("data_exports"."status" IN ('ready', 'expired') OR "data_exports"."expires_at" IS NULL)
        AND ("data_exports"."status" = 'requested' OR "data_exports"."status" = 'running' OR "data_exports"."locked_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_export_files" ADD CONSTRAINT "data_export_files_export_id_data_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."data_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_files_export_ordinal_unique" ON "data_export_files" USING btree ("export_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_files_storage_key_unique" ON "data_export_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "data_exports_organization_requested_idx" ON "data_exports" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "data_exports_status_idx" ON "data_exports" USING btree ("status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_exports_one_in_flight_unique" ON "data_exports" USING btree ("organization_id") WHERE "data_exports"."status" IN ('requested', 'running');--> statement-breakpoint
CREATE POLICY "data_export_files_current_tenant_select" ON "data_export_files" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
    "data_export_files"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "data_export_files"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "data_export_files"."organization_id"
        AND organization_scope.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "data_export_files_privacy_owner_select" ON "data_export_files" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING (true);--> statement-breakpoint
CREATE POLICY "data_export_files_privacy_owner_insert" ON "data_export_files" AS PERMISSIVE FOR INSERT TO "polaris_privacy_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "data_export_files_privacy_owner_delete" ON "data_export_files" AS PERMISSIVE FOR DELETE TO "polaris_privacy_owner" USING (true);--> statement-breakpoint
CREATE POLICY "data_exports_current_tenant_select" ON "data_exports" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
    "data_exports"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "data_exports"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "data_exports"."organization_id"
        AND organization_scope.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "data_exports_current_owner_insert" ON "data_exports" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
    "data_exports"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "data_exports"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "data_exports"."organization_id"
        AND organization_scope.status = 'active'
    )
  
        AND "data_exports"."requested_by_user_id" = NULLIF(current_setting('app.user_id', true), '')
        AND "data_exports"."status" = 'requested'
        AND "data_exports"."attempts" = 0);--> statement-breakpoint
CREATE POLICY "data_exports_privacy_owner_select" ON "data_exports" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING (true);--> statement-breakpoint
CREATE POLICY "data_exports_privacy_owner_update" ON "data_exports" AS PERMISSIVE FOR UPDATE TO "polaris_privacy_owner" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "data_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_export_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.data_exports FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.data_export_files FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
-- the tenant runtime asks (inserts a request with its three columns) and reads its own organization's
-- requests and files; it updates and deletes nothing
GRANT SELECT ON TABLE public.data_exports TO polaris_pr11_runtime;--> statement-breakpoint
GRANT INSERT (organization_id, requested_by_user_id, formats) ON TABLE public.data_exports TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.data_export_files TO polaris_pr11_runtime;--> statement-breakpoint
-- the privacy owner moves a request along through the functions below
GRANT SELECT ON TABLE public.data_exports TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (status, attempts, error_code, expires_at, files_deleted_at, locked_until, ready_at, started_at, total_bytes) ON TABLE public.data_exports TO polaris_privacy_owner;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.data_export_files TO polaris_privacy_owner;--> statement-breakpoint
-- at most three requests a day for an organization (the one in flight is the unique index's)
CREATE FUNCTION public.data_exports_daily_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF (
    SELECT pg_catalog.count(*) FROM public.data_exports AS earlier
     WHERE earlier.organization_id = NEW.organization_id
       AND earlier.requested_at > pg_catalog.now() - interval '24 hours'
  ) >= 3 THEN
    RAISE EXCEPTION 'at most three exports a day' USING ERRCODE = '23514', CONSTRAINT = 'data_exports_daily_limit';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.data_exports_daily_limit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER data_exports_daily_limit
  BEFORE INSERT ON public.data_exports
  FOR EACH ROW EXECUTE FUNCTION public.data_exports_daily_limit();--> statement-breakpoint
-- a run takes the oldest request (or one whose run stopped) and holds it for a while
CREATE FUNCTION public.claim_data_export(p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  picked public.data_exports;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO picked
    FROM public.data_exports AS export_row
   WHERE (export_row.status = 'requested' OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
     AND export_row.attempts < 3
   ORDER BY export_row.requested_at, export_row.id
   LIMIT 1
     FOR UPDATE OF export_row SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- a run that is tried again starts from nothing: what the one before left is not kept
  DELETE FROM public.data_export_files WHERE export_id = picked.id;
  UPDATE public.data_exports
     SET status = 'running', attempts = picked.attempts + 1, started_at = pg_catalog.now(),
         locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second'
   WHERE id = picked.id;
  RETURN pg_catalog.jsonb_build_object(
    'id', picked.id, 'organizationId', picked.organization_id, 'requestedBy', picked.requested_by_user_id,
    'formats', pg_catalog.to_jsonb(picked.formats), 'attempt', picked.attempts + 1
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.record_data_export_file(p_export uuid, p_ordinal integer, p_name text, p_key text, p_size bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  org text;
BEGIN
  SELECT export_row.organization_id INTO org
    FROM public.data_exports AS export_row WHERE export_row.id = p_export AND export_row.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_not_running' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.data_export_files (export_id, organization_id, ordinal, name, storage_key, size_bytes)
  VALUES (p_export, org, p_ordinal, p_name, p_key, p_size);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.complete_data_export(p_export uuid, p_validity_hours integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target public.data_exports;
  total bigint;
  until_at timestamptz;
BEGIN
  IF p_validity_hours IS NULL OR p_validity_hours < 1 OR p_validity_hours > 168 THEN
    RAISE EXCEPTION 'invalid_validity' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO target FROM public.data_exports AS export_row
   WHERE export_row.id = p_export AND export_row.status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_not_running' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.sum(file_row.size_bytes)::bigint INTO total FROM public.data_export_files AS file_row WHERE file_row.export_id = p_export;
  IF total IS NULL THEN
    RAISE EXCEPTION 'export_has_no_files' USING ERRCODE = '22023';
  END IF;
  until_at := pg_catalog.now() + p_validity_hours * interval '1 hour';
  UPDATE public.data_exports
     SET status = 'ready', ready_at = pg_catalog.now(), expires_at = until_at, total_bytes = total,
         locked_until = NULL, error_code = NULL
   WHERE id = p_export;
  INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type)
  VALUES (target.organization_id, target.requested_by_user_id, 'data_export', p_export::text, 'data_export.ready');
  RETURN pg_catalog.jsonb_build_object('expiresAt', until_at, 'totalBytes', total);
END;
$function$;--> statement-breakpoint
-- a run that failed is tried again, until it has used its attempts or the failure is final
CREATE FUNCTION public.fail_data_export(p_export uuid, p_code text, p_final boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target public.data_exports;
  final_failure boolean;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_error_code' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO target FROM public.data_exports AS export_row
   WHERE export_row.id = p_export AND export_row.status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_not_running' USING ERRCODE = '22023';
  END IF;
  final_failure := COALESCE(p_final, false) OR target.attempts >= 3;
  IF final_failure THEN
    UPDATE public.data_exports SET status = 'failed', error_code = p_code, locked_until = NULL WHERE id = p_export;
    INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type)
    VALUES (target.organization_id, target.requested_by_user_id, 'data_export', p_export::text, 'data_export.failed');
  ELSE
    UPDATE public.data_exports SET status = 'requested', error_code = p_code, locked_until = NULL WHERE id = p_export;
  END IF;
  RETURN pg_catalog.jsonb_build_object('final', final_failure);
END;
$function$;--> statement-breakpoint
-- time makes a finished export unavailable, a failed one is dropped after a while, and a run that was
-- abandoned (all its attempts used, no one holding it) fails
CREATE FUNCTION public.expire_data_exports(p_failed_keep_hours integer, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expired integer;
BEGIN
  IF p_failed_keep_hours IS NULL OR p_failed_keep_hours < 1 OR p_failed_keep_hours > 720
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  UPDATE public.data_exports
     SET status = 'failed', error_code = 'export_abandoned', locked_until = NULL
   WHERE id IN (
     SELECT export_row.id FROM public.data_exports AS export_row
      WHERE export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now() AND export_row.attempts >= 3
      ORDER BY export_row.id LIMIT p_limit FOR UPDATE SKIP LOCKED
   );
  WITH due AS (
    SELECT export_row.id FROM public.data_exports AS export_row
     WHERE (export_row.status = 'ready' AND export_row.expires_at <= pg_catalog.now())
        OR (export_row.status = 'failed' AND export_row.requested_at <= pg_catalog.now() - p_failed_keep_hours * interval '1 hour')
     ORDER BY export_row.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE public.data_exports SET status = 'expired', locked_until = NULL
     WHERE id IN (SELECT id FROM due) RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO expired FROM marked;
  RETURN expired;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.list_data_exports_to_delete(p_limit integer)
RETURNS TABLE (id uuid, organization_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT export_row.id, export_row.organization_id FROM public.data_exports AS export_row
     WHERE export_row.status = 'expired' AND export_row.files_deleted_at IS NULL
     ORDER BY export_row.id LIMIT p_limit;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.mark_data_export_files_deleted(p_export uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.data_exports SET files_deleted_at = pg_catalog.now()
   WHERE id = p_export AND status = 'expired' AND files_deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.data_export_files WHERE export_id = p_export;
  RETURN true;
END;
$function$;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_data_export(integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.record_data_export_file(uuid, integer, text, text, bigint) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.complete_data_export(uuid, integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.fail_data_export(uuid, text, boolean) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.expire_data_exports(integer, integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.list_data_exports_to_delete(integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.mark_data_export_files_deleted(uuid) OWNER TO polaris_privacy_owner;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_data_export(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_data_export_file(uuid, integer, text, text, bigint) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_data_export(uuid, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.fail_data_export(uuid, text, boolean) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_data_exports(integer, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_data_exports_to_delete(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_data_export_files_deleted(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_data_export(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_data_export_file(uuid, integer, text, text, bigint) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.complete_data_export(uuid, integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.fail_data_export(uuid, text, boolean) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_data_exports(integer, integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_data_exports_to_delete(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_data_export_files_deleted(uuid) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;
