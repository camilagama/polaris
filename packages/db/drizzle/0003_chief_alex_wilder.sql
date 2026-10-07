CREATE TYPE "public"."auth_security_audit_event_type" AS ENUM('google_login_started', 'google_callback_succeeded', 'google_callback_failed', 'logout_succeeded', 'logout_failed');--> statement-breakpoint
CREATE TYPE "public"."auth_security_audit_outcome" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "auth_security_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "auth_security_audit_event_type" NOT NULL,
	"outcome" "auth_security_audit_outcome" NOT NULL,
	"provider" text,
	"actor_id" text,
	"request_id" text NOT NULL,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_security_audit_event_actor_created_idx" ON "auth_security_audit_event" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_security_audit_event_request_idx" ON "auth_security_audit_event" USING btree ("request_id");--> statement-breakpoint
GRANT USAGE ON TYPE "public"."auth_security_audit_event_type", "public"."auth_security_audit_outcome" TO polaris_pr11_runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE "auth_security_audit_event" TO polaris_pr11_runtime;
