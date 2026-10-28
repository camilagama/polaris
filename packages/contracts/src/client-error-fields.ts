/**
 * The closed lists of the report of an error of the app in the browser (`POST /api/client-errors`). No zod here: the
 * browser builds the event from these lists alone, and the schema of `client-error.ts` checks them again on the
 * server. Every value is a word of a list or a number: nothing in the event is text the person typed or the page
 * received.
 */

export const CLIENT_ERROR_EVENT_VERSION = 1;

/** Where the error was caught: an error boundary, `window.onerror`, `unhandledrejection` or a piece that did not download. */
export const CLIENT_ERROR_KINDS = [
  "boundary",
  "chunk",
  "error",
  "rejection",
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** The class of the error by its `name`; any other name (a class of the app, of a library) is `Other`. */
export const CLIENT_ERROR_NAMES = [
  "ChunkLoadError",
  "Error",
  "Other",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
] as const;
export type ClientErrorName = (typeof CLIENT_ERROR_NAMES)[number];

/** The codes of an oRPC error; a code outside the list is `OTHER`. */
export const CLIENT_ERROR_RPC_CODES = [
  "BAD_GATEWAY",
  "BAD_REQUEST",
  "CLIENT_CLOSED_REQUEST",
  "CONFLICT",
  "FORBIDDEN",
  "GATEWAY_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "METHOD_NOT_SUPPORTED",
  "NOT_ACCEPTABLE",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
  "OTHER",
  "PAYLOAD_TOO_LARGE",
  "PRECONDITION_FAILED",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "TOO_MANY_REQUESTS",
  "UNAUTHORIZED",
  "UNPROCESSABLE_CONTENT",
  "UNSUPPORTED_MEDIA_TYPE",
] as const;
export type ClientErrorRpcCode = (typeof CLIENT_ERROR_RPC_CODES)[number];

/** The error boundary that caught it: the one of the whole page or the one of a screen (or of a tab). */
export const CLIENT_ERROR_BOUNDARIES = ["app", "screen"] as const;
export type ClientErrorBoundary = (typeof CLIENT_ERROR_BOUNDARIES)[number];

/**
 * The screen on display, as the pattern of the route and never the address: the screens of the shell (`ROUTES` of
 * `app-shell/navigation-model.ts`), a screen with tabs as `screen:tab`, then the sign-in pages (`entrar`), the
 * acceptance (`aceite`), the public catalog without its slug (`catalogo`) and anything else (`outra`). A test of
 * the app keeps the shell's part equal to the routes, so a new screen cannot fall into `outra` unnoticed.
 */
export const CLIENT_ERROR_ROUTE_IDS = [
  "attention",
  "customers",
  "dashboard:despesas",
  "dashboard:metas",
  "dashboard:resultado",
  "home",
  "inventory",
  "products:categorias",
  "products:produtos",
  "sale",
  "sale-detail",
  "sale-history",
  "settings:aparelhos",
  "settings:assinatura",
  "settings:catalogo-publico",
  "settings:formas-de-receber",
  "settings:senha",
  "aceite",
  "catalogo",
  "entrar",
  "outra",
] as const;
export type ClientErrorRouteId = (typeof CLIENT_ERROR_ROUTE_IDS)[number];

/** The route ids that are not a screen of the shell. */
export const CLIENT_ERROR_OTHER_ROUTE_IDS = [
  "aceite",
  "catalogo",
  "entrar",
  "outra",
] as const satisfies readonly ClientErrorRouteId[];

export const CLIENT_ERROR_MAX_FRAMES = 3;

/**
 * One position in the code: a file the build generated (`name-<8 characters of hash>.js`, the name of `/assets/`),
 * its line and its column. No function name and no URL: the name of a minified function says nothing and can carry
 * text.
 */
export const CLIENT_ERROR_FRAME_PATTERN =
  /^[A-Za-z0-9_-]{1,64}-[A-Za-z0-9_-]{8}\.js:\d{1,7}:\d{1,7}$/;

/** The short SHA of the commit of the build (`VITE_RELEASE`). */
export const CLIENT_ERROR_RELEASE_PATTERN = /^[0-9a-f]{7,12}$/;

/** The largest body the route reads, in bytes. */
export const CLIENT_ERROR_BODY_MAX_BYTES = 2 * 1024;

export interface ClientErrorEvent {
  boundary?: ClientErrorBoundary | undefined;
  code?: ClientErrorRpcCode | undefined;
  errorName: ClientErrorName;
  frames?: string[] | undefined;
  kind: ClientErrorKind;
  release?: string | undefined;
  routeId: ClientErrorRouteId;
  status?: number | undefined;
  v: typeof CLIENT_ERROR_EVENT_VERSION;
}

/** The name of the piece of the first frame without its hash (`sale-form-model-BX3k9a1Z.js:1:2` is `sale-form-model`). */
export function chunkNameOfFrame(frame: string): string | null {
  if (!CLIENT_ERROR_FRAME_PATTERN.test(frame)) {
    return null;
  }
  const file = frame.slice(0, frame.indexOf(".js:"));
  return file.slice(0, -"-12345678".length);
}
