CREATE TABLE "goal_target_changes" (
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	"goal_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"new_target" numeric NOT NULL,
	"organization_id" text NOT NULL,
	"previous_target" numeric NOT NULL,
	CONSTRAINT "goal_target_changes_targets_allowed" CHECK ("goal_target_changes"."new_target" > 0 AND "goal_target_changes"."previous_target" > 0 AND "goal_target_changes"."new_target" <> "goal_target_changes"."previous_target")
);
--> statement-breakpoint
ALTER TABLE "goal_target_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals" (
	"achieved_value" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_on" date NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"organization_id" text NOT NULL,
	"settled_at" timestamp with time zone,
	"starts_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"target" numeric NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goals_kind_allowed" CHECK ("goals"."kind" IN ('net_sales', 'operating_result', 'sale_count')),
	CONSTRAINT "goals_status_allowed" CHECK ("goals"."status" IN ('active', 'completed', 'missed', 'cancelled')),
	CONSTRAINT "goals_target_allowed" CHECK (
          "goals"."target" > 0
          AND (
            ("goals"."kind" = 'sale_count' AND scale("goals"."target") = 0 AND "goals"."target" <= 1000000)
            OR ("goals"."kind" <> 'sale_count' AND scale("goals"."target") <= 2 AND "goals"."target" < 1000000000000000000)
          )
        ),
	CONSTRAINT "goals_period_allowed" CHECK (
          "goals"."starts_on" >= DATE '2000-01-01'
          AND "goals"."ends_on" >= "goals"."starts_on"
          AND "goals"."ends_on" - "goals"."starts_on" < 366
        ),
	CONSTRAINT "goals_name_allowed" CHECK ("goals"."name" IS NULL OR (char_length(btrim("goals"."name")) >= 1 AND char_length("goals"."name") <= 100)),
	CONSTRAINT "goals_settlement_coherent" CHECK (
          ("goals"."status" IN ('completed', 'missed') AND "goals"."settled_at" IS NOT NULL AND "goals"."achieved_value" IS NOT NULL)
          OR ("goals"."status" IN ('active', 'cancelled') AND "goals"."achieved_value" IS NULL)
        ),
	CONSTRAINT "goals_version_positive" CHECK ("goals"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The composite foreign key of goal_target_changes needs this unique index first.
CREATE UNIQUE INDEX "goals_organization_id_id_unique" ON "goals" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "goal_target_changes" ADD CONSTRAINT "goal_target_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_target_changes" ADD CONSTRAINT "goal_target_changes_organization_goal_fk" FOREIGN KEY ("organization_id","goal_id") REFERENCES "public"."goals"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_target_changes_organization_goal_idx" ON "goal_target_changes" USING btree ("organization_id","goal_id","changed_at");--> statement-breakpoint
CREATE INDEX "goals_organization_status_period_idx" ON "goals" USING btree ("organization_id","status","starts_on");--> statement-breakpoint
CREATE POLICY "goal_target_changes_current_tenant_select" ON "goal_target_changes" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "goal_target_changes"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goal_target_changes"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goal_target_changes"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "goal_target_changes_current_tenant_insert" ON "goal_target_changes" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "goal_target_changes"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goal_target_changes"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goal_target_changes"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "goals_current_tenant_select" ON "goals" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "goals"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goals"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goals"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "goals_current_tenant_insert" ON "goals" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "goals"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goals"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goals"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "goals_current_tenant_update" ON "goals" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "goals"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goals"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goals"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "goals"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "goals"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "goals"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.goals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.goal_target_changes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.goals FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.goals FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.goal_target_changes FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.goal_target_changes FROM polaris_pr11_runtime;--> statement-breakpoint
-- No DELETE. Kind, period, organization and creation never change; only the
-- name, the target, the status and its settlement may.
GRANT SELECT, INSERT ON TABLE public.goals TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, target, status, achieved_value, settled_at, updated_at, version)
  ON TABLE public.goals TO polaris_pr11_runtime;--> statement-breakpoint
-- The history of target changes is append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON TABLE public.goal_target_changes TO polaris_pr11_runtime;
