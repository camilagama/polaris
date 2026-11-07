import {
  CLIENT_ERROR_EVENT_VERSION,
  CLIENT_ERROR_MAX_FRAMES,
  CLIENT_ERROR_NAMES,
  CLIENT_ERROR_RELEASE_PATTERN,
  CLIENT_ERROR_ROUTE_IDS,
  CLIENT_ERROR_RPC_CODES,
  type ClientErrorBoundary,
  type ClientErrorEvent,
  type ClientErrorKind,
  type ClientErrorName,
  type ClientErrorRouteId,
  type ClientErrorRpcCode,
  chunkNameOfFrame,
} from "@polaris/contracts/client-error-fields";
import type { ErrorInfo } from "react";
import { isChunkLoadError } from "../app-shell/chunk-load-error";
import { entryPageFor, screenKeyOf } from "../app-shell/navigation-model";
import { reportRenderError, sentryActive } from "../observability/sentry";
import { isNoAnswer } from "./connection";
import { isLegalAcceptancePath } from "./legal-acceptance";

/**
 * The report of an error of the app in the browser, without Sentry (ADR 0098, amended): one minimal event to
 * `POST /api/client-errors`, which the Worker checks again and writes as one log line. The event is built from closed
 * lists only (`@polaris/contracts/client-error-fields`): the kind, the class of the error by its name, the code and
 * the status of an oRPC error, the release, the boundary, the screen as a pattern and up to three positions in the
 * generated files. The text of the error, its cause, the component stack and the address are never read into it.
 *
 * At most three reports per page load and one per local signature; `fetch` with `keepalive` and no credentials, no
 * retry, no queue, nothing kept on the device. A failure of the network is not reported (it is not a bug of the app),
 * and offline the report is dropped. Off unless the build says `VITE_CLIENT_ERRORS_ENABLED=true`; with Sentry started,
 * Sentry is the destination and this route gets nothing.
 */

export const CLIENT_ERRORS_PATH = "/api/client-errors";
const MAX_REPORTS_PER_LOAD = 3;

const KNOWN_NAMES: ReadonlySet<string> = new Set(CLIENT_ERROR_NAMES);
const KNOWN_CODES: ReadonlySet<string> = new Set(CLIENT_ERROR_RPC_CODES);
const KNOWN_ROUTES: ReadonlySet<string> = new Set(CLIENT_ERROR_ROUTE_IDS);
/** What a call that got no answer throws (`isNoAnswer` of `connection.ts` without its `TypeError`, which is any bug too). */
const NO_ANSWER_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "NoWorkerAnswerError",
  "TimeoutError",
]);
/** A position in a file of `/assets/` of an origin, at the end of a line of a stack (Chrome, Firefox and Safari). */
const ASSET_POSITION =
  /(https?:\/\/[^\s/()@]+)\/assets\/([A-Za-z0-9_-]{1,64}-[A-Za-z0-9_-]{8}\.js):(\d{1,7}):(\d{1,7})\)?$/;

export interface ClientErrorReport {
  boundary?: ClientErrorBoundary;
  kind: ClientErrorKind;
  /** React's info of a render error: handed to Sentry as it is, never read here. */
  renderInfo?: ErrorInfo;
}

export interface ClientErrorEnvironment {
  address: () => { pathname: string; search: string };
  enabled: boolean;
  online: () => boolean;
  origin: () => string;
  release: string | undefined;
  send: (body: string) => void;
  sentry: {
    active: () => boolean;
    reportRender: (error: Error, info: ErrorInfo) => void;
  };
}

/** The screen as the event names it: a pattern of a closed list, never the address. */
export function clientErrorRouteId(
  pathname: string,
  search: string
): ClientErrorRouteId {
  if (entryPageFor(pathname) !== null) {
    return "entrar";
  }
  if (isLegalAcceptancePath(pathname)) {
    return "aceite";
  }
  const key = screenKeyOf(pathname, search);
  return key !== null && KNOWN_ROUTES.has(key)
    ? (key as ClientErrorRouteId)
    : "outra";
}

function errorNameOf(error: unknown, kind: ClientErrorKind): ClientErrorName {
  if (kind === "chunk") {
    return "ChunkLoadError";
  }
  if (!(error instanceof Error)) {
    return "Other";
  }
  return KNOWN_NAMES.has(error.name)
    ? (error.name as ClientErrorName)
    : "Other";
}

/** The code and the status of an oRPC error (a string `code` and a numeric `status`), from their closed lists. */
function rpcFieldsOf(error: unknown): {
  code?: ClientErrorRpcCode;
  status?: number;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (typeof code !== "string" || typeof status !== "number") {
    return {};
  }
  return {
    code: KNOWN_CODES.has(code) ? (code as ClientErrorRpcCode) : "OTHER",
    ...(Number.isInteger(status) && status >= 400 && status <= 599
      ? { status }
      : {}),
  };
}

/**
 * Up to three positions `file:line:column` in the files the build generated and this origin served. The stack is
 * only matched line by line against that pattern: nothing else of it (the text of the error, a function name, another
 * origin) can come out.
 */
function framesOf(error: unknown, origin: string): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return [];
  }
  const frames: string[] = [];
  for (const line of error.stack.split("\n")) {
    const match = ASSET_POSITION.exec(line.trim());
    if (match !== null && match[1] === origin) {
      frames.push(`${match[2]}:${match[3]}:${match[4]}`);
      if (frames.length === CLIENT_ERROR_MAX_FRAMES) {
        break;
      }
    }
  }
  return frames;
}

/** The event of an error: only the fields of the list, each from its closed list or pattern. */
export function clientErrorEvent(
  error: unknown,
  report: ClientErrorReport,
  environment: Pick<ClientErrorEnvironment, "address" | "origin" | "release">
): ClientErrorEvent {
  const { pathname, search } = environment.address();
  const frames = framesOf(error, environment.origin());
  const release = environment.release?.trim().toLowerCase();
  return {
    errorName: errorNameOf(error, report.kind),
    kind: report.kind,
    v: CLIENT_ERROR_EVENT_VERSION,
    ...rpcFieldsOf(error),
    ...(release !== undefined && CLIENT_ERROR_RELEASE_PATTERN.test(release)
      ? { release }
      : {}),
    ...(report.boundary === undefined ? {} : { boundary: report.boundary }),
    routeId: clientErrorRouteId(pathname, search),
    ...(frames.length > 0 ? { frames } : {}),
  };
}

/** The same failure in this page load: the fields the server signs, with the piece of the first frame and no hash. */
function localSignature(event: ClientErrorEvent): string {
  const first = event.frames?.[0];
  return [
    event.kind,
    event.errorName,
    event.code ?? "",
    event.status ?? "",
    event.boundary ?? "",
    event.routeId,
    first === undefined ? "" : (chunkNameOfFrame(first) ?? ""),
  ].join("|");
}

/** A call that got no answer is the network, not the app; an unhandled rejection is where a failed `fetch` ends up. */
function isNetworkFailure(error: unknown, kind: ClientErrorKind): boolean {
  if (kind === "rejection") {
    return isNoAnswer(error);
  }
  return error instanceof Error && NO_ANSWER_NAMES.has(error.name);
}

/** One reporter per page load: the counts live as long as the page. Never throws. */
export function createClientErrorReporter(
  environment: ClientErrorEnvironment
): (error: unknown, report: ClientErrorReport) => void {
  let sent = 0;
  const signatures = new Set<string>();
  return (error, report) => {
    try {
      if (environment.sentry.active()) {
        if (report.renderInfo !== undefined && error instanceof Error) {
          environment.sentry.reportRender(error, report.renderInfo);
        }
        return;
      }
      if (
        !environment.enabled ||
        sent >= MAX_REPORTS_PER_LOAD ||
        !environment.online() ||
        isNetworkFailure(error, report.kind)
      ) {
        return;
      }
      const event = clientErrorEvent(error, report, environment);
      const signature = localSignature(event);
      if (signatures.has(signature)) {
        return;
      }
      signatures.add(signature);
      sent += 1;
      environment.send(JSON.stringify(event));
    } catch {
      // reporting must never take the fallback screen, or the page, down
    }
  };
}

function sendReport(body: string): void {
  fetch(CLIENT_ERRORS_PATH, {
    body,
    credentials: "omit",
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);
}

const browserReporter = createClientErrorReporter({
  address: () => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }),
  enabled: import.meta.env.VITE_CLIENT_ERRORS_ENABLED === "true",
  online: () => navigator.onLine !== false,
  origin: () => window.location.origin,
  release: import.meta.env.VITE_RELEASE,
  send: sendReport,
  sentry: { active: sentryActive, reportRender: reportRenderError },
});

/** The one entry of the app: picks the destination (Sentry when it started, else the route of the Worker). */
export function reportClientError(error: unknown, report: ClientErrorReport) {
  browserReporter(error, report);
}

/** The errors no boundary caught: `window.onerror` (with an error object) and the unhandled rejections. */
export function installClientErrorListeners(
  target: Pick<Window, "addEventListener">,
  report: (
    error: unknown,
    report: ClientErrorReport
  ) => void = reportClientError
): void {
  target.addEventListener("error", (event: ErrorEvent) => {
    // a script of another origin or an extension gives no error object: nothing of ours to say
    if (event.error !== null && event.error !== undefined) {
      report(event.error, { kind: "error" });
    }
  });
  target.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      report(event.reason, {
        kind: isChunkLoadError(event.reason) ? "chunk" : "rejection",
      });
    }
  );
}
