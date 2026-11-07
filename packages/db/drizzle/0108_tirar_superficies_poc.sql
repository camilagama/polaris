-- expand-contract: contract nenhum Worker do app lê ou grava estas tabelas de prova (só o Worker de prova PR11 e os gates, que agora criam a própria tabela na base descartável); o Worker anterior não as usa
DROP POLICY IF EXISTS "rls_poc_operations_organization_isolation" ON "rls_poc_operations";--> statement-breakpoint
DROP TABLE IF EXISTS "rls_poc_operations";--> statement-breakpoint
DROP TABLE IF EXISTS "db_poc_operations";
