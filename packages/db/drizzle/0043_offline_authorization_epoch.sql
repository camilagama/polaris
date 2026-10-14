ALTER TABLE "memberships" ADD COLUMN "authorization_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_authorization_epoch_non_negative" CHECK ("memberships"."authorization_epoch" >= 0);
--> statement-breakpoint
-- A security event for a user (a password reset) invalidates every offline
-- lease the user holds: the epoch of each membership is bumped and every live
-- offline grant is revoked with reason security_event, one audit event per
-- grant in its own organization. The auth runtime has no access to the tenant
-- tables, so this is the one narrow SECURITY DEFINER entry point it gets.
CREATE FUNCTION public.bump_user_authorization_epoch(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_revoked integer;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_user_id <> btrim(p_user_id) THEN
    RAISE EXCEPTION 'invalid user id for an authorization epoch bump'
      USING ERRCODE = 'P0001';
  END IF;

  -- Serializes with lease issuance (same key in offline-lease-repository.ts): a
  -- lease is either issued before the bump and revoked by it, or after and
  -- carries the new epoch.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('authorization-epoch:' || p_user_id, 0)
  );

  UPDATE public.memberships
     SET authorization_epoch = authorization_epoch + 1,
         updated_at = now()
   WHERE user_id = p_user_id;

  WITH revoked AS (
    UPDATE public.offline_grants
       SET revoked_at = now(), revoked_reason = 'security_event'
     WHERE user_id = p_user_id AND revoked_at IS NULL
    RETURNING id, organization_id
  ), audited AS (
    INSERT INTO public.tenant_audit_event
      (organization_id, actor_user_id, entity_type, entity_id, event_type)
    SELECT organization_id, p_user_id, 'offline_grant', id::text, 'offline_grant.revoked'
      FROM revoked
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_revoked FROM revoked;

  RETURN v_revoked;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bump_user_authorization_epoch(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bump_user_authorization_epoch(text) TO polaris_auth_runtime;
