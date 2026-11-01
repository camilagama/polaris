import type { Plugin } from "vite";
import { SHORT_SHA } from "./index";

/** What the Worker reads: `import.meta.env.POLARIS_SERVER_RELEASE`, undefined outside a build (tests, dev). */
export const SERVER_RELEASE_KEY = "import.meta.env.POLARIS_SERVER_RELEASE";

/**
 * The release the Worker declares (ADR 0098, amended): the first 12 characters of `VITE_RELEASE`, in lowercase,
 * the format of the release of the browser. Anything that is not then exactly 12 hex characters is `""`, and the
 * Worker sends no release header. No fallback to `GITHUB_SHA`: in a `workflow_run` it is the tip of the default
 * branch, not the commit that was built.
 */
export function serverRelease(env: Record<string, string | undefined>): string {
  const release = (env.VITE_RELEASE ?? "").trim().slice(0, 12).toLowerCase();
  return SHORT_SHA.test(release) ? release : "";
}

/**
 * Defines the release in every environment of the build but the browser one. A SHA in the bundle of the client
 * would make every commit a new build of the installed app (ADR 0041), so the client never gets it. The name has
 * no `VITE_` prefix, so Vite never exposes it to the client by itself.
 */
export function serverReleasePlugin(release: string): Plugin {
  return {
    configEnvironment(name) {
      if (name === "client") {
        return;
      }
      return { define: { [SERVER_RELEASE_KEY]: JSON.stringify(release) } };
    },
    name: "polaris:server-release",
  };
}
