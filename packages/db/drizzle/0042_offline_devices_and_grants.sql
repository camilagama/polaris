CREATE TABLE "devices" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"label" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_id" text NOT NULL,
	CONSTRAINT "devices_label_format" CHECK ("devices"."label" IS NULL OR (char_length("devices"."label") BETWEEN 1 AND 80 AND "devices"."label" = btrim("devices"."label") AND "devices"."label" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "offline_grants" (
	"authorization_epoch" integer NOT NULL,
	"device_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"user_id" text NOT NULL,
	CONSTRAINT "offline_grants_epoch_non_negative" CHECK ("offline_grants"."authorization_epoch" >= 0),
	CONSTRAINT "offline_grants_window" CHECK ("offline_grants"."expires_at" > "offline_grants"."issued_at" AND "offline_grants"."expires_at" <= "offline_grants"."issued_at" + interval '72 hours'),
	CONSTRAINT "offline_grants_revocation_consistent" CHECK (("offline_grants"."revoked_at" IS NULL) = ("offline_grants"."revoked_reason" IS NULL) AND ("offline_grants"."revoked_reason" IS NULL OR "offline_grants"."revoked_reason" IN ('device_revoked', 'user_revoked', 'security_event', 'organization_suspended')))
);
--> statement-breakpoint
ALTER TABLE "offline_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The composite foreign key of offline_grants needs this unique index first.
CREATE UNIQUE INDEX "devices_user_id_id_unique" ON "devices" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grants" ADD CONSTRAINT "offline_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grants" ADD CONSTRAINT "offline_grants_user_device_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "public"."devices"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_grants" ADD CONSTRAINT "offline_grants_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_created_idx" ON "devices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "offline_grants_org_user_device_idx" ON "offline_grants" USING btree ("organization_id","user_id","device_id","issued_at");--> statement-breakpoint
CREATE INDEX "offline_grants_device_idx" ON "offline_grants" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE POLICY "devices_current_user_select" ON "devices" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING ("devices"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "devices_current_user_insert" ON "devices" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK ("devices"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "devices_current_user_update" ON "devices" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING ("devices"."user_id" = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK ("devices"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "offline_grants_current_tenant_select" ON "offline_grants" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
      "offline_grants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
      AND "offline_grants"."user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS membership_scope
        WHERE membership_scope.organization_id = "offline_grants"."organization_id"
          AND membership_scope.user_id = "offline_grants"."user_id"
          AND membership_scope.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization_scope
        WHERE organization_scope.id = "offline_grants"."organization_id"
          AND organization_scope.status = 'active'
      )
    );--> statement-breakpoint
CREATE POLICY "offline_grants_current_tenant_insert" ON "offline_grants" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
      "offline_grants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
      AND "offline_grants"."user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS membership_scope
        WHERE membership_scope.organization_id = "offline_grants"."organization_id"
          AND membership_scope.user_id = "offline_grants"."user_id"
          AND membership_scope.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization_scope
        WHERE organization_scope.id = "offline_grants"."organization_id"
          AND organization_scope.status = 'active'
      )
    );--> statement-breakpoint
CREATE POLICY "offline_grants_current_tenant_update" ON "offline_grants" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
      "offline_grants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
      AND "offline_grants"."user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS membership_scope
        WHERE membership_scope.organization_id = "offline_grants"."organization_id"
          AND membership_scope.user_id = "offline_grants"."user_id"
          AND membership_scope.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization_scope
        WHERE organization_scope.id = "offline_grants"."organization_id"
          AND organization_scope.status = 'active'
      )
    ) WITH CHECK (
      "offline_grants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
      AND "offline_grants"."user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1
        FROM public.memberships AS membership_scope
        WHERE membership_scope.organization_id = "offline_grants"."organization_id"
          AND membership_scope.user_id = "offline_grants"."user_id"
          AND membership_scope.status = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.organizations AS organization_scope
        WHERE organization_scope.id = "offline_grants"."organization_id"
          AND organization_scope.status = 'active'
      )
    );
--> statement-breakpoint
ALTER TABLE public.devices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offline_grants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.devices, public.offline_grants FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.devices, public.offline_grants FROM polaris_pr11_runtime;--> statement-breakpoint
-- Devices and grants are never deleted by the runtime; a row only changes
-- through the revocation and bookkeeping columns granted below.
GRANT SELECT, INSERT ON TABLE public.devices, public.offline_grants TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (label, last_seen_at, revoked_at) ON TABLE public.devices TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON TABLE public.offline_grants TO polaris_pr11_runtime;--> statement-breakpoint
-- A revoked device or grant stays revoked: revocation is terminal.
CREATE FUNCTION public.guard_device_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.label IS DISTINCT FROM OLD.label
          OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at) THEN
    RAISE EXCEPTION 'a revoked device cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'devices_revocation_terminal';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_device_revocation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER devices_revocation_terminal
  BEFORE UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.guard_device_revocation();--> statement-breakpoint
CREATE FUNCTION public.guard_offline_grant_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'a revoked offline grant cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'offline_grants_revocation_terminal';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_offline_grant_revocation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER offline_grants_revocation_terminal
  BEFORE UPDATE ON public.offline_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_offline_grant_revocation();--> statement-breakpoint
-- A grant can only be issued to a live device of the same user. The device row
-- is locked FOR SHARE so a concurrent revocation either runs first (and the
-- grant is refused) or waits for the grant and then revokes it.
CREATE FUNCTION public.require_live_device_for_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_revoked_at timestamptz;
  v_found boolean;
BEGIN
  SELECT d.revoked_at, true
    INTO v_revoked_at, v_found
    FROM public.devices AS d
   WHERE d.user_id = NEW.user_id
     AND d.id = NEW.device_id
     FOR SHARE;
  IF v_found IS NOT TRUE OR v_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an offline grant needs a live device'
      USING ERRCODE = '23514', CONSTRAINT = 'offline_grants_live_device_required';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.require_live_device_for_grant() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER offline_grants_require_live_device
  BEFORE INSERT ON public.offline_grants
  FOR EACH ROW EXECUTE FUNCTION public.require_live_device_for_grant();
