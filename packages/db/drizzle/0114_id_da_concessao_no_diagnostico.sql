-- The Admin's diagnostics of an organization (ADR 0071) now says the ID of each entitlement grant it lists, so that
-- the operator on the screen of a support case can end the one she sees (ADR 0070 to 0073, amended). Only that: no
-- other field is added, the function reads the same rows of the same table for the same organization, and the
-- grants stay listed with the same key, value, start, end and revocation.
-- `polaris_admin_owner` reads `entitlement_grants` by column (0062); the function is the only thing that runs as it,
-- so the one privilege added is SELECT on the `id` column for that NOLOGIN owner. No role that signs in gains any
-- privilege, no function is added, and EXECUTE on the function stays with `polaris_admin_runtime` alone.
-- Expand only (ADR 0096): the same signature, so CREATE OR REPLACE keeps the owner and the grants of 0062 and 0077
-- (the search_path is restated because a replace without it would clear it); the previous Worker ignores the extra key.
GRANT SELECT (id) ON TABLE public.entitlement_grants TO polaris_admin_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_organization_diagnostics(p_organization_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
            'id', grant_row.id,
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
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
