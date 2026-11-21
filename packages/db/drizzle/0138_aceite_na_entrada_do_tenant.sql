-- The legal acceptance checked at the entry of a tenant transaction (ADR 0100 and ADR 0002, amended). With the control on,
-- every tenant call read `legal_acceptance_versions` on the authentication connection before the transaction: one
-- statement more against the daily quota of the Hyperdrive. The entry now does the same check, first, in the statement it
-- already sends.
--
-- * `legal_acceptance_pending` is the narrow door to the record: SECURITY DEFINER of `polaris_legal_acceptance_owner`,
--   `search_path = pg_catalog, pg_temp`, EXECUTE only for the tenant runtime. It takes the user and the minimum accepted
--   version of each document and answers only the documents below their minimum: never a hash, an instant, an origin or a
--   request ID. The tenant runtime still has no access to the table nor to `legal_acceptance_versions`. A user ID out of
--   the Better Auth shape, or a minimum that is null or out of 1-1000 (the range of the versions in the table), raises
--   22023: the control fails closed instead of answering "nothing pending".
-- * `begin_tenant_request` with nine arguments is the entry of 0136 with three more, none with a default:
--   `p_require_legal` and the two minimums. Null, or a minimum out of 1-1000, raises 22023 whether or not the check is
--   asked for, so a caller that did not decide does not pass. With `p_require_legal`, right after `app.user_id` and
--   before the membership, the capability and the organization, a pending document refuses with 42501
--   `legal_acceptance_required` and the pending documents, comma separated, in the DETAIL; any error of the helper
--   aborts the transaction. Without it, nothing is read, as with the control off.
--
-- Expand only (ADR 0096): one new function owned by the owner role, a new overload of the entry and their grants. The
-- six-argument entry stays for the Worker in the air; it is a path without the acceptance, like the SQL any tenant runtime
-- already has, and leaves in a contract migration once no Worker that calls it can come back. No table is touched.
GRANT CREATE ON SCHEMA public TO polaris_legal_acceptance_owner;--> statement-breakpoint
GRANT polaris_legal_acceptance_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_legal_acceptance_owner;--> statement-breakpoint
CREATE FUNCTION public.legal_acceptance_pending(p_user text, p_min_terms integer, p_min_privacy integer)
RETURNS TABLE (document text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_user IS NULL OR p_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid legal acceptance user' USING ERRCODE = '22023';
  END IF;
  -- IS NOT TRUE: a null minimum must raise, not compare as unknown
  IF (p_min_terms BETWEEN 1 AND 1000 AND p_min_privacy BETWEEN 1 AND 1000) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid legal acceptance minimum' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT required.name
      FROM (VALUES (1, 'terms'::text, p_min_terms), (2, 'privacy'::text, p_min_privacy)) AS required(ord, name, minimum)
     WHERE COALESCE(
             (SELECT pg_catalog.max(accepted.version)
                FROM public.legal_acceptance AS accepted
               WHERE accepted.user_id = p_user AND accepted.document = required.name),
             0
           ) < required.minimum
     ORDER BY required.ord;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.legal_acceptance_pending(text, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_acceptance_pending(text, integer, integer) TO polaris_pr11_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_legal_acceptance_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_legal_acceptance_owner;--> statement-breakpoint
CREATE FUNCTION public.begin_tenant_request(
  p_user text,
  p_organization text,
  p_roles text[],
  p_require_legal boolean,
  p_min_terms integer,
  p_min_privacy integer,
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
  v_pending text[];
  v_role text;
  v_status text;
BEGIN
  IF p_statement_timeout_ms IS NULL OR p_statement_timeout_ms <= 0
     OR p_lock_timeout_ms IS NULL OR p_lock_timeout_ms <= 0
     OR p_idle_timeout_ms IS NULL OR p_idle_timeout_ms <= 0 THEN
    RAISE EXCEPTION 'invalid_tenant_timeout' USING ERRCODE = '22023';
  END IF;
  -- IS NOT TRUE: a null flag or a null minimum must raise, not pass as "unknown"
  IF (p_require_legal IS NOT NULL
      AND p_min_terms BETWEEN 1 AND 1000
      AND p_min_privacy BETWEEN 1 AND 1000) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid_legal_acceptance_check' USING ERRCODE = '22023';
  END IF;
  IF p_user IS NULL OR p_organization IS NULL OR p_user = '' OR p_organization = '' THEN
    RAISE EXCEPTION 'tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('statement_timeout', p_statement_timeout_ms::text, true),
          pg_catalog.set_config('lock_timeout', p_lock_timeout_ms::text, true),
          pg_catalog.set_config('idle_in_transaction_session_timeout', p_idle_timeout_ms::text, true),
          pg_catalog.set_config('app.user_id', p_user, true);
  -- the acceptance before everything else, as the check of the authentication did: a person with a pending document is
  -- told so even where the membership or the capability would refuse
  IF p_require_legal THEN
    SELECT pg_catalog.array_agg(pending.document) INTO v_pending
      FROM public.legal_acceptance_pending(p_user, p_min_terms, p_min_privacy) AS pending;
    IF v_pending IS NOT NULL THEN
      RAISE EXCEPTION 'legal_acceptance_required' USING
        ERRCODE = '42501',
        DETAIL = pg_catalog.array_to_string(v_pending, ',');
    END IF;
  END IF;
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
REVOKE ALL ON FUNCTION public.begin_tenant_request(text, text, text[], boolean, integer, integer, integer, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_tenant_request(text, text, text[], boolean, integer, integer, integer, integer, integer) TO polaris_pr11_runtime;
