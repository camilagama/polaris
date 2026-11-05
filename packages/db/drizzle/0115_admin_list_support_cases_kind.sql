-- The Admin's list of cases can now be narrowed to one kind (`p_kind`: NULL for every kind, otherwise 'support' or
-- 'privacy', the closed list of the `support_cases_kind_allowed` check; anything else raises 22023). The Home counts the
-- open support cases from this list, so the page and its `next` cursor must hold only that kind.
-- Same function in every other way: SECURITY DEFINER owned by `polaris_admin_owner` with the search_path pinned to end
-- in pg_temp (0077), EXECUTE only for `polaris_admin_runtime` (0063), the same rows, the same order and the same cursor.
-- A new argument is a new signature, so the previous one is dropped instead of left as an overload with its own grant.
-- expand-contract: janela a lista de casos do Admin chama a assinatura de quatro argumentos; entre a migration e o deploy do Admin a tela de Casos e o Início respondem erro de leitura (só leitura, nenhum dado muda, o Admin é de uso interno e a tela refaz o pedido ao recarregar)
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
DROP FUNCTION public.admin_list_support_cases(text, text, integer, uuid);--> statement-breakpoint
CREATE FUNCTION public.admin_list_support_cases(p_status text, p_organization_id text, p_limit integer, p_after uuid, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('support', 'privacy') THEN
    RAISE EXCEPTION 'invalid_case_kind' USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT support_case.id, support_case.organization_id, organization.name AS organization_name,
             support_case.kind, support_case.reason, support_case.status,
             support_case.opened_at, support_case.closed_at
        FROM public.support_cases AS support_case
        JOIN public.organizations AS organization ON organization.id = support_case.organization_id
       WHERE (p_status IS NULL OR support_case.status = p_status)
         AND (p_organization_id IS NULL OR support_case.organization_id = p_organization_id)
         AND (p_kind IS NULL OR support_case.kind = p_kind)
         AND (p_after IS NULL OR support_case.id < p_after)
       ORDER BY support_case.id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'cases', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'organizationId', shown.organization_id,
            'organizationName', shown.organization_name,
            'kind', shown.kind,
            'reason', shown.reason,
            'status', shown.status,
            'openedAt', shown.opened_at,
            'closedAt', shown.closed_at
          ) ORDER BY shown.id DESC
        ) FROM shown
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
REVOKE ALL ON FUNCTION public.admin_list_support_cases(text, text, integer, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_list_support_cases(text, text, integer, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
