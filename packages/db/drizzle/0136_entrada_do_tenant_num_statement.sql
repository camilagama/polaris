-- The entry of a tenant transaction in one statement (ADR 0002, amended). The Hyperdrive counts every statement against
-- a daily quota, and the entry as separate statements takes five after the BEGIN: the timeouts, `app.user_id`, the
-- membership, `app.organization_id` and the status of the organization. `begin_tenant_request` does the same, in the
-- same order, in one call, and refuses with 42501 and the code the Worker turns into its own refusal:
--
-- * C1 the membership of the user, read under `memberships_current_user_select` after `app.user_id` is set: missing or
--   not active → `tenant_access_denied`;
-- * C2 the role of the membership is in `p_roles`, the roles that hold the capability in the map of the domain (the map
--   stays only there; an empty or null list refuses) → `capability_denied`;
-- * only then `app.organization_id`, and C3 the organization is active, read under `organizations_active_tenant_select`;
--   if not, C4 `closed_organization_status` (SECURITY DEFINER of 0085) tells a closure → `organization_closed`, anything
--   else → `tenant_access_denied`.
--
-- SECURITY INVOKER: it reads only what the tenant runtime already reads, under the same policies, so it needs no owner,
-- policy or privilege of its own; it is a shortcut in the count of statements, not a boundary. `set_config(..., true)`
-- inside it is local to the transaction (only `search_path`, listed in its SET clause, is restored on return), so the
-- timeouts and the two `app.*` hold until COMMIT. The timeouts come from the Worker, the only source of their values; a
-- null or non-positive one raises, because `set_config` with null would reset the limit instead of setting it. The
-- function depends on the query cache of the Hyperdrive staying off: a cached result would skip the whole entry.
-- Expand only (ADR 0096): one new function and its grants; the previous Worker never calls it. No table is touched.
CREATE FUNCTION public.begin_tenant_request(
  p_user text,
  p_organization text,
  p_roles text[],
  p_statement_timeout_ms integer,
  p_lock_timeout_ms integer,
  p_idle_timeout_ms integer
)
RETURNS TABLE (member_role text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_status text;
BEGIN
  IF p_statement_timeout_ms IS NULL OR p_statement_timeout_ms <= 0
     OR p_lock_timeout_ms IS NULL OR p_lock_timeout_ms <= 0
     OR p_idle_timeout_ms IS NULL OR p_idle_timeout_ms <= 0 THEN
    RAISE EXCEPTION 'invalid_tenant_timeout' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NULL OR p_organization IS NULL OR p_user = '' OR p_organization = '' THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('statement_timeout', p_statement_timeout_ms::text, true),
          pg_catalog.set_config('lock_timeout', p_lock_timeout_ms::text, true),
          pg_catalog.set_config('idle_in_transaction_session_timeout', p_idle_timeout_ms::text, true),
          pg_catalog.set_config('app.user_id', p_user, true);
  SELECT m.role, m.status INTO v_role, v_status
    FROM public.memberships AS m
   WHERE m.organization_id = p_organization AND m.user_id = p_user
   LIMIT 1;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  -- IS NOT TRUE: a null list, a null role or a null element must refuse, not pass as "unknown"
  IF (v_role = ANY (p_roles)) IS NOT TRUE THEN
    RAISE EXCEPTION 'capability_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('app.organization_id', p_organization, true);
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations AS o WHERE o.id = p_organization AND o.status = 'active'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.closed_organization_status(p_organization)) THEN
      RAISE EXCEPTION 'organization_closed' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  member_role := v_role;
  RETURN NEXT;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.begin_tenant_request(text, text, text[], integer, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_tenant_request(text, text, text[], integer, integer, integer) TO polaris_pr11_runtime;
