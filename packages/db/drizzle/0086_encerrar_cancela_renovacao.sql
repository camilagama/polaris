-- Closing the organization cancels the renewal of its subscription (L4, ADR 0074 amended, ADR 0101). The closure
-- writes `billing.renewal_cancel_requested` to the outbox in its own transaction, so the request is as durable as
-- the closure; the queue consumer (critical queue) cancels at the provider and writes `subscription_cancelled`
-- through the billing inbox. A failure of the provider never undoes the closure: the queue retries, then the
-- dead-letter queue makes it an incident, and the hourly billing run sends the event again for as long as the
-- state says the renewal is still alive (a retry by state, never by a new key: V6). Additive: policies, column
-- grants, one function replaced with the same signature and one new function.
--
-- The event names the closure cycle by the instant of its request, in milliseconds (`{requestedAt}`): one key per
-- cycle (`billing.renewal_cancel_requested:<requestedAt>`, unique with the organization), so a closure undone and
-- requested again has an event of its own, and the retry of one cycle rearms that cycle's row.
--
-- What the privacy owner (owner of the closure functions) needs besides what it had: whether the organization's
-- renewal is alive (five columns of its billing record), and the outbox rows of this type (insert, read, rearm).
GRANT SELECT (organization_id, state, provider, provider_ref, cancel_at_period_end) ON TABLE public.organization_billing TO polaris_privacy_owner;--> statement-breakpoint
CREATE POLICY organization_billing_privacy_owner_select ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner USING (true);--> statement-breakpoint
GRANT SELECT (idempotency_key, attempts, locked_until) ON TABLE public.event_outbox TO polaris_privacy_owner;--> statement-breakpoint
-- only this type, only pending and untouched, the key of the cycle the body names, and only for an organization in
-- closure whose closure record has that very request instant: the body carries nothing but the cycle
CREATE POLICY event_outbox_privacy_owner_insert_renewal_cancel ON public.event_outbox
  AS PERMISSIVE FOR INSERT TO polaris_privacy_owner
  WITH CHECK (type = 'billing.renewal_cancel_requested' AND status = 'pending' AND attempts = 0
    AND (event - 'requestedAt') = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(event -> 'requestedAt') = 'number'
    AND idempotency_key = type || ':' || (event ->> 'requestedAt')
    AND EXISTS (SELECT 1 FROM public.organization_closures AS closure_scope
                 JOIN public.organizations AS organization_scope ON organization_scope.id = closure_scope.organization_id
                 WHERE closure_scope.organization_id = event_outbox.organization_id
                   AND organization_scope.status IN ('closing', 'closed', 'purge_pending')
                   AND (pg_catalog.floor(EXTRACT(epoch FROM closure_scope.requested_at) * 1000))::bigint::text
                       = event_outbox.event ->> 'requestedAt'));--> statement-breakpoint
CREATE POLICY event_outbox_privacy_owner_select_renewal_cancel ON public.event_outbox
  AS PERMISSIVE FOR SELECT TO polaris_privacy_owner
  USING (type = 'billing.renewal_cancel_requested');--> statement-breakpoint
CREATE POLICY event_outbox_privacy_owner_rearm_renewal_cancel ON public.event_outbox
  AS PERMISSIVE FOR UPDATE TO polaris_privacy_owner
  USING (type = 'billing.renewal_cancel_requested' AND status = 'dispatched')
  WITH CHECK (type = 'billing.renewal_cancel_requested' AND status = 'pending');--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- The closure as before (0065, search_path of 0077), plus the request to cancel the renewal, in the same
-- transaction: every closure writes it, with or without a provider; the consumer reads the billing record and does
-- nothing when there is no renewal alive. The request instant is the closure record's own, so the key names the cycle.
CREATE OR REPLACE FUNCTION public.request_organization_closure(p_window_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  actor text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  target text := NULLIF(pg_catalog.current_setting('app.organization_id', true), '');
  revoked_count integer;
  requested timestamptz := pg_catalog.now();
  requested_ms bigint;
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
  deadline := requested + p_window_days * interval '24 hours';
  INSERT INTO public.organization_closures
    (organization_id, requested_by_user_id, requested_at, recover_until, closed_at, recovered_at)
  VALUES (target, actor, requested, deadline, NULL, NULL)
  ON CONFLICT (organization_id) DO UPDATE
    SET requested_by_user_id = EXCLUDED.requested_by_user_id,
        requested_at = EXCLUDED.requested_at,
        recover_until = EXCLUDED.recover_until,
        closed_at = NULL,
        recovered_at = NULL;
  INSERT INTO public.tenant_audit_event
    (organization_id, actor_user_id, entity_type, entity_id, event_type)
  VALUES (target, actor, 'organization', target, 'organization.closure_requested');
  requested_ms := (pg_catalog.floor(EXTRACT(epoch FROM requested) * 1000))::bigint;
  INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
  VALUES (
    target, 'billing.renewal_cancel_requested', pg_catalog.jsonb_build_object('requestedAt', requested_ms),
    'billing.renewal_cancel_requested:' || requested_ms::text, pg_catalog.gen_random_uuid()::text
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
  RETURN pg_catalog.jsonb_build_object('recoverUntil', deadline, 'revokedLeases', revoked_count);
END;
$function$;--> statement-breakpoint
-- The retry by state (V6), for the hourly billing run: every organization in closure (not undone) whose renewal is
-- still alive (a provider linked, a state that gives Pro, no cancellation at the end of the period) gets its cycle's
-- event written when it has none (closed before this migration, or a checkout paid after the closure), or sent back
-- to pending when it was dispatched at least `p_min_age_seconds` ago and the state still says the renewal is alive
-- (the queue gave up, or the provider found nothing yet). A pending event is left to the dispatcher. It reads no
-- name and no provider answer; it moves only the outbox rows of this type.
CREATE FUNCTION public.rearm_renewal_cancellations(p_min_age_seconds integer, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  inserted integer;
  rearmed integer;
BEGIN
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 900 OR p_min_age_seconds > 86400
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  WITH owed AS (
    SELECT organization.id AS organization_id,
           (pg_catalog.floor(EXTRACT(epoch FROM closure.requested_at) * 1000))::bigint AS requested_ms
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
      JOIN public.organization_billing AS billing ON billing.organization_id = organization.id
     WHERE organization.status IN ('closing', 'closed', 'purge_pending')
       AND closure.recovered_at IS NULL
       AND billing.provider IS NOT NULL AND billing.provider_ref IS NOT NULL
       AND billing.state IN ('trialing', 'active', 'grace')
       AND NOT billing.cancel_at_period_end
  ), missing AS (
    SELECT owed.organization_id, owed.requested_ms
      FROM owed
     WHERE NOT EXISTS (
       SELECT 1 FROM public.event_outbox AS outbox_row
        WHERE outbox_row.organization_id = owed.organization_id
          AND outbox_row.type = 'billing.renewal_cancel_requested'
          AND outbox_row.idempotency_key = 'billing.renewal_cancel_requested:' || owed.requested_ms::text
     )
     ORDER BY owed.requested_ms, owed.organization_id
     LIMIT p_limit
  )
  INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
  SELECT missing.organization_id, 'billing.renewal_cancel_requested',
         pg_catalog.jsonb_build_object('requestedAt', missing.requested_ms),
         'billing.renewal_cancel_requested:' || missing.requested_ms::text, pg_catalog.gen_random_uuid()::text
    FROM missing
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  WITH due AS (
    SELECT outbox_row.id
      FROM public.event_outbox AS outbox_row
      JOIN public.organizations AS organization ON organization.id = outbox_row.organization_id
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
      JOIN public.organization_billing AS billing ON billing.organization_id = organization.id
     WHERE outbox_row.type = 'billing.renewal_cancel_requested'
       AND outbox_row.status = 'dispatched'
       AND outbox_row.dispatched_at <= pg_catalog.now() - p_min_age_seconds * interval '1 second'
       AND outbox_row.idempotency_key = 'billing.renewal_cancel_requested:'
           || (pg_catalog.floor(EXTRACT(epoch FROM closure.requested_at) * 1000))::bigint::text
       AND organization.status IN ('closing', 'closed', 'purge_pending')
       AND closure.recovered_at IS NULL
       AND billing.provider IS NOT NULL AND billing.provider_ref IS NOT NULL
       AND billing.state IN ('trialing', 'active', 'grace')
       AND NOT billing.cancel_at_period_end
     ORDER BY outbox_row.dispatched_at, outbox_row.id
     LIMIT p_limit
       FOR UPDATE OF outbox_row SKIP LOCKED
  )
  UPDATE public.event_outbox AS target
     SET status = 'pending', available_at = pg_catalog.now()
    FROM due
   WHERE target.id = due.id;
  GET DIAGNOSTICS rearmed = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('inserted', inserted, 'rearmed', rearmed);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rearm_renewal_cancellations(integer, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.rearm_renewal_cancellations(integer, integer) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;
