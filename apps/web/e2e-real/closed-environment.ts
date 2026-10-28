/**
 * The closed environment of the build and of the preview (serve.ts). Playwright gives a web server the WHOLE
 * environment of its process plus the config's `env`, and the preview runs with `CLOUDFLARE_INCLUDE_PROCESS_ENV`,
 * which hands every variable to the local Worker. So serve.ts keeps only the names the config listed in
 * `E2E_PREVIEW_VARIABLES` (the keys of `previewEnvironment`): the owner URL of the database, provider keys or a
 * Cloudflare token of the session never reach the Worker. No import: serve.ts runs this file under Node directly.
 */

export const PREVIEW_VARIABLES = "E2E_PREVIEW_VARIABLES";

/** Only the names listed in `E2E_PREVIEW_VARIABLES`; for the build, without the secret and the connections. */
export function closedEnvironment(
  environment: NodeJS.ProcessEnv,
  stage: "build" | "preview"
): Record<string, string> {
  const listed = new Set(
    (environment[PREVIEW_VARIABLES] ?? "").split(",").filter(Boolean)
  );
  if (listed.size === 0) {
    throw new Error(
      `${PREVIEW_VARIABLES} is missing: serve.ts is started by the e2e config.`
    );
  }
  const closed: Record<string, string> = {};
  for (const name of listed) {
    const value = environment[name];
    const secretOrConnection =
      name === "BETTER_AUTH_SECRET" ||
      name === "OFFLINE_LEASE_SECRET" ||
      name === "SYNC_PAYLOAD_HASH_SECRET" ||
      name.startsWith("CLOUDFLARE_");
    if (value !== undefined && !(stage === "build" && secretOrConnection)) {
      closed[name] = value;
    }
  }
  return closed;
}
