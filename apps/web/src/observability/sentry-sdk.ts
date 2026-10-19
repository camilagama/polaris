import {
  type BrowserOptions,
  breadcrumbsIntegration,
  captureReactException,
  init,
} from "@sentry/react";
import type { ErrorInfo } from "react";
import { type SentryBuildEnv, sentryEnabled } from "./sentry-dsn";
import { sanitizeBreadcrumb, sanitizeEvent } from "./sentry-sanitize";

/**
 * The part of the browser reporter that touches the SDK (ADR 0098). It is a chunk of its own, loaded by
 * `sentry.ts` only in a build with a valid DSN, and it imports the SDK by name so the bundler leaves out what
 * the app never turns on (Replay, feedback, tracing).
 */

const CHROME_EXTENSION = /^chrome-extension:\/\//;
const FIREFOX_EXTENSION = /^moz-extension:\/\//;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
/** Integrations of the default set the app does not want: console capture, sessions, locale, own breadcrumbs. */
const DROPPED_INTEGRATIONS: ReadonlySet<string> = new Set([
  "Breadcrumbs",
  "BrowserSession",
  "Console",
  "CultureContext",
]);

/** The SDK options for this build, or `null` when reporting is off (no valid DSN, or no valid environment). */
export function sentryOptions(env: SentryBuildEnv): BrowserOptions | null {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  const environment = env.VITE_SENTRY_ENVIRONMENT?.trim();
  if (!(dsn && environment && sentryEnabled(env))) {
    return null;
  }
  const release = env.VITE_SENTRY_RELEASE?.trim().toLowerCase();
  return {
    beforeBreadcrumb: sanitizeBreadcrumb,
    beforeSend: sanitizeEvent,
    // v11 replaced `sendDefaultPii` by `dataCollection`: nothing is collected on its own (no user, cookies,
    // headers, query params, bodies or local variables); `sanitizeEvent` is the second line, not the first.
    dataCollection: {
      cookies: false,
      httpBodies: [],
      httpHeaders: false,
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    denyUrls: [CHROME_EXTENSION, FIREFOX_EXTENSION],
    dsn,
    environment,
    integrations: (defaults) => [
      ...defaults.filter((item) => !DROPPED_INTEGRATIONS.has(item.name)),
      // Navigation and requests only: a click or a console line can carry what the user typed.
      breadcrumbsIntegration({
        dom: false,
        fetch: true,
        history: true,
        sentry: false,
        xhr: true,
      }),
    ],
    maxBreadcrumbs: 30,
    release: release && COMMIT_SHA.test(release) ? release : undefined,
    // Tracing stays off: no sample rate, no tracing integration, and no `sentry-trace`/`baggage` header on requests.
    tracePropagationTargets: [],
  };
}

/** Starts the SDK. Returns false, starting nothing, when the options say reporting is off. */
export function startSentry(env: SentryBuildEnv): boolean {
  const options = sentryOptions(env);
  if (options === null) {
    return false;
  }
  init(options);
  return true;
}

export function reportReactError(error: Error, info: ErrorInfo): void {
  captureReactException(error, info);
}
