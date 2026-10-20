-- The notices of a closure and the purge checked again when it runs (ADR 0102 amended; design t107 §5, with the
-- consolidation of 19/10/2026 21:25). The privacy job writes, once each milestone's date arrives, one row per
-- milestone of the closure cycle in `closure_notices` (the request, D minus 30 and minus 7 local days, D, and the
-- new notice of 7 days when a legal hold released after the schedule pushed the purge), with an outbox event
-- `organization.closure_notice {noticeId}` for the one that goes out. The milestones come only from the dates, the
-- same with or without a legal hold; a milestone found together with a later one (a run that stopped) is written
-- `skipped`, so two e-mails never arrive at once. The e-mail itself is the next pull request: here the consumer only
-- claims the notice (IDs and dates, never the address) and records it sent or failed.
--
-- The purge also checks, when it runs and not only at the schedule, that no temporary access of the Admin is live and
-- that no renewal is alive at a provider (suggestion 1 of the security review of ADR 0102): `organization_purge_blocker`
-- returns `tenant_access_active` or `renewal_alive`, the codes of `closed_organization_purge_wait`, so the claim does
-- not take it, the mark before the storage refuses it and `purge_organization_data` refuses it, for a purge of the
-- closure period and for one of the Admin alike.
--
-- Expand only (ADR 0096): a new table, policies, column grants, three new functions and one function recreated with
-- the same signature, owner and grants (`organization_purge_blocker`: the gate `purge-functions` compares it with the
-- domain). The previous Worker does not know the new event type and never writes it.
CREATE TABLE "closure_notices" (
	"closure_requested_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"milestone" text NOT NULL,
	"organization_id" text NOT NULL,
	"purge_from" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"skipped" boolean DEFAULT false NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "closure_notices_cycle_milestone_unique" UNIQUE NULLS NOT DISTINCT("organization_id","closure_requested_at","milestone","purge_from"),
	CONSTRAINT "closure_notices_milestone_allowed" CHECK ("closure_notices"."milestone" IN ('closure', 'd30', 'd7', 'deletion_day', 'rescheduled')),
	CONSTRAINT "closure_notices_purge_from_coherent" CHECK (("closure_notices"."milestone" = 'rescheduled') = ("closure_notices"."purge_from" IS NOT NULL)),
	CONSTRAINT "closure_notices_outcome_coherent" CHECK (("closure_notices"."sent_at" IS NULL OR "closure_notices"."failed_at" IS NULL)
        AND (NOT "closure_notices"."skipped" OR ("closure_notices"."sent_at" IS NULL AND "closure_notices"."failed_at" IS NULL))
        AND (("closure_notices"."failed_at" IS NULL) = ("closure_notices"."failure_code" IS NULL))),
	CONSTRAINT "closure_notices_failure_code_format" CHECK ("closure_notices"."failure_code" IS NULL OR "closure_notices"."failure_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "closure_notices_due_after_request" CHECK ("closure_notices"."due_at" >= "closure_notices"."closure_requested_at")
);
--> statement-breakpoint
ALTER TABLE "closure_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD CONSTRAINT "closure_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closure_notices" ADD CONSTRAINT "closure_notices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closure_notices_user_idx" ON "closure_notices" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "closure_notices_privacy_owner_select" ON "closure_notices" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING (true);--> statement-breakpoint
CREATE POLICY "closure_notices_privacy_owner_insert" ON "closure_notices" AS PERMISSIVE FOR INSERT TO "polaris_privacy_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "closure_notices_privacy_owner_update" ON "closure_notices" AS PERMISSIVE FOR UPDATE TO "polaris_privacy_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
-- No runtime role reads or writes the notices: the privacy owner's functions do
REVOKE ALL ON TABLE public.closure_notices FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.closure_notices TO polaris_privacy_owner;--> statement-breakpoint
GRANT INSERT (organization_id, closure_requested_at, milestone, purge_from, due_at, user_id, skipped) ON TABLE public.closure_notices TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (sent_at, failed_at, failure_code) ON TABLE public.closure_notices TO polaris_privacy_owner;--> statement-breakpoint
-- what the privacy owner needs besides what it had: when a membership began (the owner a notice is for, when the one
-- who asked for the closure is no longer a member) and when a purge of the closure period was scheduled and may run
-- (the new notice after the release of a legal hold, read from the dates alone: the hold itself stays unread)
GRANT SELECT (created_at) ON TABLE public.memberships TO polaris_privacy_owner;--> statement-breakpoint
GRANT SELECT (scheduled_at, not_before, trigger) ON TABLE public.organization_purges TO polaris_privacy_owner;--> statement-breakpoint
-- only this type, only pending and untouched, the key the body names, and only for a notice of an organization in
-- closure that is still to go out: the body carries nothing but the notice's ID
CREATE POLICY event_outbox_privacy_owner_insert_closure_notice ON public.event_outbox
  AS PERMISSIVE FOR INSERT TO polaris_privacy_owner
  WITH CHECK (type = 'organization.closure_notice' AND status = 'pending' AND attempts = 0
    AND (event - 'noticeId') = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(event -> 'noticeId') = 'string'
    AND idempotency_key = type || ':' || (event ->> 'noticeId')
    AND EXISTS (SELECT 1 FROM public.closure_notices AS notice_scope
                 JOIN public.organizations AS organization_scope ON organization_scope.id = notice_scope.organization_id
                 WHERE notice_scope.id::text = event_outbox.event ->> 'noticeId'
                   AND notice_scope.organization_id = event_outbox.organization_id
                   AND NOT notice_scope.skipped AND notice_scope.sent_at IS NULL AND notice_scope.failed_at IS NULL
                   AND organization_scope.status IN ('closing', 'closed', 'purge_pending')));--> statement-breakpoint
-- what the purge owner reads when the purge runs, as it read at the schedule (0087): whether a temporary access of the
-- Admin is live and whether the renewal is alive, now also for an organization that waits for its purge
CREATE POLICY tenant_access_grants_purge_owner_select_pending ON public.tenant_access_grants
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = tenant_access_grants.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
CREATE POLICY organization_billing_purge_owner_select_pending ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_purge_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS purge_scope WHERE purge_scope.id = organization_billing.organization_id AND purge_scope.status = 'purge_pending'));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
-- What stops a scheduled purge from running now, as in 0079, plus the two reasons the schedule already waits for
-- (`closed_organization_purge_wait`, 0087), checked again when the purge runs: a temporary access of the Admin still
-- live, and a renewal still alive at a provider (a provider and its reference linked, a state that gives Pro, no
-- cancellation at the end of the period). The schedule comes at least 7 days before the purge, and either can begin in
-- between (an access the Admin opens, a renewal a provider brings back). The claim does not take such a purge, the mark
-- before the storage refuses it and the purge refuses it, by the same code, whoever scheduled it. A purge reapplied after
-- a restore finds its tombstone first: its first run proved these, and the restored copy of the billing record may be
-- older than that run.
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
  RETURN NULL;
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- The milestones of an organization's current closure whose date arrived, recorded or not: the request, D minus 30
-- and minus 7 local days and D (`closure_deadlines`, the domain's `closureDeadlines`), and `rescheduled` while a purge
-- of the closure period of this cycle waits past the date its schedule gave it (the later of D plus 48 hours and the
-- schedule plus 7 days): only the release of a legal hold pushes it (0087), to the release plus 7 days, so the notice is
-- due at the release and names the new date. Only for an organization in closure; internal to the functions below.
CREATE FUNCTION public.closure_notice_due(p_organization text)
RETURNS TABLE (closure_requested_at timestamptz, milestone text, due_at timestamptz, purge_from timestamptz, ordinal integer)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT closure.requested_at, owed.milestone, owed.due_at, owed.purge_from, owed.ordinal
    FROM public.organizations AS organization
    JOIN public.organization_closures AS closure ON closure.organization_id = organization.id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
    CROSS JOIN LATERAL (
      SELECT 1, 'closure', closure.requested_at, NULL::timestamptz
      UNION ALL SELECT 2, 'd30', deadline.d30_at, NULL::timestamptz
      UNION ALL SELECT 3, 'd7', deadline.d7_at, NULL::timestamptz
      UNION ALL SELECT 4, 'deletion_day', deadline.deletable_from, NULL::timestamptz
      UNION ALL
      SELECT 5, 'rescheduled', purge.not_before - interval '168 hours', purge.not_before
        FROM public.organization_purges AS purge
       WHERE purge.organization_id = organization.id
         AND organization.status = 'purge_pending'
         AND purge.trigger = 'closure_period' AND purge.purged_at IS NULL
         AND purge.scheduled_at >= closure.requested_at
         AND purge.not_before > GREATEST(deadline.deletable_from + interval '48 hours', purge.scheduled_at + interval '168 hours')
    ) AS owed(ordinal, milestone, due_at, purge_from)
   WHERE organization.id = p_organization
     AND organization.status IN ('closing', 'closed', 'purge_pending')
     AND closure.recovered_at IS NULL
     AND owed.due_at <= pg_catalog.now()
$function$;--> statement-breakpoint
-- The notices of the privacy job (ADR 0102 amended): at most `p_limit` organizations in closure with a milestone due
-- and not yet recorded, oldest closure first. Of the milestones due and missing, the latest is written and gets its
-- outbox event; the earlier ones are written `skipped`, with no event (a run that stopped never sends two at once).
-- The unique key of the cycle and the milestone makes it idempotent, also with two runs at once: a milestone another
-- run wrote is left as it is. The notice is for the owner who asked for the closure while a member, else the oldest
-- membership. No argument names an organization; only the privacy runtime executes it.
CREATE FUNCTION public.record_closure_notices(p_limit integer)
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
  RETURN pg_catalog.jsonb_build_object('organizations', seen, 'recorded', recorded, 'skipped', skipped_count);
END;
$function$;--> statement-breakpoint
-- What the consumer of `organization.closure_notice` needs to write the e-mail, by the notice and the organization the
-- event names: the milestone, the user it is for (an ID: the address is read from the account when it is sent), the
-- organization's name and time zone and the dates (the request, the end of the window, D, and the new date of a
-- rescheduled purge). Null when the notice is not to go out: skipped, sent or failed already, of another cycle (the
-- closure was undone), or of an organization no longer in closure (recovered, or purged).
CREATE FUNCTION public.claim_closure_notice_delivery(p_notice uuid, p_organization text)
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
           'purgeFrom', notice.purge_from
         )
    INTO delivery
    FROM public.closure_notices AS notice
    JOIN public.organizations AS organization ON organization.id = notice.organization_id
    JOIN public.organization_closures AS closure ON closure.organization_id = notice.organization_id
    CROSS JOIN LATERAL public.closure_deadlines(closure.requested_at, organization.timezone) AS deadline
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL
     AND organization.status IN ('closing', 'closed', 'purge_pending')
     AND closure.requested_at = notice.closure_requested_at AND closure.recovered_at IS NULL;
  RETURN delivery;
END;
$function$;--> statement-breakpoint
-- The notice went out (the provider took it, under the notice's own idempotency key). Once: a notice already sent,
-- failed or skipped is left as it is, and the answer says whether this call changed it.
CREATE FUNCTION public.mark_closure_notice_sent(p_notice uuid, p_organization text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public.closure_notices AS notice
     SET sent_at = pg_catalog.now()
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL;
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
-- The notice will not go out, with a short code (`email_not_configured`, a refused address): once, with no retry. A
-- notice already sent, failed or skipped is left as it is.
CREATE FUNCTION public.mark_closure_notice_failed(p_notice uuid, p_organization text, p_code text)
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
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL;
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.closure_notice_due(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime, polaris_privacy_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_closure_notices(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_closure_notice_delivery(uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_closure_notice_sent(uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_closure_notice_failed(uuid, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_closure_notices(integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_closure_notice_delivery(uuid, text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_closure_notice_sent(uuid, text) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_closure_notice_failed(uuid, text, text) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;
