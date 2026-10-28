import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderStaticHeadersFile } from "@polaris/http-security";
import type { Plugin } from "vite";
import {
  sentryEnabled,
  sentryIngestOrigin,
} from "../src/observability/sentry-dsn";

/**
 * The build side of the browser Sentry (ADR 0098). The DSN only ever comes from the environment of the build
 * (`VITE_SENTRY_DSN`, with `VITE_SENTRY_ENVIRONMENT`); with both valid, the build also
 *
 * - opens the DSN's ingest origin, and only that, in the `connect-src` of the app shell (`_headers` in the
 *   output; the committed `public/_headers` stays the DSN-free baseline that the headers test pins), and
 * - stamps the commit SHA as the release, unless `VITE_SENTRY_RELEASE` already says one.
 *
 * Without them the output is identical to a build that never heard of Sentry.
 */
export interface SentryBuildSettings {
  /** Origins to add to `connect-src` of the app shell. */
  connectSources: string[];
  /** `import.meta.env` values to fix at build time. */
  define: Record<string, string>;
}

/** The SHA of the commit the build is made of: the one of the CI run, else the one of the working tree. */
export function commitSha(env: NodeJS.ProcessEnv): string | undefined {
  const fromCi = env.GITHUB_SHA?.trim();
  if (fromCi) {
    return fromCi;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function sentryBuildSettings(
  env: Record<string, string | undefined>,
  processEnv: NodeJS.ProcessEnv = process.env
): SentryBuildSettings {
  // the test the SDK itself uses: a DSN alone, without a valid environment, leaves the SDK off and the CSP closed
  const origin = sentryEnabled(env)
    ? sentryIngestOrigin(env.VITE_SENTRY_DSN?.trim())
    : null;
  if (origin === null) {
    return { connectSources: [], define: {} };
  }
  const release = env.VITE_SENTRY_RELEASE?.trim() || commitSha(processEnv);
  return {
    connectSources: [origin],
    define: release
      ? { "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(release) }
      : {},
  };
}

/**
 * Rewrites `_headers` of the browser build with the extra `connect-src` origins. It runs before the service
 * worker plugin (`order: "pre"`), because the build id of the worker hashes `_headers` too.
 */
export function appShellHeadersPlugin(connectSources: string[]): Plugin {
  return {
    apply: "build",
    name: "polaris:app-shell-headers",
    writeBundle: {
      handler(output) {
        if (
          connectSources.length === 0 ||
          (this.environment && this.environment.name !== "client") ||
          !output.dir
        ) {
          return;
        }
        writeFileSync(
          join(output.dir, "_headers"),
          renderStaticHeadersFile({ connectSources })
        );
      },
      order: "pre",
    },
  };
}
