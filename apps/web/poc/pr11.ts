import { Hono } from "hono";
import { systemRoutes } from "../src/server/routes/system";
import { type RlsPocEnv, rlsPocRoutes } from "./rls-poc";

// Standalone proof Worker: it deliberately does not mount the production app, so
// production middleware (origin check, rate limits) and routes stay out of the
// PR11 gate and the PoC route stays out of the production bundle.
const app = new Hono<RlsPocEnv>();

app.route("/", systemRoutes);
app.route("/api/poc/rls", rlsPocRoutes);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<RlsPocEnv["Bindings"]>;
