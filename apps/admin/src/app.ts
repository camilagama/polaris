import { describeError } from "@polaris/observability/wide-event";
import type { AdminOrganizationPage } from "@polaris/db/admin-diagnostics-repository";
import type {
  PlatformIdentity,
  PlatformPrincipal,
} from "@polaris/db/platform-principal-repository";
import { IncompletePlanCatalogError } from "@polaris/domain/billing/entitlements";
import {
  buildOrganizationDiagnostics,
  type RawDiagnostics,
} from "@polaris/domain/admin/organization-diagnostics";
import {
  hasPlatformCapability,
  type PlatformCapability,
  platformCapabilitiesForRole,
} from "@polaris/domain/admin/platform-capabilities";
import { defaultCacheControl, securityHeaders } from "@polaris/http-security";
import { Hono, type MiddlewareHandler } from "hono";
import { type AccessClaims, AccessJwtError } from "./access-jwt";
import {
  type ActivationFunnelDependencies,
  activationFunnelRoutes,
} from "./activation-funnel-routes";
import {
  type AccessLogDependencies,
  accessLogRoutes,
} from "./access-log-routes";
import { type IncidentDependencies, incidentRoutes } from "./incident-routes";
import { type PrivacyDependencies, privacyRoutes } from "./privacy-routes";
import {
  type RefundWindowDependencies,
  refundWindowRoutes,
} from "./refund-window-routes";
import { type SupportDependencies, supportRoutes } from "./support-routes";

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
  /** The billing role's login: the only writer of billing, used only for the billing commands (ADR 0073). */
  ADMIN_BILLING_HYPERDRIVE?: { connectionString: string };
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
  /** Organizations a page at a time, and one organization's raw figures (counts, dates and states only). */
  organizations: {
    diagnostics: (
      organizationId: string,
      bindings: AdminBindings
    ) => Promise<RawDiagnostics | null>;
    list: (
      input: { after: string | null; limit: number; query: string | null },
      bindings: AdminBindings
    ) => Promise<AdminOrganizationPage>;
  };
  /** The record of access to the application, read for a court order (ADR 0092). */
  accessLog: AccessLogDependencies;
  /** The activation funnel of the stores, aggregate and audited (corte 2.4, ADR 0071 amended). */
  activationFunnel: ActivationFunnelDependencies;
  /** Operational incidents (dead letters, outbox events past the attempt cap) and the retry of a dead event (ADR 0085). */
  incidents: IncidentDependencies;
  /** The workflow of a privacy request (ADR 0077). */
  privacy: PrivacyDependencies;
  /** The window of the right of withdrawal of one store, read under an open case and audited (ADR 0104, decisions 8 and 10). */
  refundWindow: RefundWindowDependencies;
  /** Support cases, temporary tenant access, the masked read and the reveal (ADR 0072). */
  support: SupportDependencies;
  /** Diagnostics for the operator's logs: a stable code, never the token or the e-mail. */
  report: (event: string, fields?: Record<string, string>) => void;
}

export interface AdminEnv {
  Bindings: AdminBindings;
  Variables: { principal: PlatformPrincipal };
}

const ACCESS_HEADER = "cf-access-jwt-assertion";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 100;
const MAX_ID_LENGTH = 128;

const ADMIN_HEADERS = Object.entries(securityHeaders("admin"));
const ADMIN_CACHE_CONTROL = defaultCacheControl("admin");

/** The headers of every answer of the Admin come from the shared module (ADR 0090); nothing here is cacheable. */
const securityHeadersMiddleware: MiddlewareHandler = async (context, next) => {
  await next();
  for (const [name, value] of ADMIN_HEADERS) {
    context.header(name, value);
  }
  if (ADMIN_CACHE_CONTROL !== null) {
    context.header("Cache-Control", ADMIN_CACHE_CONTROL);
  }
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

/** True when the text has a control character (a NUL would be a database error, not a refusal). */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
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
  app.use("*", securityHeadersMiddleware);

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
  api.get(
    "/organizations",
    requireCapability("organization:diagnose"),
    async (context) => {
      const query = context.req.query("query") ?? null;
      const after = context.req.query("after") ?? null;
      const limit = Number(context.req.query("limit") ?? DEFAULT_PAGE_SIZE);
      if (
        hasControlCharacter(query ?? "") ||
        hasControlCharacter(after ?? "") ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_PAGE_SIZE ||
        (query?.length ?? 0) > MAX_QUERY_LENGTH ||
        (after?.length ?? 0) > MAX_ID_LENGTH
      ) {
        return context.json({ error: "invalid_request" }, 400);
      }
      return context.json(
        await dependencies.organizations.list(
          { after, limit, query },
          context.env
        )
      );
    }
  );
  api.get(
    "/organizations/:organizationId/diagnostics",
    requireCapability("organization:diagnose"),
    async (context) => {
      const organizationId = context.req.param("organizationId");
      if (
        organizationId.length > MAX_ID_LENGTH ||
        hasControlCharacter(organizationId)
      ) {
        return context.json({ error: "not_found" }, 404);
      }
      const raw = await dependencies.organizations.diagnostics(
        organizationId,
        context.env
      );
      if (!raw) {
        return context.json({ error: "not_found" }, 404);
      }
      try {
        return context.json(buildOrganizationDiagnostics(raw));
      } catch (error: unknown) {
        if (!(error instanceof IncompletePlanCatalogError)) {
          throw error;
        }
        // the product fails closed on a damaged plan catalog; the operator is told why, not left with a blank 500
        dependencies.report("plan_catalog_incomplete");
        return context.json({ error: "plan_catalog_incomplete" }, 503);
      }
    }
  );
  api.route(
    "/",
    activationFunnelRoutes(
      dependencies.activationFunnel,
      requireCapability,
      dependencies.report
    )
  );
  api.route(
    "/",
    supportRoutes(dependencies.support, requireCapability, dependencies.report)
  );
  api.route(
    "/",
    refundWindowRoutes(
      dependencies.refundWindow,
      requireCapability,
      dependencies.report
    )
  );
  api.route(
    "/",
    privacyRoutes(dependencies.privacy, requireCapability, dependencies.report)
  );
  api.route(
    "/",
    incidentRoutes(
      dependencies.incidents,
      requireCapability,
      dependencies.report
    )
  );
  api.route(
    "/",
    accessLogRoutes(
      dependencies.accessLog,
      requireCapability,
      dependencies.report
    )
  );
  app.route("/api", api);

  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((error, context) => {
    dependencies.report("admin_error", describeError(error));
    return context.json({ error: "internal_error" }, 500);
  });
  return app;
}
