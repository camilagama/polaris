import { app } from "../src/server/app";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler;
