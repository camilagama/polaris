import { randomUUID } from "node:crypto";
import { createRlsPocDatabase } from "@polaris/db/rls-poc-client";
import {
  type RlsPocOrganizationId,
  readRlsPocRows,
  readRlsPocWithoutContext,
  retryRlsPocAfterConnectionFailure,
  verifyRlsPocCrossWrite,
  verifyRlsPocRollback,
  verifyRlsPocStatementFailure,
  verifyRlsPocTransactionContextReset,
} from "@polaris/db/rls-poc-gate";
import { Hono } from "hono";
import type { ServerEnv } from "../environment";

type RlsPocAction =
  | "read"
  | "cross-read"
  | "contextless"
  | "context-reuse"
  | "rollback"
  | "statement-failure"
  | "cross-write"
  | "retry";

interface RlsPocRequest {
  action: RlsPocAction;
  delayMs?: number;
  organizationId?: RlsPocOrganizationId;
  token?: string;
}

const route = new Hono<ServerEnv>();
const tokenPattern = /^[0-9a-f-]{36}$/i;

route.onError((_error, context) =>
  context.json({ error: { code: "internal_error" } }, 500)
);

function isOrganizationId(value: unknown): value is RlsPocOrganizationId {
  return value === "org_a" || value === "org_b";
}

function isRlsPocRequest(value: unknown): value is RlsPocRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const request = value as Partial<RlsPocRequest>;
  return (
    [
      "read",
      "cross-read",
      "contextless",
      "context-reuse",
      "rollback",
      "statement-failure",
      "cross-write",
      "retry",
    ].includes(String(request.action)) &&
    (request.organizationId === undefined ||
      isOrganizationId(request.organizationId)) &&
    (request.token === undefined || tokenPattern.test(request.token)) &&
    (request.delayMs === undefined ||
      (Number.isInteger(request.delayMs) &&
        request.delayMs >= 0 &&
        request.delayMs <= 100))
  );
}

route.post("/run", async (context) => {
  if (context.env.DB_RLS_POC_ENABLED !== "true") {
    return context.json({ error: { code: "not_found" } }, 404);
  }

  let requestBody: unknown;
  try {
    requestBody = await context.req.json();
  } catch {
    return context.json({ error: { code: "invalid_json" } }, 400);
  }

  if (!isRlsPocRequest(requestBody)) {
    return context.json({ error: { code: "invalid_request" } }, 400);
  }

  // Hyperdrive owns the shared origin pool. Keep each pg client pool scoped to
  // this Worker request so concurrent invocations never share a pg.Pool.
  const database = createRlsPocDatabase(
    context.env.HYPERDRIVE.connectionString,
    { maxConnections: 1 }
  );
  const organizationId = requestBody.organizationId ?? "org_a";
  const token = requestBody.token ?? randomUUID();

  try {
    switch (requestBody.action) {
      case "read":
      case "cross-read": {
        const result = await readRlsPocRows(
          database,
          organizationId,
          requestBody.action === "cross-read",
          requestBody.delayMs
        );

        return context.json({
          backendPid: result.firstState.backendPid,
          organizationId: result.firstState.organizationId,
          rows: result.rows,
          transactionIds: [
            result.firstState.transactionId,
            result.secondState.transactionId,
          ],
        });
      }
      case "contextless": {
        const result = await readRlsPocWithoutContext(database);
        return context.json({
          backendPid: result.backendPid,
          organizationId: result.organizationId,
          visibleRows: result.rows,
        });
      }
      case "context-reuse": {
        const result = await verifyRlsPocTransactionContextReset(
          database,
          organizationId
        );
        return context.json({
          contextReuse: {
            contextless: {
              backendPid: result.contextlessState.backendPid,
              organizationId: result.contextlessState.organizationId,
            },
            tenant: {
              backendPid: result.tenantState.backendPid,
              organizationId: result.tenantState.organizationId,
            },
            visibleRows: result.visibleRows,
          },
        });
      }
      case "rollback": {
        const rolledBack = await verifyRlsPocRollback(
          database,
          organizationId,
          token
        );
        return context.json({ rolledBack });
      }
      case "statement-failure": {
        const result = await verifyRlsPocStatementFailure(
          database,
          organizationId,
          token
        );
        return context.json(result);
      }
      case "cross-write": {
        const rejectedByRls = await verifyRlsPocCrossWrite(
          database,
          organizationId,
          token
        );
        return context.json({ rejectedByRls });
      }
      case "retry": {
        const result = await retryRlsPocAfterConnectionFailure(
          database,
          organizationId,
          token
        );
        return context.json(result);
      }
      default:
        return context.json({ error: { code: "unsupported_action" } }, 400);
    }
  } finally {
    await database.pool.end();
  }
});

export const rlsPocRoutes = route;
