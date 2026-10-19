import type { ErrorInfo } from "react";
import { type SentryBuildEnv, sentryEnabled } from "./sentry-dsn";

/**
 * Browser error reporting (ADR 0098). Errors only: no Session Replay, no profiling, no tracing, no release
 * health sessions, and nothing leaves the browser unless the build carries a valid DSN and environment.
 * This file is all that stays in the main bundle: the SDK, its options and the sanitization live in
 * `sentry-sdk.ts`, a chunk fetched only for such a build. An error raised before that chunk arrives is not
 * reported.
 */

let loaded: typeof import("./sentry-sdk") | null = null;

/** Starts the SDK when the build has a valid DSN. Resolves to whether it started; without one nothing is loaded or sent. */
export async function initSentry(env: SentryBuildEnv): Promise<boolean> {
  if (loaded !== null) {
    return true;
  }
  if (!sentryEnabled(env)) {
    return false;
  }
  const sdk = await import("./sentry-sdk");
  if (!sdk.startSentry(env)) {
    return false;
  }
  loaded = sdk;
  return true;
}

/** For the Error Boundary: reports the render error with React's component stack. A no-op while the SDK is off, and never throws. */
export function reportRenderError(error: Error, info: ErrorInfo): void {
  try {
    loaded?.reportReactError(error, info);
  } catch {
    // reporting must never take the fallback screen down
  }
}
