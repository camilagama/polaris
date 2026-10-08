ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memberships_current_user_select" ON "memberships" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        "memberships"."user_id" = NULLIF(current_setting('app.user_id', true), '')
        AND (
          NULLIF(current_setting('app.organization_id', true), '') IS NULL
          OR "memberships"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        )
      );--> statement-breakpoint
CREATE POLICY "memberships_current_user_insert" ON "memberships" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "memberships"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "memberships"."user_id" = NULLIF(current_setting('app.user_id', true), '')
        AND "memberships"."role" = 'owner'
        AND "memberships"."status" = 'active'
      );--> statement-breakpoint
CREATE POLICY "organizations_active_tenant_select" ON "organizations" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        "organizations"."id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "organizations"."status" = 'active'
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "organizations"."id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
      );--> statement-breakpoint
CREATE POLICY "organizations_context_insert" ON "organizations" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "organizations"."id" = NULLIF(current_setting('app.organization_id', true), '')
        AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
        AND "organizations"."status" = 'active'
      );--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "memberships", "organizations" TO "polaris_pr11_runtime";
