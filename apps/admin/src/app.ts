import type {
  PlatformIdentity,
  PlatformPrincipal,
} from "@polaris/db/platform-principal-repository";
import {
  hasPlatformCapability,
  type PlatformCapability,
  platformCapabilitiesForRole,
} from "@polaris/domain/admin/platform-capabilities";
import { Hono, type MiddlewareHandler } from "hono";
import { type AccessClaims, AccessJwtError } from "./access-jwt";

/**
 * The Admin app's HTTP surface (plan PR92 to PR94, ADR 0070). Cloudflare Access
 * sits in front, but the Worker does not rely on that: every request to the API
 * carries a signed token that is verified here, the subject must be a platform
 * principal the database knows and has not disabled, and each route asks for a
 * named capability. Nothing is trusted from a header that only claims an identity.
 */

export interface AdminBindings {
  ACCESS_AUDIENCE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ADMIN_HYPERDRIVE?: { connectionString: string };
}

export interface AdminDependencies {
  /** Verifies the Access token for this deployment (signature, issuer, audience, window, subject). */
  authenticate: (
    token: string,
    bindings: AdminBindings
  ) => Promise<AccessClaims>;
  /** Finds the active platform principal for a verified identity, or null. */
  resolvePrincipal: (
    identity: PlatformIdentity,
    bindings: AdminBindings
  ) => Promise<PlatformPrincipal | null>;
  /** Diagnostics for the operator's logs: a stable code, never the token or the e-mail. */
  report: (event: string, fields?: Record<string, string>) => void;
}

interface AdminEnv {
  Bindings: AdminBindings;
  Variables: { principal: PlatformPrincipal };
}

const ACCESS_HEADER = "cf-access-jwt-assertion";

const securityHeaders: MiddlewareHandler = async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
};

interface Refusal {
  body: { error: string };
  status: 401 | 403 | 503;
}

/** Verifies the Access token and turns what is wrong with it into the answer to give. */
async function verifiedIdentity(
  dependencies: AdminDependencies,
  token: string,
  bindings: AdminBindings
): Promise<AccessClaims | Refusal> {
  try {
    return await dependencies.authenticate(token, bindings);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "admin_not_configured") {
      dependencies.report("admin_not_configured");
      return { body: { error: "admin_not_configured" }, status: 503 };
    }
    const rejected = error instanceof AccessJwtError;
    dependencies.report("access_token_rejected", {
      reason: rejected ? error.code : "unavailable",
    });
    return rejected
      ? { body: { error: "unauthenticated" }, status: 401 }
      : { body: { error: "unavailable" }, status: 503 };
  }
}

async function knownPrincipal(
  dependencies: AdminDependencies,
  claims: AccessClaims,
  bindings: AdminBindings
): Promise<PlatformPrincipal | Refusal> {
  try {
    const principal = await dependencies.resolvePrincipal(
      { email: claims.email, issuer: claims.issuer, subject: claims.subject },
      bindings
    );
    if (principal) {
      return principal;
    }
    // a valid login that is not an operator: no hint about why
    dependencies.report("not_a_platform_principal");
    return { body: { error: "forbidden" }, status: 403 };
  } catch {
    dependencies.report("principal_lookup_failed");
    return { body: { error: "unavailable" }, status: 503 };
  }
}

function isRefusal(value: object): value is Refusal {
  return "status" in value && "body" in value;
}

function configured(bindings: AdminBindings): boolean {
  return Boolean(
    bindings.ACCESS_AUDIENCE &&
      bindings.ACCESS_TEAM_DOMAIN &&
      bindings.ADMIN_HYPERDRIVE
  );
}

function authentication(
  dependencies: AdminDependencies
): MiddlewareHandler<AdminEnv> {
  return async (context, next) => {
    const bindings = context.env;
    if (!configured(bindings)) {
      // never run without verification because something is not configured
      dependencies.report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    const token = context.req.header(ACCESS_HEADER);
    if (!token) {
      return context.json({ error: "unauthenticated" }, 401);
    }
    const claims = await verifiedIdentity(dependencies, token, bindings);
    if (isRefusal(claims)) {
      return context.json(claims.body, claims.status);
    }
    const principal = await knownPrincipal(dependencies, claims, bindings);
    if (isRefusal(principal)) {
      return context.json(principal.body, principal.status);
    }
    context.set("principal", principal);
    await next();
  };
}

/** A route's one question: does the principal's role hold this named capability. */
function requireCapability(
  capability: PlatformCapability
): MiddlewareHandler<AdminEnv> {
  return async (context, next) => {
    if (!hasPlatformCapability(context.get("principal").role, capability)) {
      return context.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}

export function createAdminApp(dependencies: AdminDependencies) {
  const app = new Hono<AdminEnv>();
  app.use("*", securityHeaders);

  // answers without a login so a deployment can be checked; says nothing about the platform
  app.get("/health", (context) => context.json({ status: "ok" }));

  const api = new Hono<AdminEnv>();
  api.use("*", authentication(dependencies));
  api.get("/whoami", requireCapability("platform:read"), (context) => {
    const principal = context.get("principal");
    return context.json({
      capabilities: platformCapabilitiesForRole(principal.role),
      principal: {
        emailSnapshot: principal.emailSnapshot,
        id: principal.id,
        role: principal.role,
      },
    });
  });
  app.route("/api", api);

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((error, context) => {
    dependencies.report("admin_error", { name: error.name });
    return context.json({ error: "internal_error" }, 500);
  });
  return app;
}
