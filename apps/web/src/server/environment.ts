import type { RequestIdVariables } from "hono/request-id";

interface HyperdriveBinding {
  connectionString: string;
}

interface RateLimitBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

export interface WorkerBindings {
  AUTH_ABUSE_PROTECTION_ENABLED?: string;
  AUTH_EMAIL_RATE_LIMITER?: RateLimitBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  BETTER_AUTH_BASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_REPLY_TO?: string;
  EMAIL_PASSWORD_AUTH_ENABLED?: string;
  RESEND_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  DB_POC_ENABLED: string;
  DB_RLS_POC_ENABLED: string;
  HYPERDRIVE: HyperdriveBinding;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables;
}
