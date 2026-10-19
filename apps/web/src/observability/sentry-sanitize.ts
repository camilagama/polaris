import { redact, redactText } from "@polaris/observability/redaction";
import type {
  Breadcrumb,
  ErrorEvent,
  Exception,
  StackFrame,
} from "@sentry/react";

/**
 * What leaves the browser for Sentry is sanitized here, with the same policy the server applies to its logs
 * (`@polaris/observability/redaction`, ADR 0089): keys that say what they hold lose their value, and strings
 * that look like an e-mail, phone, CPF/CNPJ, card, IP, cookie or token lose that part. On top of it:
 *
 * - a URL keeps its path (an id there is fine) but every query value is masked and the fragment is dropped,
 *   because `?token=`, `?code=`, `?state=` and a search term are all one datum the report does not need;
 * - the request keeps only its URL, method and the User-Agent/Referer headers; cookies, the body, the query
 *   string and every other header go;
 * - the user, form values and console output never leave (the SDK is also set up not to collect them).
 */

const MASK = "[REDACTED]";
const URL_KEYS: ReadonlySet<string> = new Set(["url", "from", "to"]);
/** Breadcrumb data that carries what the user typed or what the page sent. */
const DROPPED_DATA_KEYS = new Set([
  "arguments",
  "body",
  "input",
  "request_body",
  "requestbody",
  "response_body",
  "responsebody",
  "value",
]);
/** Keys that hold what a user typed in a form or what a request carried: the whole subtree goes, whatever is in it. */
const FORM_KEYS = new Set([
  "body",
  "fields",
  "form",
  "formdata",
  "formvalues",
  "input",
  "inputs",
  "payload",
  "requestbody",
  "responsebody",
]);
/** Only navigation and requests are kept: a click, an input or a console line can carry what the user typed. */
const KEPT_CATEGORIES: ReadonlySet<string> = new Set([
  "fetch",
  "navigation",
  "xhr",
]);
const KEPT_MECHANISM_KEYS: ReadonlySet<string> = new Set([
  "function",
  "handler",
  "target",
  "type",
]);
const KEPT_REQUEST_HEADERS = new Set(["referer", "user-agent"]);

/** `https://app/x?a=1&token=2#frag` becomes `https://app/x?a=[REDACTED]&token=[REDACTED]`. */
export function sanitizeUrl(url: string): string {
  const withoutFragment = url.split("#", 1)[0] ?? "";
  const queryStart = withoutFragment.indexOf("?");
  if (queryStart === -1) {
    return redactText(withoutFragment);
  }
  const path = redactText(withoutFragment.slice(0, queryStart));
  const query = withoutFragment
    .slice(queryStart + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const equals = pair.indexOf("=");
      // a name can carry data too (`?maria@example.com`), a value always can
      return equals === -1
        ? redactText(pair)
        : `${redactText(pair.slice(0, equals))}=${MASK}`;
    })
    .join("&");
  return query === "" ? path : `${path}?${query}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_FORM_SCAN_DEPTH = 8;

/** Replaces every subtree under a form-like key, at any depth, because free text has no pattern to catch it. */
function maskFormContent(value: unknown, depth = 0): unknown {
  if (depth >= MAX_FORM_SCAN_DEPTH || typeof value !== "object" || !value) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskFormContent(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      FORM_KEYS.has(key.toLowerCase().replaceAll(/[^a-z]/g, ""))
        ? "[REDACTED:form]"
        : maskFormContent(item, depth + 1),
    ])
  );
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redact(maskFormContent(value) as Record<string, unknown>);
}

export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (!(breadcrumb.category && KEPT_CATEGORIES.has(breadcrumb.category))) {
    return null;
  }
  const next: Breadcrumb = { ...breadcrumb };
  if (typeof next.message === "string") {
    next.message = redactText(next.message);
  }
  if (isRecord(next.data)) {
    const urls: Record<string, string> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.data)) {
      if (DROPPED_DATA_KEYS.has(key.toLowerCase())) {
        continue;
      }
      if (typeof value === "string" && URL_KEYS.has(key)) {
        // masked here, and kept out of `redact`, which would read `token=[REDACTED]` as a secret and eat the name
        urls[key] = sanitizeUrl(value);
      } else {
        rest[key] = value;
      }
    }
    next.data = { ...redactRecord(rest), ...urls };
  }
  return next;
}

function sanitizeRequest(
  request: NonNullable<ErrorEvent["request"]>
): NonNullable<ErrorEvent["request"]> {
  const next: NonNullable<ErrorEvent["request"]> = {};
  if (request.url !== undefined) {
    next.url = sanitizeUrl(request.url);
  }
  if (request.method !== undefined) {
    next.method = request.method;
  }
  if (request.headers !== undefined) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (KEPT_REQUEST_HEADERS.has(lower)) {
        headers[name] = lower === "referer" ? sanitizeUrl(value) : value;
      }
    }
    next.headers = headers;
  }
  return next;
}

function sanitizeFrame(frame: StackFrame): StackFrame {
  const next = { ...frame };
  if (next.abs_path !== undefined) {
    next.abs_path = sanitizeUrl(next.abs_path);
  }
  if (next.filename !== undefined) {
    next.filename = sanitizeUrl(next.filename);
  }
  return next;
}

function sanitizeException(item: Exception): Exception {
  const next = { ...item };
  if (next.value !== undefined) {
    next.value = redactText(next.value);
  }
  if (next.mechanism?.data) {
    // only the names of the handler and the target; whatever else a mechanism carries is not needed to diagnose
    const data = Object.fromEntries(
      Object.entries(next.mechanism.data).filter(([key]) =>
        KEPT_MECHANISM_KEYS.has(key)
      )
    );
    next.mechanism = {
      ...next.mechanism,
      data: redactRecord(data) as typeof next.mechanism.data,
    };
  }
  if (next.stacktrace?.frames) {
    // frames are not run through `redact` (it caps a list at 100 entries); only the file URLs can carry data
    next.stacktrace = {
      ...next.stacktrace,
      frames: next.stacktrace.frames.map(sanitizeFrame),
    };
  }
  return next;
}

export function sanitizeEvent(event: ErrorEvent): ErrorEvent {
  // the user and the host name never leave
  const { server_name: _host, user: _user, ...next } = event;
  if (next.message !== undefined) {
    next.message = redactText(next.message);
  }
  if (next.logentry) {
    const { params: _params, ...logentry } = next.logentry;
    next.logentry =
      logentry.message === undefined
        ? logentry
        : { ...logentry, message: redactText(logentry.message) };
  }
  if (next.transaction !== undefined) {
    next.transaction = sanitizeUrl(next.transaction);
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map(sanitizeException),
    };
  }
  if (next.request) {
    next.request = sanitizeRequest(next.request);
  }
  if (next.breadcrumbs) {
    next.breadcrumbs = next.breadcrumbs
      .map(sanitizeBreadcrumb)
      .filter((item): item is Breadcrumb => item !== null);
  }
  if (next.fingerprint) {
    next.fingerprint = next.fingerprint.map((part) => redactText(part));
  }
  if (next.extra) {
    // `__serialized__` is what the SDK makes of a thrown value that is not an Error: free text and fields, any shape
    const { __serialized__: _thrown, ...extra } = next.extra;
    next.extra = redactRecord(extra);
  }
  if (next.contexts) {
    next.contexts = redactRecord(next.contexts) as NonNullable<
      ErrorEvent["contexts"]
    >;
  }
  if (next.tags) {
    next.tags = redactRecord(next.tags) as NonNullable<ErrorEvent["tags"]>;
  }
  return next;
}
