/**
 * The ingest origin of a Sentry DSN, or `null` when the value is not a DSN this app accepts. The same check
 * decides whether the SDK starts (`sentry.ts`) and which origin the CSP of the app shell opens (the Vite
 * config), so a malformed or foreign value turns the reporter off instead of opening an origin.
 *
 * Accepted: `https://<public key>@o<org id>.ingest[.<region>].sentry.io/<numeric project id>`, no password, no port, no query.
 */
const INGEST_HOST = /^o\d+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/;
const PROJECT_PATH = /^\/\d+$/;

export function sentryIngestOrigin(dsn: string | undefined): string | null {
  if (!dsn) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const valid =
    url.protocol === "https:" &&
    url.username !== "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    PROJECT_PATH.test(url.pathname) &&
    INGEST_HOST.test(url.hostname);
  return valid ? url.origin : null;
}

export interface SentryBuildEnv {
  /** `VITE_SENTRY_DSN`: the only switch. Empty or invalid, the SDK stays off. */
  VITE_SENTRY_DSN?: string | undefined;
  /** `VITE_SENTRY_ENVIRONMENT`: `local`, `staging` or `production`. Required when there is a DSN. */
  VITE_SENTRY_ENVIRONMENT?: string | undefined;
  /** `VITE_SENTRY_RELEASE`: the commit SHA of the build (the Vite config fills it in when a DSN is set). */
  VITE_SENTRY_RELEASE?: string | undefined;
}

const ENVIRONMENTS: ReadonlySet<string> = new Set([
  "local",
  "staging",
  "production",
]);

/**
 * True when the build asks for the reporter and says what it is reporting from: a valid DSN and a known
 * environment. The SDK (`initSentry`) and the CSP of the build (`pwa/sentry-build.ts`) use this one test, so
 * the CSP never opens an origin for an SDK that stays off.
 */
export function sentryEnabled(env: SentryBuildEnv): boolean {
  const environment = env.VITE_SENTRY_ENVIRONMENT?.trim();
  return (
    sentryIngestOrigin(env.VITE_SENTRY_DSN?.trim()) !== null &&
    environment !== undefined &&
    ENVIRONMENTS.has(environment)
  );
}
