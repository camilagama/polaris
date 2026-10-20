/**
 * The browser security headers of every response the platform sends (plan PR120, ADR 0090).
 *
 * One module owns them. Each kind of response asks for its profile and the apps apply it; no app
 * builds a policy by hand. The profiles differ in what the browser is allowed to load:
 *
 * - `app-shell`: the single-page app of apps/web (index.html, JS, CSS, the worker script). It is served
 *   by Workers Static Assets, which never runs the Worker, so the same headers are also rendered into
 *   `public/_headers` by `renderStaticHeadersFile` and a test keeps the file equal to the render.
 * - `auth-entry`: the same shell on the sign-in pages that show the Cloudflare Turnstile challenge (ADR 0100).
 *   Exactly two differences from `app-shell`: `script-src` takes the Turnstile origin and `frame-src` opens
 *   to it (the widget is an iframe); nothing else changes. Rendered into `public/_headers` for
 *   `AUTH_ENTRY_PATHS` only, so no other page of the app may load a third-party script.
 * - `api`: JSON and file answers of the Worker of apps/web. Nothing is ever loaded from them.
 * - `admin`: the Admin Worker. Like `api`, with no referrer at all (the host is behind Cloudflare Access).
 * - `public-document`: the HTML of the public catalog, rendered on the server. Its hydration scripts are
 *   inline, so the policy carries a nonce made for each response instead of 'unsafe-inline'.
 * - `public-media`: the image bytes of the public catalog, embeddable from other origins on purpose
 *   (a store link shared in a chat shows its photo), and inert as a document.
 *
 * No policy has 'unsafe-inline' or 'unsafe-eval', a wildcard source or a scheme-only source for
 * scripts, styles or connections. An origin is added only through `connectSources` (or `imgSources`), which
 * accepts exact https origins and nothing else.
 */

export type SecurityProfile =
  | "admin"
  | "api"
  | "app-shell"
  | "auth-entry"
  | "public-document"
  | "public-media";

export interface SecurityHeadersOptions {
  /**
   * Exact https origins the page may connect to (fetch and XHR), for example the ingest origin of an
   * error reporter. Empty by default: nothing is open until there is a reason.
   */
  connectSources?: readonly string[];
  /** Exact https origins images may load from. Empty by default: media goes through our own routes. */
  imgSources?: readonly string[];
  /** The nonce of this response; required by `public-document`, refused by the other profiles. */
  nonce?: string;
}

/** The headers of a profile. The isolation ones are absent from `public-media`, which any origin may embed. */
export interface SecurityHeaderSet {
  "Content-Security-Policy": string;
  "Cross-Origin-Opener-Policy"?: string;
  "Cross-Origin-Resource-Policy": string;
  "Permissions-Policy": string;
  "Referrer-Policy": string;
  "Strict-Transport-Security": string;
  "X-Content-Type-Options": string;
  "X-Frame-Options"?: string;
  "X-Permitted-Cross-Domain-Policies": string;
}

type Directives = ReadonlyArray<readonly [string, readonly string[]]>;

const SELF = "'self'";
/** The one origin of the Turnstile script and of its iframe. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The pages that show the challenge (sign in, create an account, forgotten password, new password and the
 * verification resend). `/desbloquear`, `/aceite`, the legal pages and the change of password have none.
 */
export const AUTH_ENTRY_PATHS = [
  "/entrar",
  "/criar-conta",
  "/esqueci-a-senha",
  "/redefinir-senha",
  "/confirmar-email",
] as const;
const NONE = "'none'";

// a host name of at least two labels whose last one starts with a letter (an IP address is not one)
const HTTPS_ORIGIN =
  /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/;
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22,}={0,2}$/;
const NONCE_BYTES = 16;

/** An origin that is not exactly `https://host[:port]` (no wildcard, path, scheme alone or keyword) is a mistake. */
function checkedOrigins(
  origins: readonly string[] | undefined,
  name: string
): readonly string[] {
  const list = origins ?? [];
  for (const origin of list) {
    if (!HTTPS_ORIGIN.test(origin)) {
      throw new Error(
        `${name}: "${origin}" is not an exact https origin (no wildcard, path or keyword)`
      );
    }
  }
  return [...new Set(list)].sort();
}

function serialize(directives: Directives): string {
  return directives
    .map(([directive, sources]) => [directive, ...sources].join(" "))
    .join("; ");
}

/**
 * The offline store is SQLite compiled to WebAssembly. 'wasm-unsafe-eval' lets the browser compile
 * WebAssembly and nothing else (it is not 'unsafe-eval': JavaScript eval stays blocked), and the
 * library embeds the module as a data: URL, so `connect-src` allows `data:`, which only reads bytes
 * already in the page and cannot reach the network. Without both, the local store fails to open under
 * this policy (proved in a browser by apps/web/e2e/offline-csp.e2e.ts).
 *
 * `style-src` has no 'unsafe-inline': the production build emits external CSS and React applies
 * `style` props through the CSSOM, which CSP does not block.
 */
function appShellPolicy(connect: readonly string[], img: readonly string[]) {
  return [
    ["default-src", [SELF]],
    ["script-src", [SELF, "'wasm-unsafe-eval'"]],
    ["style-src", [SELF]],
    ["img-src", [SELF, "blob:", "data:", ...img]],
    ["font-src", [SELF]],
    ["connect-src", [SELF, "data:", ...connect]],
    ["manifest-src", [SELF]],
    ["object-src", [NONE]],
    ["base-uri", [SELF]],
    ["form-action", [SELF]],
    ["frame-ancestors", [NONE]],
  ] satisfies Directives;
}

/** The shell with the challenge: its script and its iframe, and not one source more. */
function authEntryPolicy(connect: readonly string[], img: readonly string[]) {
  const directives: [string, readonly string[]][] = [];
  for (const [directive, sources] of appShellPolicy(connect, img)) {
    if (directive === "script-src") {
      directives.push([directive, [...sources, TURNSTILE_ORIGIN]]);
      continue;
    }
    directives.push([directive, sources]);
    if (directive === "connect-src") {
      directives.push(["frame-src", [TURNSTILE_ORIGIN]]);
    }
  }
  return directives satisfies Directives;
}

/** A response that is data, not a page: it may load nothing and cannot be framed or submit forms. */
const INERT_POLICY = [
  ["default-src", [NONE]],
  ["base-uri", [NONE]],
  ["form-action", [NONE]],
  ["frame-ancestors", [NONE]],
] satisfies Directives;

function publicDocumentPolicy(
  nonce: string,
  connect: readonly string[],
  img: readonly string[]
) {
  return [
    ["default-src", [NONE]],
    ["script-src", [SELF, `'nonce-${nonce}'`]],
    ["style-src", [SELF]],
    ["img-src", [SELF, ...img]],
    ["font-src", [SELF]],
    ["connect-src", [SELF, ...connect]],
    ["manifest-src", [NONE]],
    ["object-src", [NONE]],
    ["base-uri", [SELF]],
    ["form-action", [SELF]],
    ["frame-ancestors", [NONE]],
  ] satisfies Directives;
}

/** Image bytes: `sandbox` keeps an image that a browser opens as a document (an SVG, say) from running anything. */
const PUBLIC_MEDIA_POLICY = [
  ...INERT_POLICY,
  ["sandbox", []],
] satisfies Directives;

const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

function policyFor(
  profile: SecurityProfile,
  options: SecurityHeadersOptions
): string {
  const connect = checkedOrigins(options.connectSources, "connectSources");
  const img = checkedOrigins(options.imgSources, "imgSources");
  const { nonce } = options;

  if (profile === "public-document") {
    if (nonce === undefined || !NONCE_PATTERN.test(nonce)) {
      throw new Error("public-document needs the nonce of its response");
    }
    return serialize(publicDocumentPolicy(nonce, connect, img));
  }
  if (nonce !== undefined) {
    throw new Error(`${profile} has no inline script: it takes no nonce`);
  }
  if (profile === "app-shell") {
    return serialize(appShellPolicy(connect, img));
  }
  if (profile === "auth-entry") {
    return serialize(authEntryPolicy(connect, img));
  }
  if (connect.length > 0 || img.length > 0) {
    throw new Error(`${profile} loads nothing: it takes no sources`);
  }
  return serialize(
    profile === "public-media" ? PUBLIC_MEDIA_POLICY : INERT_POLICY
  );
}

/** A fresh, unguessable nonce for one response (128 random bits, base64). Never reuse one. */
export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** The security headers of a profile, by canonical name. Cache-Control is not here: see `defaultCacheControl`. */
export function securityHeaders(
  profile: SecurityProfile,
  options: SecurityHeadersOptions = {}
): SecurityHeaderSet {
  const headers: SecurityHeaderSet = {
    "Content-Security-Policy": policyFor(profile, options),
    // an image, not a document: any origin may embed it and it needs no isolation of its own
    "Cross-Origin-Resource-Policy":
      profile === "public-media" ? "cross-origin" : "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Referrer-Policy":
      profile === "admin" ? "no-referrer" : "strict-origin-when-cross-origin",
    // Sent by the application (not only a zone setting) so the policy is versioned and reviewable.
    // Browsers ignore it over plain HTTP, so local development is unaffected. `preload` is absent on
    // purpose: it is a one-way commitment to make at the domain level, not in application code.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Permitted-Cross-Domain-Policies": "none",
  };
  if (profile !== "public-media") {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["X-Frame-Options"] = "DENY";
  }
  return headers;
}

/**
 * The Cache-Control a profile imposes. The answers of the Worker and of the Admin come from an
 * authenticated session (or answer a session-less caller), so no shared or browser cache may keep them.
 * The Worker applies it only to an answer without a Cache-Control of its own (the file routes choose
 * `private, no-store`); the Admin applies it to every answer. The other profiles have none: the routes
 * that know their content decide (hashed assets, public catalog images). The HTML of the catalog is the
 * exception that the catalog's own entry enforces, because its nonce must never be cached.
 */
export function defaultCacheControl(profile: SecurityProfile): string | null {
  return profile === "api" || profile === "admin" ? "no-store" : null;
}

/**
 * The content of `public/_headers` of apps/web, which Workers Static Assets applies to the shell (the
 * Worker does not run for it). A test fails when the committed file differs from this text.
 *
 * The rules of `_headers` add up, and a page under two policies obeys both (the widget would be blocked),
 * so each sign-in page first detaches (`!`) the policy of `/*` and then sets its own.
 */
export function renderStaticHeadersFile(
  options: SecurityHeadersOptions = {}
): string {
  const lines = [
    "# Generated from @polaris/http-security (renderStaticHeadersFile), ADR 0090. Do not edit by hand:",
    "# change the module and copy the render; security-headers.test.ts fails while the two differ.",
    "# Workers Static Assets applies this file to the SPA shell only (index.html, JS, CSS, the",
    "# single-page-application fallback). Worker responses (/health, /ready, /rpc/*, /api/*) get their",
    "# headers from the same module through the Worker middleware.",
    "/*",
    ...Object.entries(securityHeaders("app-shell", options)).map(
      ([name, value]) => `  ${name}: ${value}`
    ),
    "",
    "# The sign-in pages with the Turnstile challenge (ADR 0100): the policy of /* is detached, then replaced.",
    ...AUTH_ENTRY_PATHS.flatMap((path) => [
      path,
      "  ! Content-Security-Policy",
      `  Content-Security-Policy: ${policyFor("auth-entry", options)}`,
    ]),
    "",
    "# The service worker script is always revalidated, so a new build is found at once.",
    "/sw.js",
    "  Cache-Control: no-cache",
    "",
  ];
  return lines.join("\n");
}
