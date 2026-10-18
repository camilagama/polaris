-- The transactional outbox (plan PR108, ADR 0082): an event written in the same transaction as the command
-- that causes it, for the dispatcher of PR110 to hand to a queue. The tenant runtime only inserts; nobody
-- else has a privilege here until PR110 adds the dispatcher's role in its own migration.
CREATE TABLE "event_outbox" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idempotency_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "event_outbox_status_allowed" CHECK ("event_outbox"."status" IN ('pending', 'dispatched')),
	CONSTRAINT "event_outbox_attempts_allowed" CHECK ("event_outbox"."attempts" >= 0),
	CONSTRAINT "event_outbox_type_format" CHECK ("event_outbox"."type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length("event_outbox"."type") <= 80),
	CONSTRAINT "event_outbox_tokens_format" CHECK ("event_outbox"."idempotency_key" ~ '^[A-Za-z0-9._:-]{1,128}$' AND "event_outbox"."correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "event_outbox_event_shape" CHECK (jsonb_typeof("event_outbox"."event") = 'object'
        AND octet_length("event_outbox"."event"::text) <= 2048
        AND NOT jsonb_path_exists("event_outbox"."event", 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][A-Za-z0-9]{0,31}$"))')
        AND NOT jsonb_path_exists("event_outbox"."event", 'strict $.* ? (@.type() == "object" || @.type() == "array" || @.type() == "null")')
        AND NOT jsonb_path_exists("event_outbox"."event", 'strict $.* ? (@.type() == "string" && !(@ like_regex "^[A-Za-z0-9_-]{1,64}$"))')
        AND NOT jsonb_path_exists("event_outbox"."event", 'strict $.* ? (@.type() == "number" && (@ % 1 != 0 || @ < -9007199254740991 || @ > 9007199254740991))'))
);
--> statement-breakpoint
ALTER TABLE "event_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_idempotency_unique" ON "event_outbox" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("available_at","id") WHERE "event_outbox"."status" = 'pending';--> statement-breakpoint
CREATE POLICY "event_outbox_tenant_insert" ON "event_outbox" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "event_outbox"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "event_outbox"."type" IN ('data_export.requested')
        AND "event_outbox"."status" = 'pending'
        AND "event_outbox"."attempts" = 0
        AND "event_outbox"."idempotency_key" = "event_outbox"."type" || ':' || ("event_outbox"."event" ->> 'exportId')
        AND EXISTS (
          SELECT 1
          FROM public.data_exports AS export_scope
          WHERE export_scope.id::text = "event_outbox"."event" ->> 'exportId'
            AND export_scope.organization_id = "event_outbox"."organization_id"
            AND export_scope.requested_by_user_id = NULLIF(current_setting('app.user_id', true), '')
        )
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "event_outbox"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "event_outbox"."organization_id"
            AND organization_scope.status = 'active'
        ));--> statement-breakpoint
ALTER TABLE "event_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.event_outbox FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner;--> statement-breakpoint
-- insert-only: the tenant runtime names the five columns of an event (never the ID, the status, the
-- attempts, the time or the creation time: those are the table's own) and reads, updates and deletes
-- nothing; no policy allows it either
GRANT INSERT (organization_id, type, event, idempotency_key, correlation_id) ON TABLE public.event_outbox TO polaris_pr11_runtime;
