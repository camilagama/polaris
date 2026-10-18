import type {
  MaskedCustomerPage,
  SupportCaseDetail,
  SupportCasePage,
  TenantAccessGrantRecord,
} from "@polaris/db/admin-support-repository";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import { InvalidEntitlementGrantError } from "@polaris/domain/billing/grants";
import {
  InvalidSupportRequestError,
  isRevealableField,
  normalizeAccessMinutes,
  normalizeOpenCase,
  normalizeResolution,
  type RevealableCustomerField,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import type { GrantCommand } from "./billing-commands";

/**
 * Support cases, temporary tenant access, the masked read and the reveal (plan
 * PR96 to PR98, ADR 0072). Every route asks for a named capability, takes the
 * operator from the verified login (never from the body), and leaves the work and
 * the audit to database functions that refuse without an active grant.
 */

export interface SupportDependencies {
  /** Gives the organization of an open case a temporary entitlement (recorded before and after). */
  grantEntitlement: (
    principalId: string,
    caseId: string,
    command: GrantCommand,
    bindings: AdminBindings
  ) => Promise<{
    created: boolean;
    id: string;
    organizationId: string;
    outcomeRecorded: boolean;
  }>;
  reactivate: (
    principalId: string,
    caseId: string,
    bindings: AdminBindings
  ) => Promise<{ changed: boolean; status: string } | null>;
  /** Ends a grant of the case's organization (recorded before and after). */
  revokeEntitlement: (
    principalId: string,
    caseId: string,
    grantId: string,
    bindings: AdminBindings
  ) => Promise<{ outcomeRecorded: boolean; revoked: boolean }>;
  suspend: (
    principalId: string,
    caseId: string,
    bindings: AdminBindings
  ) => Promise<{
    changed: boolean;
    revokedLeases?: number;
    status: string;
  } | null>;
  close: (
    principalId: string,
    caseId: string,
    resolution: string | null,
    bindings: AdminBindings
  ) => Promise<{ changed: boolean; id: string; status: string } | null>;
  customers: (
    principalId: string,
    caseId: string,
    input: { after: string | null; limit: number },
    bindings: AdminBindings
  ) => Promise<MaskedCustomerPage>;
  detail: (
    caseId: string,
    bindings: AdminBindings
  ) => Promise<SupportCaseDetail | null>;
  grant: (
    principalId: string,
    caseId: string,
    minutes: number,
    bindings: AdminBindings
  ) => Promise<TenantAccessGrantRecord | null>;
  list: (
    input: {
      after: string | null;
      limit: number;
      organizationId: string | null;
      status: string | null;
    },
    bindings: AdminBindings
  ) => Promise<SupportCasePage>;
  open: (
    principalId: string,
    input: {
      context: string | null;
      kind: string;
      organizationId: string;
      reason: string;
    },
    bindings: AdminBindings
  ) => Promise<{ id: string } | null>;
  reveal: (
    principalId: string,
    caseId: string,
    customerId: string,
    field: RevealableCustomerField,
    bindings: AdminBindings
  ) => Promise<{
    customerId: string;
    field: string;
    value: string | null;
  } | null>;
  revoke: (
    principalId: string,
    grantId: string,
    bindings: AdminBindings
  ) => Promise<boolean>;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_PATH =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const MAX_BODY_BYTES = 8192;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const MAX_ID_LENGTH = 128;
const NOT_FOUND_CODES = new Set(["unknown_case", "unknown_organization"]);

type Json = Record<string, unknown>;

function controlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/** A JSON object body of reasonable size, or null when the request does not carry one. */
export async function readBody(
  context: Context<AdminEnv>
): Promise<Json | null> {
  const type = context.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return null;
  }
  const text = await context.req.text();
  if (text.length > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const value: unknown = text === "" ? {} : JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * A change that comes from a browser must come from this origin: the login is a
 * cookie, so a page elsewhere could otherwise make the operator's browser act.
 */
export const sameOrigin: MiddlewareHandler<AdminEnv> = async (
  context,
  next
) => {
  const origin = context.req.header("origin");
  if (
    context.req.method !== "GET" &&
    origin !== undefined &&
    origin !== new URL(context.req.url).origin
  ) {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
};

export function supportRoutes(
  dependencies: SupportDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);

  /** Maps the named refusals to answers; nothing of the database reaches the operator. */
  routes.onError((error, context) => {
    if (error instanceof TenantAccessDeniedError) {
      // a refused attempt leaves no row (the transaction is undone), so it is at least in the operator's log
      report("tenant_access_denied", {
        route: context.req.path.replaceAll(UUID_IN_PATH, ":id"),
      });
      return context.json({ error: "tenant_access_denied" }, 403);
    }
    if (error instanceof InvalidEntitlementGrantError) {
      return context.json({ error: error.code }, 400);
    }
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    if (
      error instanceof Error &&
      error.message === "entitlement_grant_id_conflict"
    ) {
      // the caller's command ID already holds a different grant
      return context.json({ error: "grant_id_conflict" }, 409);
    }
    if (error instanceof Error && error.message === "organization_not_found") {
      return context.json({ error: "not_found" }, 404);
    }
    if (error instanceof InvalidSupportRequestError) {
      return context.json(
        { error: error.code },
        NOT_FOUND_CODES.has(error.code) ? 404 : 400
      );
    }
    report("admin_error", { errorClass: error.name });
    return context.json({ error: "internal_error" }, 500);
  });

  const principalOf = (context: Context<AdminEnv>) =>
    context.get("principal").id;
  const idParam = (context: Context<AdminEnv>, name: string) => {
    const value = context.req.param(name) ?? "";
    return UUID.test(value) ? value.toLowerCase() : null;
  };
  const page = (context: Context<AdminEnv>) => {
    const limit = Number(context.req.query("limit") ?? DEFAULT_PAGE_SIZE);
    const after = context.req.query("after") ?? null;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      (after !== null && !UUID.test(after))
    ) {
      return null;
    }
    return { after: after?.toLowerCase() ?? null, limit };
  };
  const invalid = (context: Context<AdminEnv>) =>
    context.json({ error: "invalid_request" }, 400);
  const notFound = (context: Context<AdminEnv>) =>
    context.json({ error: "not_found" }, 404);

  routes.post(
    "/support-cases",
    requireCapability("support_case:manage"),
    async (context) => {
      const body = await readBody(context);
      const organizationId = body?.organizationId;
      if (
        !body ||
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        organizationId.length > MAX_ID_LENGTH ||
        controlCharacter(organizationId) ||
        typeof body.kind !== "string" ||
        typeof body.reason !== "string" ||
        optionalString(body.context) === undefined
      ) {
        return invalid(context);
      }
      const normalized = normalizeOpenCase({
        context: optionalString(body.context) ?? null,
        kind: body.kind,
        reason: body.reason,
      });
      // a privacy case has its own workflow (and its own capability): it is opened there, not here
      if (normalized.kind === "privacy") {
        return context.json({ error: "privacy_case_workflow_required" }, 400);
      }
      const created = await dependencies.open(
        principalOf(context),
        { ...normalized, organizationId },
        context.env
      );
      return context.json(created, 201);
    }
  );

  routes.get(
    "/support-cases",
    requireCapability("support_case:manage"),
    async (context) => {
      const paging = page(context);
      const status = context.req.query("status") ?? null;
      const organizationId = context.req.query("organizationId") ?? null;
      if (
        !paging ||
        (status !== null && status !== "open" && status !== "closed") ||
        (organizationId !== null &&
          (organizationId.length > MAX_ID_LENGTH ||
            controlCharacter(organizationId)))
      ) {
        return invalid(context);
      }
      return context.json(
        await dependencies.list(
          { ...paging, organizationId, status },
          context.env
        )
      );
    }
  );

  routes.get(
    "/support-cases/:caseId",
    requireCapability("support_case:manage"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const found = caseId
        ? await dependencies.detail(caseId, context.env)
        : null;
      return found ? context.json(found) : notFound(context);
    }
  );

  routes.post(
    "/support-cases/:caseId/close",
    requireCapability("support_case:manage"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const body = await readBody(context);
      const resolution = optionalString(body?.resolution);
      if (!caseId) {
        return notFound(context);
      }
      if (!body || resolution === undefined) {
        return invalid(context);
      }
      const closed = await dependencies.close(
        principalOf(context),
        caseId,
        normalizeResolution(resolution),
        context.env
      );
      return closed ? context.json(closed) : notFound(context);
    }
  );

  routes.post(
    "/support-cases/:caseId/access",
    requireCapability("tenant_access:grant"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const body = await readBody(context);
      if (!caseId) {
        return notFound(context);
      }
      const minutes = body?.minutes;
      if (!body || (minutes !== undefined && typeof minutes !== "number")) {
        return invalid(context);
      }
      const granted = await dependencies.grant(
        principalOf(context),
        caseId,
        normalizeAccessMinutes(minutes),
        context.env
      );
      return context.json(granted, 201);
    }
  );

  routes.delete(
    "/tenant-access/:grantId",
    requireCapability("tenant_access:grant"),
    async (context) => {
      const grantId = idParam(context, "grantId");
      if (!grantId) {
        return notFound(context);
      }
      const revoked = await dependencies.revoke(
        principalOf(context),
        grantId,
        context.env
      );
      return context.json({ revoked });
    }
  );

  routes.post(
    "/support-cases/:caseId/suspend",
    requireCapability("organization:suspend"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      if (!caseId) {
        return notFound(context);
      }
      return context.json(
        await dependencies.suspend(principalOf(context), caseId, context.env)
      );
    }
  );

  routes.post(
    "/support-cases/:caseId/reactivate",
    requireCapability("organization:suspend"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      if (!caseId) {
        return notFound(context);
      }
      return context.json(
        await dependencies.reactivate(principalOf(context), caseId, context.env)
      );
    }
  );

  routes.post(
    "/support-cases/:caseId/entitlement-grants",
    requireCapability("billing:operate"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const body = await readBody(context);
      if (!caseId) {
        return notFound(context);
      }
      if (
        !body ||
        typeof body.key !== "string" ||
        typeof body.reason !== "string" ||
        !(typeof body.value === "number" || typeof body.value === "boolean") ||
        typeof body.hours !== "number" ||
        !Number.isInteger(body.hours) ||
        (body.commandId !== undefined &&
          !(typeof body.commandId === "string" && UUID.test(body.commandId)))
      ) {
        return invalid(context);
      }
      const granted = await dependencies.grantEntitlement(
        principalOf(context),
        caseId,
        {
          hours: body.hours,
          ...(typeof body.commandId === "string"
            ? { id: body.commandId.toLowerCase() }
            : {}),
          key: body.key,
          reason: body.reason,
          value: body.value,
        },
        context.env
      );
      return context.json(granted, granted.created ? 201 : 200);
    }
  );

  routes.delete(
    "/support-cases/:caseId/entitlement-grants/:grantId",
    requireCapability("billing:operate"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const grantId = idParam(context, "grantId");
      if (!(caseId && grantId)) {
        return notFound(context);
      }
      return context.json(
        await dependencies.revokeEntitlement(
          principalOf(context),
          caseId,
          grantId,
          context.env
        )
      );
    }
  );

  routes.get(
    "/support-cases/:caseId/customers",
    requireCapability("tenant_data:read"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const paging = page(context);
      if (!caseId) {
        return notFound(context);
      }
      if (!paging) {
        return invalid(context);
      }
      return context.json(
        await dependencies.customers(
          principalOf(context),
          caseId,
          paging,
          context.env
        )
      );
    }
  );

  routes.post(
    "/support-cases/:caseId/customers/:customerId/reveal",
    requireCapability("pii:reveal"),
    async (context) => {
      const caseId = idParam(context, "caseId");
      const customerId = idParam(context, "customerId");
      const body = await readBody(context);
      if (!(caseId && customerId)) {
        return notFound(context);
      }
      const field = body?.field;
      if (typeof field !== "string" || !isRevealableField(field)) {
        return invalid(context);
      }
      const revealed = await dependencies.reveal(
        principalOf(context),
        caseId,
        customerId,
        field,
        context.env
      );
      return revealed ? context.json(revealed) : notFound(context);
    }
  );

  return routes;
}
