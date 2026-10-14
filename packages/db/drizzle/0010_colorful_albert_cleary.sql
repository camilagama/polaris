ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_actor_nonempty";--> statement-breakpoint
ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_type_nonempty";--> statement-breakpoint
ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_entity_type_nonempty";--> statement-breakpoint
ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_entity_id_nonempty";--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_actor_id_length" CHECK (char_length(btrim("tenant_audit_event"."actor_user_id")) BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_event_type_format" CHECK (char_length("tenant_audit_event"."event_type") BETWEEN 1 AND 128 AND "tenant_audit_event"."event_type" ~ '^[a-z][a-z0-9_.-]*$');--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_entity_type_format" CHECK (char_length("tenant_audit_event"."entity_type") BETWEEN 1 AND 64 AND "tenant_audit_event"."entity_type" ~ '^[a-z][a-z0-9_]*$');--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_entity_id_format" CHECK (char_length("tenant_audit_event"."entity_id") BETWEEN 1 AND 255 AND "tenant_audit_event"."entity_id" ~ '^[A-Za-z0-9._:-]+$');