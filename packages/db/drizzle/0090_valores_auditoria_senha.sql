-- New values of the auth audit event type for the password flows (ADR 0100, section 2; P8a, merged right before P8):
-- the login lock and unlock and the password change, reset and first definition. Only the type grows: expand-only, so
-- the previous Worker keeps working, and no row, function or grant uses the new values here.
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'login_locked';--> statement-breakpoint
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'login_unlocked';--> statement-breakpoint
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'password_changed';--> statement-breakpoint
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'password_reset_completed';--> statement-breakpoint
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'password_set';
