CREATE TABLE "customers" (
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"email" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"organization_id" text NOT NULL,
	"phone" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customers_name_not_blank" CHECK (char_length(btrim("customers"."name")) >= 1),
	CONSTRAINT "customers_contact_required" CHECK (
          ("customers"."phone" IS NOT NULL OR "customers"."email" IS NOT NULL)
          AND ("customers"."phone" IS NULL OR char_length(btrim("customers"."phone")) >= 1)
          AND ("customers"."email" IS NULL OR char_length(btrim("customers"."email")) >= 1)
        ),
	CONSTRAINT "customers_version_positive" CHECK ("customers"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_organization_archive_name_idx" ON "customers" USING btree ("organization_id","archived_at","name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_organization_id_id_unique" ON "customers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE POLICY "customers_current_tenant_select" ON "customers" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
    "customers"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "customers"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "customers"."organization_id"
        AND organization_scope.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "customers_current_tenant_insert" ON "customers" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
    "customers"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "customers"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "customers"."organization_id"
        AND organization_scope.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY "customers_current_tenant_update" ON "customers" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
    "customers"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "customers"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "customers"."organization_id"
        AND organization_scope.status = 'active'
    )
  ) WITH CHECK (
    "customers"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public.memberships AS membership_scope
      WHERE membership_scope.organization_id = "customers"."organization_id"
        AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
        AND membership_scope.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization_scope
      WHERE organization_scope.id = "customers"."organization_id"
        AND organization_scope.status = 'active'
    )
  );
--> statement-breakpoint
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.customers FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.customers FROM polaris_pr11_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customers TO polaris_pr11_runtime;
