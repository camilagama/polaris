-- The e-mail of the closure notices and the act of the support (ADR 0102 amended; design t107 §5, line E of its table of
-- pull requests, with the conditions of the security review of 20/10/2026). Three things the e-mail needs from the
-- database, and nothing more:
--
-- 1. The address, read by a function of the authentication role only (`closure_notice_recipient`, executed by
--    `polaris_auth_runtime`, owned by the new `polaris_notice_recipient_owner`): it answers the e-mail of the user a
--    notice still owed is for, joined with `closure_notices`, and only whether it is verified (an address not verified
--    is noted on the notice, `unverified_at`, the fact a dismissal for that reason needs); never a free read of the
--    table of users, and never the name. The privacy role, which claims the notice, still reads no account.
-- 2. The act of the support (`admin_reissue_closure_notice` and `admin_dismiss_closure_notice`), under a privacy case and
--    with the platform audit, never an UPDATE by hand: a new `d7` notice of the same cycle (`reissue` 1, 2...), sent to
--    the owner, or dismissed by the decision of the person responsible (no user: the account may be gone, and nobody is
--    told). A dismissed notice counts as delivered for the purge (`COALESCE(sent_at, dismissed_at)`, still at least 7
--    days before the run), so a store whose `d7` was skipped, failed or lost with the owner's account is not held back
--    forever. The rows of the support go through `closure_notice_support_reissue`, of the privacy owner (who already
--    writes the notices and their outbox events), executed only by the Admin owner.
-- 3. The handover of the notices left unresolved while the e-mail was off (`list_owed_closure_notices`): of the notices
--    of the current cycle still owed, the latest is handed to the privacy job to send, and the earlier ones are settled
--    `skipped`, so the owner never gets the old ones in a row. One owed to a user who left is not taken, and the ones
--    found not verified go to the end of the batch, so they never keep a notice that can go out from it.
--
-- Expand only (ADR 0096): three new columns (`reissue` with a default, `dismissed_at` and `unverified_at`), `user_id` nullable (a dismissed notice has none), the unique key
-- of the cycle recreated with the reissue (same name, so `ON CONFLICT ON CONSTRAINT` still finds it), a new check, two
-- new types of the platform audit, a new owner role and new functions; recreated with the same signature, owner and
-- grants: `organization_purge_blocker` and `closed_organization_purge_wait` (the gate `purge-functions` compares them
-- with the domain), `record_closure_notices`, `claim_closure_notice_delivery` (two more keys in its answer) and the two
-- marks. The previous Worker writes no reissue and dismisses nothing; its consumer reads keys it knows only.
ALTER TABLE "closure_notices" DROP CONSTRAINT "closure_notices_cycle_milestone_unique";--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "closure_notices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD COLUMN "reissue" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD COLUMN "unverified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD CONSTRAINT "closure_notices_cycle_milestone_unique" UNIQUE NULLS NOT DISTINCT("organization_id","closure_requested_at","milestone","purge_from","reissue");--> statement-breakpoint
ALTER TABLE "closure_notices" ADD CONSTRAINT "closure_notices_dismissal_coherent" CHECK (("closure_notices"."dismissed_at" IS NULL OR ("closure_notices"."sent_at" IS NULL AND "closure_notices"."failed_at" IS NULL AND NOT "closure_notices"."skipped"))
        AND (("closure_notices"."user_id" IS NULL) = ("closure_notices"."dismissed_at" IS NOT NULL))
        AND ("closure_notices"."reissue" = 0 OR "closure_notices"."milestone" = 'd7')
        AND ("closure_notices"."dismissed_at" IS NULL OR "closure_notices"."reissue" > 0)
        AND "closure_notices"."reissue" >= 0);--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released', 'organization.legal_hold_reviewed', 'access_log.read', 'closure_notice.reissued', 'closure_notice.dismissed'));--> statement-breakpoint
-- what the privacy owner writes besides what it wrote: the reissue and the dismissal of the support (new rows only), and
-- `skipped` on a notice still owed that a later one of the same cycle replaces (the handover and the dismissal)
GRANT INSERT (reissue, dismissed_at) ON TABLE public.closure_notices TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (skipped) ON TABLE public.closure_notices TO polaris_privacy_owner;--> statement-breakpoint
-- the event of a notice goes out only for one still owed that names a user: never for a dismissed one
ALTER POLICY event_outbox_privacy_owner_insert_closure_notice ON public.event_outbox
  WITH CHECK (type = 'organization.closure_notice' AND status = 'pending' AND attempts = 0
    AND (event - 'noticeId') = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(event -> 'noticeId') = 'string'
    AND idempotency_key = type || ':' || (event ->> 'noticeId')
    AND EXISTS (SELECT 1 FROM public.closure_notices AS notice_scope
                 JOIN public.organizations AS organization_scope ON organization_scope.id = notice_scope.organization_id
                 WHERE notice_scope.id::text = event_outbox.event ->> 'noticeId'
                   AND notice_scope.organization_id = event_outbox.organization_id
                   AND NOT notice_scope.skipped AND notice_scope.sent_at IS NULL AND notice_scope.failed_at IS NULL
                   AND notice_scope.dismissed_at IS NULL AND notice_scope.user_id IS NOT NULL
                   AND organization_scope.status IN ('closing', 'closed', 'purge_pending')));--> statement-breakpoint
-- the purge owner reads the dismissed notices too, in one column more: a dismissal under a privacy case counts as delivered
GRANT SELECT (dismissed_at) ON TABLE public.closure_notices TO polaris_purge_owner;--> statement-breakpoint
ALTER POLICY closure_notices_purge_owner_select_delivered ON public.closure_notices
  USING (milestone IN ('d7', 'rescheduled') AND (sent_at IS NOT NULL OR dismissed_at IS NOT NULL)
         AND EXISTS (SELECT 1 FROM public.organizations AS purge_scope
                      WHERE purge_scope.id = closure_notices.organization_id AND purge_scope.status IN ('closed', 'purge_pending')));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
-- As in 0088, with one change: a `d7` notice dismissed by the support (`dismissed_at`) counts as delivered, and the 7 days
-- run from the latest delivery or dismissal.
CREATE OR REPLACE FUNCTION public.organization_purge_blocker(p_organization text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
  ) THEN
    RETURN 'legal_hold_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deletion_ledger AS tombstone
     WHERE tombstone.organization_id = p_organization AND tombstone.entity_type = 'organization'
       AND tombstone.entity_id = p_organization AND tombstone.operation = 'purge'
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_closures AS closure
     WHERE closure.organization_id = p_organization AND closure.closed_at IS NOT NULL
       AND closure.recover_until <= pg_catalog.now()
       AND closure.requested_at + interval '90 days' <= pg_catalog.now()
  ) THEN
    RETURN 'closure_period_not_elapsed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_access_grants AS access_grant
     WHERE access_grant.organization_id = p_organization AND access_grant.revoked_at IS NULL
       AND access_grant.expires_at > pg_catalog.now()
  ) THEN
    RETURN 'tenant_access_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = p_organization
       AND billing.provider IS NOT NULL AND billing.provider_ref IS NOT NULL
       AND billing.state IN ('trialing', 'active', 'grace')
       AND NOT billing.cancel_at_period_end
  ) THEN
    RETURN 'renewal_alive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.closure_notices AS notice
      JOIN public.organization_closures AS closure
        ON closure.organization_id = notice.organization_id AND closure.requested_at = notice.closure_requested_at
     WHERE notice.organization_id = p_organization
       AND notice.milestone IN ('d7', 'rescheduled') AND COALESCE(notice.sent_at, notice.dismissed_at) IS NOT NULL
    HAVING pg_catalog.max(COALESCE(notice.sent_at, notice.dismissed_at)) <= pg_catalog.now() - interval '168 hours'
  ) THEN
    RETURN 'closure_notice_not_delivered';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- As in 0088, with the same change as the blocker above: a dismissed `d7` counts as delivered.
CREATE OR REPLACE FUNCTION public.closed_organization_purge_wait(p_organization text, p_requested_at timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
  ) THEN
    RETURN 'legal_hold_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_access_grants AS access_grant
     WHERE access_grant.organization_id = p_organization AND access_grant.revoked_at IS NULL
       AND access_grant.expires_at > pg_catalog.now()
  ) THEN
    RETURN 'tenant_access_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_purge_cancellations AS cancellation
     WHERE cancellation.organization_id = p_organization AND cancellation.cancelled_at >= p_requested_at
  ) THEN
    RETURN 'purge_cancelled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = p_organization
       AND billing.provider IS NOT NULL AND billing.provider_ref IS NOT NULL
       AND billing.state IN ('trialing', 'active', 'grace')
       AND NOT billing.cancel_at_period_end
  ) THEN
    RETURN 'renewal_alive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.closure_notices AS notice
     WHERE notice.organization_id = p_organization AND notice.closure_requested_at = p_requested_at
       AND notice.milestone IN ('d7', 'rescheduled') AND COALESCE(notice.sent_at, notice.dismissed_at) IS NOT NULL
    HAVING pg_catalog.max(COALESCE(notice.sent_at, notice.dismissed_at)) <= pg_catalog.now() - interval '168 hours'
  ) THEN
    RETURN 'closure_notice_not_delivered';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;--> statement-breakpoint
-- The owner of the one function that reads an address for a closure notice: three columns of the users and the notices
-- still owed, nothing else.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_notice_recipient_owner') THEN
    EXECUTE 'CREATE ROLE polaris_notice_recipient_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one is never a login
  EXECUTE 'ALTER ROLE polaris_notice_recipient_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT SELECT (id, email, email_verified) ON TABLE public."user" TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id, skipped, sent_at, failed_at, dismissed_at, unverified_at) ON TABLE public.closure_notices TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status) ON TABLE public.memberships TO polaris_notice_recipient_owner;--> statement-breakpoint
-- whether the user is still an owner of the organization: only the owners, in four columns
CREATE POLICY memberships_recipient_owner_select_owner ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_notice_recipient_owner
  USING (role = 'owner' AND status = 'active');--> statement-breakpoint
CREATE POLICY closure_notices_recipient_owner_select_owed ON public.closure_notices
  AS PERMISSIVE FOR SELECT TO polaris_notice_recipient_owner
  USING (NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND dismissed_at IS NULL AND user_id IS NOT NULL);--> statement-breakpoint
-- the one thing it writes: when it found the address of a notice still owed not verified (the fact the dismissal
-- `email_not_verified` needs), on that notice alone
GRANT UPDATE (unverified_at) ON TABLE public.closure_notices TO polaris_notice_recipient_owner;--> statement-breakpoint
CREATE POLICY closure_notices_recipient_owner_update_owed ON public.closure_notices
  AS PERMISSIVE FOR UPDATE TO polaris_notice_recipient_owner
  USING (NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND dismissed_at IS NULL AND user_id IS NOT NULL)
  WITH CHECK (NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND dismissed_at IS NULL AND user_id IS NOT NULL);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT polaris_notice_recipient_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_notice_recipient_owner;--> statement-breakpoint
-- The address of a closure notice, for the consumer that sends it (condition of the security review of 20/10/2026): only
-- for a notice still owed (neither sent, failed, skipped nor dismissed), by its ID and organization, and only the e-mail of
-- the user it is for, joined with the notice and only while that user is still an owner of the organization (one who
-- left gets nothing, even between the claim and this read): never a free read of the users. A user whose e-mail is not verified gets
-- `{"verified": false}` and no address (the notice is left unresolved, not failed), and the notice keeps the instant
-- (`unverified_at`): the fact, read by the database itself, that the dismissal `email_not_verified` needs; an address
-- found verified later clears it. A notice not owed, null. The name of the user is never read. Volatile, so no cache
-- answers it. Only the authentication runtime executes it.
CREATE FUNCTION public.closure_notice_recipient(p_notice uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  verified boolean;
  address text;
BEGIN
  SELECT account.email_verified, account.email INTO verified, address
    FROM public.closure_notices AS notice
    JOIN public."user" AS account ON account.id = notice.user_id
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.memberships AS membership
        WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
          AND membership.role = 'owner' AND membership.status = 'active'
     );
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF verified THEN
    UPDATE public.closure_notices AS notice SET unverified_at = NULL
     WHERE notice.id = p_notice AND notice.unverified_at IS NOT NULL;
    RETURN pg_catalog.jsonb_build_object('verified', true, 'email', address);
  END IF;
  UPDATE public.closure_notices AS notice SET unverified_at = pg_catalog.now() WHERE notice.id = p_notice;
  RETURN pg_catalog.jsonb_build_object('verified', false);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_notice_recipient(uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_notice_recipient(uuid, text) TO polaris_auth_runtime;--> statement-breakpoint
-- Whether the owner a notice still owed is for has, right now, an e-mail not verified (review of 20/10/2026): the check
-- the dismissal `email_not_verified` makes of the present, not only of the instant a delivery found it so
-- (`unverified_at`), since the owner may have verified it since. Only a boolean, never the address; false for a notice
-- not owed, or for a user who is no longer an owner. Only the owner of the act of the support executes it.
CREATE FUNCTION public.closure_notice_owner_unverified(p_notice uuid, p_organization text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.closure_notices AS notice
      JOIN public."user" AS account ON account.id = notice.user_id
     WHERE notice.id = p_notice AND notice.organization_id = p_organization
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
       AND account.email_verified IS NOT TRUE
       AND EXISTS (
         SELECT 1 FROM public.memberships AS membership
          WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
            AND membership.role = 'owner' AND membership.status = 'active'
       )
  );
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_notice_owner_unverified(uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_notice_owner_unverified(uuid, text) TO polaris_privacy_owner;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_notice_recipient_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_notice_recipient_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- As in 0088, with two changes: a notice dismissed by the support is not owed, so it is not counted as overdue; and each
-- organization is written under the lock of its notices (the act of the support and the handover take it too).
CREATE OR REPLACE FUNCTION public.record_closure_notices(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  candidate record;
  owed record;
  recipient text;
  newest boolean;
  written uuid;
  seen integer := 0;
  recorded integer := 0;
  skipped_count integer := 0;
  overdue integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT organization.id, closure.requested_by_user_id
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
     WHERE organization.status IN ('closing', 'closed', 'purge_pending')
       AND closure.recovered_at IS NULL
       -- an organization with nobody to tell is left out of the batch, so it never holds back the ones after it
       AND EXISTS (
         SELECT 1 FROM public.memberships AS member
          WHERE member.organization_id = organization.id AND member.role = 'owner' AND member.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM public.closure_notice_due(organization.id) AS due
          WHERE NOT EXISTS (
            SELECT 1 FROM public.closure_notices AS notice
             WHERE notice.organization_id = organization.id
               AND notice.closure_requested_at = due.closure_requested_at
               AND notice.milestone = due.milestone
               AND notice.purge_from IS NOT DISTINCT FROM due.purge_from
          )
       )
     ORDER BY closure.requested_at, organization.id
     LIMIT p_limit
  LOOP
    -- the same lock as the act of the support and the handover: a d7 of the support and one of the job never cross
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('closure_notice:' || candidate.id, 0));
    seen := seen + 1;
    recipient := NULL;
    SELECT membership.user_id INTO recipient
      FROM public.memberships AS membership
     WHERE membership.organization_id = candidate.id
       AND membership.role = 'owner' AND membership.status = 'active'
     ORDER BY (membership.user_id = candidate.requested_by_user_id) DESC, membership.created_at, membership.user_id
     LIMIT 1;
    CONTINUE WHEN recipient IS NULL;
    newest := true;
    FOR owed IN
      SELECT due.closure_requested_at, due.milestone, due.due_at, due.purge_from
        FROM public.closure_notice_due(candidate.id) AS due
       WHERE NOT EXISTS (
         SELECT 1 FROM public.closure_notices AS notice
          WHERE notice.organization_id = candidate.id
            AND notice.closure_requested_at = due.closure_requested_at
            AND notice.milestone = due.milestone
            AND notice.purge_from IS NOT DISTINCT FROM due.purge_from
       )
       ORDER BY due.due_at DESC, due.ordinal DESC
    LOOP
      written := NULL;
      INSERT INTO public.closure_notices
        (organization_id, closure_requested_at, milestone, purge_from, due_at, user_id, skipped)
      VALUES (candidate.id, owed.closure_requested_at, owed.milestone, owed.purge_from, owed.due_at, recipient, NOT newest)
      ON CONFLICT ON CONSTRAINT closure_notices_cycle_milestone_unique DO NOTHING
      RETURNING id INTO written;
      IF written IS NOT NULL AND newest THEN
        INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
        VALUES (
          candidate.id, 'organization.closure_notice', pg_catalog.jsonb_build_object('noticeId', written::text),
          'organization.closure_notice:' || written::text, pg_catalog.gen_random_uuid()::text
        );
        recorded := recorded + 1;
      ELSIF written IS NOT NULL THEN
        skipped_count := skipped_count + 1;
      END IF;
      newest := false;
    END LOOP;
  END LOOP;
  -- the notices still owed 3 days after their date (`CLOSURE_NOTICE_OVERDUE_DAYS`) for an organization still in this
  -- closure: neither sent nor failed nor skipped nor dismissed, for example while no e-mail is configured or the address is
  -- not verified. They feed the alert of a
  -- store left behind, so someone sees the owner was not told.
  SELECT pg_catalog.count(*)::integer INTO overdue
    FROM public.closure_notices AS notice
    JOIN public.organizations AS organization ON organization.id = notice.organization_id
    JOIN public.organization_closures AS closure ON closure.organization_id = notice.organization_id
   WHERE NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
     AND notice.due_at + interval '72 hours' <= pg_catalog.now()
     AND organization.status IN ('closing', 'closed', 'purge_pending')
     AND closure.requested_at = notice.closure_requested_at AND closure.recovered_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'organizations', seen, 'recorded', recorded, 'skipped', skipped_count, 'overdue', overdue
  );
END;
$function$;--> statement-breakpoint
-- As in 0088, with three changes: a dismissed notice (no user) is not to go out; the notice goes only to a user who is
-- still an active owner of the organization (one who left gets nothing: the support reissues it to the owner of now);
-- and the answer also carries when the notice was due and its reissue, so the e-mail of a `d7` sent again names the
-- real first day of the deletion (never sooner than 7 days after it).
CREATE OR REPLACE FUNCTION public.claim_closure_notice_delivery(p_notice uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  delivery jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
           'noticeId', notice.id, 'organizationId', notice.organization_id, 'milestone', notice.milestone,
           'userId', notice.user_id, 'organizationName', organization.name, 'timezone', organization.timezone,
           'requestedAt', closure.requested_at, 'recoverUntil', closure.recover_until,
           'deletionDate', deadline.deletion_date, 'deletableFrom', deadline.deletable_from,
           'purgeFrom', notice.purge_from, 'dueAt', notice.due_at, 'reissue', notice.reissue
         )
    INTO delivery
    FROM public.closure_notices AS notice
    JOIN public.organizations AS organization ON organization.id = notice.organization_id
    JOIN public.organization_closures AS closure ON closure.organization_id = notice.organization_id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
     AND notice.dismissed_at IS NULL AND notice.user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.memberships AS membership
        WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
          AND membership.role = 'owner' AND membership.status = 'active'
     )
     AND organization.status IN ('closing', 'closed', 'purge_pending')
     AND closure.requested_at = notice.closure_requested_at AND closure.recovered_at IS NULL;
  RETURN delivery;
END;
$function$;--> statement-breakpoint
-- As in 0088, plus: a dismissed notice is never marked sent.
CREATE OR REPLACE FUNCTION public.mark_closure_notice_sent(p_notice uuid, p_organization text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public.closure_notices AS notice
     SET sent_at = pg_catalog.now()
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
     -- a delivered notice lets a store be deleted: only one of the cycle in course, of a store still in closure
     AND EXISTS (
       SELECT 1 FROM public.organization_closures AS closure
         JOIN public.organizations AS organization ON organization.id = closure.organization_id
        WHERE closure.organization_id = notice.organization_id AND closure.requested_at = notice.closure_requested_at
          AND closure.recovered_at IS NULL AND organization.status IN ('closing', 'closed', 'purge_pending')
     );
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
-- As in 0088, plus: a dismissed notice is never marked failed.
CREATE OR REPLACE FUNCTION public.mark_closure_notice_failed(p_notice uuid, p_organization text, p_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_failure_code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.closure_notices AS notice
     SET failed_at = pg_catalog.now(), failure_code = p_code
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL;
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
-- The handover of the notices left unresolved (ADR 0102 amended): while the e-mail was off, or a delivery did not settle
-- (the queue gave up on a transient failure, an address not verified yet), a notice stays owed. With the e-mail on, the
-- privacy job asks this every run: for at most `p_limit` organizations still in closure with a notice of the current
-- cycle owed for 15 minutes or more (the consumer had its turn), the latest owed one is answered to be sent, and the
-- earlier owed ones of the cycle are settled `skipped`, so the owner never gets the old ones in a row. A latest one
-- recorded in the last 15 minutes is left to the consumer. One organization at a time, under the same lock as the act
-- of the support. A cycle whose latest owed notice is for a user who is no longer an owner is not taken (it never goes
-- out; the support sends it again), and the cycles go by `unverified_at` (never found not verified first, then the
-- oldest), so the batch takes turns and the notices that cannot go out now never keep the others out of it. Only the
-- privacy runtime executes it.
CREATE FUNCTION public.list_owed_closure_notices(p_limit integer)
RETURNS TABLE (owed_notice uuid, owed_organization text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  candidate record;
  latest uuid;
  latest_recorded timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT organization.id AS organization_id, closure.requested_at
      FROM public.organizations AS organization
      JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
      -- the latest owed notice of the cycle, the one that would go out
      CROSS JOIN LATERAL (
        SELECT notice.user_id, notice.unverified_at
          FROM public.closure_notices AS notice
         WHERE notice.organization_id = organization.id AND notice.closure_requested_at = closure.requested_at
           AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
           AND notice.dismissed_at IS NULL AND notice.user_id IS NOT NULL
         ORDER BY notice.due_at DESC, notice.reissue DESC, notice.recorded_at DESC, notice.id DESC
         LIMIT 1
      ) AS latest_owed
     WHERE organization.status IN ('closing', 'closed', 'purge_pending')
       AND closure.recovered_at IS NULL
       AND EXISTS (
         SELECT 1 FROM public.closure_notices AS notice
          WHERE notice.organization_id = organization.id AND notice.closure_requested_at = closure.requested_at
            AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
            AND notice.dismissed_at IS NULL AND notice.user_id IS NOT NULL
            AND notice.recorded_at <= pg_catalog.now() - interval '15 minutes'
       )
       -- one owed to a user who is no longer an owner never goes out (the support sends it again to the owner of now):
       -- it is not taken, so it never holds a place of the batch
       AND EXISTS (
         SELECT 1 FROM public.memberships AS membership
          WHERE membership.organization_id = organization.id AND membership.user_id = latest_owed.user_id
            AND membership.role = 'owner' AND membership.status = 'active'
       )
     -- the ones never found not verified first, then the ones found so longest ago: each delivery that finds the address
     -- not verified writes `unverified_at` again, so the notices that cannot go out now take turns at the end of the
     -- batch and never keep the others out of it
     ORDER BY latest_owed.unverified_at NULLS FIRST, closure.requested_at, organization.id
     LIMIT p_limit
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('closure_notice:' || candidate.organization_id, 0));
    latest := NULL;
    SELECT notice.id, notice.recorded_at INTO latest, latest_recorded
      FROM public.closure_notices AS notice
     WHERE notice.organization_id = candidate.organization_id
       AND notice.closure_requested_at = candidate.requested_at
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
       AND notice.dismissed_at IS NULL AND notice.user_id IS NOT NULL
     ORDER BY notice.due_at DESC, notice.reissue DESC, notice.recorded_at DESC, notice.id DESC
     LIMIT 1;
    CONTINUE WHEN latest IS NULL;
    UPDATE public.closure_notices AS notice
       SET skipped = true
     WHERE notice.organization_id = candidate.organization_id
       AND notice.closure_requested_at = candidate.requested_at
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
       AND notice.dismissed_at IS NULL AND notice.id <> latest;
    IF latest_recorded <= pg_catalog.now() - interval '15 minutes' THEN
      owed_notice := latest;
      owed_organization := candidate.organization_id;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;--> statement-breakpoint
-- The rows of the act of the support (condition of `CLOSURE_AUTO_PURGE_ENABLED`, ADR 0102 amended): a new `d7` notice of
-- the current cycle, never an UPDATE of the one that was skipped, failed or lost with the account. Only once the `d7` of
-- the cycle is due, for an organization still in closure, and only while no `d7` or `rescheduled` of the cycle was
-- delivered or dismissed (nothing to do then, and a new one would only push the deletion again). Each new row has the
-- next `reissue` of the cycle, under the same lock as the job and the handover.
-- Sent again (`p_dismiss_reason` null): to the owner of now, chosen as the privacy job chooses, with its outbox event. A
-- notice still owed to a user who is no longer an owner is settled `skipped` (it would never go out); one still owed to
-- an owner refuses it (it goes out first, or is dismissed).
-- Dismissed (`p_dismiss_reason` one of the closed list): no user and `dismissed_at` filled, so the purge may go on 7 days
-- later, and the notices still owed of the cycle are settled `skipped`. The reason must fit the facts the database
-- holds: `owner_account_deleted` with no owner left; `email_undeliverable` with a `d7` of the cycle the provider refused
-- (`email_rejected`) for a user who is still an owner, and none still owed to an owner; `email_not_verified` with a `d7`
-- still owed to an owner whose address `closure_notice_recipient` found not verified (`unverified_at`: the e-mail was on
-- and the consumer tried; the address is never read here). Internal to the two functions of the Admin below,
-- which check the case and write the audit: only the Admin owner executes it.
CREATE FUNCTION public.closure_notice_support_reissue(p_organization text, p_dismiss_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  cycle timestamptz;
  requester text;
  d7_due timestamptz;
  recipient text;
  next_reissue smallint;
  written uuid;
  owed_to_owner integer;
  unverified_to_owner integer;
BEGIN
  IF p_organization IS NULL
     OR (p_dismiss_reason IS NOT NULL
         AND p_dismiss_reason NOT IN ('owner_account_deleted', 'email_not_verified', 'email_undeliverable')) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('closure_notice:' || p_organization, 0));
  SELECT closure.requested_at, closure.requested_by_user_id, deadline.d7_at
    INTO cycle, requester, d7_due
    FROM public.organizations AS organization
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
   WHERE organization.id = p_organization
     AND organization.status IN ('closing', 'closed', 'purge_pending')
     AND closure.recovered_at IS NULL;
  IF cycle IS NULL THEN
    RAISE EXCEPTION 'organization_not_in_closure' USING ERRCODE = '55000';
  END IF;
  IF d7_due > pg_catalog.now() THEN
    RAISE EXCEPTION 'closure_notice_not_due' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.closure_notices AS notice
     WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
       AND notice.milestone IN ('d7', 'rescheduled')
       AND COALESCE(notice.sent_at, notice.dismissed_at) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'closure_notice_delivered' USING ERRCODE = '55000';
  END IF;
  SELECT (COALESCE(pg_catalog.max(notice.reissue), 0) + 1)::smallint INTO next_reissue
    FROM public.closure_notices AS notice
   WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle AND notice.milestone = 'd7';
  -- the notices still owed of the cycle to a user who is still an owner (the others never go out)
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(*) FILTER (WHERE notice.milestone = 'd7' AND notice.unverified_at IS NOT NULL)::integer
    INTO owed_to_owner, unverified_to_owner
    FROM public.closure_notices AS notice
   WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.memberships AS membership
        WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
          AND membership.role = 'owner' AND membership.status = 'active'
     );
  IF p_dismiss_reason IS NOT NULL THEN
    IF p_dismiss_reason = 'owner_account_deleted' AND EXISTS (
      SELECT 1 FROM public.memberships AS membership
       WHERE membership.organization_id = p_organization AND membership.role = 'owner' AND membership.status = 'active'
    ) THEN
      RAISE EXCEPTION 'closure_notice_owner_present' USING ERRCODE = '55000';
    END IF;
    IF p_dismiss_reason = 'email_undeliverable' AND (owed_to_owner > 0 OR NOT EXISTS (
      SELECT 1 FROM public.closure_notices AS notice
       WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
         AND notice.milestone = 'd7' AND notice.failure_code = 'email_rejected'
         AND EXISTS (
           SELECT 1 FROM public.memberships AS membership
            WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
              AND membership.role = 'owner' AND membership.status = 'active'
         )
    )) THEN
      RAISE EXCEPTION 'closure_notice_not_refused' USING ERRCODE = '55000';
    END IF;
    IF p_dismiss_reason = 'email_not_verified' AND unverified_to_owner = 0 THEN
      RAISE EXCEPTION 'closure_notice_not_unverified' USING ERRCODE = '55000';
    END IF;
    -- the fact of a past delivery is not enough: the owner may have verified the e-mail since, and then the notice is
    -- sent again, never dismissed (the address is not read here, only whether it is verified now)
    IF p_dismiss_reason = 'email_not_verified' AND NOT EXISTS (
      SELECT 1 FROM public.closure_notices AS notice
       WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
         AND notice.milestone = 'd7' AND notice.unverified_at IS NOT NULL
         AND public.closure_notice_owner_unverified(notice.id, notice.organization_id)
    ) THEN
      RAISE EXCEPTION 'closure_notice_owner_verified' USING ERRCODE = '55000';
    END IF;
    UPDATE public.closure_notices AS notice
       SET skipped = true
     WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL;
    INSERT INTO public.closure_notices
      (organization_id, closure_requested_at, milestone, due_at, user_id, reissue, dismissed_at)
    VALUES (p_organization, cycle, 'd7', pg_catalog.now(), NULL, next_reissue, pg_catalog.now())
    RETURNING id INTO written;
  ELSE
    IF owed_to_owner > 0 THEN
      RAISE EXCEPTION 'closure_notice_pending' USING ERRCODE = '55000';
    END IF;
    UPDATE public.closure_notices AS notice
       SET skipped = true
     WHERE notice.organization_id = p_organization AND notice.closure_requested_at = cycle
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL;
    SELECT membership.user_id INTO recipient
      FROM public.memberships AS membership
     WHERE membership.organization_id = p_organization
       AND membership.role = 'owner' AND membership.status = 'active'
     ORDER BY (membership.user_id = requester) DESC, membership.created_at, membership.user_id
     LIMIT 1;
    IF recipient IS NULL THEN
      RAISE EXCEPTION 'closure_notice_no_owner' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.closure_notices
      (organization_id, closure_requested_at, milestone, due_at, user_id, reissue)
    VALUES (p_organization, cycle, 'd7', pg_catalog.now(), recipient, next_reissue)
    RETURNING id INTO written;
    INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id)
    VALUES (
      p_organization, 'organization.closure_notice', pg_catalog.jsonb_build_object('noticeId', written::text),
      'organization.closure_notice:' || written::text, pg_catalog.gen_random_uuid()::text
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object('noticeId', written, 'reissue', next_reissue, 'dismissed', p_dismiss_reason IS NOT NULL);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_owed_closure_notices(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_notice_support_reissue(text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_owed_closure_notices(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.closure_notice_support_reissue(text, text) TO polaris_admin_owner;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- The support sends the notice of D minus 7 days again (ADR 0102 amended): a `d7` skipped, failed, or written for an owner
-- who left. Under an open privacy case of the organization (any stage: the owner asked, or the support saw the store held
-- back; sending a notice takes nothing away), naming that same organization (a confirmation), with the audit
-- `closure_notice.reissued` (the new notice's ID). The purge then waits 7 days from its delivery.
CREATE FUNCTION public.admin_reissue_closure_notice(p_principal uuid, p_case uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  result jsonb;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privacy_cases AS privacy WHERE privacy.support_case_id = p_case) THEN
    RAISE EXCEPTION 'privacy_case_required' USING ERRCODE = '55000';
  END IF;
  result := public.closure_notice_support_reissue(target, NULL);
  PERFORM public.admin_record_audit(
    p_principal, 'closure_notice.reissued', target, p_case, 'closure_notice', result ->> 'noticeId', NULL
  );
  RETURN result;
END;
$function$;--> statement-breakpoint
-- The person responsible dismisses the notice of D minus 7 days (ADR 0102 amended): nobody can be told (the owner's
-- account is gone, the address is not verified or refuses the e-mail). Under an open privacy case of the organization
-- that is a deletion asked by the owner (by a data subject only with `owner_account_deleted`) and accepted in whole
-- (`decided` or `executed`), naming the organization, with
-- one reason of a closed list that must fit the facts (`closure_notice_support_reissue`), audited as
-- `closure_notice.dismissed` with the reason as its detail. The purge may then go on 7 days later.
CREATE FUNCTION public.admin_dismiss_closure_notice(p_principal uuid, p_case uuid, p_organization text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  privacy_type text;
  privacy_requester text;
  privacy_stage text;
  privacy_decision text;
  result jsonb;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('owner_account_deleted', 'email_not_verified', 'email_undeliverable') THEN
    RAISE EXCEPTION 'invalid_dismissal_reason' USING ERRCODE = '22023';
  END IF;
  SELECT privacy.request_type, privacy.requester_kind, privacy.stage, privacy.decision
    INTO privacy_type, privacy_requester, privacy_stage, privacy_decision
    FROM public.privacy_cases AS privacy WHERE privacy.support_case_id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy_case_required' USING ERRCODE = '55000';
  END IF;
  -- as strict as the Admin's purge (0087) where it matters: a deletion asked by the owner and accepted in whole; a data
  -- subject only when no owner is left (the account is what went), never to silence the notice of an owner
  IF privacy_type IS DISTINCT FROM 'deletion' THEN
    RAISE EXCEPTION 'privacy_case_not_deletion' USING ERRCODE = '55000';
  END IF;
  IF privacy_requester IS DISTINCT FROM 'organization_owner'
     AND NOT (privacy_requester = 'data_subject' AND p_reason = 'owner_account_deleted') THEN
    RAISE EXCEPTION 'privacy_requester_not_owner' USING ERRCODE = '55000';
  END IF;
  IF privacy_stage NOT IN ('decided', 'executed') OR privacy_decision IS DISTINCT FROM 'accept' THEN
    RAISE EXCEPTION 'privacy_case_not_accepted' USING ERRCODE = '55000';
  END IF;
  result := public.closure_notice_support_reissue(target, p_reason);
  PERFORM public.admin_record_audit(
    p_principal, 'closure_notice.dismissed', target, p_case, 'closure_notice', result ->> 'noticeId', p_reason
  );
  RETURN result;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_reissue_closure_notice(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_dismiss_closure_notice(uuid, uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_reissue_closure_notice(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_dismiss_closure_notice(uuid, uuid, text, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
