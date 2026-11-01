import { releaseHeaders } from "@polaris/http-security";
import { Hono } from "hono";
import type { ServerEnv } from "../environment";

const builtRelease: string = import.meta.env.POLARIS_SERVER_RELEASE ?? "";

/** `/health` and `/ready`; `/health` also declares the release the Worker was built from, behind its switch. */
export function createSystemRoutes(release: string = builtRelease) {
  const routes = new Hono<ServerEnv>();
  routes.get("/health", (context) =>
    context.json(
      { status: "ok" },
      200,
      releaseHeaders(release, context.env?.RELEASE_HEADER_ENABLED)
    )
  );
  routes.get("/ready", (context) => context.json({ status: "ready" }));
  return routes;
}

export const systemRoutes = createSystemRoutes();
