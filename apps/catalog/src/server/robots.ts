import { env } from "cloudflare:workers";
import { releaseHeaders } from "@polaris/http-security";

const builtRelease: string = import.meta.env.POLARIS_SERVER_RELEASE ?? "";

/**
 * `/robots.txt`, the catalog's one fixed path that is not a store slug: behind its switch it also declares the
 * release the Worker was built from, which the staging smoke reads (ADR 0098, amended).
 */
export function robotsTxt(
  release: string,
  enabled: string | undefined
): Response {
  return new Response("User-agent: *\nAllow: /\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...releaseHeaders(release, enabled),
    },
  });
}

export function serveRobotsTxt(): Response {
  return robotsTxt(builtRelease, env.RELEASE_HEADER_ENABLED);
}
