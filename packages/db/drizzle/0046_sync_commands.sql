CREATE TABLE "sync_commands" (
	"command_id" uuid NOT NULL,
	"command_type" text NOT NULL,
	"device_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lease_grant_id" uuid,
	"organization_id" text NOT NULL,
	"outcome_code" text,
	"outcome_result" jsonb,
	"outcome_status" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "sync_commands_outcome_status_allowed" CHECK ("sync_commands"."outcome_status" IN ('accepted', 'rejected')),
	CONSTRAINT "sync_commands_outcome_coherent" CHECK (("sync_commands"."outcome_status" = 'accepted' AND "sync_commands"."outcome_code" IS NULL) OR ("sync_commands"."outcome_status" = 'rejected' AND "sync_commands"."outcome_code" IS NOT NULL AND "sync_commands"."outcome_result" IS NULL)),
	CONSTRAINT "sync_commands_outcome_code_format" CHECK ("sync_commands"."outcome_code" IS NULL OR "sync_commands"."outcome_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "sync_commands_command_type_format" CHECK ("sync_commands"."command_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length("sync_commands"."command_type") <= 100),
	CONSTRAINT "sync_commands_payload_hash_format" CHECK ("sync_commands"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "sync_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_commands_organization_command_unique" ON "sync_commands" USING btree ("organization_id","command_id");--> statement-breakpoint
CREATE INDEX "sync_commands_organization_received_idx" ON "sync_commands" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE POLICY "sync_commands_current_tenant_select" ON "sync_commands" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        "sync_commands"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1 FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "sync_commands"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
      );--> statement-breakpoint
CREATE POLICY "sync_commands_current_tenant_insert" ON "sync_commands" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "sync_commands"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "sync_commands"."user_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1 FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "sync_commands"."organization_id"
            AND membership_scope.user_id = "sync_commands"."user_id"
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "sync_commands"."organization_id"
            AND organization_scope.status = 'active'
        )
      );
--> statement-breakpoint
ALTER TABLE public.sync_commands FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sync_commands FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sync_commands FROM polaris_pr11_runtime;--> statement-breakpoint
-- Read and insert only: an outcome, once given, is never edited or deleted.
GRANT SELECT, INSERT ON TABLE public.sync_commands TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.guard_sync_command_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'a sync command outcome is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'sync_commands_immutable';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_sync_command_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER sync_commands_immutable
  BEFORE UPDATE ON public.sync_commands
  FOR EACH ROW EXECUTE FUNCTION public.guard_sync_command_immutable();
