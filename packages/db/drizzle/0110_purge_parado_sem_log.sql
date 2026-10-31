-- A purge that stalls without a log (ADR 0081, amended). A run the Worker kills (time or CPU) or a lease that runs out
-- writes no `organization_purge_stalled`; the only trace is `attempts`, which grows at the claim. The hourly privacy
-- job counts the purges claimed `p_min_attempts` times or more that did not finish and have recorded no step in the
-- last `p_window_hours`: `storage_touched_at` and `purged_at` are the steps with a time (`swept_at` closes the purge), and
-- `locked_until` older than the window leaves out a purge that is not being claimed at all, and a purge the blocker
-- stops now (a legal hold, a temporary access, a renewal alive, a notice not delivered) is held on purpose and
-- `closure_purge_overdue` already reports it, even when its last claim was hours ago.
--
-- Only a count leaves the database: no organization ID, name or date. The login role of the job
-- (`polaris_privacy_runtime`) has no privilege on `organization_purges` (0075, and the gates that list the tables it
-- cannot read) and keeps none; the function is owned by `polaris_purge_owner`, which already reads the table whole, as
-- `count_purges_held_back` (0088). No grant is added to any role. Expand only (ADR 0096): a new function, no table,
-- column or existing function changes.
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
CREATE FUNCTION public.count_purges_stalled_without_progress(p_min_attempts integer, p_window_hours integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_min_attempts IS NULL OR p_min_attempts < 1 OR p_min_attempts > 100
     OR p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 720 THEN
    RAISE EXCEPTION 'invalid_stalled_purge_limits' USING ERRCODE = '22023';
  END IF;
  RETURN (
    SELECT pg_catalog.count(*)::integer
      FROM public.organization_purges AS purge
      JOIN public.organizations AS organization ON organization.id = purge.organization_id
     WHERE organization.status IN ('purge_pending', 'purged')
       AND purge.swept_at IS NULL
       AND (organization.status = 'purged' OR public.organization_purge_blocker(organization.id) IS NULL)
       AND purge.attempts >= p_min_attempts
       AND purge.locked_until > pg_catalog.now() - p_window_hours * interval '1 hour'
       AND (purge.storage_touched_at IS NULL
            OR purge.storage_touched_at <= pg_catalog.now() - p_window_hours * interval '1 hour')
       AND (purge.purged_at IS NULL
            OR purge.purged_at <= pg_catalog.now() - p_window_hours * interval '1 hour')
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.count_purges_stalled_without_progress(integer, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.count_purges_stalled_without_progress(integer, integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;
