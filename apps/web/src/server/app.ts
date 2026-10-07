import { RPCHandler } from "@orpc/server/fetch";
import { createDatabase } from "@polaris/db/client";
import { type Context, Hono } from "hono";
import {
  type AuthAbuseProtector,
  isAuthAbuseProtectionApplicable,
  protectAuthRequest,
} from "./auth/abuse-protection";
import {
  handleBetterAuthRequest,
  isEmailPasswordAuthEnabled,
} from "./auth/handler";
import type { ServerEnv, WorkerBindings } from "./environment";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { systemRoutes } from "./routes/system";
import { rpcRouter } from "./rpc/router";

type AuthRequestHandler = (
  request: Request,
  bindings: WorkerBindings,
  requestId: string
) => Promise<Response>;

interface ServerAppOptions {
  authAbuseProtector?: AuthAbuseProtector;
  authHandler?: AuthRequestHandler;
}

export function createServerApp({
  authAbuseProtector = protectAuthRequest,
  authHandler = handleBetterAuthRequest,
}: ServerAppOptions = {}) {
  const app = new Hono<ServerEnv>();
  const rpcHandler = new RPCHandler(rpcRouter);

  app.use("*", requestIdMiddleware);
  app.use("*", securityHeadersMiddleware);
  app.use("/rpc/*", async (context, next) => {
    const { matched, response } = await rpcHandler.handle(context.req.raw, {
      context: {},
      prefix: "/rpc",
    });

    if (matched) {
      return context.newResponse(response.body, response);
    }

    await next();
  });

  const authRoute = async (context: Context<ServerEnv>) => {
    const secret = context.env.BETTER_AUTH_SECRET;
    const baseURL = context.env.BETTER_AUTH_BASE_URL;

    if (!secret || secret.length < 32 || !baseURL) {
      return context.json(
        {
          error: { code: "auth_unavailable" },
          requestId: context.get("requestId"),
        },
        503
      );
    }

    if (
      isAuthAbuseProtectionApplicable(context.req.raw) &&
      isEmailPasswordAuthEnabled(context.env)
    ) {
      const abuseResponse = await authAbuseProtector(
        context.req.raw,
        context.env,
        context.get("requestId")
      );
      if (abuseResponse !== undefined) {
        return context.newResponse(abuseResponse.body, abuseResponse);
      }
    }

    return await authHandler(
      context.req.raw,
      context.env,
      context.get("requestId")
    );
  };
  app.get("/api/auth/*", authRoute);
  app.post("/api/auth/*", authRoute);

  app.route("/", systemRoutes);

  app.post("/api/poc/database", async (context) => {
    if (context.env.DB_POC_ENABLED !== "true") {
      return context.json(
        {
          error: { code: "not_found" },
          requestId: context.get("requestId"),
        },
        404
      );
    }

    const { pool } = createDatabase(context.env.HYPERDRIVE.connectionString, {
      maxConnections: 1,
    });

    try {
      const probe = await pool.query("SELECT 1 AS connected");

      if (Number(probe.rows[0]?.connected) !== 1) {
        return context.json({ error: { code: "database_unavailable" } }, 503);
      }

      return context.json({ status: "ok" });
    } finally {
      await pool.end();
    }
  });

  app.notFound((context) =>
    context.json(
      {
        error: { code: "not_found" },
        requestId: context.get("requestId"),
      },
      404
    )
  );

  app.onError((_error, context) =>
    context.json(
      {
        error: { code: "internal_error" },
        requestId: context.get("requestId"),
      },
      500
    )
  );

  return app;
}

export const app = createServerApp();
