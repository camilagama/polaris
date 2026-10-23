-- A list price of 0,00 counts as not informed in the public catalog (product rule of 22/10/2026, AC-12 of the public catalog cut).
-- The catalog never shows "R$ 0,00": with variants at 0,00 and 49,90 the list says "a partir de R$ 49,90", and with every price
-- zero or null the site shows the text it already shows for a missing price. The rule is one expression, `NULLIF(list_price, 0)`,
-- in the two functions that give a price to the public, so the list, the product page and the search description cannot disagree:
--   - `public_catalog_products`: `priceFrom` is the minimum of the prices that are not zero (null when none is left);
--   - `public_catalog_product`: the `price` of a variant at 0,00 is null.
-- The data does not change: `product_variants.list_price` keeps the 0,00 the ERP wrote (the check of 0044 allows it), and the
-- sale, the export and the ERP read it as before. Only the output of the public functions changes.
-- Expand only (ADR 0096): same signatures and same result shape. The previous Worker gets `null` where it got "0.00" and shows the
-- text of a missing price, which is the new behavior; no window where one version breaks.
-- The two bodies are those of 0060 with the expression above and `pg_temp` last in the search path (ADR 0093; 0077 had set it with
-- ALTER FUNCTION and CREATE OR REPLACE sets it again from the clause). They are replaced as their owner, the way 0078 and 0097 did:
-- CREATE on `public` and SET on the role only for the moment, given back at once. The owner and the EXECUTE grants stay (CREATE OR
-- REPLACE does not touch them).
GRANT CREATE ON SCHEMA public TO polaris_catalog_owner;--> statement-breakpoint
GRANT polaris_catalog_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_catalog_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.public_catalog_products(p_slug text, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
          SELECT pg_catalog.min(NULLIF(variant.list_price, 0))
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
CREATE OR REPLACE FUNCTION public.public_catalog_product(p_slug text, p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
            'price', NULLIF(variant.list_price, 0)::text
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
RESET ROLE;--> statement-breakpoint
REVOKE polaris_catalog_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_catalog_owner;
