CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_length" CHECK (char_length(btrim("categories"."name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_organization_id_name_idx" ON "categories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE POLICY "categories_current_tenant_select" ON "categories" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        "categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "categories"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "categories"."organization_id"
            AND organization_scope.status = 'active'
        )
      );--> statement-breakpoint
CREATE POLICY "categories_current_tenant_insert" ON "categories" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        "categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "categories"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "categories"."organization_id"
            AND organization_scope.status = 'active'
        )
      );
--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "categories" FROM "polaris_pr11_runtime";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "categories" TO "polaris_pr11_runtime";--> statement-breakpoint
DO $create_onboarding_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'polaris_onboarding_runtime'
  ) THEN
    EXECUTE 'CREATE ROLE polaris_onboarding_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$create_onboarding_role$;--> statement-breakpointCREATE FUNCTION public.create_initial_organization(
  p_user_id text,
  p_organization_id text,
  p_name text,
  p_timezone text,
  p_request_id uuid
)
RETURNS TABLE (
  created boolean,
  id text,
  name text,
  timezone text,
  currency text,
  status text,
  created_at timestamp,
  updated_at timestamp
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_email_verified boolean;
  v_membership_count integer;
  v_existing_organization_id text;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' OR p_user_id <> btrim(p_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_user_id';
  END IF;

  IF p_organization_id IS NULL OR p_organization_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_organization_id';
  END IF;

  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_organization_name';
  END IF;

  IF p_timezone IS NULL OR char_length(btrim(p_timezone)) NOT BETWEEN 1 AND 64
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names AS timezone_name
       WHERE timezone_name.name = p_timezone
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'invalid_timezone';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    1347374145,
    pg_catalog.hashtext(p_user_id)
  );

  SELECT identity.email_verified
  INTO v_email_verified
  FROM public."user" AS identity
  WHERE identity.id = p_user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'user_not_found';
  END IF;

  IF v_email_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'email_not_verified';
  END IF;

  SELECT count(*)::integer, min(membership.organization_id)
  INTO v_membership_count, v_existing_organization_id
  FROM public.memberships AS membership
  WHERE membership.user_id = p_user_id;

  IF v_membership_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'polaris_initial_organization_error',
      DETAIL = 'multiple_existing_organizations';
  END IF;

  IF v_membership_count = 1 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.organizations AS organization
      WHERE organization.id = v_existing_organization_id
        AND organization.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'polaris_initial_organization_error',
        DETAIL = 'organization_not_available';
    END IF;

    RETURN QUERY
    SELECT false, organization.id, organization.name, organization.timezone,
           organization.currency, organization.status,
           organization.created_at, organization.updated_at
    FROM public.organizations AS organization
    WHERE organization.id = v_existing_organization_id;
    RETURN;
  END IF;

  INSERT INTO public.organizations (id, name, timezone)
  VALUES (p_organization_id, btrim(p_name), p_timezone);

  INSERT INTO public.memberships (organization_id, user_id)
  VALUES (p_organization_id, p_user_id);

  INSERT INTO public.tenant_audit_event (
    organization_id,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    request_id
  )
  VALUES (
    p_organization_id,
    p_user_id,
    'organization.created',
    'organization',
    p_organization_id,
    p_request_id
  );

  RETURN QUERY
  SELECT true, organization.id, organization.name, organization.timezone,
         organization.currency, organization.status,
         organization.created_at, organization.updated_at
  FROM public.organizations AS organization
  WHERE organization.id = p_organization_id
    AND organization.status = 'active';
  RETURN;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_initial_organization(text, text, text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_initial_organization(text, text, text, text, uuid) TO "polaris_onboarding_runtime";