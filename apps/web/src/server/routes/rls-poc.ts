import { randomUUID } from "node:crypto";
import {
  readRlsPocRows,
  readRlsPocWithoutContext,
  retryRlsPocAfterConnectionFailure,
  verifyRlsPocCrossWrite,
  verifyRlsPocRollback,
  verifyRlsPocStatementFailure,
  type RlsPocOrganizationId,
} from "@polaris/db/rls-poc-gate";
import { createRlsPocDatabase } from "@polaris/db/rls-poc-client";
import { Hono } from "hono";
import type { ServerEnv } from "../environment";

type RlsPocAction =
  | "read"
  | "cross-read"
  | "contextless"
  | "rollback"
  | "statement-failure"
  | "cross-write"
  | "retry";

interface RlsPocRequest {
  action: RlsPocAction;
  organizationId?: RlsPocOrganizationId;
  token?: string;
  delayMs?: number;
}

const route = new Hono<ServerEnv>();
const tokenPattern = /^[0-9a-f-]{36}$/i;
let databaseConnectionString: string | undefined;
let databaseInstance: ReturnType<typeof createRlsPocDatabase> | undefined;

function getDatabase(connectionString: string) {
  if (databaseInstance && databaseConnectionString === connectionString) {
    return databaseInstance;
  }

  databaseConnectionString = connectionString;
  databaseInstance = createRlsPocDatabase(connectionString, {
    maxConnections: 4,
  });

  return databaseInstance;
}

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

  const database = getDatabase(context.env.HYPERDRIVE.connectionString);
  const organizationId = requestBody.organizationId ?? "org_a";
  const token = requestBody.token ?? randomUUID();

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
});

export const rlsPocRoutes = route;
