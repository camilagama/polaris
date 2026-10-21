-- Two follow-ups of the purge of the users who never verified the e-mail (ADR 0100, P10; the security review of 21/10/2026).
-- 1) A late resend: the e-mail link of the sign-up dies in a day, but a link sent again later is valid for a day from then, and
-- the purge would delete the user under it. `user.verification_link_expires_at` is the date the last link sent stops working,
-- by the database clock, written by the server each time it sends one (never read from the e-mail), and the purge waits for
-- it: a user is kept while that date has not passed. Null means no link was sent (or the user is older than the column, and a
-- link of the sign-up is long dead), and does not hold the user. A nullable column with no default: expand only (ADR 0096), the
-- previous Worker neither reads nor writes it.
-- 2) The end of the contract of the acceptance: `legal_acceptance` is kept 10 years after the contract ends, the end being the
-- deletion of the account. The user the purge deletes had accepted the terms at the sign-up (origin `signup`), so the purge
-- records, in the statement that deletes the user, the row of `legal_acceptance_contract_end` the 10 years count from (user
-- ID, instant by the database clock, why). Opaque ID only, no foreign key (the user is gone), append-only like the acceptance
-- (triggers for every role, `ENABLE ALWAYS`), and no runtime reads or writes it: the only grant is the INSERT of the owner of the
-- purge. The routine that deletes an account writes the same row (it will widen the reason check); the expiry of the acceptance
-- does not exist yet and reads it as the owner of the acceptance.
ALTER TABLE "user" ADD COLUMN "verification_link_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "legal_acceptance_contract_end" (
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"user_id" text PRIMARY KEY NOT NULL,
	CONSTRAINT "legal_acceptance_contract_end_user_format" CHECK ("legal_acceptance_contract_end"."user_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "legal_acceptance_contract_end_reason_allowed" CHECK ("legal_acceptance_contract_end"."reason" IN ('unverified_user_deleted'))
);
--> statement-breakpoint
ALTER TABLE "legal_acceptance_contract_end" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "legal_acceptance_contract_end_unverified_user_insert" ON "legal_acceptance_contract_end" AS PERMISSIVE FOR INSERT TO "polaris_unverified_user_owner" WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "legal_acceptance_contract_end" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.legal_acceptance_contract_end FROM PUBLIC, polaris_pr11_runtime, polaris_auth_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime, polaris_outbox_owner, polaris_purge_owner, polaris_media_cleanup_runtime, polaris_media_cleanup_owner, polaris_onboarding_runtime, polaris_billing_owner, polaris_catalog_owner, polaris_retention_owner, polaris_device_session_owner, polaris_access_log_owner, polaris_login_lock_owner, polaris_notice_recipient_owner, polaris_closed_export_reader, polaris_legal_acceptance_owner;--> statement-breakpoint
GRANT INSERT (user_id, reason) ON TABLE public.legal_acceptance_contract_end TO polaris_unverified_user_owner;--> statement-breakpoint
CREATE TRIGGER legal_acceptance_contract_end_no_change
  BEFORE UPDATE OR DELETE ON public.legal_acceptance_contract_end
  FOR EACH ROW EXECUTE FUNCTION public.legal_acceptance_immutable();--> statement-breakpoint
CREATE TRIGGER legal_acceptance_contract_end_no_truncate
  BEFORE TRUNCATE ON public.legal_acceptance_contract_end
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_acceptance_immutable();--> statement-breakpoint
-- ALWAYS: they fire also under session_replication_role = replica
ALTER TABLE public.legal_acceptance_contract_end ENABLE ALWAYS TRIGGER legal_acceptance_contract_end_no_change;--> statement-breakpoint
ALTER TABLE public.legal_acceptance_contract_end ENABLE ALWAYS TRIGGER legal_acceptance_contract_end_no_truncate;--> statement-breakpoint
-- the owner of the purge reads the date of the last link (and nothing else new)
GRANT SELECT (verification_link_expires_at) ON TABLE public."user" TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT polaris_unverified_user_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_unverified_user_owner;--> statement-breakpoint
-- The same function of the migration before, with one condition more, in the candidate query and in the DELETE: the date of
-- the last link is null or already past (a link valid to the second is a user kept; the DELETE repeats the check for symmetry,
-- and the row lock already holds the UPDATE of a resend until the delete ends). And the row of the end of the contract of
-- each user deleted, in the same statement as the delete and the audit (a data-modifying CTE always runs; a conflict with a row
-- that already exists keeps the earlier date). The ACL and the owner of the function are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.purge_unverified_users(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_ids text[];
  v_run text := 'unverified-user-purge:' || pg_catalog.gen_random_uuid()::text;
  v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid purge limit' USING ERRCODE = '22023';
  END IF;
  -- the candidates, locked in one statement; a row another transaction holds is left for the next run
  SELECT pg_catalog.array_agg(picked.id ORDER BY picked.created_at, picked.id) INTO v_ids
    FROM (
      SELECT candidate.id, candidate.created_at
        FROM public."user" AS candidate
       WHERE NOT candidate.email_verified
         AND candidate.created_at < pg_catalog.clock_timestamp() - interval '24 hours'
         AND (candidate.verification_link_expires_at IS NULL OR candidate.verification_link_expires_at < pg_catalog.clock_timestamp())
         AND NOT EXISTS (SELECT 1 FROM public.account AS other WHERE other.user_id = candidate.id AND other.provider_id <> 'credential')
         AND NOT EXISTS (SELECT 1 FROM public.session AS live WHERE live.user_id = candidate.id)
         AND NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.user_id = candidate.id)
       ORDER BY candidate.created_at, candidate.id
       LIMIT p_limit
         FOR UPDATE OF candidate SKIP LOCKED
    ) AS picked;
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;
  -- the conditions again, in a statement that starts after the locks, then the end of the contract and the audit of exactly the rows deleted
  WITH deleted AS (
    DELETE FROM public."user" AS doomed
     WHERE doomed.id = ANY (v_ids)
       AND NOT doomed.email_verified
       AND doomed.created_at < pg_catalog.clock_timestamp() - interval '24 hours'
       AND (doomed.verification_link_expires_at IS NULL OR doomed.verification_link_expires_at < pg_catalog.clock_timestamp())
       AND NOT EXISTS (SELECT 1 FROM public.account AS other WHERE other.user_id = doomed.id AND other.provider_id <> 'credential')
       AND NOT EXISTS (SELECT 1 FROM public.session AS live WHERE live.user_id = doomed.id)
       AND NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.user_id = doomed.id)
    RETURNING doomed.id
  ), contract_ended AS (
    INSERT INTO public.legal_acceptance_contract_end (user_id, reason)
    SELECT deleted.id, 'unverified_user_deleted' FROM deleted
    ON CONFLICT DO NOTHING
  )
  INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, subject_id)
  SELECT 'unverified_user_deleted', 'succeeded', v_run, deleted.id FROM deleted;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_unverified_user_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_unverified_user_owner;
