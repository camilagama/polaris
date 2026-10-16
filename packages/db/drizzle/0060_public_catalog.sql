-- The public catalog (plan PR87 and PR88, ADR 0069): the profile an organization
-- chooses to show, the products it chooses to show, and the only way anything
-- reaches the public. The public app has its own database role that can read no
-- table at all: it can only run four functions that return what is shown (never
-- an organization ID, a cost, a stock count or a customer) and that look at the
-- plan on every call, so a downgrade, a closed account or an unpublished product
-- stops being served without anything being written.
CREATE TABLE "product_publications" (
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text NOT NULL,
	"unpublished_at" timestamp with time zone,
	CONSTRAINT "product_publications_pk" PRIMARY KEY("organization_id","product_id"),
	CONSTRAINT "product_publications_actor_allowed" CHECK (char_length("product_publications"."published_by") BETWEEN 1 AND 128),
	CONSTRAINT "product_publications_period_coherent" CHECK ("product_publications"."unpublished_at" IS NULL OR "product_publications"."unpublished_at" >= "product_publications"."published_at")
);
--> statement-breakpoint
ALTER TABLE "product_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "public_catalog_profiles" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"instagram" text,
	"organization_id" text PRIMARY KEY NOT NULL,
	"public_name" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"slug" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"whatsapp" text,
	CONSTRAINT "public_catalog_profiles_slug_allowed" CHECK (
        char_length("public_catalog_profiles"."slug") BETWEEN 3 AND 40
        AND "public_catalog_profiles"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        AND "public_catalog_profiles"."slug" NOT IN ('admin', 'api', 'app', 'assets', 'catalog', 'catalogo', 'login', 'm', 'polaris', 'robots', 'sitemap', 'static', 'www')
      ),
	CONSTRAINT "public_catalog_profiles_name_allowed" CHECK (char_length(btrim("public_catalog_profiles"."public_name")) BETWEEN 1 AND 80),
	CONSTRAINT "public_catalog_profiles_description_allowed" CHECK ("public_catalog_profiles"."description" IS NULL OR char_length("public_catalog_profiles"."description") BETWEEN 1 AND 280),
	CONSTRAINT "public_catalog_profiles_whatsapp_allowed" CHECK ("public_catalog_profiles"."whatsapp" IS NULL OR "public_catalog_profiles"."whatsapp" ~ '^[0-9]{10,15}$'),
	CONSTRAINT "public_catalog_profiles_instagram_allowed" CHECK ("public_catalog_profiles"."instagram" IS NULL OR "public_catalog_profiles"."instagram" ~ '^[a-z0-9._]{1,30}$'),
	CONSTRAINT "public_catalog_profiles_published_coherent" CHECK (NOT "public_catalog_profiles"."published" OR "public_catalog_profiles"."published_at" IS NOT NULL),
	CONSTRAINT "public_catalog_profiles_version_positive" CHECK ("public_catalog_profiles"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "public_catalog_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_publications" ADD CONSTRAINT "product_publications_organization_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_catalog_profiles" ADD CONSTRAINT "public_catalog_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_publications_shown_idx" ON "product_publications" USING btree ("organization_id","published_at") WHERE "product_publications"."unpublished_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "public_catalog_profiles_slug_unique" ON "public_catalog_profiles" USING btree ("slug");--> statement-breakpoint
CREATE POLICY "product_publications_current_tenant_select" ON "product_publications" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "product_publications"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_publications"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_publications"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "product_publications_current_tenant_insert" ON "product_publications" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "product_publications"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_publications"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_publications"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "product_publications_current_tenant_update" ON "product_publications" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "product_publications"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_publications"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_publications"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "product_publications"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_publications"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_publications"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "public_catalog_profiles_current_tenant_select" ON "public_catalog_profiles" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "public_catalog_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "public_catalog_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "public_catalog_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "public_catalog_profiles_current_tenant_insert" ON "public_catalog_profiles" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "public_catalog_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "public_catalog_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "public_catalog_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "public_catalog_profiles_current_tenant_update" ON "public_catalog_profiles" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "public_catalog_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "public_catalog_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "public_catalog_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "public_catalog_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "public_catalog_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "public_catalog_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
ALTER TABLE public.public_catalog_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_publications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.public_catalog_profiles FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.product_publications FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
-- the tenant edits its own profile and its own publications: no delete (a product is unpublished, not erased)
GRANT SELECT, INSERT ON TABLE public.public_catalog_profiles TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (slug, public_name, description, whatsapp, instagram, published, published_at, updated_at, version)
  ON TABLE public.public_catalog_profiles TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_publications TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (published_at, published_by, unpublished_at)
  ON TABLE public.product_publications TO polaris_pr11_runtime;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_catalog_owner') THEN
    EXECUTE 'CREATE ROLE polaris_catalog_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_catalog_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_catalog_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_catalog_owner, polaris_catalog_runtime;--> statement-breakpoint
-- what the functions may read, and only inside them (the owner role is never a login)
GRANT SELECT (id, status) ON TABLE public.organizations TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY organizations_catalog_owner_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, state, access_ends_at) ON TABLE public.organization_billing TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY organization_billing_catalog_owner_select ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (plan_id, key, flag_value) ON TABLE public.plan_entitlements TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY plan_entitlements_catalog_owner_select ON public.plan_entitlements
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, key, flag_value, starts_at, expires_at, revoked_at) ON TABLE public.entitlement_grants TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY entitlement_grants_catalog_owner_select ON public.entitlement_grants
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, slug, public_name, description, whatsapp, instagram, published) ON TABLE public.public_catalog_profiles TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY public_catalog_profiles_catalog_owner_select ON public.public_catalog_profiles
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id, unpublished_at) ON TABLE public.product_publications TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY product_publications_catalog_owner_select ON public.product_publications
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, id, name, description, archived_at, deleted_at) ON TABLE public.products TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY products_catalog_owner_select ON public.products
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, id, product_id, list_price, position) ON TABLE public.product_variants TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY product_variants_catalog_owner_select ON public.product_variants
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id, variant_id, option_id, option_value_id) ON TABLE public.variant_option_values TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY variant_option_values_catalog_owner_select ON public.variant_option_values
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id, id, position) ON TABLE public.product_options TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY product_options_catalog_owner_select ON public.product_options
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id, id, name) ON TABLE public.product_option_values TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY product_option_values_catalog_owner_select ON public.product_option_values
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, product_id, media_asset_id, position) ON TABLE public.product_media TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY product_media_catalog_owner_select ON public.product_media
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, id, storage_key, content_type, byte_size, width, height) ON TABLE public.media_assets TO polaris_catalog_owner;--> statement-breakpoint
CREATE POLICY media_assets_catalog_owner_select ON public.media_assets
  AS PERMISSIVE FOR SELECT TO polaris_catalog_owner USING (true);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_catalog_owner;--> statement-breakpoint
-- whether the organization's plan in force includes the public catalog right now (plan or an unexpired
-- grant): the same rule the entitlement engine applies (ADR 0057), evaluated at every public read
CREATE FUNCTION public.organization_public_catalog_enabled(p_organization_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  pro_in_force boolean;
  plan_includes boolean;
BEGIN
  SELECT billing.state IN ('trialing', 'active', 'grace')
         AND billing.access_ends_at IS NOT NULL
         AND billing.access_ends_at > pg_catalog.now()
    INTO pro_in_force
    FROM public.organization_billing AS billing
   WHERE billing.organization_id = p_organization_id;
  SELECT COALESCE(entitlement.flag_value, false)
    INTO plan_includes
    FROM public.plan_entitlements AS entitlement
   WHERE entitlement.plan_id = CASE WHEN COALESCE(pro_in_force, false) THEN 'pro' ELSE 'free' END
     AND entitlement.key = 'public_catalog';
  RETURN COALESCE(plan_includes, false)
    OR EXISTS (
      SELECT 1
        FROM public.entitlement_grants AS granted
       WHERE granted.organization_id = p_organization_id
         AND granted.key = 'public_catalog'
         AND granted.flag_value IS TRUE
         AND granted.starts_at <= pg_catalog.now()
         AND granted.expires_at > pg_catalog.now()
         AND (granted.revoked_at IS NULL OR granted.revoked_at > granted.starts_at)
    );
END;
$function$;--> statement-breakpoint
-- the organization behind a public address, only while it is shown: the profile is switched on, the account is
-- active and the plan includes the public catalog; NULL otherwise (never says which of those is missing)
CREATE FUNCTION public.public_catalog_visible_organization(p_slug text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found text;
BEGIN
  SELECT profile.organization_id
    INTO found
    FROM public.public_catalog_profiles AS profile
    JOIN public.organizations AS organization ON organization.id = profile.organization_id
   WHERE profile.slug = p_slug
     AND profile.published
     AND organization.status = 'active';
  IF found IS NULL OR NOT public.organization_public_catalog_enabled(found) THEN
    RETURN NULL;
  END IF;
  RETURN found;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.public_catalog_profile(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found text;
BEGIN
  found := public.public_catalog_visible_organization(p_slug);
  IF found IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'slug', profile.slug,
      'name', profile.public_name,
      'description', profile.description,
      'whatsapp', profile.whatsapp,
      'instagram', profile.instagram
    )
    FROM public.public_catalog_profiles AS profile
    WHERE profile.organization_id = found
  );
END;
$function$;--> statement-breakpoint
-- the products shown, newest first, a page at a time: { products: [{ id, name, description, priceFrom, coverAssetId }], next }
CREATE FUNCTION public.public_catalog_products(p_slug text, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 60 THEN
    RAISE EXCEPTION 'invalid public catalog page size'
      USING ERRCODE = '22023';
  END IF;
  found := public.public_catalog_visible_organization(p_slug);
  IF found IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH page AS (
      SELECT
        product.id,
        product.name,
        product.description,
        (
          SELECT pg_catalog.min(variant.list_price)
          FROM public.product_variants AS variant
          WHERE variant.organization_id = product.organization_id
            AND variant.product_id = product.id
            AND variant.list_price IS NOT NULL
        ) AS price_from,
        (
          SELECT link.media_asset_id
          FROM public.product_media AS link
          WHERE link.organization_id = product.organization_id
            AND link.product_id = product.id
          ORDER BY link.position
          LIMIT 1
        ) AS cover_asset_id
      FROM public.product_publications AS publication
      JOIN public.products AS product
        ON product.organization_id = publication.organization_id
       AND product.id = publication.product_id
      WHERE publication.organization_id = found
        AND publication.unpublished_at IS NULL
        AND product.archived_at IS NULL
        AND product.deleted_at IS NULL
        AND (p_after IS NULL OR product.id < p_after)
      ORDER BY product.id DESC
      LIMIT p_limit + 1
    ),
    shown AS (
      SELECT * FROM page ORDER BY id DESC LIMIT p_limit
    )
    SELECT pg_catalog.jsonb_build_object(
      'products', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'name', shown.name,
            'description', shown.description,
            'priceFrom', shown.price_from::text,
            'coverAssetId', shown.cover_asset_id
          ) ORDER BY shown.id DESC
        )
        FROM shown
      ), '[]'::jsonb),
      'next', CASE
        WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
          THEN (SELECT shown.id FROM shown ORDER BY shown.id LIMIT 1)
        ELSE NULL
      END
    )
  );
END;
$function$;--> statement-breakpoint
-- one product that is shown, with its variants (a label from the option values, and the list price when there is one)
-- and its pictures in order; NULL when it is not shown
CREATE FUNCTION public.public_catalog_product(p_slug text, p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found text;
BEGIN
  found := public.public_catalog_visible_organization(p_slug);
  IF found IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'id', product.id,
      'name', product.name,
      'description', product.description,
      'variants', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', variant.id,
            'label', (
              SELECT pg_catalog.string_agg(option_value.name, ' / ' ORDER BY option.position)
              FROM public.variant_option_values AS chosen
              JOIN public.product_options AS option
                ON option.organization_id = chosen.organization_id
               AND option.product_id = chosen.product_id
               AND option.id = chosen.option_id
              JOIN public.product_option_values AS option_value
                ON option_value.organization_id = chosen.organization_id
               AND option_value.product_id = chosen.product_id
               AND option_value.id = chosen.option_value_id
              WHERE chosen.organization_id = variant.organization_id
                AND chosen.variant_id = variant.id
            ),
            'price', variant.list_price::text
          ) ORDER BY variant.position NULLS LAST, variant.id
        )
        FROM public.product_variants AS variant
        WHERE variant.organization_id = product.organization_id
          AND variant.product_id = product.id
      ), '[]'::jsonb),
      'media', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'assetId', link.media_asset_id,
            'width', asset.width,
            'height', asset.height
          ) ORDER BY link.position
        )
        FROM public.product_media AS link
        JOIN public.media_assets AS asset
          ON asset.organization_id = link.organization_id
         AND asset.id = link.media_asset_id
        WHERE link.organization_id = product.organization_id
          AND link.product_id = product.id
      ), '[]'::jsonb)
    )
    FROM public.product_publications AS publication
    JOIN public.products AS product
      ON product.organization_id = publication.organization_id
     AND product.id = publication.product_id
    WHERE publication.organization_id = found
      AND publication.product_id = p_product_id
      AND publication.unpublished_at IS NULL
      AND product.archived_at IS NULL
      AND product.deleted_at IS NULL
  );
END;
$function$;--> statement-breakpoint
-- where a public picture lives, only for a picture of a product that is shown; NULL otherwise
CREATE FUNCTION public.public_catalog_media(p_slug text, p_product_id uuid, p_asset_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found text;
BEGIN
  found := public.public_catalog_visible_organization(p_slug);
  IF found IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'storageKey', asset.storage_key,
      'contentType', asset.content_type,
      'byteSize', asset.byte_size
    )
    FROM public.product_publications AS publication
    JOIN public.products AS product
      ON product.organization_id = publication.organization_id
     AND product.id = publication.product_id
    JOIN public.product_media AS link
      ON link.organization_id = product.organization_id
     AND link.product_id = product.id
    JOIN public.media_assets AS asset
      ON asset.organization_id = link.organization_id
     AND asset.id = link.media_asset_id
    WHERE publication.organization_id = found
      AND publication.product_id = p_product_id
      AND publication.unpublished_at IS NULL
      AND product.archived_at IS NULL
      AND product.deleted_at IS NULL
      AND link.media_asset_id = p_asset_id
  );
END;
$function$;--> statement-breakpoint
GRANT polaris_catalog_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.organization_public_catalog_enabled(text) OWNER TO polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_visible_organization(text) OWNER TO polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_profile(text) OWNER TO polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_products(text, integer, uuid) OWNER TO polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_product(text, uuid) OWNER TO polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_media(text, uuid, uuid) OWNER TO polaris_catalog_owner;--> statement-breakpoint
SET ROLE polaris_catalog_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_public_catalog_enabled(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_catalog_visible_organization(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_catalog_profile(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_catalog_products(text, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_catalog_product(text, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.public_catalog_media(text, uuid, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
-- the public role runs the four functions that return what is shown, and nothing else
GRANT EXECUTE ON FUNCTION public.public_catalog_profile(text) TO polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.public_catalog_products(text, integer, uuid) TO polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.public_catalog_product(text, uuid) TO polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.public_catalog_media(text, uuid, uuid) TO polaris_catalog_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_catalog_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_catalog_owner;
