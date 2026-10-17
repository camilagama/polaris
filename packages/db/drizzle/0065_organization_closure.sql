-- Closing an organization (plan PR101, ADR 0074): the statuses of its whole life, the record of a
-- closure with the end of its recovery window, and the functions that request it, undo it and
-- mark it closed. The tenant runtime reaches the closure only through functions owned by a role
-- that is never a login; a second group role (never a login either) runs the sweep that marks an
-- expired recovery window as closed.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_privacy_owner') THEN
    EXECUTE 'CREATE ROLE polaris_privacy_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_privacy_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_privacy_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_privacy_owner, polaris_privacy_runtime;--> statement-breakpoint
CREATE TABLE "organization_closures" (
	"closed_at" timestamp with time zone,
	"organization_id" text PRIMARY KEY NOT NULL,
	"recover_until" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" text NOT NULL,
	CONSTRAINT "organization_closures_window_allowed" CHECK ("organization_closures"."recover_until" > "organization_closures"."requested_at" AND "organization_closures"."recover_until" <= "organization_closures"."requested_at" + interval '2160 hours'),
	CONSTRAINT "organization_closures_requester_allowed" CHECK (char_length(btrim("organization_closures"."requested_by_user_id")) BETWEEN 1 AND 255),
	CONSTRAINT "organization_closures_outcome_coherent" CHECK ("organization_closures"."closed_at" IS NULL OR "organization_closures"."recovered_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "organization_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offline_grants" DROP CONSTRAINT "offline_grants_revocation_consistent";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_status_check";--> statement-breakpoint
ALTER TABLE "organization_closures" ADD CONSTRAINT "organization_closures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_closures_recover_until_idx" ON "organization_closures" USING btree ("recover_until");--> statement-breakpoint
ALTER TABLE "offline_grants" ADD CONSTRAINT "offline_grants_revocation_consistent" CHECK (("offline_grants"."revoked_at" IS NULL) = ("offline_grants"."revoked_reason" IS NULL) AND ("offline_grants"."revoked_reason" IS NULL OR "offline_grants"."revoked_reason" IN ('device_revoked', 'user_revoked', 'security_event', 'organization_suspended', 'organization_closed')));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'closing', 'closed', 'purge_pending', 'purged'));--> statement-breakpoint
CREATE POLICY "organization_closures_privacy_owner_select" ON "organization_closures" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING (true);--> statement-breakpoint
CREATE POLICY "organization_closures_privacy_owner_insert" ON "organization_closures" AS PERMISSIVE FOR INSERT TO "polaris_privacy_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_closures_privacy_owner_update" ON "organization_closures" AS PERMISSIVE FOR UPDATE TO "polaris_privacy_owner" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "organization_closures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.organization_closures FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
-- what the closure functions may touch, and nothing else: the status, the authorization epoch,
-- the live offline leases, the audit and the closure record
GRANT SELECT, INSERT, UPDATE ON TABLE public.organization_closures TO polaris_privacy_owner;--> statement-breakpoint
GRANT SELECT (id, name, status) ON TABLE public.organizations TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON TABLE public.organizations TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY organizations_privacy_owner_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner USING (true);--> statement-breakpoint
CREATE POLICY organizations_privacy_owner_update ON public.organizations
  AS PERMISSIVE FOR UPDATE TO polaris_privacy_owner USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status, authorization_epoch) ON TABLE public.memberships TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (authorization_epoch, updated_at) ON TABLE public.memberships TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY memberships_privacy_owner_select ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner USING (true);--> statement-breakpoint
CREATE POLICY memberships_privacy_owner_update ON public.memberships
  AS PERMISSIVE FOR UPDATE TO polaris_privacy_owner USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT (organization_id, revoked_at) ON TABLE public.offline_grants TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON TABLE public.offline_grants TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY offline_grants_privacy_owner_select ON public.offline_grants
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner USING (true);--> statement-breakpoint
CREATE POLICY offline_grants_privacy_owner_update ON public.offline_grants
  AS PERMISSIVE FOR UPDATE TO polaris_privacy_owner USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT INSERT ON TABLE public.tenant_audit_event TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY tenant_audit_event_privacy_owner_insert ON public.tenant_audit_event
  AS PERMISSIVE FOR INSERT TO polaris_privacy_owner WITH CHECK (true);--> statement-breakpoint
-- The owner asks for a closure from inside a tenant transaction: who they are and which organization
-- come from the transaction's own settings (set only after the server authorized the request), never
-- from an argument. The window is an argument only because the domain owns the number of days.
CREATE FUNCTION public.request_organization_closure(p_window_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  actor text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  target text := NULLIF(pg_catalog.current_setting('app.organization_id', true), '');
  revoked_count integer;
  deadline timestamptz;
BEGIN
  IF actor IS NULL OR target IS NULL THEN
    RAISE EXCEPTION 'tenant_context_required' USING ERRCODE = '42501';
  END IF;
  IF p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 90 THEN
    RAISE EXCEPTION 'invalid_closure_window' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships AS member
     WHERE member.organization_id = target AND member.user_id = actor
       AND member.status = 'active' AND member.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  -- the same key lease issuance takes per user: a lease is either issued before this and revoked by it,
  -- or after it and refused (the organization is no longer active)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('authorization-epoch:' || membership.user_id, 0)
  )
  FROM (
    SELECT member.user_id FROM public.memberships AS member
     WHERE member.organization_id = target ORDER BY member.user_id
  ) AS membership;
  UPDATE public.organizations SET status = 'closing', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_active' USING ERRCODE = '55000';
  END IF;
  UPDATE public.memberships
     SET authorization_epoch = authorization_epoch + 1, updated_at = pg_catalog.now()
   WHERE organization_id = target;
  UPDATE public.offline_grants
     SET revoked_at = pg_catalog.now(), revoked_reason = 'organization_closed'
   WHERE organization_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  deadline := pg_catalog.now() + p_window_days * interval '24 hours';
  INSERT INTO public.organization_closures
    (organization_id, requested_by_user_id, requested_at, recover_until, closed_at, recovered_at)
  VALUES (target, actor, pg_catalog.now(), deadline, NULL, NULL)
  ON CONFLICT (organization_id) DO UPDATE
    SET requested_by_user_id = EXCLUDED.requested_by_user_id,
        requested_at = EXCLUDED.requested_at,
        recover_until = EXCLUDED.recover_until,
        closed_at = NULL,
        recovered_at = NULL;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type)
  VALUES (target, actor, 'organization', target, 'organization.closure_requested');
  RETURN pg_catalog.jsonb_build_object('recoverUntil', deadline, 'revokedLeases', revoked_count);
END;
$function$;--> statement-breakpoint
-- The owner undoes a closure while the window is open. The organization is no longer active, so this
-- does not run inside a tenant transaction: it needs only the authenticated user, whose active owner
-- membership of the organization it checks itself. The leases revoked at the request stay revoked.
CREATE FUNCTION public.recover_organization_closure(p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
  UPDATE public.organization_closures SET recovered_at = pg_catalog.now()
   WHERE organization_id = p_organization;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type)
  VALUES (p_organization, actor, 'organization', p_organization, 'organization.closure_recovered');
  RETURN pg_catalog.jsonb_build_object('status', 'active');
END;
$function$;--> statement-breakpoint
-- The organizations of the authenticated user that can still be recovered (only the ones they own).
CREATE FUNCTION public.list_organizations_in_closure()
RETURNS TABLE (id text, name text, recover_until timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT organization.id, organization.name, closure.recover_until
    FROM public.memberships AS member
    JOIN public.organizations AS organization ON organization.id = member.organization_id
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
   WHERE member.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')
     AND member.status = 'active'
     AND member.role = 'owner'
     AND organization.status = 'closing'
     AND closure.recover_until > pg_catalog.now()
   ORDER BY closure.recover_until, organization.id
$function$;--> statement-breakpoint
-- What time itself causes: a closing organization whose window ended is closed. It is the only thing
-- the privacy runtime does; it moves nothing back and deletes nothing.
CREATE FUNCTION public.finalize_expired_closures(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  finalized integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  WITH due AS (
    SELECT organization.id
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
     WHERE organization.status = 'closing' AND closure.recover_until <= pg_catalog.now()
     ORDER BY closure.recover_until, organization.id
     LIMIT p_limit
       FOR UPDATE OF organization SKIP LOCKED
  ), closed AS (
    UPDATE public.organizations AS organization
       SET status = 'closed', updated_at = pg_catalog.now()
      FROM due
     WHERE organization.id = due.id
    RETURNING organization.id
  ), marked AS (
    UPDATE public.organization_closures AS closure
       SET closed_at = pg_catalog.now()
      FROM closed
     WHERE closure.organization_id = closed.id
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO finalized FROM marked;
  RETURN finalized;
END;
$function$;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.request_organization_closure(integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.recover_organization_closure(text) OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.list_organizations_in_closure() OWNER TO polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.finalize_expired_closures(integer) OWNER TO polaris_privacy_owner;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.request_organization_closure(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.recover_organization_closure(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_organizations_in_closure() FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_expired_closures(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.request_organization_closure(integer) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.recover_organization_closure(text) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_organizations_in_closure() TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finalize_expired_closures(integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;
