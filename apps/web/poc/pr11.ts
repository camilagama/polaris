import { app } from "../src/server/app";
import type { WorkerBindings } from "../src/server/environment";
import { rlsPocRoutes } from "../src/server/routes/rls-poc";

app.route("/api/poc/rls", rlsPocRoutes);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<WorkerBindings>;
