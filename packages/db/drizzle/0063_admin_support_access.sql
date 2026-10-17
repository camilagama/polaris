-- Support cases, temporary tenant access and the administrative audit (plan PR96 to PR98,
-- ADR 0072). The Admin still reads no table: it runs functions, owned by a role that is
-- never a login, that open and close cases, grant read-only access to one organization
-- for a while, read that organization's customers MASKED, reveal one field of one customer
-- on request, and write the audit in the same transaction. Without an active grant from an
-- open case every one of them refuses. The audit is append-only and never holds the value
-- that was revealed, only which field of which record.
CREATE TABLE "platform_audit_events" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text,
	"entity_id" text,
	"entity_type" text,
	"event_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text,
	"principal_id" uuid NOT NULL,
	"support_case_id" uuid,
	CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed')),
	CONSTRAINT "platform_audit_events_detail_allowed" CHECK ("platform_audit_events"."detail" IS NULL OR char_length("platform_audit_events"."detail") <= 200)
);
--> statement-breakpoint
ALTER TABLE "platform_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_cases" (
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"context" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"resolution" text,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "support_cases_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "support_cases_kind_allowed" CHECK ("support_cases"."kind" IN ('support', 'privacy')),
	CONSTRAINT "support_cases_status_allowed" CHECK ("support_cases"."status" IN ('open', 'closed')),
	CONSTRAINT "support_cases_reason_allowed" CHECK (char_length("support_cases"."reason") BETWEEN 1 AND 500 AND "support_cases"."reason" = btrim("support_cases"."reason")),
	CONSTRAINT "support_cases_context_allowed" CHECK ("support_cases"."context" IS NULL OR char_length("support_cases"."context") BETWEEN 1 AND 2000),
	CONSTRAINT "support_cases_resolution_allowed" CHECK ("support_cases"."resolution" IS NULL OR char_length("support_cases"."resolution") BETWEEN 1 AND 500),
	CONSTRAINT "support_cases_closing_coherent" CHECK (("support_cases"."status" = 'open' AND "support_cases"."closed_at" IS NULL AND "support_cases"."closed_by" IS NULL AND "support_cases"."resolution" IS NULL) OR ("support_cases"."status" = 'closed' AND "support_cases"."closed_at" IS NOT NULL AND "support_cases"."closed_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "support_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_access_grants" (
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"support_case_id" uuid NOT NULL,
	CONSTRAINT "tenant_access_grants_window_allowed" CHECK ("tenant_access_grants"."expires_at" > "tenant_access_grants"."starts_at" AND "tenant_access_grants"."expires_at" <= "tenant_access_grants"."starts_at" + interval '4 hours'),
	CONSTRAINT "tenant_access_grants_revocation_coherent" CHECK (("tenant_access_grants"."revoked_at" IS NULL) = ("tenant_access_grants"."revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "tenant_access_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_principal_id_platform_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_closed_by_platform_principals_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_opened_by_platform_principals_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_access_grants" ADD CONSTRAINT "tenant_access_grants_principal_id_platform_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_access_grants" ADD CONSTRAINT "tenant_access_grants_revoked_by_platform_principals_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_access_grants" ADD CONSTRAINT "tenant_access_grants_case_organization_fk" FOREIGN KEY ("support_case_id","organization_id") REFERENCES "public"."support_cases"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_events_case_idx" ON "platform_audit_events" USING btree ("support_case_id","id");--> statement-breakpoint
CREATE INDEX "platform_audit_events_organization_idx" ON "platform_audit_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "support_cases_organization_idx" ON "support_cases" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "support_cases_status_idx" ON "support_cases" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "tenant_access_grants_case_idx" ON "tenant_access_grants" USING btree ("support_case_id");--> statement-breakpoint
CREATE INDEX "tenant_access_grants_principal_idx" ON "tenant_access_grants" USING btree ("principal_id","expires_at");--> statement-breakpoint
CREATE POLICY "platform_audit_events_admin_owner_select" ON "platform_audit_events" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "platform_audit_events_admin_owner_insert" ON "platform_audit_events" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "support_cases_admin_owner_select" ON "support_cases" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "support_cases_admin_owner_insert" ON "support_cases" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "support_cases_admin_owner_update" ON "support_cases" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_access_grants_admin_owner_select" ON "tenant_access_grants" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_access_grants_admin_owner_insert" ON "tenant_access_grants" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_access_grants_admin_owner_update" ON "tenant_access_grants" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "support_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_access_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- the Admin role reads and writes none of these tables: the functions below, owned by a role that
-- is never a login, do it, and write the audit in the same transaction as the thing audited
GRANT SELECT (id, status) ON TABLE public.platform_principals TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY platform_principals_admin_owner_select ON public.platform_principals
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.support_cases TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (status, closed_at, closed_by, resolution) ON TABLE public.support_cases TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.tenant_access_grants TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by) ON TABLE public.tenant_access_grants TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.platform_audit_events TO polaris_admin_owner;--> statement-breakpoint
-- the only tenant records the Admin can reach, and only through an active grant (ADR 0072)
GRANT SELECT (id, organization_id, name, email, phone, notes, archived_at) ON TABLE public.customers TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY customers_admin_owner_select ON public.customers
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
CREATE FUNCTION public.platform_audit_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'platform audit events are append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_audit_events_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER platform_audit_events_no_change
  BEFORE UPDATE OR DELETE ON public.platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.platform_audit_events_immutable();--> statement-breakpoint
CREATE TRIGGER platform_audit_events_no_truncate
  BEFORE TRUNCATE ON public.platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_events_immutable();--> statement-breakpoint
-- a closed case stays closed and a revoked grant stays revoked, even for a change made around the functions
CREATE FUNCTION public.support_cases_closed_is_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed support case cannot change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.support_cases_closed_is_final() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER support_cases_closed_is_final
  BEFORE UPDATE ON public.support_cases
  FOR EACH ROW EXECUTE FUNCTION public.support_cases_closed_is_final();--> statement-breakpoint
CREATE FUNCTION public.tenant_access_grants_revocation_is_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked tenant access cannot change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.tenant_access_grants_revocation_is_final() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tenant_access_grants_revocation_is_final
  BEFORE UPDATE ON public.tenant_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.tenant_access_grants_revocation_is_final();--> statement-breakpoint
-- masks: a name keeps the first letter of each word, an e-mail its first letters and its ending, a phone its last two digits
CREATE FUNCTION public.admin_mask_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.string_agg(
    CASE WHEN pg_catalog.char_length(word.value) > 1 THEN pg_catalog.left(word.value, 1) || '***' ELSE '***' END,
    ' ' ORDER BY word.position
  )
  FROM pg_catalog.unnest(pg_catalog.regexp_split_to_array(pg_catalog.btrim(p_value), '\s+')) WITH ORDINALITY AS word(value, position)
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_mask_email(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN p_value ~ '^[^@]+@[^@]+\.[^@]+$'
      THEN pg_catalog.regexp_replace(p_value, '^(.)[^@]*@(.)[^@]*(\.[^.@]+)$', '\1***@\2***\3')
    ELSE '***'
  END
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_mask_phone(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN pg_catalog.char_length(pg_catalog.regexp_replace(p_value, '\D', '', 'g')) < 4 THEN '***'
    ELSE '***' || pg_catalog.right(pg_catalog.regexp_replace(p_value, '\D', '', 'g'), 2)
  END
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_require_principal(p_principal uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_principal IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_principals AS principal
     WHERE principal.id = p_principal AND principal.status = 'active'
  ) THEN
    RAISE EXCEPTION 'not an active platform principal'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;--> statement-breakpoint
-- the organization this principal may read through this case right now, or a refusal
CREATE FUNCTION public.admin_require_grant(p_principal uuid, p_case uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found_organization text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  SELECT grant_row.organization_id
    INTO found_organization
    FROM public.tenant_access_grants AS grant_row
    JOIN public.support_cases AS support_case
      ON support_case.id = grant_row.support_case_id
     AND support_case.organization_id = grant_row.organization_id
   WHERE grant_row.support_case_id = p_case
     AND grant_row.principal_id = p_principal
     AND grant_row.revoked_at IS NULL
     AND pg_catalog.now() >= grant_row.starts_at
     AND pg_catalog.now() < grant_row.expires_at
     AND support_case.status = 'open'
   ORDER BY grant_row.expires_at DESC
   LIMIT 1;
  IF found_organization IS NULL THEN
    RAISE EXCEPTION 'no active tenant access'
      USING ERRCODE = '42501';
  END IF;
  RETURN found_organization;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_record_audit(
  p_principal uuid,
  p_event text,
  p_organization text,
  p_case uuid,
  p_entity_type text,
  p_entity_id text,
  p_detail text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.platform_audit_events
    (principal_id, event_type, organization_id, support_case_id, entity_type, entity_id, detail)
  VALUES
    (p_principal, p_event, p_organization, p_case, p_entity_type, p_entity_id, p_detail);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_open_support_case(
  p_principal uuid,
  p_organization_id text,
  p_kind text,
  p_reason text,
  p_context text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  clean_reason text := pg_catalog.btrim(p_reason);
  clean_context text := NULLIF(pg_catalog.btrim(COALESCE(p_context, '')), '');
  created_id uuid;
  created_at timestamptz;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF p_kind IS NULL OR p_kind NOT IN ('support', 'privacy') THEN
    RAISE EXCEPTION 'invalid_case_kind' USING ERRCODE = '22023';
  END IF;
  IF clean_reason IS NULL OR pg_catalog.char_length(clean_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_case_reason' USING ERRCODE = '22023';
  END IF;
  IF clean_context IS NOT NULL AND pg_catalog.char_length(clean_context) > 2000 THEN
    RAISE EXCEPTION 'invalid_case_context' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations AS organization WHERE organization.id = p_organization_id) THEN
    RAISE EXCEPTION 'unknown_organization' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.support_cases (organization_id, kind, reason, context, opened_by)
  VALUES (p_organization_id, p_kind, clean_reason, clean_context, p_principal)
  RETURNING id, opened_at INTO created_id, created_at;
  PERFORM public.admin_record_audit(
    p_principal, 'support_case.opened', p_organization_id, created_id,
    'support_case', created_id::text, p_kind
  );
  RETURN pg_catalog.jsonb_build_object(
    'id', created_id,
    'organizationId', p_organization_id,
    'kind', p_kind,
    'reason', clean_reason,
    'status', 'open',
    'openedAt', created_at
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_close_support_case(p_principal uuid, p_case uuid, p_resolution text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target public.support_cases%ROWTYPE;
  clean_resolution text := NULLIF(pg_catalog.btrim(COALESCE(p_resolution, '')), '');
  revoked_count integer;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF clean_resolution IS NOT NULL AND pg_catalog.char_length(clean_resolution) > 500 THEN
    RAISE EXCEPTION 'invalid_case_resolution' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO target FROM public.support_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF target.status = 'closed' THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'id', target.id, 'status', 'closed');
  END IF;
  UPDATE public.tenant_access_grants
     SET revoked_at = pg_catalog.now(), revoked_by = p_principal
   WHERE support_case_id = p_case AND revoked_at IS NULL AND expires_at > pg_catalog.now();
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  UPDATE public.support_cases
     SET status = 'closed', closed_at = pg_catalog.now(), closed_by = p_principal, resolution = clean_resolution
   WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'support_case.closed', target.organization_id, p_case,
    'support_case', p_case::text, 'revoked=' || revoked_count
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'id', p_case, 'status', 'closed', 'revokedGrants', revoked_count);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_list_support_cases(p_status text, p_organization_id text, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT support_case.id, support_case.organization_id, organization.name AS organization_name,
             support_case.kind, support_case.reason, support_case.status,
             support_case.opened_at, support_case.closed_at
        FROM public.support_cases AS support_case
        JOIN public.organizations AS organization ON organization.id = support_case.organization_id
       WHERE (p_status IS NULL OR support_case.status = p_status)
         AND (p_organization_id IS NULL OR support_case.organization_id = p_organization_id)
         AND (p_after IS NULL OR support_case.id < p_after)
       ORDER BY support_case.id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'cases', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'organizationId', shown.organization_id,
            'organizationName', shown.organization_name,
            'kind', shown.kind,
            'reason', shown.reason,
            'status', shown.status,
            'openedAt', shown.opened_at,
            'closedAt', shown.closed_at
          ) ORDER BY shown.id DESC
        ) FROM shown
      ), '[]'::jsonb),
      'next', CASE
        WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
          THEN (SELECT shown.id FROM shown ORDER BY shown.id LIMIT 1)
        ELSE NULL
      END
    )
  );
END;
$function$;--> statement-breakpoint
-- one case with its grants and its audit trail (what was done, never what was seen)
CREATE FUNCTION public.admin_support_case_detail(p_case uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'case', pg_catalog.jsonb_build_object(
        'id', support_case.id,
        'organizationId', support_case.organization_id,
        'organizationName', organization.name,
        'kind', support_case.kind,
        'reason', support_case.reason,
        'context', support_case.context,
        'status', support_case.status,
        'openedBy', support_case.opened_by,
        'openedAt', support_case.opened_at,
        'closedAt', support_case.closed_at,
        'resolution', support_case.resolution
      ),
      'grants', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', grant_row.id,
            'principalId', grant_row.principal_id,
            'startsAt', grant_row.starts_at,
            'expiresAt', grant_row.expires_at,
            'revokedAt', grant_row.revoked_at,
            'active', (grant_row.revoked_at IS NULL AND pg_catalog.now() >= grant_row.starts_at
                       AND pg_catalog.now() < grant_row.expires_at AND support_case.status = 'open')
          ) ORDER BY grant_row.id DESC
        )
        FROM public.tenant_access_grants AS grant_row
        WHERE grant_row.support_case_id = support_case.id
      ), '[]'::jsonb),
      'audit', COALESCE((
        SELECT pg_catalog.jsonb_agg(entry ORDER BY entry_id DESC)
        FROM (
          SELECT audit.id AS entry_id,
                 pg_catalog.jsonb_build_object(
                   'id', audit.id,
                   'eventType', audit.event_type,
                   'principalId', audit.principal_id,
                   'entityType', audit.entity_type,
                   'entityId', audit.entity_id,
                   'detail', audit.detail,
                   'createdAt', audit.created_at
                 ) AS entry
            FROM public.platform_audit_events AS audit
           WHERE audit.support_case_id = support_case.id
           ORDER BY audit.id DESC
           LIMIT 100
        ) AS recent
      ), '[]'::jsonb)
    )
    FROM public.support_cases AS support_case
    JOIN public.organizations AS organization ON organization.id = support_case.organization_id
    WHERE support_case.id = p_case
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_grant_tenant_access(p_principal uuid, p_case uuid, p_minutes integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  minutes integer := COALESCE(p_minutes, 60);
  target public.support_cases%ROWTYPE;
  created_id uuid;
  started timestamptz;
  ends timestamptz;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF minutes NOT BETWEEN 5 AND 240 THEN
    RAISE EXCEPTION 'invalid_duration' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO target FROM public.support_cases WHERE id = p_case FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_case' USING ERRCODE = '22023';
  END IF;
  IF target.status <> 'open' THEN
    RAISE EXCEPTION 'case_not_open' USING ERRCODE = '22023';
  END IF;
  started := pg_catalog.now();
  ends := started + minutes * interval '1 minute';
  INSERT INTO public.tenant_access_grants (support_case_id, organization_id, principal_id, starts_at, expires_at)
  VALUES (p_case, target.organization_id, p_principal, started, ends)
  RETURNING id INTO created_id;
  PERFORM public.admin_record_audit(
    p_principal, 'tenant_access.granted', target.organization_id, p_case,
    'tenant_access_grant', created_id::text, 'minutes=' || minutes
  );
  RETURN pg_catalog.jsonb_build_object(
    'id', created_id,
    'caseId', p_case,
    'organizationId', target.organization_id,
    'startsAt', started,
    'expiresAt', ends
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_revoke_tenant_access(p_principal uuid, p_grant uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  revoked_organization text;
  revoked_case uuid;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  UPDATE public.tenant_access_grants
     SET revoked_at = pg_catalog.now(), revoked_by = p_principal
   WHERE id = p_grant AND revoked_at IS NULL AND expires_at > pg_catalog.now()
  RETURNING organization_id, support_case_id INTO revoked_organization, revoked_case;
  IF revoked_case IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('revoked', false);
  END IF;
  PERFORM public.admin_record_audit(
    p_principal, 'tenant_access.revoked', revoked_organization, revoked_case,
    'tenant_access_grant', p_grant::text, NULL
  );
  RETURN pg_catalog.jsonb_build_object('revoked', true);
END;
$function$;--> statement-breakpoint
-- the organization's customers, masked, for as long as the grant lasts; reading them is audited
CREATE FUNCTION public.admin_tenant_customers(p_principal uuid, p_case uuid, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_organization text;
  result jsonb;
  returned integer;
BEGIN
  target_organization := public.admin_require_grant(p_principal, p_case);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT customer.id, customer.name, customer.email, customer.phone, customer.notes, customer.archived_at
      FROM public.customers AS customer
     WHERE customer.organization_id = target_organization
       AND (p_after IS NULL OR customer.id < p_after)
     ORDER BY customer.id DESC
     LIMIT p_limit + 1
  ),
  shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
  SELECT pg_catalog.jsonb_build_object(
    'customers', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', shown.id,
          'name', public.admin_mask_name(shown.name),
          'email', CASE WHEN shown.email IS NULL THEN NULL ELSE public.admin_mask_email(shown.email) END,
          'phone', CASE WHEN shown.phone IS NULL THEN NULL ELSE public.admin_mask_phone(shown.phone) END,
          'hasNotes', shown.notes IS NOT NULL,
          'archived', shown.archived_at IS NOT NULL
        ) ORDER BY shown.id DESC
      ) FROM shown
    ), '[]'::jsonb),
    'next', CASE
      WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
        THEN (SELECT shown.id FROM shown ORDER BY shown.id LIMIT 1)
      ELSE NULL
    END
  ),
  (SELECT pg_catalog.count(*) FROM shown)
  INTO result, returned;
  PERFORM public.admin_record_audit(
    p_principal, 'tenant_data.customers_read', target_organization, p_case,
    'support_case', p_case::text, 'count=' || returned
  );
  RETURN result;
END;
$function$;--> statement-breakpoint
-- one field of one customer, unmasked: only with an active grant, and never without a record of it
CREATE FUNCTION public.admin_reveal_customer_field(p_principal uuid, p_case uuid, p_customer uuid, p_field text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_organization text;
  revealed text;
  found boolean;
BEGIN
  target_organization := public.admin_require_grant(p_principal, p_case);
  IF p_field IS NULL OR p_field NOT IN ('name', 'email', 'phone', 'notes') THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
  END IF;
  SELECT true,
         CASE p_field
           WHEN 'name' THEN customer.name
           WHEN 'email' THEN customer.email
           WHEN 'phone' THEN customer.phone
           ELSE customer.notes
         END
    INTO found, revealed
    FROM public.customers AS customer
   WHERE customer.id = p_customer AND customer.organization_id = target_organization;
  IF found IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  PERFORM public.admin_record_audit(
    p_principal, 'pii.revealed', target_organization, p_case,
    'customer', p_customer::text, p_field
  );
  RETURN pg_catalog.jsonb_build_object('customerId', p_customer, 'field', p_field, 'value', revealed);
END;
$function$;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_mask_name(text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_mask_email(text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_mask_phone(text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_require_principal(uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_require_grant(uuid, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_record_audit(uuid, text, text, uuid, text, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_open_support_case(uuid, text, text, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_close_support_case(uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_list_support_cases(text, text, integer, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_support_case_detail(uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_grant_tenant_access(uuid, uuid, integer) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_revoke_tenant_access(uuid, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_tenant_customers(uuid, uuid, integer, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_reveal_customer_field(uuid, uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_mask_name(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_mask_email(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_mask_phone(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_require_principal(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_require_grant(uuid, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_record_audit(uuid, text, text, uuid, text, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_open_support_case(uuid, text, text, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_close_support_case(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_list_support_cases(text, text, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_support_case_detail(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_grant_tenant_access(uuid, uuid, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_revoke_tenant_access(uuid, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_tenant_customers(uuid, uuid, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_reveal_customer_field(uuid, uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_open_support_case(uuid, text, text, text, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_close_support_case(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_list_support_cases(text, text, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_support_case_detail(uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_grant_tenant_access(uuid, uuid, integer) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_revoke_tenant_access(uuid, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_tenant_customers(uuid, uuid, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_reveal_customer_field(uuid, uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
