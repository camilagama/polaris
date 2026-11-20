-- The organizations of the user in one statement (ADR 0002, amended). Every opening of the app lists them, and the
-- Hyperdrive counts every statement against a daily quota: read as separate statements, the list takes `app.user_id`,
-- the memberships, and then, for each organization, `app.organization_id` and its row. `list_user_organizations` does
-- the same, in the same order, in one call:
--
-- * `app.user_id` is the user and `app.organization_id` is empty, so `memberships_current_user_select` lets the user
--   read their own rows; the active ones are read whole, in order of `created_at, organization_id`, before the loop,
--   because the policies read the settings on every row and the loop changes `app.organization_id`;
-- * for each of them, `app.organization_id` is that organization and its row is read under
--   `organizations_active_tenant_select`; only an active one is answered, with the role of the membership;
-- * at the end both settings are empty again, so a later statement of the same transaction inherits neither; it
--   runs only in a transaction of its own, never inside a tenant transaction, whose context it would clear.
--
-- SECURITY INVOKER: it reads only what the tenant runtime already reads, under the same policies, so it needs no owner,
-- policy or privilege of its own; the answer depends on the policies alone, never on the argument as a proof. Every
-- `set_config` is local (`true`): with the transaction of the Worker it ends at COMMIT, and on a connection reused by
-- the Hyperdrive the next transaction starts without it. A user that is null, empty or has blank space at an end is
-- refused with 42501 and `tenant_access_denied`, the refusal of the Worker. The function depends on the query cache of
-- the Hyperdrive staying off: a cached answer would keep listing an organization the user was removed from.
-- Expand only (ADR 0096): one new function and its grants; the previous Worker never calls it. No table is touched.
CREATE FUNCTION public.list_user_organizations(p_user text)
RETURNS TABLE (id text, name text, role text, timezone text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_organizations text[];
  v_roles text[];
  v_name text;
  v_timezone text;
BEGIN
  IF p_user IS NULL OR p_user = '' OR p_user ~ '^[[:space:]]|[[:space:]]$' THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('app.user_id', p_user, true),
          pg_catalog.set_config('app.organization_id', '', true);
  SELECT pg_catalog.array_agg(m.organization_id ORDER BY m.created_at, m.organization_id),
         pg_catalog.array_agg(m.role ORDER BY m.created_at, m.organization_id)
    INTO v_organizations, v_roles
    FROM public.memberships AS m
   WHERE m.user_id = p_user AND m.status = 'active';
  FOR i IN 1 .. COALESCE(pg_catalog.array_length(v_organizations, 1), 0) LOOP
    PERFORM pg_catalog.set_config('app.organization_id', v_organizations[i], true);
    SELECT o.name, o.timezone INTO v_name, v_timezone
      FROM public.organizations AS o
     WHERE o.id = v_organizations[i] AND o.status = 'active';
    IF FOUND THEN
      id := v_organizations[i];
      name := v_name;
      role := v_roles[i];
      timezone := v_timezone;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.organization_id', '', true),
          pg_catalog.set_config('app.user_id', '', true);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_user_organizations(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_user_organizations(text) TO polaris_pr11_runtime;
