/**
 * Single source of truth for browser security headers.
 *
 * The SPA shell (index.html, JS, CSS) is served by Workers Static Assets and
 * never runs through the Worker, so `public/_headers` must carry the same
 * policy for those responses. The Worker applies it to /health, /ready, /rpc/*
 * and /api/*. `security-headers.test.ts` fails when the two copies diverge.
 *
 * - CSP lives in both places because a clickjacking/XSS defense is only useful
 *   on the HTML document (static) and API responses are cheap to cover too.
 *   `style-src` has no 'unsafe-inline': the production build emits external CSS
 *   and React applies `style` props through the CSSOM, which CSP does not block.
 * - The offline store is SQLite compiled to WebAssembly. 'wasm-unsafe-eval' lets
 *   the browser compile WebAssembly and nothing else (it is NOT 'unsafe-eval':
 *   JavaScript eval stays blocked), and the library embeds the module as a data:
 *   URL, so `connect-src` allows `data:`, which can only read bytes already in the
 *   page and cannot reach the network. Without both, the local store fails to open
 *   under this policy (proved in a browser by e2e/offline-csp.e2e.ts).
 * - HSTS is sent by the application (not only a zone setting) so the policy is
 *   versioned and reviewable. Browsers ignore it over plain HTTP, so local
 *   development is unaffected. `preload` is intentionally absent: it is a
 *   one-way commitment to be made at the domain level, not in application code.
 */
const CONTENT_SECURITY_POLICY_DIRECTIVES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
  ["style-src", ["'self'"]],
  ["img-src", ["'self'", "blob:", "data:"]],
  ["font-src", ["'self'"]],
  ["connect-src", ["'self'", "data:"]],
  ["manifest-src", ["'self'"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'self'"]],
  ["frame-ancestors", ["'none'"]],
];

const CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY_DIRECTIVES.map(
  ([directive, sources]) => `${directive} ${sources.join(" ")}`
).join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
