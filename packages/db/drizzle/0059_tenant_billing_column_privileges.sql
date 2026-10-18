-- What a tenant may read of the billing record and of its grants (ADR 0057, emenda): the
-- columns the product shows or derives entitlements from, and nothing the
-- billing lifecycle keeps for itself. A new column starts invisible to the
-- tenant until it is granted here, so the next one cannot leak by default.
--
-- organization_billing: not the provider's subscription reference, the clock of
-- facts, nor the memory of payments taken back (revoked_*).
REVOKE SELECT ON TABLE public.organization_billing FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT (
  organization_id, state, access_ends_at, cancel_at_period_end, cycle_months,
  pending_cycle_months, trial_started_at, over_limit_since, provider,
  created_at, updated_at, version
) ON TABLE public.organization_billing TO polaris_pr11_runtime;--> statement-breakpoint
-- entitlement_grants: not the reason (an internal note), nor who gave or ended a grant.
REVOKE SELECT ON TABLE public.entitlement_grants FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT (
  id, organization_id, key, limit_value, flag_value, starts_at, expires_at,
  revoked_at, created_at
) ON TABLE public.entitlement_grants TO polaris_pr11_runtime;
