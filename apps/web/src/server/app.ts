import { RPCHandler } from "@orpc/server/fetch";
import { createDatabase } from "@polaris/db/client";
import { Hono } from "hono";
import type { ServerEnv } from "./environment";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { systemRoutes } from "./routes/system";
import { rpcRouter } from "./rpc/router";

export const app = new Hono<ServerEnv>();

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
