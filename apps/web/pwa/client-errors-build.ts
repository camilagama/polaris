import { commitSha } from "./sentry-build";

const SHORT_SHA_LENGTH = 12;

/**
 * The build side of the reports of errors of the browser (`src/lib/client-errors.ts`, ADR 0098 amended). With
 * `VITE_CLIENT_ERRORS_ENABLED=true` the build stamps `VITE_RELEASE`, the short SHA of its commit (12 characters),
 * unless the environment already says one: the bundle cannot carry the hash of itself, and the Worker and the shell
 * come from the same commit. Without the flag nothing is defined, so the output is the same as a build that never
 * heard of the reports and a commit that changes no file of the app is no new build.
 */
export function clientErrorsBuildDefine(
  env: Record<string, string | undefined>,
  processEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (env.VITE_CLIENT_ERRORS_ENABLED !== "true") {
    return {};
  }
  const release = (env.VITE_RELEASE?.trim() || commitSha(processEnv))
    ?.slice(0, SHORT_SHA_LENGTH)
    .toLowerCase();
  return release
    ? { "import.meta.env.VITE_RELEASE": JSON.stringify(release) }
    : {};
}
