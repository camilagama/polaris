import { createFileRoute } from "@tanstack/react-router";
import { serveRobotsTxt } from "../server/robots";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () => serveRobotsTxt(),
    },
  },
});
