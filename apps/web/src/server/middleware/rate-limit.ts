import type { MiddlewareHandler } from "hono";
import { limiterKey } from "../auth/abuse-protection";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";

const sessionCookiePattern = /^(?:__Secure-)?better-auth\.session_token$/;
const MAX_IDENTITY_LENGTH = 512;
const READ_PROCEDURE_PATTERN = /^(?:list|get|find|search|ping)(?:[A-Z]|$)/;

interface RateLimitOptions {
  /** Cloudflare Workers Rate Limiting binding for this scope. */
  binding: (bindings: WorkerBindings) => RateLimitBinding | undefined;
  /** Narrows the requests that count against the limit. */
  applies: (request: Request) => boolean;
  /** Stable scope name; namespaces the hashed limiter keys. */
  scope: string;
}

/** oRPC clients call every procedure with POST, so reads are told apart by name. */
export function isRpcMutationRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    return false;
  }
  const procedure = new URL(request.url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  return !(procedure && READ_PROCEDURE_PATTERN.test(procedure));
}

export function isMediaUploadRequest(request: Request): boolean {
  return request.method.toUpperCase() === "POST";
}

function sessionCookie(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (
      separator > 0 &&
      sessionCookiePattern.test(part.slice(0, separator).trim())
    ) {
      const value = part.slice(separator + 1).trim();
      return value.length > 0 && value.length <= MAX_IDENTITY_LENGTH
        ? value
        : undefined;
    }
  }
  return undefined;
}

function clientIp(request: Request): string | undefined {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  return value && value.length <= 64 ? value : undefined;
}

async function isWithinLimit(
  limiter: RateLimitBinding,
  secret: string,
  scope: string,
  request: Request
): Promise<boolean> {
  const identities = [
    ["ip", clientIp(request)],
    ["session", sessionCookie(request)],
  ] as const;
  const results = await Promise.all(
    identities.map(async ([kind, identity]) =>
      identity === undefined
        ? { success: true }
        : await limiter.limit({
            key: await limiterKey(secret, `${scope}-${kind}`, identity),
          })
    )
  );

  return results.every((result) => result.success !== false);
}

/**
 * Per-user (session) and per-IP quota for expensive authenticated endpoints.
 *
 * The user identity is the hashed session cookie: the middleware runs before
 * authentication so it cannot know the user id, but a valid session always
 * maps to the same bucket, and the additional IP bucket stops a client from
 * rotating junk cookies to dodge the limit. Keys are HMAC digests, so neither
 * cookies nor addresses reach the limiter or logs.
 *
 * When the binding is absent (local development, unit tests) the request is
 * not limited, and a single warning per isolate makes the gap visible in
 * production logs; the go-live checklist requires the binding. A limiter
 * outage fails open on purpose: a point-of-sale must keep selling, and the
 * binding is colo-local so errors are rare.
 */
export function createRateLimitMiddleware(
  options: RateLimitOptions
): MiddlewareHandler<ServerEnv> {
  let warnedAboutMissingBinding = false;

  return async (context, next) => {
    if (!options.applies(context.req.raw)) {
      await next();
      return;
    }

    const limiter = options.binding(context.env);
    const secret = context.env.BETTER_AUTH_SECRET;
    if (!(limiter && secret)) {
      if (!warnedAboutMissingBinding) {
        warnedAboutMissingBinding = true;
        console.warn({
          event: "rate_limit_binding_missing",
          scope: options.scope,
        });
      }
      await next();
      return;
    }

    let withinLimit: boolean;
    try {
      withinLimit = await isWithinLimit(
        limiter,
        secret,
        options.scope,
        context.req.raw
      );
    } catch (error) {
      console.error({
        errorName: error instanceof Error ? error.name : "UnknownError",
        event: "rate_limit_unavailable",
        requestId: context.get("requestId"),
        scope: options.scope,
      });
      withinLimit = true;
    }

    if (!withinLimit) {
      return context.json(
        {
          error: { code: "rate_limited" },
          requestId: context.get("requestId"),
        },
        429,
        { "Retry-After": "60" }
      );
    }

    await next();
  };
}

export const rpcMutationRateLimitMiddleware = createRateLimitMiddleware({
  applies: isRpcMutationRequest,
  binding: (bindings) => bindings.RPC_MUTATION_RATE_LIMIT,
  scope: "rpc-mutation",
});

export const mediaUploadRateLimitMiddleware = createRateLimitMiddleware({
  applies: isMediaUploadRequest,
  binding: (bindings) => bindings.MEDIA_UPLOAD_RATE_LIMIT,
  scope: "media-upload",
});
