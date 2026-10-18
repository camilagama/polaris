import { securityHeaders } from "@polaris/http-security";

/**
 * The security headers of the public catalog (ADR 0090). The server entry (`src/server.ts`) gives each
 * request a nonce, hands it to the router (the hydration scripts of the page carry it) and sets the
 * headers on what comes back, so no route writes a Content-Security-Policy of its own.
 */

/** A Cache-Control that already keeps a page out of shared caches. */
const PRIVATE_CACHE = /\b(private|no-store)\b/;

/** Carries the nonce of a request from the server entry to `getRouter`; the entry overwrites whatever the client sent. */
export const NONCE_HEADER = "x-polaris-csp-nonce";

/** The request with a nonce of ours in it: a value sent by the client is replaced, never trusted. */
export function requestWithNonce(request: Request, nonce: string): Request {
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  return new Request(request, { headers });
}

/**
 * The response with its security headers: a page (HTML) gets the policy with the nonce, anything else
 * that is not already covered (a redirect, robots.txt) is inert. A route that set its own policy, as the
 * image route does through the same module, keeps it. A page is never kept by a shared cache, whatever
 * its route asked for: its nonce is made for one response, and a copy served to another visitor would
 * make the nonce public. Other responses keep the Cache-Control of the route that knows its content.
 */
export function secureResponse(response: Response, nonce: string): Response {
  if (response.headers.has("Content-Security-Policy")) {
    return response;
  }
  const secured = new Response(response.body, response);
  const isDocument = (response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("text/html");
  const headers = isDocument
    ? securityHeaders("public-document", { nonce })
    : securityHeaders("api");
  for (const [name, value] of Object.entries(headers)) {
    secured.headers.set(name, value);
  }
  if (
    isDocument &&
    !PRIVATE_CACHE.test(response.headers.get("Cache-Control") ?? "")
  ) {
    secured.headers.set("Cache-Control", "private, no-cache");
  }
  return secured;
}
