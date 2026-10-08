-- Cap every Better Auth refresh at the session's immutable 30-day deadline.
CREATE OR REPLACE FUNCTION public.cap_auth_session_expiration()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;

  NEW.expires_at := LEAST(
    NEW.expires_at,
    NEW.created_at + INTERVAL '30 days'
  );
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
UPDATE public.session
SET expires_at = LEAST(expires_at, created_at + INTERVAL '30 days')
WHERE expires_at > created_at + INTERVAL '30 days';
--> statement-breakpoint
CREATE TRIGGER session_absolute_expiration
BEFORE INSERT OR UPDATE OF created_at, expires_at
ON public.session
FOR EACH ROW
EXECUTE FUNCTION public.cap_auth_session_expiration();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cap_auth_session_expiration() TO polaris_pr11_runtime;