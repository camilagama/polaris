import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { systemRoutes } from "./routes/system";
import { rpcRouter } from "./rpc/router";

interface ServerEnv {
  Variables: RequestIdVariables;
}

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
