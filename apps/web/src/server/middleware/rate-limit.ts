import { traverseContractProcedures } from "@orpc/server";
import {
  type ProcedureKind,
  type ProcedureMeta,
  polarisContract,
} from "@polaris/contracts";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import type { MiddlewareHandler } from "hono";
import { limiterKey } from "../auth/abuse-protection";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";

const sessionCookiePattern = /^(?:__Secure-)?better-auth\.session_token$/;
const MAX_IDENTITY_LENGTH = 512;
const RPC_PREFIX = "/rpc/";

type KeyType = "ip" | "session";

/** One quota: the bucket it reports in the 429 log, and the binding that counts each kind of key. */
export interface RateLimitRule {
  /** What the 429 log says denied it (`write`, `read`, `media-upload`); never a key. */
  bucket: string;
  bindings: Record<
    KeyType,
    (bindings: WorkerBindings) => RateLimitBinding | undefined
  >;
  /** Stable scope name; namespaces the hashed limiter keys. */
  scope: string;
}

interface RateLimitOptions {
  /** The quota a request counts against; null when it counts against none. */
  rule: (request: Request) => RateLimitRule | null;
}

/** The kind each procedure of the contract declares, by its path under `/rpc/` (`sale/confirm`). */
const procedureKinds: ReadonlyMap<string, ProcedureKind> = (() => {
  const kinds = new Map<string, ProcedureKind>();
  traverseContractProcedures(
    { path: [], router: polarisContract },
    ({ contract, path }) => {
      const { kind } = contract["~orpc"].meta as ProcedureMeta;
      if (kind) {
        kinds.set(path.join("/"), kind);
      }
    }
  );
  return kinds;
})();

/**
 * The bucket of an RPC call, by the `kind` its procedure declares in the contract (oRPC calls every
 * procedure with POST, so the method says nothing). A path the contract does not know, or a procedure
 * without a kind, counts as a write: a new procedure never escapes the write quota by its name. GET,
 * HEAD and OPTIONS run no procedure and count against nothing, as before.
 */
export function rpcProcedureKind(request: Request): ProcedureKind | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    return null;
  }
  const { pathname } = new URL(request.url);
  const path = pathname.startsWith(RPC_PREFIX)
    ? pathname.slice(RPC_PREFIX.length)
    : pathname;
  return procedureKinds.get(path) ?? "write";
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

/** The keys this request is counted by: the address and the session, the ones it carries. */
function identities(request: Request): [KeyType, string][] {
  const found: [KeyType, string][] = [];
  const ip = clientIp(request);
  if (ip !== undefined) {
    found.push(["ip", ip]);
  }
  const session = sessionCookie(request);
  if (session !== undefined) {
    found.push(["session", session]);
  }
  return found;
}

/** The kinds of key whose bucket is exhausted; empty when the request is within every limit. */
async function deniedKeyTypes(
  counted: [KeyType, RateLimitBinding, string][],
  secret: string,
  scope: string
): Promise<KeyType[]> {
  const results = await Promise.all(
    counted.map(async ([keyType, limiter, identity]) => ({
      keyType,
      result: await limiter.limit({
        key: await limiterKey(secret, `${scope}-${keyType}`, identity),
      }),
    }))
  );
  return results
    .filter(({ result }) => result.success === false)
    .map(({ keyType }) => keyType);
}

/**
 * Per-user (session) and per-IP quotas for authenticated endpoints; every bucket a request counts in can
 * refuse it.
 *
 * The user identity is the hashed session cookie: the middleware runs before
 * authentication so it cannot know the user id, but a valid session always
 * maps to the same bucket, and the additional IP bucket stops a client from
 * rotating junk cookies to dodge the limit. Keys are HMAC digests, so neither
 * cookies nor addresses reach the limiter or logs; nothing the client chooses
 * (an organization, a forwarded address, a header of its own) is ever a key.
 *
 * When a binding is absent (local development, unit tests) its keys are not
 * limited, and a single warning per isolate and binding makes the gap visible
 * in production logs; the go-live checklist requires the bindings. A limiter
 * outage fails open on purpose: a point-of-sale must keep selling, and the
 * binding is colo-local so errors are rare. A 429 names the bucket and the
 * kind of key that denied it in the log, never the key.
 */
export function createRateLimitMiddleware(
  options: RateLimitOptions
): MiddlewareHandler<ServerEnv> {
  const warnedAboutMissingBinding = new Set<string>();
  const warnMissing = (scope: string) => {
    if (!warnedAboutMissingBinding.has(scope)) {
      warnedAboutMissingBinding.add(scope);
      logger.warn("rate_limit_binding_missing", { scope });
    }
  };

  return async (context, next) => {
    const rule = options.rule(context.req.raw);
    if (!rule) {
      await next();
      return;
    }

    const secret = context.env.BETTER_AUTH_SECRET;
    if (!secret) {
      warnMissing(rule.scope);
      await next();
      return;
    }
    const counted: [KeyType, RateLimitBinding, string][] = [];
    for (const [keyType, identity] of identities(context.req.raw)) {
      const limiter = rule.bindings[keyType](context.env);
      if (limiter) {
        counted.push([keyType, limiter, identity]);
      } else {
        warnMissing(`${rule.scope}-${keyType}`);
      }
    }

    let denied: KeyType[];
    try {
      denied = await deniedKeyTypes(counted, secret, rule.scope);
    } catch (error) {
      logger.error("rate_limit_unavailable", {
        ...describeError(error),
        requestId: context.get("requestId"),
        scope: rule.scope,
      });
      denied = [];
    }

    if (denied.length > 0) {
      logger.warn("rate_limited", {
        bucket: rule.bucket,
        keyType: denied.join("+"),
        requestId: context.get("requestId"),
        route: new URL(context.req.url).pathname,
        scope: rule.scope,
      });
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

/** Writes: 120 per minute per session and per address (`RPC_MUTATION_RATE_LIMIT`), as before the split. */
export const RPC_WRITE_RULE: RateLimitRule = {
  bindings: {
    ip: (bindings) => bindings.RPC_MUTATION_RATE_LIMIT,
    session: (bindings) => bindings.RPC_MUTATION_RATE_LIMIT,
  },
  bucket: "write",
  scope: "rpc-mutation",
};

/**
 * Reads: a bucket of their own, so the app's own reads (the sync pull, the summaries) never spend the
 * write quota. The address bucket (`RPC_READ_IP_RATE_LIMIT`) is wider than the session one
 * (`RPC_READ_RATE_LIMIT`): every device of a store, and the stores behind one carrier address, share it.
 */
const RPC_READ_RULE: RateLimitRule = {
  bindings: {
    ip: (bindings) => bindings.RPC_READ_IP_RATE_LIMIT,
    session: (bindings) => bindings.RPC_READ_RATE_LIMIT,
  },
  bucket: "read",
  scope: "rpc-read",
};

const MEDIA_UPLOAD_RULE: RateLimitRule = {
  bindings: {
    ip: (bindings) => bindings.MEDIA_UPLOAD_RATE_LIMIT,
    session: (bindings) => bindings.MEDIA_UPLOAD_RATE_LIMIT,
  },
  bucket: "media-upload",
  scope: "media-upload",
};

export const rpcRateLimitMiddleware = createRateLimitMiddleware({
  rule: (request) => {
    const kind = rpcProcedureKind(request);
    if (kind === null) {
      return null;
    }
    return kind === "read" ? RPC_READ_RULE : RPC_WRITE_RULE;
  },
});

export const mediaUploadRateLimitMiddleware = createRateLimitMiddleware({
  rule: (request) => (isMediaUploadRequest(request) ? MEDIA_UPLOAD_RULE : null),
});
