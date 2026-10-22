-- The last four SECURITY DEFINER functions that still belonged to the database owner (ADR 0093, amended; design t208):
-- the two triggers of the sync log (`record_sync_change`, `assign_sync_change_sequence`), `bump_user_authorization_epoch`
-- (executed by the authentication runtime) and `create_initial_organization` (executed by the onboarding runtime). On Neon
-- the owner has BYPASSRLS, so each of them ran over the row security of every tenant: a wrong WHERE in one would reach all
-- of them. Each moves to a role of its own, never a login, with the columns it reads and writes and with policies that bind
-- it to the user or the organization of the call:
--   - `polaris_sync_owner`: the two triggers (they stay SECURITY DEFINER, so the runtime can neither forge nor renumber a
--     change, as 0045 wants);
--   - `polaris_authorization_epoch_owner`: the bump, across the organizations of one user and only of that user;
--   - `polaris_onboarding_owner`: the first organization and its owner membership.
-- The scope is a setting of the transaction under `app.owner_scope.*`, written by the function itself from its arguments
-- (or from the row of the trigger) right after the checks and before any read; the policies of each owner compare with it,
-- name the owner and no other role (`TO <owner>`), and read no setting of the runtime. A runtime that sets the same name
-- gains nothing: no policy of a runtime reads `app.owner_scope.*`, and the function overwrites it before it reads. Without
-- the setting every policy here is false: a body that forgets it, in a transaction where no call set it before, fails closed
-- (no row, or 42501). After an earlier call in the same transaction it would act in the scope of that call, never wider.
-- Expand only (ADR 0096): three new roles, grants, policies for the new roles only, the same four functions with the same
-- signatures and results (one more line each), and the change of owner. The previous Worker calls the same functions and
-- gets the same answers; no policy of a runtime changes. Everything commits together: a call sees the old catalog (owner
-- with bypass) or the new one (owner without bypass, policies in place).
-- Each CREATE POLICY takes an ACCESS EXCLUSIVE lock on a busy table: better to fail and deploy again than to queue requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_sync_owner') THEN
    EXECUTE 'CREATE ROLE polaris_sync_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it numbers the sync log and is never a login
  -- no NOSUPERUSER here: PostgreSQL refuses it to a role that is not a superuser itself (Neon), and a role made by one never is;
  -- the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_sync_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_sync_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_sync_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_authorization_epoch_owner') THEN
    EXECUTE 'CREATE ROLE polaris_authorization_epoch_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it bumps the epoch of one user and is never a login
  -- no NOSUPERUSER here (see above); the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_authorization_epoch_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_authorization_epoch_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_authorization_epoch_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_onboarding_owner') THEN
    EXECUTE 'CREATE ROLE polaris_onboarding_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it creates the first organization of one user and is never a login
  -- no NOSUPERUSER here (see above); the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_onboarding_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_onboarding_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_onboarding_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_sync_owner, polaris_authorization_epoch_owner, polaris_onboarding_owner;--> statement-breakpoint
-- The sync log: the trigger of a domain table writes one change of the organization of its row; the deferred trigger
-- counts and numbers the changes of one organization still without a number and moves its counter. Never the entity of a
-- change (only its key, organization and number), never a DELETE.
GRANT SELECT (id, organization_id, seq), INSERT (organization_id, entity_type, entity_id), UPDATE (seq) ON TABLE public.sync_changes TO polaris_sync_owner;--> statement-breakpoint
GRANT SELECT (organization_id, last_seq), INSERT (organization_id, last_seq), UPDATE (last_seq) ON TABLE public.sync_cursors TO polaris_sync_owner;--> statement-breakpoint
CREATE POLICY sync_changes_sync_owner_select ON public.sync_changes
  AS PERMISSIVE FOR SELECT TO polaris_sync_owner
  USING (organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY sync_changes_sync_owner_insert ON public.sync_changes
  AS PERMISSIVE FOR INSERT TO polaris_sync_owner
  WITH CHECK (seq IS NULL
    AND organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY sync_changes_sync_owner_update ON public.sync_changes
  AS PERMISSIVE FOR UPDATE TO polaris_sync_owner
  USING (seq IS NULL
    AND organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''))
  WITH CHECK (seq IS NOT NULL
    AND organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY sync_cursors_sync_owner_select ON public.sync_cursors
  AS PERMISSIVE FOR SELECT TO polaris_sync_owner
  USING (organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY sync_cursors_sync_owner_insert ON public.sync_cursors
  AS PERMISSIVE FOR INSERT TO polaris_sync_owner
  WITH CHECK (organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY sync_cursors_sync_owner_update ON public.sync_cursors
  AS PERMISSIVE FOR UPDATE TO polaris_sync_owner
  USING (organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''))
  WITH CHECK (organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.sync_organization_id', true), ''));--> statement-breakpoint
-- The bump: every membership of the user (the epoch and its time), the live offline grants of the user (revoked for a
-- security event) and one audit row per grant revoked, of that grant, its organization and the user.
GRANT SELECT (user_id, authorization_epoch), UPDATE (authorization_epoch, updated_at) ON TABLE public.memberships TO polaris_authorization_epoch_owner;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id, revoked_at), UPDATE (revoked_at, revoked_reason) ON TABLE public.offline_grants TO polaris_authorization_epoch_owner;--> statement-breakpoint
GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, event_type) ON TABLE public.tenant_audit_event TO polaris_authorization_epoch_owner;--> statement-breakpoint
CREATE POLICY memberships_authorization_epoch_owner_select ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_authorization_epoch_owner
  USING (user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''));--> statement-breakpoint
CREATE POLICY memberships_authorization_epoch_owner_update ON public.memberships
  AS PERMISSIVE FOR UPDATE TO polaris_authorization_epoch_owner
  USING (user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''))
  WITH CHECK (user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''));--> statement-breakpoint
CREATE POLICY offline_grants_authorization_epoch_owner_select ON public.offline_grants
  AS PERMISSIVE FOR SELECT TO polaris_authorization_epoch_owner
  USING (user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''));--> statement-breakpoint
CREATE POLICY offline_grants_authorization_epoch_owner_update ON public.offline_grants
  AS PERMISSIVE FOR UPDATE TO polaris_authorization_epoch_owner
  USING (revoked_at IS NULL
    AND user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''))
  WITH CHECK (revoked_at IS NOT NULL AND revoked_reason = 'security_event'
    AND user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), ''));--> statement-breakpoint
CREATE POLICY tenant_audit_event_authorization_epoch_owner_insert ON public.tenant_audit_event
  AS PERMISSIVE FOR INSERT TO polaris_authorization_epoch_owner
  WITH CHECK (event_type = 'offline_grant.revoked' AND entity_type = 'offline_grant'
    AND actor_user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public.offline_grants AS grant_scope
       WHERE grant_scope.id::text = tenant_audit_event.entity_id
         AND grant_scope.organization_id = tenant_audit_event.organization_id
         AND grant_scope.user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.authorization_epoch_user_id', true), '')
    ));--> statement-breakpoint
-- The first organization: the user (whether it exists and is verified; UPDATE of `updated_at` only for the row lock of
-- FOR SHARE, the precedent of 0093, never written), the memberships and organizations of the user (the ceiling and the
-- organization already open), the new organization, its owner membership and its audit row. The membership is only of the
-- organization of the call, created in this transaction (its `created_at` is the default, `now()`, the start of the
-- transaction); `"user"` has no row security and no trigger.
GRANT SELECT (id, email_verified), UPDATE (updated_at) ON TABLE public."user" TO polaris_onboarding_owner;--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status), INSERT (organization_id, user_id) ON TABLE public.memberships TO polaris_onboarding_owner;--> statement-breakpoint
GRANT SELECT (id, name, timezone, currency, status, created_at, updated_at), INSERT (id, name, timezone) ON TABLE public.organizations TO polaris_onboarding_owner;--> statement-breakpoint
GRANT INSERT (organization_id, actor_user_id, event_type, entity_type, entity_id, request_id) ON TABLE public.tenant_audit_event TO polaris_onboarding_owner;--> statement-breakpoint
CREATE POLICY memberships_onboarding_owner_select ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_onboarding_owner
  USING (user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), ''));--> statement-breakpoint
CREATE POLICY memberships_onboarding_owner_insert ON public.memberships
  AS PERMISSIVE FOR INSERT TO polaris_onboarding_owner
  WITH CHECK (role = 'owner' AND status = 'active'
    AND user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), '')
    AND organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public.organizations AS created_scope
       WHERE created_scope.id = memberships.organization_id
         AND created_scope.created_at = pg_catalog.now()
    ));--> statement-breakpoint
CREATE POLICY organizations_onboarding_owner_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_onboarding_owner
  USING (id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_organization_id', true), '')
    OR EXISTS (
      SELECT 1 FROM public.memberships AS member_scope
       WHERE member_scope.organization_id = organizations.id
         AND member_scope.user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), '')
    ));--> statement-breakpoint
CREATE POLICY organizations_onboarding_owner_insert ON public.organizations
  AS PERMISSIVE FOR INSERT TO polaris_onboarding_owner
  WITH CHECK (status = 'active'
    AND id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_organization_id', true), ''));--> statement-breakpoint
CREATE POLICY tenant_audit_event_onboarding_owner_insert ON public.tenant_audit_event
  AS PERMISSIVE FOR INSERT TO polaris_onboarding_owner
  WITH CHECK (event_type = 'organization.created' AND entity_type = 'organization' AND entity_id = organization_id
    AND organization_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_organization_id', true), '')
    AND actor_user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), ''));--> statement-breakpoint
-- The four bodies of today (0045, 0043 and 0085, with the search_path of 0077), plus the line that writes the scope.
-- Written by the domain tables' triggers, in the writer's transaction.
CREATE OR REPLACE FUNCTION public.record_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_organization_id text := v_row ->> 'organization_id';
  v_entity_id text := v_row ->> TG_ARGV[1];
BEGIN
  IF v_organization_id IS NULL OR v_entity_id IS NULL THEN
    RAISE EXCEPTION 'sync change without organization or entity (%.%)', TG_TABLE_NAME, TG_ARGV[1]
      USING ERRCODE = 'P0001';
  END IF;
  -- the owner's policies see only this organization
  PERFORM pg_catalog.set_config('app.owner_scope.sync_organization_id', v_organization_id, true);
  INSERT INTO public.sync_changes (organization_id, entity_type, entity_id)
  VALUES (v_organization_id, TG_ARGV[0], v_entity_id::uuid);
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- Numbers the transaction's pending changes at COMMIT. The per-organization
-- counter row is locked until the commit completes, so sequence order is commit
-- order: a reader at sequence N has already seen every change numbered below it.
CREATE OR REPLACE FUNCTION public.assign_sync_change_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_pending integer;
  v_last bigint;
BEGIN
  -- the owner's policies see only the organization of this change: a wrong count or number cannot reach another one
  PERFORM pg_catalog.set_config('app.owner_scope.sync_organization_id', NEW.organization_id, true);
  -- Only this transaction's own rows are still unnumbered and visible.
  SELECT count(*)::integer INTO v_pending
    FROM public.sync_changes
   WHERE organization_id = NEW.organization_id AND seq IS NULL;
  IF v_pending = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.sync_cursors (organization_id, last_seq)
  VALUES (NEW.organization_id, v_pending)
  ON CONFLICT (organization_id)
  DO UPDATE SET last_seq = public.sync_cursors.last_seq + v_pending
  RETURNING last_seq INTO v_last;

  UPDATE public.sync_changes AS change
     SET seq = v_last - v_pending + numbered.position
    FROM (
      SELECT id, row_number() OVER (ORDER BY id) AS position
        FROM public.sync_changes
       WHERE organization_id = NEW.organization_id AND seq IS NULL
    ) AS numbered
   WHERE change.id = numbered.id;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.bump_user_authorization_epoch(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_revoked integer;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_user_id <> btrim(p_user_id) THEN
    RAISE EXCEPTION 'invalid user id for an authorization epoch bump'
      USING ERRCODE = 'P0001';
  END IF;
  -- the owner's policies see only this user's rows
  PERFORM pg_catalog.set_config('app.owner_scope.authorization_epoch_user_id', p_user_id, true);

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
$function$;--> statement-breakpoint
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

  -- the owner's policies see only this user and this organization
  PERFORM pg_catalog.set_config('app.owner_scope.onboarding_user_id', p_user_id, true);
  PERFORM pg_catalog.set_config('app.owner_scope.onboarding_organization_id', p_organization_id, true);

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
$function$;--> statement-breakpoint
-- The change of owner, the way every other owner got its functions: CREATE on public and SET on the role only for the
-- moment of the ALTER, given back at once. The EXECUTE of the runtimes follows the function (the grantor becomes the new
-- owner). The migrator loses the implicit EXECUTE of an owner, and a future `CREATE TRIGGER … EXECUTE FUNCTION` of either
-- trigger function needs it (42501 on Neon otherwise), so the new owner gives it back to the session user, the migrator.
GRANT CREATE ON SCHEMA public TO polaris_sync_owner, polaris_authorization_epoch_owner, polaris_onboarding_owner;--> statement-breakpoint
GRANT polaris_sync_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT polaris_authorization_epoch_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT polaris_onboarding_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.record_sync_change() OWNER TO polaris_sync_owner;--> statement-breakpoint
ALTER FUNCTION public.assign_sync_change_sequence() OWNER TO polaris_sync_owner;--> statement-breakpoint
ALTER FUNCTION public.bump_user_authorization_epoch(text) OWNER TO polaris_authorization_epoch_owner;--> statement-breakpoint
ALTER FUNCTION public.create_initial_organization(text, text, text, text, uuid) OWNER TO polaris_onboarding_owner;--> statement-breakpoint
SET ROLE polaris_sync_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_sync_change(), public.assign_sync_change_sequence() TO SESSION_USER;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_sync_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE polaris_authorization_epoch_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE polaris_onboarding_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_sync_owner, polaris_authorization_epoch_owner, polaris_onboarding_owner;--> statement-breakpoint
-- The end state, as 0077 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): every
-- SECURITY DEFINER function of the application belongs to a `polaris_*_owner` role (the scope of `foreignOwner` in
-- definer-hardening-checks.ts: every schema but pg_catalog, information_schema and pg_toast*, and no function of an
-- extension), the four have the owner above, none of the three new owners keeps CREATE on public, and the migrator keeps no
-- SET or INHERIT on them.
DO $end_state$
DECLARE
  v_foreign text;
BEGIN
  SELECT pg_catalog.string_agg(n.nspname || '.' || p.proname || ' (' || pg_catalog.pg_get_userbyid(p.proowner) || ')', ', ' ORDER BY n.nspname, p.proname)
    INTO v_foreign
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend AS d
        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
     )
     AND pg_catalog.pg_get_userbyid(p.proowner) NOT LIKE 'polaris\_%\_owner';
  IF v_foreign IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions that do not belong to a polaris_*_owner role: %', v_foreign;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE (p.oid = 'public.record_sync_change()'::regprocedure AND p.proowner = 'polaris_sync_owner'::regrole)
          OR (p.oid = 'public.assign_sync_change_sequence()'::regprocedure AND p.proowner = 'polaris_sync_owner'::regrole)
          OR (p.oid = 'public.bump_user_authorization_epoch(text)'::regprocedure AND p.proowner = 'polaris_authorization_epoch_owner'::regrole)
          OR (p.oid = 'public.create_initial_organization(text, text, text, text, uuid)'::regprocedure AND p.proowner = 'polaris_onboarding_owner'::regrole)) <> 4 THEN
    RAISE EXCEPTION 'the four functions do not have their new owners';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_sync_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_authorization_epoch_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_onboarding_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'a new owner role kept CREATE on schema public';
  END IF;
  -- the SET the migrator took for the ALTER is given back (a REVOKE that does not match is only a WARNING on Neon)
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid IN ('polaris_sync_owner'::regrole, 'polaris_authorization_epoch_owner'::regrole, 'polaris_onboarding_owner'::regrole)
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on a new owner role';
  END IF;
END
$end_state$;
