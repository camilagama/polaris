import type { Hono } from "hono";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";

/** A limiter that lets everything through, for tests that are not about the limit. */
const allowAllRateLimiter: RateLimitBinding = {
  limit: () => Promise.resolve({ success: true }),
};

const testClientIp = "203.0.113.9";

/**
 * Gives a test app what the Google sign-in start and callback now require: a client IP (Cloudflare
 * sets it at the edge) and the limiter binding. Tests of the limit itself build their own.
 */
export function withSocialRateLimit(app: Hono<ServerEnv>) {
  return {
    request: (
      path: string,
      init: { headers?: Record<string, string> } & RequestInit,
      bindings: WorkerBindings
    ) =>
      app.request(
        path,
        {
          ...init,
          headers: { "cf-connecting-ip": testClientIp, ...init.headers },
        },
        { ...bindings, AUTH_SOCIAL_RATE_LIMITER: allowAllRateLimiter }
      ),
  };
}
