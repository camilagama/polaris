import { app } from "../src/server/app";
import type { WorkerBindings } from "../src/server/environment";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<WorkerBindings>;
