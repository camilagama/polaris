-- Free Over Limit (ADR 0064): the start of the adaptation window on the billing
-- record, and the record of which variants stay operational once an organization
-- is over the Free limit. The choice is a table of its own, never a property of
-- the variant.
CREATE TABLE "operational_variant_selections" (
	"episode_started_at" timestamp with time zone NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "operational_variant_selections_pk" PRIMARY KEY("organization_id","variant_id"),
	CONSTRAINT "operational_variant_selections_source_allowed" CHECK ("operational_variant_selections"."source" IN ('user', 'default'))
);
--> statement-breakpoint
ALTER TABLE "operational_variant_selections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "over_limit_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational_variant_selections" ADD CONSTRAINT "operational_variant_selections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_variant_selections" ADD CONSTRAINT "operational_variant_selections_organization_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_over_limit_since_coherent" CHECK ("organization_billing"."over_limit_since" IS NULL OR "organization_billing"."state" IN ('free_over_limit', 'trial_setup'));--> statement-breakpoint
CREATE POLICY "operational_variant_selections_current_tenant_select" ON "operational_variant_selections" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "operational_variant_selections"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "operational_variant_selections"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "operational_variant_selections"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "operational_variant_selections_current_tenant_insert" ON "operational_variant_selections" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "operational_variant_selections"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "operational_variant_selections"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "operational_variant_selections"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "operational_variant_selections_current_tenant_delete" ON "operational_variant_selections" AS PERMISSIVE FOR DELETE TO "polaris_pr11_runtime" USING (
  "operational_variant_selections"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "operational_variant_selections"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "operational_variant_selections"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
ALTER TABLE public.operational_variant_selections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.operational_variant_selections FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.operational_variant_selections FROM polaris_pr11_runtime;--> statement-breakpoint
-- No UPDATE: a choice is added or removed, never edited. The command that
-- changes it decides what may be removed (the window is open) or only added.
GRANT SELECT, INSERT, DELETE ON TABLE public.operational_variant_selections TO polaris_pr11_runtime;--> statement-breakpoint
-- the billing writer records when the free episode began (and clears it on leaving)
GRANT UPDATE (over_limit_since) ON TABLE public.organization_billing TO polaris_billing_runtime;
