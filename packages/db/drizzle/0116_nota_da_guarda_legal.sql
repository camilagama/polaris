-- A decision whose reason is `legal_retention` ("Guarda por obrigação legal") now has to say which obligation: the note
-- is required and holds from 10 to 500 characters after the trim, the same code points `char_length` counts. Without it
-- the function raises `invalid_privacy_step` (22023), the refusal every malformed step already uses. The other reasons,
-- `other` included, keep the rule of before.
-- No CHECK on `privacy_cases`: Postgres tests a CHECK on every UPDATE of the row, and the cases decided before this rule,
-- with `legal_retention` and no note, still go through `executed` and `resolved`. The function is the only writer of the
-- decision (the decision is immutable once written, 0067), so tightening it is enough; those cases stay as they are.
-- Expand only (ADR 0096): the same signature, so CREATE OR REPLACE keeps the owner and the grants of 0067 and 0077; the
-- search_path is restated, with pg_temp last as in 0077, because a replace without it would clear it. The Worker of the
-- previous version that sends this reason without a note gets the 400 it already knows.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_privacy_record_decision(p_principal uuid, p_case uuid, p_decision text, p_reason text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  case_row public.privacy_cases;
  support_org text;
  clean_note text := NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), '');
  accepting boolean;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  case_row := public.admin_lock_privacy_case(p_case);
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'partially_accept', 'reject', 'redirect_to_controller')
     OR (p_reason IS NOT NULL AND p_reason NOT IN ('identity_not_verified', 'no_authority', 'controller_is_reseller', 'legal_retention', 'manifestly_unfounded', 'not_personal_data', 'other'))
     OR (clean_note IS NOT NULL AND pg_catalog.char_length(clean_note) > 500)
     OR (p_reason = 'legal_retention' AND (clean_note IS NULL OR pg_catalog.char_length(clean_note) < 10)) THEN
    RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
  END IF;
  IF case_row.stage <> 'scoped' THEN
    RAISE EXCEPTION 'privacy_stage_conflict' USING ERRCODE = '22023';
  END IF;
  accepting := p_decision IN ('accept', 'partially_accept');
  -- what the case already established decides what may be decided (the same rules the table checks)
  IF case_row.identity_status = 'failed' THEN
    IF p_decision <> 'reject' OR p_reason IS DISTINCT FROM 'identity_not_verified' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF accepting AND case_row.polaris_role = 'processor' AND case_row.requester_kind <> 'organization_owner' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
    IF p_decision = 'redirect_to_controller' AND case_row.polaris_role IS DISTINCT FROM 'processor' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
    IF p_decision <> 'accept' AND p_reason IS NULL THEN
      RAISE EXCEPTION 'invalid_privacy_step' USING ERRCODE = '22023';
    END IF;
    IF p_reason = 'identity_not_verified' THEN
      RAISE EXCEPTION 'privacy_decision_not_allowed' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.privacy_cases
     SET stage = 'decided', decision = p_decision, decision_reason = p_reason, decision_note = clean_note, updated_at = pg_catalog.now()
   WHERE support_case_id = p_case;
  SELECT organization_id INTO support_org FROM public.support_cases WHERE id = p_case;
  PERFORM public.admin_record_audit(
    p_principal, 'privacy_case.stage_recorded', support_org, p_case,
    'privacy_case', p_case::text,
    'stage=decided;decision=' || p_decision || COALESCE(';reason=' || p_reason, '')
  );
  RETURN pg_catalog.jsonb_build_object('id', p_case, 'stage', 'decided');
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_privacy_record_decision(uuid, uuid, text, text, text) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
