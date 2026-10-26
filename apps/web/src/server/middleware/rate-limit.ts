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
import type {
  RateLimitBinding,
  ServerEnv,
  WorkerBindings,
} from "../environment";

const IPV4_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
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

function procedurePath(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.startsWith(RPC_PREFIX)
    ? pathname.slice(RPC_PREFIX.length)
    : pathname;
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
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
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
  baseURL: string | undefined
): string | undefined {
  const name = sessionCookieName(baseURL);
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

/** The eight 16-bit groups of an IPv6 address, or undefined for text that is not one (a zone after `%` is dropped). */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%", 1)[0] ?? "";
  const tailStart = text.lastIndexOf(":") + 1;
  if (text.includes(".")) {
    const octets = ipv4Octets(text.slice(tailStart));
    if (octets === undefined) {
      return undefined;
    }
    // a dotted tail stands for the last two groups
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, tailStart)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split("::");
  const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);
  const before = groupsOf(halves[0]);
  const after = groupsOf(halves[1]);
  const missing = 8 - before.length - after.length;
  if (
    halves.length > 2 ||
    (halves.length === 2 ? missing < 1 : missing !== 0)
  ) {
    return undefined;
  }
  const all = [
    ...before,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...after,
  ];
  return all.every((group) => IPV6_GROUP.test(group))
    ? all.map((group) => Number.parseInt(group, 16))
    : undefined;
}

function ipv4Octets(text: string): number[] | undefined {
  if (!IPV4_ADDRESS.test(text)) {
    return undefined;
  }
  const octets = text.split(".").map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/**
 * What an IPv6 address counts as: its /64 (the first four groups, lowercase, without leading zeros), or the
 * IPv4 address itself for an IPv4-mapped one (`::ffff:a.b.c.d`, in any spelling). Undefined for text that is not
 * an IPv6 address.
 */
function ipv6Identity(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined) {
    return undefined;
  }
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0xff_ff
  ) {
    return [
      Math.floor(g6 / 256),
      g6 % 256,
      Math.floor(g7 / 256),
      g7 % 256,
    ].join(".");
  }
  return `${[g0, g1, g2, g3].map((group) => (group ?? 0).toString(16)).join(":")}::/64`;
}

/**
 * The address the IP bucket counts: an IPv4 address whole, an IPv6 address by its /64 (one subscriber holds
 * a whole /64, so its addresses are one client). Text that is neither counts as no address.
 */
function clientIp(request: Request): string | undefined {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > 64) {
    return undefined;
  }
  return value.includes(":")
    ? ipv6Identity(value)
    : ipv4Octets(value)?.join(".");
}

/** The keys this request is counted by: the address and the session, the ones it carries. */
function identities(
  request: Request,
  baseURL: string | undefined
): [KeyType, string][] {
  const found: [KeyType, string][] = [];
  const ip = clientIp(request);
  if (ip !== undefined) {
    found.push(["ip", ip]);
  }
  const session = sessionCookie(request, baseURL);
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
    for (const [keyType, identity] of identities(
      context.req.raw,
      context.env.BETTER_AUTH_BASE_URL
    )) {
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
    return kind === "read" ? RPC_READ_RULE : RPC_WRITE_RULE;
  },
});

export const mediaUploadRateLimitMiddleware = createRateLimitMiddleware({
  route: () => "/api/products/:productId/media",
  rule: (request) => (isMediaUploadRequest(request) ? MEDIA_UPLOAD_RULE : null),
});
