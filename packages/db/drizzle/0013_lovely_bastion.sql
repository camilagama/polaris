ALTER TABLE "categories" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_organization_name_unique" ON "categories" USING btree ("organization_id",lower(btrim("name")));--> statement-breakpoint
CREATE POLICY "categories_current_tenant_update" ON "categories" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
        "categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "categories"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "categories"."organization_id"
            AND organization_scope.status = 'active'
        )
      ) WITH CHECK (
        "categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "categories"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "categories"."organization_id"
            AND organization_scope.status = 'active'
        )
      );
--> statement-breakpoint
GRANT UPDATE ON TABLE public.categories TO polaris_pr11_runtime;
