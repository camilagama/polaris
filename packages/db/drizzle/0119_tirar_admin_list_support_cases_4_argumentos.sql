-- expand-contract: contract o Admin que chama admin_list_support_cases com quatro argumentos saiu: o repositório só chama a assinatura com p_kind (0115) e o Admin do staging roda código posterior a ela; a assinatura de cinco argumentos continua com o mesmo corpo, dono e grants
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
DROP FUNCTION public.admin_list_support_cases(text, text, integer, uuid);--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;
