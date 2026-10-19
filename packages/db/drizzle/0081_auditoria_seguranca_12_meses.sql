-- The security audit of the tenant now expires 12 months after the event, not 60 (decision of the user of 19/10/2026: all
-- the retention periods approved, "always looking for simplicity"; ADR 0079 and ADR 0081). Only the body of the internal
-- `tenant_audit_event_expired` holds the period of the `security` class, and the retention policy of the table and the guard
-- trigger both ask it, so one CREATE OR REPLACE moves all three. The `operational` period (6 months after the purge of the
-- organization) and the legal hold check are untouched. CREATE OR REPLACE keeps the owner, the REVOKE from PUBLIC and the
-- EXECUTE of `polaris_retention_owner` of 0080; the search_path is restated because a replace without it would clear it.
-- Same signature, same return, only a shorter period: the previous Worker never calls it (nothing calls the function and no
-- runtime role can execute it), so it keeps working against this migration (ADR 0096). No row is deleted here: no job calls
-- `expire_tenant_audit_events` yet, so the security rows older than 12 months only become expirable, and all of them at once
-- on the day a job is turned on (accepted by the user's decision).
CREATE OR REPLACE FUNCTION public.tenant_audit_event_expired(p_organization text, p_class text, p_created_at timestamp with time zone)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT NOT EXISTS (
           SELECT 1 FROM public.organization_legal_holds AS hold
            WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
         )
     AND CASE p_class
           WHEN 'security' THEN
             (p_created_at AT TIME ZONE 'UTC' + interval '12 months') AT TIME ZONE 'UTC' <= pg_catalog.now()
           WHEN 'operational' THEN
             EXISTS (
               SELECT 1 FROM public.organization_purges AS purge
                WHERE purge.organization_id = p_organization AND purge.purged_at IS NOT NULL
                  AND (purge.purged_at AT TIME ZONE 'UTC' + interval '6 months') AT TIME ZONE 'UTC' <= pg_catalog.now()
             )
           ELSE false
         END
$function$;
