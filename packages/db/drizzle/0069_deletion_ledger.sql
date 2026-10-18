CREATE TABLE "deletion_ledger" (
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"operation" text NOT NULL,
	"organization_id" text NOT NULL,
	"privacy_case_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_ledger_kind_allowed" CHECK (("deletion_ledger"."entity_type" = 'customer' AND "deletion_ledger"."operation" = 'anonymize')
        OR ("deletion_ledger"."entity_type" = 'organization' AND "deletion_ledger"."operation" = 'purge')),
	CONSTRAINT "deletion_ledger_ids_opaque" CHECK ("deletion_ledger"."entity_id" ~ '^[A-Za-z0-9_-]{1,64}$'
        AND "deletion_ledger"."organization_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "deletion_ledger_entity_shape" CHECK (("deletion_ledger"."entity_type" <> 'customer'
          OR "deletion_ledger"."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        AND ("deletion_ledger"."entity_type" <> 'organization' OR "deletion_ledger"."entity_id" = "deletion_ledger"."organization_id"))
);
--> statement-breakpoint
ALTER TABLE "deletion_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_ledger_entity_operation_unique" ON "deletion_ledger" USING btree ("entity_type","entity_id","operation");--> statement-breakpoint
CREATE INDEX "deletion_ledger_recorded_idx" ON "deletion_ledger" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "deletion_ledger_organization_idx" ON "deletion_ledger" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "deletion_ledger_customer_anonymization_insert" ON "deletion_ledger" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "deletion_ledger"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "deletion_ledger"."entity_type" = 'customer'
        AND "deletion_ledger"."operation" = 'anonymize'
        AND "deletion_ledger"."privacy_case_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "deletion_ledger"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "deletion_ledger"."organization_id"
            AND organization_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.customers AS customer_scope
          WHERE customer_scope.id::text = "deletion_ledger"."entity_id"
            AND customer_scope.organization_id = "deletion_ledger"."organization_id"
            AND customer_scope.anonymized_at IS NOT NULL
        ));--> statement-breakpoint
CREATE POLICY "deletion_ledger_privacy_owner_select" ON "deletion_ledger" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING (true);
--> statement-breakpoint
ALTER TABLE "deletion_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.deletion_ledger FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner;--> statement-breakpoint
-- append-only: the tenant runtime inserts the four columns of a tombstone (never the case, the ID or the
-- time) and reads, updates and deletes nothing; no policy allows an UPDATE or a DELETE to anyone
GRANT INSERT (organization_id, entity_type, entity_id, operation) ON TABLE public.deletion_ledger TO polaris_pr11_runtime;--> statement-breakpoint
-- the privacy owner reads the ledger for a restore (the purge will also write to it, in its own migration)
GRANT SELECT ON TABLE public.deletion_ledger TO polaris_privacy_owner;
