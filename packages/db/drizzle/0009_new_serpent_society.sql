CREATE TABLE "tenant_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"request_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_audit_actor_nonempty" CHECK (btrim("tenant_audit_event"."actor_user_id") <> ''),
	CONSTRAINT "tenant_audit_type_nonempty" CHECK (btrim("tenant_audit_event"."event_type") <> ''),
	CONSTRAINT "tenant_audit_entity_type_nonempty" CHECK (btrim("tenant_audit_event"."entity_type") <> ''),
	CONSTRAINT "tenant_audit_entity_id_nonempty" CHECK (btrim("tenant_audit_event"."entity_id") <> '')
);
--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_event_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_audit_event_org_created_idx" ON "tenant_audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_audit_event_request_idx" ON "tenant_audit_event" USING btree ("request_id");--> statement-breakpoint
CREATE POLICY "tenant_audit_event_current_actor_insert" ON "tenant_audit_event" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "tenant_audit_event"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "tenant_audit_event"."actor_user_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "tenant_audit_event"."organization_id"
            AND membership_scope.user_id = "tenant_audit_event"."actor_user_id"
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "tenant_audit_event"."organization_id"
            AND organization_scope.status = 'active'
        )
      );--> statement-breakpoint
ALTER TABLE "tenant_audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "tenant_audit_event" FROM "polaris_pr11_runtime";--> statement-breakpoint
GRANT INSERT ON TABLE "tenant_audit_event" TO "polaris_pr11_runtime";
