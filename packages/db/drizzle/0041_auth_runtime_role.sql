-- Separate the Better Auth runtime from the tenant runtime.
--
-- Until now one role (polaris_pr11_runtime) served both. It therefore had
-- SELECT/INSERT/UPDATE/DELETE on the identity tables (user, account, session,
-- verification), which have no RLS: any arbitrary SQL running as the tenant
-- runtime could read every user and session token, or forge app.user_id for
-- any tenant. Tenant code never reads those tables, so they move to a role of
-- their own. Production connects each runtime through its own Hyperdrive login
-- role (a member of exactly one of the two roles); see the go-live checklist.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'polaris_auth_runtime') THEN
    CREATE ROLE polaris_auth_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."user", public.account, public.session, public.verification TO polaris_auth_runtime;--> statement-breakpoint
GRANT INSERT ON TABLE public.auth_security_audit_event TO polaris_auth_runtime;--> statement-breakpoint
GRANT USAGE ON TYPE public.auth_security_audit_event_type, public.auth_security_audit_outcome TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cap_auth_session_expiration() TO polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public."user", public.account, public.session, public.verification, public.auth_security_audit_event FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE USAGE ON TYPE public.auth_security_audit_event_type, public.auth_security_audit_outcome FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.cap_auth_session_expiration() FROM polaris_pr11_runtime;
