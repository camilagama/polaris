-- The people who run Polaris (plan PR93, ADR 0070). The Admin app has its own
-- database role: it can read the principals and refresh the e-mail snapshot and
-- the last-seen time, and nothing else. It cannot create a principal (that is a
-- runbook step done by the database owner), so a valid Access login alone does
-- not make anyone an operator, and it holds no privilege on any tenant table.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_admin_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_admin_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_admin_runtime;--> statement-breakpoint
CREATE TABLE "platform_principals" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_snapshot" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"issuer" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"subject" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_principals_role_allowed" CHECK ("platform_principals"."role" IN ('platform_owner')),
	CONSTRAINT "platform_principals_status_allowed" CHECK ("platform_principals"."status" IN ('active', 'disabled')),
	CONSTRAINT "platform_principals_issuer_allowed" CHECK (char_length("platform_principals"."issuer") BETWEEN 1 AND 512 AND "platform_principals"."issuer" ~ '^https://'),
	CONSTRAINT "platform_principals_subject_allowed" CHECK (char_length("platform_principals"."subject") BETWEEN 1 AND 512),
	CONSTRAINT "platform_principals_email_allowed" CHECK ("platform_principals"."email_snapshot" IS NULL OR char_length("platform_principals"."email_snapshot") <= 320)
);
--> statement-breakpoint
ALTER TABLE "platform_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_principals_identity_unique" ON "platform_principals" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "platform_principals_status_idx" ON "platform_principals" USING btree ("status");--> statement-breakpoint
CREATE POLICY "platform_principals_admin_select" ON "platform_principals" AS PERMISSIVE FOR SELECT TO "polaris_admin_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "platform_principals_admin_update" ON "platform_principals" AS PERMISSIVE FOR UPDATE TO "polaris_admin_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "platform_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE public.platform_principals TO polaris_admin_runtime;--> statement-breakpoint
GRANT UPDATE (email_snapshot, last_seen_at, updated_at) ON TABLE public.platform_principals TO polaris_admin_runtime;
