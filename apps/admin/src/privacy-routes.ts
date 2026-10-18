import type {
  PrivacyCaseDetail,
  PrivacyCasePage,
  PrivacyStepResult,
} from "@polaris/db/admin-support-repository";
import {
  InvalidPrivacyStepError,
  normalizeActionStep,
  normalizeDecisionStep,
  normalizeIdentityStep,
  normalizePrivacyRequest,
  normalizeRoleStep,
  normalizeScopeStep,
  PRIVACY_CASE_RESPONSE_DAYS,
} from "@polaris/domain/admin/privacy-case";
import type { PlatformCapability } from "@polaris/domain/admin/platform-capabilities";
import {
  InvalidSupportRequestError,
  normalizeOpenCase,
  normalizeResolution,
  TenantAccessDeniedError,
} from "@polaris/domain/admin/support-access";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AdminBindings, AdminEnv } from "./app";
import { readBody, sameOrigin, UUID } from "./support-routes";

/**
 * The workflow of a privacy request (plan PR103, ADR 0077): open the case, then
 * check identity, determine Polaris's role, scope, decide, carry out and resolve,
 * each step a route that asks for the privacy capability, takes the operator from
 * the verified login and leaves the work and the audit to a database function that
 * refuses a step out of order or a decision the case does not allow. A case holds
 * codes, an opaque reference and a short note, never personal data.
 */

type Step = PrivacyStepResult;

export interface PrivacyDependencies {
  action: (
    principalId: string,
    caseId: string,
    input: { action: string; entityId: string | null },
    bindings: AdminBindings
  ) => Promise<(Step & { actionId: string }) | null>;
  decision: (
    principalId: string,
    caseId: string,
    input: { decision: string; note: string | null; reason: string | null },
    bindings: AdminBindings
  ) => Promise<Step | null>;
  detail: (
    caseId: string,
    bindings: AdminBindings
  ) => Promise<PrivacyCaseDetail | null>;
  identity: (
    principalId: string,
    caseId: string,
    input: { method: string; status: string },
    bindings: AdminBindings
  ) => Promise<Step | null>;
  list: (
    input: {
      after: string | null;
      filter: "closed" | "open" | "overdue" | null;
      limit: number;
    },
    bindings: AdminBindings
  ) => Promise<PrivacyCasePage>;
  open: (
    principalId: string,
    input: {
      channel: string;
      dueDays: number;
      note: string | null;
      organizationId: string;
      reason: string;
      receivedAt: Date | null;
      requesterKind: string;
      requestType: string;
    },
    bindings: AdminBindings
  ) => Promise<{ id: string } | null>;
  resolve: (
    principalId: string,
    caseId: string,
    resolution: string | null,
    bindings: AdminBindings
  ) => Promise<(Step & { revokedGrants: number }) | null>;
  role: (
    principalId: string,
    caseId: string,
    role: string,
    bindings: AdminBindings
  ) => Promise<Step | null>;
  scope: (
    principalId: string,
    caseId: string,
    input: { categories: string[]; subjectReference: string | null },
    bindings: AdminBindings
  ) => Promise<Step | null>;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const MAX_ID_LENGTH = 128;
const NOT_FOUND_CODES = new Set(["unknown_case", "unknown_organization"]);
const CONFLICT_CODES = new Set(["privacy_stage_conflict", "case_not_open"]);
const FILTERS = new Set(["open", "closed", "overdue"]);
const UUID_IN_PATH =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function controlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export function privacyRoutes(
  dependencies: PrivacyDependencies,
  requireCapability: (
    capability: PlatformCapability
  ) => MiddlewareHandler<AdminEnv>,
  report: (event: string, fields?: Record<string, string>) => void
) {
  const routes = new Hono<AdminEnv>();
  routes.use("*", sameOrigin);
  const guard = requireCapability("privacy_case:manage");

  routes.onError((error, context) => {
    if (error instanceof TenantAccessDeniedError) {
      report("tenant_access_denied", {
        route: context.req.path.replaceAll(UUID_IN_PATH, ":id"),
      });
      return context.json({ error: "tenant_access_denied" }, 403);
    }
    if (error instanceof InvalidPrivacyStepError) {
      return context.json(
        { error: error.code },
        CONFLICT_CODES.has(error.code) ? 409 : 400
      );
    }
    if (error instanceof InvalidSupportRequestError) {
      if (NOT_FOUND_CODES.has(error.code)) {
        return context.json({ error: error.code }, 404);
      }
      return context.json(
        { error: error.code },
        CONFLICT_CODES.has(error.code) ? 409 : 400
      );
    }
    if (error instanceof Error && error.message === "admin_not_configured") {
      report("admin_not_configured");
      return context.json({ error: "admin_not_configured" }, 503);
    }
    report("admin_error", { name: error.name });
    return context.json({ error: "internal_error" }, 500);
  });

  const principalOf = (context: Context<AdminEnv>) =>
    context.get("principal").id;
  const idParam = (context: Context<AdminEnv>) => {
    const value = context.req.param("caseId") ?? "";
    return UUID.test(value) ? value.toLowerCase() : null;
  };
  const invalid = (context: Context<AdminEnv>) =>
    context.json({ error: "invalid_request" }, 400);
  const notFound = (context: Context<AdminEnv>) =>
    context.json({ error: "not_found" }, 404);

  /** The case in the path and a JSON body, or null when either is not acceptable. */
  const stepInput = async (context: Context<AdminEnv>) => {
    const caseId = idParam(context);
    const body = await readBody(context);
    return caseId && body ? { body, caseId } : null;
  };

  routes.post("/privacy-cases", guard, async (context) => {
    const body = await readBody(context);
    const organizationId = body?.organizationId;
    if (
      !body ||
      typeof organizationId !== "string" ||
      organizationId.length === 0 ||
      organizationId.length > MAX_ID_LENGTH ||
      controlCharacter(organizationId) ||
      typeof body.reason !== "string" ||
      (body.receivedAt !== undefined &&
        (typeof body.receivedAt !== "string" ||
          !ISO_INSTANT.test(body.receivedAt)))
    ) {
      return invalid(context);
    }
    const received =
      typeof body.receivedAt === "string"
        ? new Date(body.receivedAt)
        : undefined;
    const request = normalizePrivacyRequest(
      {
        channel: body.channel,
        note: body.note,
        receivedAt: received,
        requestType: body.requestType,
        requesterKind: body.requesterKind,
      },
      new Date()
    );
    // why the case exists: the same short, clean text a support case takes
    const { reason } = normalizeOpenCase({
      context: null,
      kind: "support",
      reason: body.reason,
    });
    const created = await dependencies.open(
      principalOf(context),
      {
        channel: request.channel,
        dueDays: PRIVACY_CASE_RESPONSE_DAYS,
        note: request.note,
        organizationId,
        reason,
        receivedAt: received ?? null,
        requesterKind: request.requesterKind,
        requestType: request.requestType,
      },
      context.env
    );
    return context.json(created, 201);
  });

  routes.get("/privacy-cases", guard, async (context) => {
    const limit = Number(context.req.query("limit") ?? DEFAULT_PAGE_SIZE);
    const after = context.req.query("after") ?? null;
    const filter = context.req.query("filter") ?? null;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      (after !== null && !UUID.test(after)) ||
      (filter !== null && !FILTERS.has(filter))
    ) {
      return invalid(context);
    }
    return context.json(
      await dependencies.list(
        {
          after: after?.toLowerCase() ?? null,
          filter: filter as "closed" | "open" | "overdue" | null,
          limit,
        },
        context.env
      )
    );
  });

  routes.get("/privacy-cases/:caseId", guard, async (context) => {
    const caseId = idParam(context);
    const found = caseId
      ? await dependencies.detail(caseId, context.env)
      : null;
    return found ? context.json(found) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/identity", guard, async (context) => {
    const input = await stepInput(context);
    if (!input) {
      return invalid(context);
    }
    const step = normalizeIdentityStep({
      method: input.body.method,
      status: input.body.status,
    });
    const result = await dependencies.identity(
      principalOf(context),
      input.caseId,
      step,
      context.env
    );
    return result ? context.json(result) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/role", guard, async (context) => {
    const input = await stepInput(context);
    if (!input) {
      return invalid(context);
    }
    const result = await dependencies.role(
      principalOf(context),
      input.caseId,
      normalizeRoleStep(input.body.role),
      context.env
    );
    return result ? context.json(result) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/scope", guard, async (context) => {
    const input = await stepInput(context);
    if (!input) {
      return invalid(context);
    }
    const result = await dependencies.scope(
      principalOf(context),
      input.caseId,
      normalizeScopeStep({
        categories: input.body.categories,
        subjectReference: input.body.subjectReference,
      }),
      context.env
    );
    return result ? context.json(result) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/decision", guard, async (context) => {
    const input = await stepInput(context);
    if (!input) {
      return invalid(context);
    }
    const result = await dependencies.decision(
      principalOf(context),
      input.caseId,
      normalizeDecisionStep({
        decision: input.body.decision,
        note: input.body.note,
        reason: input.body.reason,
      }),
      context.env
    );
    return result ? context.json(result) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/actions", guard, async (context) => {
    const input = await stepInput(context);
    if (!input) {
      return invalid(context);
    }
    const result = await dependencies.action(
      principalOf(context),
      input.caseId,
      normalizeActionStep({
        action: input.body.action,
        entityId: input.body.entityId,
      }),
      context.env
    );
    return result ? context.json(result, 201) : notFound(context);
  });

  routes.post("/privacy-cases/:caseId/resolve", guard, async (context) => {
    const input = await stepInput(context);
    const resolution = input ? input.body.resolution : undefined;
    if (
      !input ||
      (resolution !== undefined &&
        resolution !== null &&
        typeof resolution !== "string")
    ) {
      return invalid(context);
    }
    const result = await dependencies.resolve(
      principalOf(context),
      input.caseId,
      normalizeResolution(resolution ?? null),
      context.env
    );
    return result ? context.json(result) : notFound(context);
  });

  return routes;
}
