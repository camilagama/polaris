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
import { sessionCookieName } from "../auth/security-options";
import { clientIp } from "../client-ip";
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";

const MAX_IDENTITY_LENGTH = 512;
const RPC_PREFIX = "/rpc/";
const EDGE_SLASHES = /^\/|\/$/g;

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
  /** The route the 429 log names: never a path the client made up (it could flood the log with its own text). */
  route: (request: Request) => string;
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
  return procedureKinds.get(procedurePath(request)) ?? "write";
}

/** The procedure's path as oRPC matches it: one leading and one trailing slash do not name another procedure. */
function procedurePath(request: Request): string {
  const { pathname } = new URL(request.url);
  const path = pathname.startsWith(RPC_PREFIX)
    ? pathname.slice(RPC_PREFIX.length)
    : pathname;
  return path.replace(EDGE_SLASHES, "");
}

/** The procedure's route when the contract knows it; any other path is logged as one. */
function rpcRoute(request: Request): string {
  const path = procedurePath(request);
  return procedureKinds.has(path) ? `${RPC_PREFIX}${path}` : "/rpc/<unknown>";
}

export function isMediaUploadRequest(request: Request): boolean {
  return request.method.toUpperCase() === "POST";
}

/**
 * The session a cookie value names, as Better Auth reads it (quotes off, percent-escapes decoded): the token
 * before the signature's dot, so that no spelling of one session, and no signature, opens another bucket.
 */
function sessionIdentity(raw: string): string | undefined {
  let value = raw.trim();
  // better-call's rule, to the letter: a leading quote drops the first character and always the last one
  if (value.codePointAt(0) === 34) {
    value = value.slice(1, -1);
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    // an escape that does not decode is kept as it came, as Better Auth keeps it
  }
  const token = value.split(".", 1)[0] ?? "";
  return token.length > 0 && token.length <= MAX_IDENTITY_LENGTH
    ? token
    : undefined;
}

/** The value of the one cookie Better Auth uses for the session in this environment, by its exact name. */
function sessionCookie(
  request: Request,
  name: string | undefined
): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return sessionIdentity(part.slice(separator + 1));
    }
  }
  return undefined;
}

/** The keys this request is counted by: the address and the session, the ones it carries. */
function identities(
  request: Request,
  cookieName: string | undefined
): [KeyType, string][] {
  const found: [KeyType, string][] = [];
  const ip = clientIp(request);
  if (ip !== undefined) {
    found.push(["ip", ip]);
  }
  const session = sessionCookie(request, cookieName);
  if (session !== undefined) {
    found.push(["session", session]);
  }
  return found;
}

/**
 * The kinds of key whose bucket is exhausted (empty when the request is within every limit that answered),
 * and the first failure of a limiter. A limiter that fails opens only its own key: another key's refusal stands.
 */
async function deniedKeyTypes(
  counted: [KeyType, RateLimitBinding, string][],
  secret: string,
  scope: string
): Promise<{ denied: KeyType[]; failure: unknown }> {
  const results = await Promise.allSettled(
    counted.map(async ([keyType, limiter, identity]) => ({
      keyType,
      result: await limiter.limit({
        key: await limiterKey(secret, `${scope}-${keyType}`, identity),
      }),
    }))
  );
  const denied: KeyType[] = [];
  let failure: unknown;
  for (const settled of results) {
    if (settled.status === "rejected") {
      failure ??= settled.reason;
    } else if (settled.value.result.success === false) {
      denied.push(settled.value.keyType);
    }
  }
  return { denied, failure };
}

/**
 * Per-user (session) and per-IP quotas for authenticated endpoints; every bucket a request counts in can
 * refuse it.
 *
 * The user identity is the hashed session cookie, read by the one name Better Auth gives it for the
 * base URL (`sessionCookieName`): the middleware runs before
 * authentication so it cannot know the user id, but a valid session always
 * maps to the same bucket, and the additional IP bucket stops a client from
 * rotating junk cookies to dodge the limit. The address is the IPv4 address, or the /64 of an IPv6 one.
 * Keys are HMAC digests, so neither cookies nor addresses reach the limiter or logs; nothing the client chooses
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
  let warnedAboutSessionCookieName = false;
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
    const cookieName = sessionCookieName(context.env.BETTER_AUTH_BASE_URL);
    if (cookieName === undefined && !warnedAboutSessionCookieName) {
      // without a cookie name only the address bucket counts
      warnedAboutSessionCookieName = true;
      logger.warn("rate_limit_session_cookie_name_missing", {
        scope: rule.scope,
      });
    }
    const counted: [KeyType, RateLimitBinding, string][] = [];
    for (const [keyType, identity] of identities(context.req.raw, cookieName)) {
      const limiter = rule.bindings[keyType](context.env);
      if (limiter) {
        counted.push([keyType, limiter, identity]);
      } else {
        warnMissing(`${rule.scope}-${keyType}`);
      }
    }

    const { denied, failure } = await deniedKeyTypes(
      counted,
      secret,
      rule.scope
    );
    if (failure !== undefined) {
      logger.error("rate_limit_unavailable", {
        ...describeError(failure),
        requestId: context.get("requestId"),
        scope: rule.scope,
      });
    }

    if (denied.length > 0) {
      logger.warn("rate_limited", {
        bucket: rule.bucket,
        keyType: denied.join("+"),
        requestId: context.get("requestId"),
        route: options.route(context.req.raw),
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

/**
 * Many rows in one call (the slices of a spreadsheet import, `kind: "bulk"`): a bucket of their own
 * (`RPC_BULK_RATE_LIMIT`, per session and per address), with few calls per minute. Counted as one write, a call
 * would multiply the write limit by its rows; counted as one write per row, it would leave the sales of the same
 * session without quota. It spends neither: the write bucket stays whole for the sales during an import.
 */
const RPC_BULK_RULE: RateLimitRule = {
  bindings: {
    ip: (bindings) => bindings.RPC_BULK_RATE_LIMIT,
    session: (bindings) => bindings.RPC_BULK_RATE_LIMIT,
  },
  bucket: "bulk",
  scope: "rpc-bulk",
};

/** The bucket of each kind; a kind missing here counts as a write. */
const RPC_RULES: Partial<Record<ProcedureKind, RateLimitRule>> = {
  bulk: RPC_BULK_RULE,
  read: RPC_READ_RULE,
  write: RPC_WRITE_RULE,
};

/** The quota a kind of procedure counts against: a kind this table does not know is a write. */
export function rpcRuleFor(kind: ProcedureKind): RateLimitRule {
  return RPC_RULES[kind] ?? RPC_WRITE_RULE;
}

const MEDIA_UPLOAD_RULE: RateLimitRule = {
  bindings: {
    ip: (bindings) => bindings.MEDIA_UPLOAD_RATE_LIMIT,
    session: (bindings) => bindings.MEDIA_UPLOAD_RATE_LIMIT,
  },
  bucket: "media-upload",
  scope: "media-upload",
};

export const rpcRateLimitMiddleware = createRateLimitMiddleware({
  route: rpcRoute,
  rule: (request) => {
    const kind = rpcProcedureKind(request);
    if (kind === null) {
      return null;
    }
    return rpcRuleFor(kind);
  },
});

export const mediaUploadRateLimitMiddleware = createRateLimitMiddleware({
  route: () => "/api/products/:productId/media",
  rule: (request) => (isMediaUploadRequest(request) ? MEDIA_UPLOAD_RULE : null),
});
