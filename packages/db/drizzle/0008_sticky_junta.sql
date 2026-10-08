DROP POLICY "memberships_current_user_insert" ON "memberships" CASCADE;--> statement-breakpoint
DROP POLICY "organizations_context_insert" ON "organizations" CASCADE;--> statement-breakpoint
REVOKE INSERT ON TABLE "memberships", "organizations" FROM "polaris_pr11_runtime";
