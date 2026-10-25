-- What the consumer of `billing.notice` and the hourly sweep read of a store (ADR 0104, decision 7; PR G0 of design t268
-- v2, §9), the database part. Expand only (ADR 0096): two new functions, three column grants and four policies for an
-- existing owner role; nothing is changed, dropped or recreated, and the previous Worker calls none of it.
--
-- The billing role (`polaris_billing_runtime`) reads neither `organizations` nor the catalog, and the tenant role needs a
-- membership. Instead of a grant to the runtime role, two SECURITY DEFINER functions owned by `polaris_billing_owner`
-- (no login; the owner of the welcome's sweep, which already reads `organizations`, `memberships` and the Free limits)
-- answer exactly what the e-mails need, executed only by the billing role:
--
-- * `billing_notice_store(p_organization, p_notice)`: for a notice still owed (neither sent, failed nor skipped), of
--   that store, the store's name and time zone, whether it is in closure, closed or waiting for the purge (EM-7), whether
--   the person of the notice is still an active owner (the same rule `billing_notice_recipient` applies), how many
--   variants it has (those of products not deleted: the count the Free limit holds) and that limit (`variants.active.max`
--   of the live Free plan). A notice not owed, of another store, or of a store purged: null. Volatile: it writes the
--   scope the owner's policies read, so no cache answers it. The owner's policies see only that notice and that store,
--   and the scope is cleared when the call ends.
-- * `billing_notice_sweep_zones()`: the stores the hourly sweep looks at (in a trial, in grace, or active on the yearly
--   cycle) with their time zone, in one call, so the billing role needs no grant on `organizations`. Volatile for the same
--   reason: it writes its scope (`app.owner_scope.billing_notice_sweep_zones`), the only time the owner's policies show an
--   `organizations` row of a store with such a record, or that record, and clears it at the end.
-- Each new policy takes an ACCESS EXCLUSIVE lock on its table: the three are taken first, in one fixed order, and a lock
-- not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.organizations, public.organization_billing, public.billing_notices IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
GRANT SELECT (name, timezone) ON TABLE public.organizations TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY organizations_billing_owner_select_notice ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (id = pg_catalog.current_setting('app.owner_scope.billing_notice_store_organization_id', true));--> statement-breakpoint
CREATE POLICY organizations_billing_owner_select_billed ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (pg_catalog.current_setting('app.owner_scope.billing_notice_sweep_zones', true) = 'on' AND EXISTS (SELECT 1 FROM public.organization_billing AS billed WHERE billed.organization_id = organizations.id));--> statement-breakpoint
GRANT SELECT (organization_id, state, cycle_months) ON TABLE public.organization_billing TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY organization_billing_billing_owner_select_sweep ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (pg_catalog.current_setting('app.owner_scope.billing_notice_sweep_zones', true) = 'on' AND (state IN ('trialing', 'grace') OR (state = 'active' AND cycle_months = 12)));--> statement-breakpoint
GRANT SELECT (id, organization_id, sent_at, failed_at, skipped_reason) ON TABLE public.billing_notices TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY billing_notices_billing_owner_select_owed ON public.billing_notices
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner
  USING (sent_at IS NULL AND failed_at IS NULL AND skipped_reason IS NULL AND id = (CASE WHEN pg_catalog.current_setting('app.owner_scope.billing_notice_store_notice_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.owner_scope.billing_notice_store_notice_id', true)::uuid END));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_billing_owner;--> statement-breakpoint
GRANT polaris_billing_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_billing_owner;--> statement-breakpoint
CREATE FUNCTION public.billing_notice_store(p_organization text, p_notice uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  notice_user text;
  store_name text;
  store_zone text;
  store_status text;
  owner_active boolean;
  variants_count bigint;
  variants_limit integer;
  facts jsonb;
BEGIN
  -- the owner's policies see only this notice and this store, until the end of the call
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_store_notice_id', COALESCE(p_notice::text, ''), true);
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_store_organization_id', COALESCE(p_organization, ''), true);
  <<lookup>>
  BEGIN
    SELECT notice.user_id INTO notice_user
      FROM public.billing_notices AS notice
     WHERE notice.id = p_notice AND notice.organization_id = p_organization
       AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.skipped_reason IS NULL;
    IF NOT FOUND THEN
      EXIT lookup;
    END IF;
    SELECT store.name, store.timezone, store.status INTO store_name, store_zone, store_status
      FROM public.organizations AS store
     WHERE store.id = p_organization;
    IF NOT FOUND OR store_status = 'purged' THEN
      EXIT lookup;
    END IF;
    -- the welcome's person, in any store, or an owner of the store for a notice of the billing cycle: the rule of
    -- `billing_notice_recipient`
    SELECT EXISTS (
      SELECT 1 FROM public.memberships AS membership
       WHERE membership.role = 'owner' AND membership.status = 'active'
         AND (CASE WHEN notice_user IS NOT NULL THEN membership.user_id = notice_user
                   ELSE membership.organization_id = p_organization END)
    ) INTO owner_active;
    SELECT pg_catalog.max(entitlement.limit_value) INTO variants_limit
      FROM public.plan_entitlements AS entitlement
     WHERE entitlement.plan_id = 'free' AND entitlement.key = 'variants.active.max';
    IF variants_limit IS NULL THEN
      RAISE EXCEPTION 'the free plan limits are incomplete' USING ERRCODE = '22023';
    END IF;
    -- the count the Free limit holds (ADR 0058): the variants of the products not deleted
    SELECT pg_catalog.count(*) INTO variants_count
      FROM public.product_variants AS variant
      JOIN public.products AS product
        ON product.organization_id = variant.organization_id AND product.id = variant.product_id
     WHERE variant.organization_id = p_organization AND product.deleted_at IS NULL;
    facts := pg_catalog.jsonb_build_object(
      'name', store_name,
      'timezone', store_zone,
      'closed', store_status IN ('closing', 'closed', 'purge_pending'),
      'ownerActive', owner_active,
      'variants', variants_count,
      'variantLimit', variants_limit
    );
  END lookup;
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_store_notice_id', '', true);
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_store_organization_id', '', true);
  RETURN facts;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_notice_store(text, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_notice_store(text, uuid) TO polaris_billing_runtime;--> statement-breakpoint
-- The stores the hourly sweep of the notices looks at, with the time zone its local days and hours are counted in.
CREATE FUNCTION public.billing_notice_sweep_zones()
RETURNS TABLE (organization_id text, timezone text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  -- the owner's policies show the stores with such a record only inside this call
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_sweep_zones', 'on', true);
  RETURN QUERY
  SELECT store.id, store.timezone
    FROM public.organizations AS store
    JOIN public.organization_billing AS billed ON billed.organization_id = store.id
   WHERE store.status <> 'purged'
     AND (billed.state IN ('trialing', 'grace') OR (billed.state = 'active' AND billed.cycle_months = 12))
   ORDER BY store.id;
  PERFORM pg_catalog.set_config('app.owner_scope.billing_notice_sweep_zones', '', true);
  RETURN;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.billing_notice_sweep_zones() FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.billing_notice_sweep_zones() TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_billing_owner;--> statement-breakpoint
-- The end state, as 0101 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): the two
-- functions have their owner and their executors, the owner keeps no CREATE on public, and the migrator keeps no SET
-- or INHERIT on it.
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE p.oid IN ('public.billing_notice_store(text, uuid)'::regprocedure, 'public.billing_notice_sweep_zones()'::regprocedure)
         AND p.proowner = 'polaris_billing_owner'::regrole) <> 2 THEN
    RAISE EXCEPTION 'the new functions do not have their owner';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.billing_notice_store(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.billing_notice_sweep_zones()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.billing_notice_store(text, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.billing_notice_sweep_zones()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the new functions do not have their executors';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_billing_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the billing owner kept CREATE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_billing_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on the billing owner';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
