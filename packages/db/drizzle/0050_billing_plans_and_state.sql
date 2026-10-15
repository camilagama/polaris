CREATE TABLE "billing_plans" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "billing_plans_id_allowed" CHECK ("billing_plans"."id" IN ('free', 'pro')),
	CONSTRAINT "billing_plans_name_allowed" CHECK (char_length(btrim("billing_plans"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "billing_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_prices" (
	"active" boolean DEFAULT true NOT NULL,
	"amount" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"interval_months" integer NOT NULL,
	"plan_id" text NOT NULL,
	CONSTRAINT "billing_prices_interval_allowed" CHECK ("billing_prices"."interval_months" IN (1, 6, 12)),
	CONSTRAINT "billing_prices_amount_allowed" CHECK ("billing_prices"."amount" > 0 AND scale("billing_prices"."amount") = 2 AND "billing_prices"."amount" < 1000000),
	CONSTRAINT "billing_prices_paid_plan" CHECK ("billing_prices"."plan_id" <> 'free')
);
--> statement-breakpoint
ALTER TABLE "billing_prices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"flag_value" boolean,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"limit_value" integer,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "entitlement_grants_key_value_coherent" CHECK (
        ("entitlement_grants"."key" IN ('goals.active.max', 'images.active.max', 'images.per_product.max', 'variants.active.max')
          AND "entitlement_grants"."limit_value" IS NOT NULL AND "entitlement_grants"."limit_value" >= 0 AND "entitlement_grants"."flag_value" IS NULL)
        OR ("entitlement_grants"."key" IN ('offline.write', 'public_catalog')
          AND "entitlement_grants"."flag_value" IS NOT NULL AND "entitlement_grants"."limit_value" IS NULL)
      ),
	CONSTRAINT "entitlement_grants_reason_allowed" CHECK (char_length(btrim("entitlement_grants"."reason")) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "entitlement_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_billing" (
	"access_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'free' NOT NULL,
	"trial_started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organization_billing_state_allowed" CHECK ("organization_billing"."state" IN ('free', 'trial_setup', 'trialing', 'active', 'grace', 'free_over_limit')),
	CONSTRAINT "organization_billing_access_coherent" CHECK (
        ("organization_billing"."state" IN ('trialing', 'active', 'grace') AND "organization_billing"."access_ends_at" IS NOT NULL)
        OR ("organization_billing"."state" IN ('free', 'trial_setup', 'free_over_limit') AND "organization_billing"."access_ends_at" IS NULL)
      ),
	CONSTRAINT "organization_billing_trial_recorded" CHECK ("organization_billing"."state" <> 'trialing' OR "organization_billing"."trial_started_at" IS NOT NULL),
	CONSTRAINT "organization_billing_version_positive" CHECK ("organization_billing"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "organization_billing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_entitlements" (
	"flag_value" boolean,
	"key" text NOT NULL,
	"limit_value" integer,
	"plan_id" text NOT NULL,
	CONSTRAINT "plan_entitlements_pk" PRIMARY KEY("plan_id","key"),
	CONSTRAINT "plan_entitlements_key_value_coherent" CHECK (
        ("plan_entitlements"."key" IN ('goals.active.max', 'images.active.max', 'images.per_product.max', 'variants.active.max')
          AND "plan_entitlements"."limit_value" IS NOT NULL AND "plan_entitlements"."limit_value" >= 0 AND "plan_entitlements"."flag_value" IS NULL)
        OR ("plan_entitlements"."key" IN ('offline.write', 'public_catalog')
          AND "plan_entitlements"."flag_value" IS NOT NULL AND "plan_entitlements"."limit_value" IS NULL)
      )
);
--> statement-breakpoint
ALTER TABLE "plan_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_prices" ADD CONSTRAINT "billing_prices_plan_id_billing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."billing_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_billing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."billing_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_prices_plan_idx" ON "billing_prices" USING btree ("plan_id","interval_months");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_prices_active_unique" ON "billing_prices" USING btree ("plan_id","interval_months") WHERE "billing_prices"."active";--> statement-breakpoint
CREATE INDEX "entitlement_grants_organization_idx" ON "entitlement_grants" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE POLICY "billing_plans_read" ON "billing_plans" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "billing_prices_read" ON "billing_prices" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "entitlement_grants_current_tenant_select" ON "entitlement_grants" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "entitlement_grants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "entitlement_grants"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "entitlement_grants"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "organization_billing_current_tenant_select" ON "organization_billing" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "organization_billing"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "organization_billing"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "organization_billing"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "plan_entitlements_read" ON "plan_entitlements" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (true);--> statement-breakpoint
-- The initial commercial hypotheses (PRODUCT.md). Seeded before FORCE RLS, since
-- the runtime role never writes this reference data. The remote gate compares
-- these rows with INITIAL_PLAN_CATALOG so the two cannot drift apart unnoticed.
INSERT INTO public.billing_plans (id, name) VALUES ('free', 'Free'), ('pro', 'Pro');--> statement-breakpoint
INSERT INTO public.plan_entitlements (plan_id, key, limit_value, flag_value) VALUES
  ('free', 'goals.active.max', 1, NULL),
  ('free', 'images.active.max', 50, NULL),
  ('free', 'images.per_product.max', 1, NULL),
  ('free', 'variants.active.max', 50, NULL),
  ('free', 'offline.write', NULL, false),
  ('free', 'public_catalog', NULL, false),
  ('pro', 'goals.active.max', 3, NULL),
  ('pro', 'images.active.max', 5000, NULL),
  ('pro', 'images.per_product.max', 10, NULL),
  ('pro', 'variants.active.max', 2000, NULL),
  ('pro', 'offline.write', NULL, true),
  ('pro', 'public_catalog', NULL, true);--> statement-breakpoint
INSERT INTO public.billing_prices (id, plan_id, interval_months, amount) VALUES
  ('pro_monthly', 'pro', 1, 24.90),
  ('pro_semiannual', 'pro', 6, 124.50),
  ('pro_annual', 'pro', 12, 249.00);--> statement-breakpoint
ALTER TABLE public.billing_plans FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.billing_prices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.plan_entitlements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.organization_billing FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.entitlement_grants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.billing_plans FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.billing_prices FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.plan_entitlements FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.organization_billing FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.billing_plans FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.billing_prices FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.plan_entitlements FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.organization_billing FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.entitlement_grants FROM polaris_pr11_runtime;--> statement-breakpoint
-- The runtime only reads: the catalog is reference data, and billing state and
-- grants change through the billing lifecycle (later phases), not through the
-- tenant request path.
GRANT SELECT ON TABLE public.billing_plans TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.billing_prices TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.plan_entitlements TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.organization_billing TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.entitlement_grants TO polaris_pr11_runtime;
