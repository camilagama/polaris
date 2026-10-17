-- Privacy cases (plan PR103, ADR 0077): the internal workflow of a request about personal data, moved one
-- step at a time (request, identity, role, scope, decision, action, resolution) by functions of the Admin that
-- write the audit in the same transaction. A case holds codes, an opaque reference and a short note, never
-- personal data; the database refuses a skipped step, an acceptance after a failed identity check and an
-- acceptance by Polaris, on its own authority, of data it only processes.
CREATE TABLE "privacy_case_actions" (
	"action" text NOT NULL,
	"entity_id" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"support_case_id" uuid NOT NULL,
	CONSTRAINT "privacy_case_actions_action_allowed" CHECK ("privacy_case_actions"."action" IN ('customer_anonymized', 'organization_closed', 'export_delivered', 'purge_scheduled', 'redirected_to_reseller', 'no_action_required', 'other')),
	CONSTRAINT "privacy_case_actions_entity_allowed" CHECK ("privacy_case_actions"."entity_id" IS NULL OR "privacy_case_actions"."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "privacy_case_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "privacy_cases" (
	"channel" text NOT NULL,
	"decision" text,
	"decision_note" text,
	"decision_reason" text,
	"due_at" timestamp with time zone NOT NULL,
	"identity_method" text,
	"identity_status" text,
	"note" text,
	"polaris_role" text,
	"received_at" timestamp with time zone NOT NULL,
	"requester_kind" text NOT NULL,
	"request_type" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"scope_categories" text[],
	"stage" text DEFAULT 'requested' NOT NULL,
	"subject_reference" text,
	"support_case_id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_cases_stage_allowed" CHECK ("privacy_cases"."stage" IN ('requested', 'identity_checked', 'role_determined', 'scoped', 'decided', 'executed', 'resolved')),
	CONSTRAINT "privacy_cases_request_allowed" CHECK ("privacy_cases"."request_type" IN ('access', 'correction', 'deletion', 'portability', 'objection', 'restriction', 'other')
        AND "privacy_cases"."requester_kind" IN ('data_subject', 'organization_owner', 'authority', 'other')
        AND "privacy_cases"."channel" IN ('email', 'in_app', 'support_ticket', 'other')),
	CONSTRAINT "privacy_cases_due_after_receipt" CHECK ("privacy_cases"."due_at" > "privacy_cases"."received_at"),
	CONSTRAINT "privacy_cases_identity_allowed" CHECK (("privacy_cases"."identity_status" IS NULL AND "privacy_cases"."identity_method" IS NULL)
        OR ("privacy_cases"."identity_status" IN ('verified', 'failed')
            AND "privacy_cases"."identity_method" IN ('authenticated_session', 'email_ownership', 'owner_confirmation', 'document_review', 'other'))),
	CONSTRAINT "privacy_cases_role_allowed" CHECK ("privacy_cases"."polaris_role" IS NULL OR "privacy_cases"."polaris_role" IN ('controller', 'processor')),
	CONSTRAINT "privacy_cases_scope_allowed" CHECK ("privacy_cases"."scope_categories" IS NULL
        OR (cardinality("privacy_cases"."scope_categories") BETWEEN 1 AND 9
            AND "privacy_cases"."scope_categories" <@ ARRAY['account', 'authentication', 'organization_profile', 'customers', 'sales', 'inventory_catalog', 'media', 'billing', 'audit_logs']::text[])),
	CONSTRAINT "privacy_cases_decision_allowed" CHECK (("privacy_cases"."decision" IS NULL OR "privacy_cases"."decision" IN ('accept', 'partially_accept', 'reject', 'redirect_to_controller'))
        AND ("privacy_cases"."decision_reason" IS NULL OR "privacy_cases"."decision_reason" IN ('identity_not_verified', 'no_authority', 'controller_is_reseller', 'legal_retention', 'manifestly_unfounded', 'not_personal_data', 'other'))
        AND ("privacy_cases"."decision" IS NULL OR "privacy_cases"."decision" = 'accept' OR "privacy_cases"."decision_reason" IS NOT NULL)),
	CONSTRAINT "privacy_cases_texts_allowed" CHECK (("privacy_cases"."note" IS NULL OR (char_length("privacy_cases"."note") BETWEEN 1 AND 500 AND "privacy_cases"."note" !~ '[[:cntrl:]]'))
        AND ("privacy_cases"."decision_note" IS NULL OR (char_length("privacy_cases"."decision_note") BETWEEN 1 AND 500 AND "privacy_cases"."decision_note" !~ '[[:cntrl:]]'))
        AND ("privacy_cases"."subject_reference" IS NULL OR (char_length("privacy_cases"."subject_reference") BETWEEN 1 AND 64 AND "privacy_cases"."subject_reference" ~ '^[A-Za-z0-9_-]+$'))),
	CONSTRAINT "privacy_cases_steps_in_order" CHECK ((("privacy_cases"."stage" = 'requested') = ("privacy_cases"."identity_status" IS NULL))
        AND (("privacy_cases"."stage" IN ('requested', 'identity_checked')) = ("privacy_cases"."polaris_role" IS NULL))
        AND (("privacy_cases"."stage" IN ('requested', 'identity_checked', 'role_determined')) = ("privacy_cases"."scope_categories" IS NULL))
        AND (("privacy_cases"."stage" IN ('requested', 'identity_checked', 'role_determined', 'scoped')) = ("privacy_cases"."decision" IS NULL))
        AND (("privacy_cases"."stage" = 'resolved') = ("privacy_cases"."resolved_at" IS NOT NULL))),
	CONSTRAINT "privacy_cases_decision_fits_facts" CHECK (("privacy_cases"."identity_status" IS DISTINCT FROM 'failed'
            OR "privacy_cases"."decision" IS NULL
            OR ("privacy_cases"."decision" = 'reject' AND "privacy_cases"."decision_reason" = 'identity_not_verified'))
        AND ("privacy_cases"."decision_reason" IS DISTINCT FROM 'identity_not_verified' OR "privacy_cases"."identity_status" = 'failed')
        AND ("privacy_cases"."polaris_role" IS DISTINCT FROM 'processor'
            OR "privacy_cases"."requester_kind" = 'organization_owner'
            OR "privacy_cases"."decision" IS NULL
            OR "privacy_cases"."decision" NOT IN ('accept', 'partially_accept'))
        AND ("privacy_cases"."decision" IS DISTINCT FROM 'redirect_to_controller' OR "privacy_cases"."polaris_role" = 'processor'))
);
--> statement-breakpoint
ALTER TABLE "privacy_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "privacy_case_actions" ADD CONSTRAINT "privacy_case_actions_recorded_by_platform_principals_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_case_actions" ADD CONSTRAINT "privacy_case_actions_case_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."privacy_cases"("support_case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_cases" ADD CONSTRAINT "privacy_cases_support_case_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_case_actions_case_idx" ON "privacy_case_actions" USING btree ("support_case_id","id");--> statement-breakpoint
CREATE INDEX "privacy_cases_stage_due_idx" ON "privacy_cases" USING btree ("stage","due_at");--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded'));--> statement-breakpoint
CREATE POLICY "privacy_case_actions_admin_owner_select" ON "privacy_case_actions" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "privacy_case_actions_admin_owner_insert" ON "privacy_case_actions" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "privacy_cases_admin_owner_select" ON "privacy_cases" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "privacy_cases_admin_owner_insert" ON "privacy_cases" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "privacy_cases_admin_owner_update" ON "privacy_cases" AS PERMISSIVE FOR UPDATE TO "polaris_admin_owner" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- the Admin role reaches none of this directly: the functions below, owned by a role that is never a login,
-- move a case one step at a time and write the audit in the same transaction
ALTER TABLE "privacy_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy_case_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.privacy_cases FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.privacy_case_actions FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.privacy_cases TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (stage, identity_status, identity_method, polaris_role, scope_categories, subject_reference, decision, decision_reason, decision_note, resolved_at, updated_at) ON TABLE public.privacy_cases TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.privacy_case_actions TO polaris_admin_owner;--> statement-breakpoint
-- the actions are append-only, like the audit
CREATE TRIGGER privacy_case_actions_no_change
  BEFORE UPDATE OR DELETE ON public.privacy_case_actions
  FOR EACH ROW EXECUTE FUNCTION public.platform_audit_events_immutable();--> statement-breakpoint
CREATE TRIGGER privacy_case_actions_no_truncate
  BEFORE TRUNCATE ON public.privacy_case_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_events_immutable();--> statement-breakpoint
-- a case moves one step at a time, what a step set is never changed, and a resolved case is final
CREATE FUNCTION public.privacy_cases_forward_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  stages text[] := ARRAY['requested', 'identity_checked', 'role_determined', 'scoped', 'decided', 'executed', 'resolved'];
BEGIN
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
REVOKE ALL ON FUNCTION public.privacy_cases_forward_only() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER privacy_cases_forward_only
  BEFORE UPDATE ON public.privacy_cases
  FOR EACH ROW EXECUTE FUNCTION public.privacy_cases_forward_only();--> statement-breakpoint
-- the open privacy case a step is about, locked for the step (internal: nothing but the functions below calls it)
CREATE FUNCTION public.admin_lock_privacy_case(p_case uuid)
RETURNS public.privacy_cases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  locked public.privacy_cases;
BEGIN
  SELECT privacy_case.* INTO locked
    FROM public.privacy_cases AS privacy_case
    JOIN public.support_cases AS support_case ON support_case.id = privacy_case.support_case_id
   WHERE privacy_case.support_case_id = p_case AND support_case.status = 'open' AND support_case.kind = 'privacy'
     FOR UPDATE OF privacy_case;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.privacy_cases AS privacy_case WHERE privacy_case.support_case_id = p_case) THEN
      RAISE EXCEPTION 'unknown_case' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'case_not_open' USING ERRCODE = '22023';
  END IF;
  RETURN locked;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_open_privacy_case(
  p_principal uuid,
  p_organization_id text,
  p_reason text,
  p_request_type text,
  p_requester_kind text,
  p_channel text,
  p_received_at timestamptz,
  p_note text,
  p_due_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  clean_reason text := pg_catalog.btrim(p_reason);
  clean_note text := NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), '');
  received timestamptz := COALESCE(p_received_at, pg_catalog.now());
  created_id uuid;
  created_at timestamptz;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF clean_reason IS NULL OR pg_catalog.char_length(clean_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_case_reason' USING ERRCODE = '22023';
  END IF;
  IF clean_note IS NOT NULL AND pg_catalog.char_length(clean_note) > 500 THEN
    RAISE EXCEPTION 'invalid_privacy_request' USING ERRCODE = '22023';
  END IF;
  IF p_due_days IS NULL OR p_due_days < 1 OR p_due_days > 90 OR received > pg_catalog.now()
     OR received < pg_catalog.now() - interval '8760 hours' THEN
    RAISE EXCEPTION 'invalid_privacy_request' USING ERRCODE = '22023';
  END IF;
  IF p_request_type IS NULL OR p_request_type NOT IN ('access', 'correction', 'deletion', 'portability', 'objection', 'restriction', 'other')
     OR p_requester_kind IS NULL OR p_requester_kind NOT IN ('data_subject', 'organization_owner', 'authority', 'other')
     OR p_channel IS NULL OR p_channel NOT IN ('email', 'in_app', 'support_ticket', 'other') THEN
    RAISE EXCEPTION 'invalid_privacy_request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations AS organization WHERE organization.id = p_organization_id) THEN
    RAISE EXCEPTION 'unknown_organization' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.support_cases (organization_id, kind, reason, context, opened_by)
  VALUES (p_organization_id, 'privacy', clean_reason, NULL, p_principal)
  RETURNING id, opened_at INTO created_id, created_at;
  INSERT INTO public.privacy_cases (support_case_id, request_type, requester_kind, channel, received_at, due_at, note)
  VALUES (created_id, p_request_type, p_requester_kind, p_channel, received, received + p_due_days * interval '24 hours', clean_note);
  PERFORM public.admin_record_audit(
    p_principal, 'support_case.opened', p_organization_id, created_id,
    'support_case', created_id::text, 'privacy'
  );
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', p_organization_id, created_id,
    'privacy_case', created_id::text, 'stage=requested;type=' || p_request_type || ';by=' || p_requester_kind
  );
  RETURN pg_catalog.jsonb_build_object(
    'id', created_id,
    'organizationId', p_organization_id,
    'stage', 'requested',
    'dueAt', received + p_due_days * interval '24 hours',
    'openedAt', created_at
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_record_identity(p_principal uuid, p_case uuid, p_status text, p_method text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_status IS NULL OR p_status NOT IN ('verified', 'failed')
     OR p_method IS NULL OR p_method NOT IN ('authenticated_session', 'email_ownership', 'owner_confirmation', 'document_review', 'other') THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  IF case_row.stage <> 'requested' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  UPDATE public.privacy_cases
     SET stage = 'identity_checked', identity_status = p_status, identity_method = p_method, updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text, 'stage=identity_checked;status=' || p_status || ';method=' || p_method
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'identity_checked');
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_record_role(p_principal uuid, p_case uuid, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_role IS NULL OR p_role NOT IN ('controller', 'processor') THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  IF case_row.stage <> 'identity_checked' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  UPDATE public.privacy_cases
     SET stage = 'role_determined', polaris_role = p_role, updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text, 'stage=role_determined;role=' || p_role
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'role_determined');
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_record_scope(p_principal uuid, p_case uuid, p_categories text[], p_subject text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
  clean_subject text := NULLIF(pg_catalog.btrim(COALESCE(p_subject, '')), '');
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_categories IS NULL
     OR pg_catalog.cardinality(p_categories) NOT BETWEEN 1 AND 9
     OR NOT (p_categories <@ ARRAY['account', 'authentication', 'organization_profile', 'customers', 'sales', 'inventory_catalog', 'media', 'billing', 'audit_logs']::text[])
     OR (SELECT pg_catalog.count(DISTINCT category) FROM pg_catalog.unnest(p_categories) AS category) <> pg_catalog.cardinality(p_categories)
     OR (clean_subject IS NOT NULL AND (pg_catalog.char_length(clean_subject) > 64 OR clean_subject !~ '^[A-Za-z0-9_-]+$')) THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  IF case_row.stage <> 'role_determined' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  UPDATE public.privacy_cases
     SET stage = 'scoped', scope_categories = p_categories, subject_reference = clean_subject, updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text, 'stage=scoped;categories=' || pg_catalog.cardinality(p_categories)
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'scoped');
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_record_decision(p_principal uuid, p_case uuid, p_decision text, p_reason text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
  clean_note text := NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), '');
  accepting boolean;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'partially_accept', 'reject', 'redirect_to_controller')
     OR (p_reason IS NOT NULL AND p_reason NOT IN ('identity_not_verified', 'no_authority', 'controller_is_reseller', 'legal_retention', 'manifestly_unfounded', 'not_personal_data', 'other'))
     OR (clean_note IS NOT NULL AND pg_catalog.char_length(clean_note) > 500) THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  IF case_row.stage <> 'scoped' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  accepting := p_decision IN ('accept', 'partially_accept');
  -- what the case already established decides what may be decided (the same rules the table checks)
  IF case_row.identity_status = 'failed' THEN
    IF p_decision <> 'reject' OR p_reason IS DISTINCT FROM 'identity_not_verified' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF accepting AND case_row.polaris_role = 'processor' AND case_row.requester_kind <> 'organization_owner' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
    IF p_decision = 'redirect_to_controller' AND case_row.polaris_role IS DISTINCT FROM 'processor' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
    IF p_decision <> 'accept' AND p_reason IS NULL THEN
      RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
    END IF;
    IF p_reason = 'identity_not_verified' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.privacy_cases
     SET stage = 'decided', decision = p_decision, decision_reason = p_reason, decision_note = clean_note, updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text,
    'stage=decided;decision=' || p_decision || COALESCE(';reason=' || p_reason, '')
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'decided');
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_record_action(p_principal uuid, p_case uuid, p_action text, p_entity text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
  clean_entity text := NULLIF(pg_catalog.btrim(COALESCE(p_entity, '')), '');
  action_id uuid;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_action IS NULL OR p_action NOT IN ('customer_anonymized', 'organization_closed', 'export_delivered', 'purge_scheduled', 'redirected_to_reseller', 'no_action_required', 'other')
     OR (clean_entity IS NOT NULL AND clean_entity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  -- a refusal has nothing to carry out
  IF case_row.stage NOT IN ('decided', 'executed') OR case_row.decision = 'reject' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  -- and what is recorded fits what was decided: a redirect is carried out by telling the controller, an acceptance by doing something (not by redirecting, not by doing nothing)
  IF (case_row.decision = 'redirect_to_controller' AND p_action NOT IN ('redirected_to_reseller', 'no_action_required', 'other'))
     OR (case_row.decision IN ('accept', 'partially_accept') AND p_action IN ('redirected_to_reseller', 'no_action_required')) THEN
    RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.privacy_case_actions (support_case_id, action, entity_id, recorded_by)
  VALUES (p_case, p_action, pg_catalog.lower(clean_entity), p_principal)
  RETURNING id INTO action_id;
  UPDATE public.privacy_cases SET stage = 'executed', updated_at = pg_catalog.now() WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.action_recorded', support_org, p_case,
    'privacy_case', p_case::text, 'action=' || p_action
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'executed', 'actionId', action_id);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_resolve(p_principal uuid, p_case uuid, p_resolution text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
  clean_resolution text := NULLIF(pg_catalog.btrim(COALESCE(p_resolution, '')), '');
  revoked_count integer;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  PERFORM 1 FROM public.support_cases AS support_case WHERE support_case.id = p_case FOR UPDATE;
  IF clean_resolution IS NOT NULL AND pg_catalog.char_length(clean_resolution) > 500 THEN
    RAISE EXCEPTION 'invalid_case_resolution' USING ERRCODE = '22023';
  END IF;
  -- an acceptance is resolved after it was carried out; a refusal or a redirect needs no execution
  IF NOT (case_row.stage = 'executed' OR (case_row.stage = 'decided' AND case_row.decision IN ('reject', 'redirect_to_controller'))) THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  UPDATE public.tenant_access_grants
     SET revoked_at = pg_catalog.now(), revoked_by = p_principal
   WHERE support_case_id = p_case AND revoked_at IS NULL AND expires_at > pg_catalog.now();
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  UPDATE public.privacy_cases
     SET stage = 'resolved', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  UPDATE public.support_cases
     SET status = 'closed', closed_at = pg_catalog.now(), closed_by = p_principal, resolution = clean_resolution
   WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text, 'stage=resolved'
  );
  PERFORM public.admin_record_audit(
    p_principal, 'support_case.closed', support_org, p_case,
    'support_case', p_case::text, 'revoked=' || revoked_count
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'resolved', 'revokedGrants', revoked_count);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_privacy_case_detail(p_case uuid)
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
        'status', support_case.status,
        'openedAt', support_case.opened_at,
        'closedAt', support_case.closed_at,
        'resolution', support_case.resolution
      ),
      'privacy', pg_catalog.jsonb_build_object(
        'requestType', privacy_case.request_type,
        'requesterKind', privacy_case.requester_kind,
        'channel', privacy_case.channel,
        'receivedAt', privacy_case.received_at,
        'dueAt', privacy_case.due_at,
        'overdue', (privacy_case.stage <> 'resolved' AND pg_catalog.now() > privacy_case.due_at),
        'note', privacy_case.note,
        'stage', privacy_case.stage,
        'identityStatus', privacy_case.identity_status,
        'identityMethod', privacy_case.identity_method,
        'polarisRole', privacy_case.polaris_role,
        'scopeCategories', privacy_case.scope_categories,
        'subjectReference', privacy_case.subject_reference,
        'decision', privacy_case.decision,
        'decisionReason', privacy_case.decision_reason,
        'decisionNote', privacy_case.decision_note,
        'resolvedAt', privacy_case.resolved_at
      ),
      'actions', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', action_row.id, 'action', action_row.action, 'entityId', action_row.entity_id,
            'recordedBy', action_row.recorded_by, 'recordedAt', action_row.recorded_at
          ) ORDER BY action_row.id
        ) FROM public.privacy_case_actions AS action_row WHERE action_row.support_case_id = privacy_case.support_case_id
      ), '[]'::jsonb),
      'audit', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'eventType', audit.event_type, 'entityType', audit.entity_type, 'detail', audit.detail,
            'principalId', audit.principal_id, 'at', audit.created_at
          ) ORDER BY audit.id
        ) FROM (
          SELECT event.* FROM public.platform_audit_events AS event
           WHERE event.support_case_id = privacy_case.support_case_id ORDER BY event.id LIMIT 200
        ) AS audit
      ), '[]'::jsonb)
    )
    FROM public.privacy_cases AS privacy_case
    JOIN public.support_cases AS support_case ON support_case.id = privacy_case.support_case_id
    JOIN public.organizations AS organization ON organization.id = support_case.organization_id
   WHERE privacy_case.support_case_id = p_case
  );
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_list_privacy_cases(p_filter text, p_limit integer, p_after uuid)
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
  IF p_filter IS NOT NULL AND p_filter NOT IN ('open', 'closed', 'overdue') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT privacy_case.support_case_id AS id, support_case.organization_id, organization.name AS organization_name,
             support_case.status, support_case.opened_at, privacy_case.request_type, privacy_case.requester_kind,
             privacy_case.stage, privacy_case.due_at,
             (privacy_case.stage <> 'resolved' AND pg_catalog.now() > privacy_case.due_at) AS overdue
        FROM public.privacy_cases AS privacy_case
        JOIN public.support_cases AS support_case ON support_case.id = privacy_case.support_case_id
        JOIN public.organizations AS organization ON organization.id = support_case.organization_id
       WHERE (p_filter IS NULL
              OR (p_filter = 'open' AND support_case.status = 'open')
              OR (p_filter = 'closed' AND support_case.status = 'closed')
              OR (p_filter = 'overdue' AND privacy_case.stage <> 'resolved' AND pg_catalog.now() > privacy_case.due_at))
         AND (p_after IS NULL OR privacy_case.support_case_id < p_after)
       ORDER BY privacy_case.support_case_id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'cases', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id, 'organizationId', shown.organization_id, 'organizationName', shown.organization_name,
            'status', shown.status, 'openedAt', shown.opened_at, 'requestType', shown.request_type,
            'requesterKind', shown.requester_kind, 'stage', shown.stage, 'dueAt', shown.due_at, 'overdue', shown.overdue
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
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_lock_privacy_case(uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_open_privacy_case(uuid, text, text, text, text, text, timestamptz, text, integer) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_identity(uuid, uuid, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_role(uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_scope(uuid, uuid, text[], text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_decision(uuid, uuid, text, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_action(uuid, uuid, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_resolve(uuid, uuid, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_case_detail(uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_list_privacy_cases(text, integer, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- the generic functions no longer open or close a privacy case: it has its own workflow, which closes it at the end
CREATE OR REPLACE FUNCTION public.admin_open_support_case(
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
  IF p_kind = 'privacy' THEN
    RAISE EXCEPTION 'privacy_case_workflow_required' USING ERRCODE = '22023';
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
CREATE OR REPLACE FUNCTION public.admin_close_support_case(p_principal uuid, p_case uuid, p_resolution text)
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
  IF target.kind = 'privacy' AND EXISTS (SELECT 1 FROM public.privacy_cases AS privacy_case WHERE privacy_case.support_case_id = p_case) THEN
    RAISE EXCEPTION 'privacy_case_workflow_required' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION public.admin_lock_privacy_case(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_open_privacy_case(uuid, text, text, text, text, text, timestamptz, text, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_identity(uuid, uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_role(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_scope(uuid, uuid, text[], text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_decision(uuid, uuid, text, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_action(uuid, uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_resolve(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_case_detail(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_list_privacy_cases(text, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_open_privacy_case(uuid, text, text, text, text, text, timestamptz, text, integer) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_record_identity(uuid, uuid, text, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_record_role(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_record_scope(uuid, uuid, text[], text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_record_decision(uuid, uuid, text, text, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_record_action(uuid, uuid, text, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_resolve(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_privacy_case_detail(uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_list_privacy_cases(text, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
