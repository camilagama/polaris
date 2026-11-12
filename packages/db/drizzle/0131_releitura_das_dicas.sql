-- The re-read of a tip of the activation series when it is sent (ADR 0106, D2 and D3): between the hourly sweep that
-- records a notice and the queue that sends it, the store may have sold, the person opted out, the store turned Pro or
-- closed. The billing runtime that sends it reads none of that (0129 took even the opt-out from it), so the owner of the
-- series answers, notice by notice, whether it still holds. Expand only (ADR 0096): one new function and one column
-- grant; nothing is dropped, altered or recreated, the candidates keep their body and their result, and the previous
-- Worker never calls the new function. Nothing here sends an e-mail and the series stays off (D6).
--
-- * `activation_notice_still_owed(p_organization, p_notice, p_now)`, SECURITY DEFINER of
--   `polaris_activation_notice_owner`, EXECUTE to the billing runtime only. It answers one of three shapes and nothing
--   else: null (the notice does not exist, is of another store, or was sent, failed or skipped), `{"skip": code}` with
--   the first rule that stopped holding, in the fixed order below, or `{"step", "hasProduct", "store"}` when every rule
--   still holds. The codes are the ones of `packages/domain/src/activation/notices.ts`, which the gate compares with
--   what this function answers. It answers no fact behind a rule (no address, person, instant, count, billing state or
--   status): a code names only which rule stopped holding, and the caller records it as the reason of the skip. It
--   writes nothing nor takes the lock of the cap.
-- * The rules are those of `activation_notice_candidates` (0126), read again for one notice:
--   expired, series_window_passed, activated, opted_out, billing_relation, store_not_active, privacy_request_open,
--   internal_store, not_first_owner, email_not_verified, state_changed (an a1 once the store has a live product, an a3
--   whose a2 never went out: the candidates make neither). The gate seeds a
--   store for each and proves both functions agree (the store leaves the candidates; its notice answers the code), so a
--   later rule added to only one of them fails it.
-- * `p_now` is the Worker's clock, as in 0126; a clock more than 10 minutes away from the database's is replaced by the
--   database's, so a wrong clock keeps a store of 14 days or an expired notice owed 10 minutes at most. The role sees only
--   the stores of the last 14 days of the database's clock anyway, and the billing runtime that passes it could record
--   any notice skipped by itself.
-- * The name of the store goes into the body of the tip, so the owner of the series reads `organizations.name`: one
--   more column, of the same stores of 14 days its policy of 0124 already shows; still not `"user".email`.
GRANT SELECT (name) ON TABLE public.organizations TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT polaris_activation_notice_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_notice_owner;--> statement-breakpoint
-- Whether the notice `p_notice` of the store `p_organization` is still owed at `p_now`, and what the e-mail needs if so:
-- the step, whether the store has a live product (S1) or not (S0), and the name of the store as typed. The first rule
-- that stopped holding is the answer, in the order of the stop codes of the domain.
CREATE FUNCTION public.activation_notice_still_owed(p_organization text, p_notice uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  clock timestamptz;
  owed_user text;
  owed_step text;
  owed_due timestamptz;
  store_created timestamptz;
  store_status text;
  store_name text;
  founder_user text;
  founder_since timestamptz;
  has_product boolean;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_now' USING ERRCODE = '22023';
  END IF;
  IF p_organization IS NULL OR p_notice IS NULL THEN
    RETURN NULL;
  END IF;
  clock := CASE WHEN p_now BETWEEN pg_catalog.now() - interval '10 minutes' AND pg_catalog.now() + interval '10 minutes'
                THEN p_now ELSE pg_catalog.now() END;
  SELECT notice.user_id, notice.step, notice.due_at INTO owed_user, owed_step, owed_due
    FROM public.activation_notices AS notice
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.skipped_reason IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF clock >= owed_due + interval '3 days' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'expired');
  END IF;
  SELECT store.created_at, store.status, store.name INTO store_created, store_status, store_name
    FROM public.organizations AS store
   WHERE store.id = p_organization;
  -- a store of 14 days or more of the database's clock is out of the role's sight
  IF NOT FOUND OR store_created <= clock - interval '14 days' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'series_window_passed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales AS sale WHERE sale.organization_id = p_organization) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'activated');
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_opt_outs AS opt_out WHERE opt_out.user_id = owed_user) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'opted_out');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = p_organization
       AND (billing.trial_started_at IS NOT NULL OR billing.state <> 'free')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'billing_relation');
  END IF;
  IF store_status <> 'active' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'store_not_active');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.support_cases AS support_case
      JOIN public.privacy_cases AS privacy_case ON privacy_case.support_case_id = support_case.id
     WHERE support_case.organization_id = p_organization AND privacy_case.resolved_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'privacy_request_open');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_internal_organizations AS internal WHERE internal.organization_id = p_organization
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'internal_store');
  END IF;
  SELECT membership.user_id, membership.created_at INTO founder_user, founder_since
    FROM public.memberships AS membership
   WHERE membership.organization_id = p_organization AND membership.role = 'owner' AND membership.status = 'active'
   ORDER BY membership.created_at, membership.user_id
   LIMIT 1;
  IF founder_user IS DISTINCT FROM owed_user OR EXISTS (
    SELECT 1 FROM public.memberships AS earlier
     WHERE earlier.user_id = owed_user AND earlier.organization_id <> p_organization
       AND earlier.role = 'owner' AND earlier.status = 'active'
       AND (earlier.created_at, earlier.organization_id) < (founder_since, p_organization)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'not_first_owner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."user" AS account WHERE account.id = owed_user AND account.email_verified) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'email_not_verified');
  END IF;
  has_product := EXISTS (
    SELECT 1 FROM public.products AS product
     WHERE product.organization_id = p_organization AND product.deleted_at IS NULL
  );
  IF (owed_step = 'a1' AND has_product) OR (owed_step = 'a3' AND NOT EXISTS (
    SELECT 1 FROM public.activation_notices AS sent
     WHERE sent.user_id = owed_user AND sent.step = 'a2' AND sent.sent_at IS NOT NULL
  )) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'state_changed');
  END IF;
  RETURN pg_catalog.jsonb_build_object('step', owed_step, 'hasProduct', has_product, 'store', store_name);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_notice_still_owed(text, uuid, timestamptz) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_notice_still_owed(text, uuid, timestamptz) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_notice_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_notice_owner;--> statement-breakpoint
-- The end state (a REVOKE without the right is only a WARNING on Neon): the owner of the series holds exactly the 35
-- SELECT columns (the 34 of 0124 and 0126 and the name) and the INSERT of 0129, still no table privilege nor CREATE,
-- never `"user".email` nor `session`; of the `polaris_*` groups of the series, the measure and the billing runtime, it
-- alone reads the name; it owns exactly its three functions; only the billing runtime executes the new one; the
-- candidates still answer no name; and no role, the migrator included, can SET or INHERIT the owner.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner') AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_notices.due_at:SELECT', 'activation_notices.failed_at:SELECT', 'activation_notices.id:SELECT',
    'activation_notices.organization_id:SELECT', 'activation_notices.recorded_at:SELECT',
    'activation_notices.sent_at:SELECT', 'activation_notices.skipped_reason:SELECT', 'activation_notices.step:SELECT',
    'activation_notices.user_id:SELECT', 'activation_series_state.enabled_since:SELECT', 'email_opt_outs.user_id:INSERT',
    'email_opt_outs.user_id:SELECT', 'memberships.created_at:SELECT', 'memberships.organization_id:SELECT',
    'memberships.role:SELECT', 'memberships.status:SELECT', 'memberships.user_id:SELECT',
    'organization_billing.organization_id:SELECT', 'organization_billing.state:SELECT',
    'organization_billing.trial_started_at:SELECT', 'organizations.created_at:SELECT', 'organizations.id:SELECT',
    'organizations.name:SELECT', 'organizations.status:SELECT', 'platform_internal_organizations.organization_id:SELECT',
    'privacy_cases.resolved_at:SELECT', 'privacy_cases.support_case_id:SELECT', 'products.created_at:SELECT',
    'products.deleted_at:SELECT', 'products.organization_id:SELECT', 'sales.confirmed_at:SELECT',
    'sales.organization_id:SELECT', 'support_cases.id:SELECT', 'support_cases.organization_id:SELECT',
    'user.email_verified:SELECT', 'user.id:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_notice_owner')
     OR pg_catalog.has_column_privilege('polaris_activation_notice_owner', 'public."user"', 'email', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_notice_owner', 'public.session', 'SELECT')
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series reads the session or the address, or holds more than columns';
  END IF;
  IF pg_catalog.has_column_privilege('polaris_activation_owner', 'public.organizations', 'name', 'SELECT')
     OR pg_catalog.has_column_privilege('polaris_activation_recipient_owner', 'public.organizations', 'name', 'SELECT')
     OR pg_catalog.has_column_privilege('polaris_billing_runtime', 'public.organizations', 'name', 'SELECT') THEN
    RAISE EXCEPTION 'the name of the store reaches another role of the series';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_notice_owner'::regrole)
     IS DISTINCT FROM ARRAY['activation_notice_candidates(timestamp with time zone,integer)',
                            'activation_notice_still_owed(text,uuid,timestamp with time zone)',
                            'activation_record_opt_out(text)'] THEN
    RAISE EXCEPTION 'the owner of the series does not own exactly its three functions';
  END IF;
  IF (SELECT pg_catalog.array_agg(a.name ORDER BY a.position)
        FROM pg_catalog.pg_proc AS p,
             LATERAL unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS a (name, mode, position)
       WHERE p.oid = 'public.activation_notice_candidates(timestamptz, integer)'::regprocedure AND a.mode = 't')
     IS DISTINCT FROM ARRAY['organization_id', 'user_id', 'step', 'due_at', 'outcome', 'truncated']::text[] THEN
    RAISE EXCEPTION 'the candidates answer other columns than their six';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.activation_notice_still_owed(text, uuid, timestamptz)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.activation_notice_still_owed(text, uuid, timestamptz)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_notice_still_owed(text, uuid, timestamptz)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the re-read of the series does not have its one executor';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.roleid = 'polaris_activation_notice_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'a role, the migrator included, can SET or INHERIT the owner of the series';
  END IF;
END
$end_state$;
