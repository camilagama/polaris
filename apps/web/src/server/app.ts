import { Hono } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { systemRoutes } from "./routes/system";

interface ServerEnv {
  Variables: RequestIdVariables;
}

export const app = new Hono<ServerEnv>();

app.use("*", requestIdMiddleware);
app.use("*", securityHeadersMiddleware);
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
