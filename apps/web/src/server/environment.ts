import type { RequestIdVariables } from "hono/request-id";

interface HyperdriveBinding {
  connectionString: string;
}

interface RateLimitBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

export interface WorkerBindings {
  AUTH_DATABASE_CONNECT_TIMEOUT_MS?: string;
  AUTH_ABUSE_PROTECTION_ENABLED?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_RATE_LIMITER?: RateLimitBinding;
  AUTH_EMAIL_REPLY_TO?: string;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  BETTER_AUTH_BASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  DB_POC_ENABLED: string;
  DB_RLS_POC_ENABLED: string;
  EMAIL_PASSWORD_AUTH_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  HYPERDRIVE: HyperdriveBinding;
  ONBOARDING_HYPERDRIVE?: HyperdriveBinding;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables;
}
