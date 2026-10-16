-- What the Admin may see of an organization without any tenant access (plan PR95,
-- ADR 0071): its status, plan, entitlements, usage against the plan, devices, sync
-- health and billing summary, as counts, dates and states. The Admin role still reads
-- no table: it runs two functions, owned by a role that can read only these columns,
-- and they return no name of a person, no product, customer or sale, no amount and
-- no e-mail. Reading a tenant's records is a different, audited path (later PRs).
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_admin_owner') THEN
    EXECUTE 'CREATE ROLE polaris_admin_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT (id, name, status, timezone, currency, created_at) ON TABLE public.organizations TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY organizations_admin_owner_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (plan_id, key, flag_value, limit_value) ON TABLE public.plan_entitlements TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY plan_entitlements_admin_owner_select ON public.plan_entitlements
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, status, authorization_epoch) ON TABLE public.memberships TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY memberships_admin_owner_select ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, state, access_ends_at, trial_started_at, cycle_months, pending_cycle_months, cancel_at_period_end, over_limit_since, provider, last_fact_at, version, revoked_through, revoked_reason) ON TABLE public.organization_billing TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY organization_billing_admin_owner_select ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, key, flag_value, limit_value, starts_at, expires_at, revoked_at) ON TABLE public.entitlement_grants TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY entitlement_grants_admin_owner_select ON public.entitlement_grants
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, status, received_at, attempts) ON TABLE public.billing_events TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY billing_events_admin_owner_select ON public.billing_events
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (id, organization_id, archived_at, deleted_at) ON TABLE public.products TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY products_admin_owner_select ON public.products
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id) ON TABLE public.product_variants TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY product_variants_admin_owner_select ON public.product_variants
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id) ON TABLE public.product_media TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY product_media_admin_owner_select ON public.product_media
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, status) ON TABLE public.goals TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY goals_admin_owner_select ON public.goals
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, device_id, expires_at, revoked_at) ON TABLE public.offline_grants TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY offline_grants_admin_owner_select ON public.offline_grants
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (id, last_seen_at) ON TABLE public.devices TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY devices_admin_owner_select ON public.devices
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, outcome_status, outcome_code, received_at) ON TABLE public.sync_commands TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY sync_commands_admin_owner_select ON public.sync_commands
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
-- the organizations, a page at a time, found by exact ID or by the start of the name
CREATE FUNCTION public.admin_organizations_overview(p_query text, p_limit integer, p_after text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size'
      USING ERRCODE = '22023';
  END IF;
  IF p_query IS NOT NULL AND pg_catalog.char_length(p_query) > 100 THEN
    RAISE EXCEPTION 'invalid query'
      USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT
        organization.id,
        organization.name,
        organization.status,
        organization.created_at,
        billing.state AS billing_state,
        billing.access_ends_at,
        -- the plan the billing record gives right now (a temporary grant is not counted here)
        CASE
          WHEN billing.state IN ('trialing', 'active', 'grace') AND billing.access_ends_at > pg_catalog.now()
            THEN 'pro' ELSE 'free'
        END AS plan_in_force
      FROM public.organizations AS organization
      LEFT JOIN public.organization_billing AS billing
        ON billing.organization_id = organization.id
      WHERE (p_after IS NULL OR organization.id > p_after)
        AND (
          p_query IS NULL
          OR p_query = ''
          OR organization.id = p_query
          OR pg_catalog.starts_with(pg_catalog.lower(organization.name), pg_catalog.lower(p_query))
        )
      ORDER BY organization.id
      LIMIT p_limit + 1
    ),
    shown AS (
      SELECT * FROM page ORDER BY id LIMIT p_limit
    )
    SELECT pg_catalog.jsonb_build_object(
      'organizations', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'name', shown.name,
            'status', shown.status,
            'createdAt', shown.created_at,
            'billingState', COALESCE(shown.billing_state, 'free'),
            'accessEndsAt', shown.access_ends_at,
            'planInForce', shown.plan_in_force
          ) ORDER BY shown.id
        )
        FROM shown
      ), '[]'::jsonb),
      'next', CASE
        WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
          THEN (SELECT pg_catalog.max(shown.id) FROM shown)
        ELSE NULL
      END
    )
  );
END;
$function$;--> statement-breakpoint
-- one organization's state, plan, usage and health; null when there is no such organization
CREATE FUNCTION public.admin_organization_diagnostics(p_organization_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'now', pg_catalog.now(),
      'planCatalog', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'planId', entitlement.plan_id,
            'key', entitlement.key,
            'flagValue', entitlement.flag_value,
            'limitValue', entitlement.limit_value
          ) ORDER BY entitlement.plan_id, entitlement.key
        )
        FROM public.plan_entitlements AS entitlement
      ), '[]'::jsonb),
      'organization', pg_catalog.jsonb_build_object(
        'id', organization.id,
        'name', organization.name,
        'status', organization.status,
        'timezone', organization.timezone,
        'currency', organization.currency,
        'createdAt', organization.created_at,
        'members', (
          SELECT pg_catalog.count(*) FROM public.memberships AS membership
           WHERE membership.organization_id = organization.id AND membership.status = 'active'
        ),
        'authorizationEpoch', (
          SELECT COALESCE(pg_catalog.max(membership.authorization_epoch), 0)
            FROM public.memberships AS membership
           WHERE membership.organization_id = organization.id
        )
      ),
      'billing', (
        SELECT pg_catalog.jsonb_build_object(
          'state', billing.state,
          'accessEndsAt', billing.access_ends_at,
          'trialStartedAt', billing.trial_started_at,
          'cycleMonths', billing.cycle_months,
          'pendingCycleMonths', billing.pending_cycle_months,
          'cancelAtPeriodEnd', billing.cancel_at_period_end,
          'overLimitSince', billing.over_limit_since,
          'provider', billing.provider,
          'lastFactAt', billing.last_fact_at,
          'version', billing.version,
          'revokedThrough', billing.revoked_through,
          'revokedReason', billing.revoked_reason
        )
        FROM public.organization_billing AS billing
        WHERE billing.organization_id = organization.id
      ),
      'grants', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'key', grant_row.key,
            'flagValue', grant_row.flag_value,
            'limitValue', grant_row.limit_value,
            'startsAt', grant_row.starts_at,
            'expiresAt', grant_row.expires_at,
            'revokedAt', grant_row.revoked_at
          ) ORDER BY grant_row.starts_at, grant_row.key
        )
        FROM public.entitlement_grants AS grant_row
        WHERE grant_row.organization_id = organization.id
      ), '[]'::jsonb),
      'usage', pg_catalog.jsonb_build_object(
        'products', (
          SELECT pg_catalog.count(*) FROM public.products AS product
           WHERE product.organization_id = organization.id
             AND product.deleted_at IS NULL AND product.archived_at IS NULL
        ),
        'archivedProducts', (
          SELECT pg_catalog.count(*) FROM public.products AS product
           WHERE product.organization_id = organization.id
             AND product.deleted_at IS NULL AND product.archived_at IS NOT NULL
        ),
        'variants', (
          SELECT pg_catalog.count(*)
            FROM public.product_variants AS variant
            JOIN public.products AS product
              ON product.organization_id = variant.organization_id AND product.id = variant.product_id
           WHERE variant.organization_id = organization.id AND product.deleted_at IS NULL
        ),
        'images', (
          SELECT pg_catalog.count(*)
            FROM public.product_media AS link
            JOIN public.products AS product
              ON product.organization_id = link.organization_id AND product.id = link.product_id
           WHERE link.organization_id = organization.id AND product.deleted_at IS NULL
        ),
        'maxImagesPerProduct', (
          SELECT COALESCE(pg_catalog.max(per_product.total), 0)
            FROM (
              SELECT pg_catalog.count(*) AS total
                FROM public.product_media AS link
                JOIN public.products AS product
                  ON product.organization_id = link.organization_id AND product.id = link.product_id
               WHERE link.organization_id = organization.id AND product.deleted_at IS NULL
               GROUP BY link.product_id
            ) AS per_product
        ),
        'activeGoals', (
          SELECT pg_catalog.count(*) FROM public.goals AS goal
           WHERE goal.organization_id = organization.id AND goal.status = 'active'
        )
      ),
      'offline', pg_catalog.jsonb_build_object(
        'activeGrants', (
          SELECT pg_catalog.count(*) FROM public.offline_grants AS lease
           WHERE lease.organization_id = organization.id
             AND lease.revoked_at IS NULL AND lease.expires_at > pg_catalog.now()
        ),
        'devices', (
          SELECT pg_catalog.count(DISTINCT lease.device_id) FROM public.offline_grants AS lease
           WHERE lease.organization_id = organization.id
             AND lease.revoked_at IS NULL AND lease.expires_at > pg_catalog.now()
        ),
        'lastSeenAt', (
          SELECT pg_catalog.max(device.last_seen_at)
            FROM public.devices AS device
           WHERE device.id IN (
             SELECT lease.device_id FROM public.offline_grants AS lease
              WHERE lease.organization_id = organization.id
           )
        )
      ),
      'sync', pg_catalog.jsonb_build_object(
        'lastReceivedAt', (
          SELECT pg_catalog.max(command.received_at) FROM public.sync_commands AS command
           WHERE command.organization_id = organization.id
        ),
        'last7Days', COALESCE((
          SELECT pg_catalog.jsonb_object_agg(recent.outcome_status, recent.total)
            FROM (
              SELECT command.outcome_status, pg_catalog.count(*) AS total
                FROM public.sync_commands AS command
               WHERE command.organization_id = organization.id
                 AND command.received_at > pg_catalog.now() - interval '7 days'
               GROUP BY command.outcome_status
            ) AS recent
        ), '{}'::jsonb),
        'rejectedByCode', COALESCE((
          SELECT pg_catalog.jsonb_object_agg(rejected.outcome_code, rejected.total)
            FROM (
              SELECT command.outcome_code, pg_catalog.count(*) AS total
                FROM public.sync_commands AS command
               WHERE command.organization_id = organization.id
                 AND command.outcome_status = 'rejected'
                 AND command.received_at > pg_catalog.now() - interval '7 days'
               GROUP BY command.outcome_code
            ) AS rejected
        ), '{}'::jsonb)
      ),
      'billingEvents', pg_catalog.jsonb_build_object(
        'byStatus', COALESCE((
          SELECT pg_catalog.jsonb_object_agg(counted.status, counted.total)
            FROM (
              SELECT event.status, pg_catalog.count(*) AS total
                FROM public.billing_events AS event
               WHERE event.organization_id = organization.id
               GROUP BY event.status
            ) AS counted
        ), '{}'::jsonb),
        'lastReceivedAt', (
          SELECT pg_catalog.max(event.received_at) FROM public.billing_events AS event
           WHERE event.organization_id = organization.id
        ),
        'oldestUnprocessedAt', (
          SELECT pg_catalog.min(event.received_at) FROM public.billing_events AS event
           WHERE event.organization_id = organization.id AND event.status IN ('received', 'failed')
        ),
        'maxAttempts', (
          SELECT COALESCE(pg_catalog.max(event.attempts), 0) FROM public.billing_events AS event
           WHERE event.organization_id = organization.id
        )
      )
    )
    FROM public.organizations AS organization
    WHERE organization.id = p_organization_id
  );
END;
$function$;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.admin_organizations_overview(text, integer, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_organization_diagnostics(text) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_organizations_overview(text, integer, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_organization_diagnostics(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_organizations_overview(text, integer, text) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_organization_diagnostics(text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
