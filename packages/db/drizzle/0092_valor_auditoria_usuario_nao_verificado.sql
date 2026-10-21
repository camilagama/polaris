-- New value of the auth audit event type for the purge of a user never verified (P10 of the entry screen, ADR 0100,
-- Q-D2): `unverified_user_deleted`. Only the type grows: expand-only, so the previous Worker keeps working, and no row,
-- function or grant uses the new value here (the function that writes it comes in the next migration).
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE IF NOT EXISTS 'unverified_user_deleted';
