CREATE TABLE "billing_events" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"fact" jsonb NOT NULL,
	"fact_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"organization_id" text,
	"outcome_code" text,
	"processed_at" timestamp with time zone,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_after" text,
	"state_before" text,
	"status" text DEFAULT 'received' NOT NULL,
	CONSTRAINT "billing_events_provider_format" CHECK ("billing_events"."provider" ~ '^[a-z][a-z0-9_]{1,31}$' AND char_length("billing_events"."provider_event_id") BETWEEN 1 AND 160),
	CONSTRAINT "billing_events_provider_ref_length" CHECK ("billing_events"."provider_ref" IS NULL OR char_length("billing_events"."provider_ref") BETWEEN 1 AND 128),
	CONSTRAINT "billing_events_fact_type_allowed" CHECK ("billing_events"."fact_type" IN ('trial_method_ready', 'charge_succeeded', 'charge_failed', 'subscription_cancelled', 'cycle_change_scheduled', 'time_elapsed', 'command')),
	CONSTRAINT "billing_events_status_allowed" CHECK ("billing_events"."status" IN ('received', 'applied', 'ignored', 'failed')),
	CONSTRAINT "billing_events_outcome_allowed" CHECK ("billing_events"."outcome_code" IS NULL OR "billing_events"."outcome_code" IN ('not_applicable', 'stale', 'reference_mismatch', 'unknown_organization', 'error')),
	CONSTRAINT "billing_events_fact_is_small_object" CHECK (jsonb_typeof("billing_events"."fact") = 'object' AND pg_column_size("billing_events"."fact") < 2048),
	CONSTRAINT "billing_events_attempts_nonnegative" CHECK ("billing_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "cycle_months" integer;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "last_fact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "pending_cycle_months" integer;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_unique" ON "billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_organization_idx" ON "billing_events" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "billing_events_pending_idx" ON "billing_events" USING btree ("received_at") WHERE "billing_events"."status" IN ('received', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "organization_billing_provider_ref_unique" ON "organization_billing" USING btree ("provider","provider_ref") WHERE "organization_billing"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_billing_due_idx" ON "organization_billing" USING btree ("access_ends_at") WHERE "organization_billing"."state" IN ('trialing', 'active', 'grace');--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_cycle_allowed" CHECK (("organization_billing"."cycle_months" IS NULL OR "organization_billing"."cycle_months" IN (1, 6, 12)) AND ("organization_billing"."pending_cycle_months" IS NULL OR "organization_billing"."pending_cycle_months" IN (1, 6, 12)));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_free_has_no_subscription_flags" CHECK (
        "organization_billing"."state" IN ('trialing', 'active', 'grace')
        OR (NOT "organization_billing"."cancel_at_period_end" AND "organization_billing"."cycle_months" IS NULL AND "organization_billing"."pending_cycle_months" IS NULL)
      );--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_provider_coherent" CHECK (
        ("organization_billing"."provider" IS NULL AND "organization_billing"."provider_ref" IS NULL)
        OR (
          "organization_billing"."provider" ~ '^[a-z][a-z0-9_]{1,31}$'
          AND char_length("organization_billing"."provider_ref") BETWEEN 1 AND 128
        )
      );--> statement-breakpoint
CREATE POLICY "billing_events_current_tenant_select" ON "billing_events" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING ("billing_events"."organization_id" IS NOT NULL AND 
  "billing_events"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "billing_events"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "billing_events"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
-- The billing path (ADR 0062): webhooks, the sweep of expired access and the
-- command that starts a trial write the billing record through their own role,
-- never through the tenant request path, which keeps no write on billing. Same
-- layout as the media cleanup roles (migrations 0026 and 0052).
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_billing_owner') THEN
    EXECUTE 'CREATE ROLE polaris_billing_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_billing_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_billing_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
ALTER TABLE public.billing_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.billing_events FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.billing_events TO polaris_pr11_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_billing_owner, polaris_billing_runtime;--> statement-breakpoint
-- the billing record: read, create and change only the columns the lifecycle owns
GRANT SELECT, INSERT ON TABLE public.organization_billing TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (state, access_ends_at, trial_started_at, cancel_at_period_end, cycle_months, pending_cycle_months, last_fact_at, provider, provider_ref, updated_at, version)
  ON TABLE public.organization_billing TO polaris_billing_runtime;--> statement-breakpoint
CREATE POLICY organization_billing_billing_runtime_select ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_billing_runtime USING (true);--> statement-breakpoint
CREATE POLICY organization_billing_billing_runtime_insert ON public.organization_billing
  AS PERMISSIVE FOR INSERT TO polaris_billing_runtime WITH CHECK (true);--> statement-breakpoint
CREATE POLICY organization_billing_billing_runtime_update ON public.organization_billing
  AS PERMISSIVE FOR UPDATE TO polaris_billing_runtime USING (true) WITH CHECK (true);--> statement-breakpoint
-- the inbox and ledger: append, and record how a row was processed; never delete
GRANT SELECT, INSERT ON TABLE public.billing_events TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (organization_id, status, outcome_code, state_before, state_after, attempts, processed_at)
  ON TABLE public.billing_events TO polaris_billing_runtime;--> statement-breakpoint
CREATE POLICY billing_events_billing_runtime_select ON public.billing_events
  AS PERMISSIVE FOR SELECT TO polaris_billing_runtime USING (true);--> statement-breakpoint
CREATE POLICY billing_events_billing_runtime_insert ON public.billing_events
  AS PERMISSIVE FOR INSERT TO polaris_billing_runtime WITH CHECK (true);--> statement-breakpoint
CREATE POLICY billing_events_billing_runtime_update ON public.billing_events
  AS PERMISSIVE FOR UPDATE TO polaris_billing_runtime USING (true) WITH CHECK (true);--> statement-breakpoint
-- what the over-limit check may read (only inside its SECURITY DEFINER function)
GRANT SELECT (plan_id, key, limit_value) ON TABLE public.plan_entitlements TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY plan_entitlements_billing_owner_read ON public.plan_entitlements
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, id, deleted_at) ON TABLE public.products TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY products_billing_owner_select ON public.products
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id) ON TABLE public.product_variants TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY product_variants_billing_owner_select ON public.product_variants
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id) ON TABLE public.product_media TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY product_media_billing_owner_select ON public.product_media
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, status) ON TABLE public.goals TO polaris_billing_owner;--> statement-breakpoint
CREATE POLICY goals_billing_owner_select ON public.goals
  AS PERMISSIVE FOR SELECT TO polaris_billing_owner USING (true);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_billing_owner;--> statement-breakpoint
CREATE FUNCTION public.organization_exceeds_free_limits(p_organization_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  variants_limit integer;
  images_limit integer;
  per_product_limit integer;
  goals_limit integer;
BEGIN
  -- The same limits and the same counts the writes enforce (ADR 0058): variants
  -- and images of products that were not deleted, images per product, active goals.
  SELECT
    max(limit_value) FILTER (WHERE key = 'variants.active.max'),
    max(limit_value) FILTER (WHERE key = 'images.active.max'),
    max(limit_value) FILTER (WHERE key = 'images.per_product.max'),
    max(limit_value) FILTER (WHERE key = 'goals.active.max')
  INTO variants_limit, images_limit, per_product_limit, goals_limit
  FROM public.plan_entitlements
  WHERE plan_id = 'free';

  IF variants_limit IS NULL OR images_limit IS NULL OR per_product_limit IS NULL OR goals_limit IS NULL THEN
    RAISE EXCEPTION 'the free plan limits are incomplete'
      USING ERRCODE = '22023';
  END IF;

  RETURN
    (
      SELECT pg_catalog.count(*)
      FROM public.product_variants AS variant
      JOIN public.products AS product
        ON product.organization_id = variant.organization_id
       AND product.id = variant.product_id
      WHERE variant.organization_id = p_organization_id
        AND product.deleted_at IS NULL
    ) > variants_limit
    OR (
      SELECT pg_catalog.count(*)
      FROM public.product_media AS link
      JOIN public.products AS product
        ON product.organization_id = link.organization_id
       AND product.id = link.product_id
      WHERE link.organization_id = p_organization_id
        AND product.deleted_at IS NULL
    ) > images_limit
    OR EXISTS (
      SELECT 1
      FROM public.product_media AS link
      JOIN public.products AS product
        ON product.organization_id = link.organization_id
       AND product.id = link.product_id
      WHERE link.organization_id = p_organization_id
        AND product.deleted_at IS NULL
      GROUP BY link.product_id
      HAVING pg_catalog.count(*) > per_product_limit
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM public.goals AS goal
      WHERE goal.organization_id = p_organization_id
        AND goal.status = 'active'
    ) > goals_limit;
END;
$function$;--> statement-breakpoint
GRANT polaris_billing_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.organization_exceeds_free_limits(text) OWNER TO polaris_billing_owner;--> statement-breakpoint
SET ROLE polaris_billing_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_exceeds_free_limits(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.organization_exceeds_free_limits(text) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_billing_owner;
