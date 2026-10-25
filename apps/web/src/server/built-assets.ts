import { securityHeaders } from "@polaris/http-security";

/**
 * The files of the build under `/assets/` (the hashed scripts and style sheets, ADR 0103). The platform answers an
 * unknown path with the shell, `200 text/html`, which is right for a page and wrong for a file: a chunk that is not
 * there yet (a deploy in progress) or no longer (an old tab after a deploy) came back as a page, and `import()` and the
 * service worker took it for the chunk. The Worker runs first for this prefix (`run_worker_first`), passes the
 * request to the static assets and turns that fallback, and any miss, into a 404 that is never cached.
 */
export interface AssetsBinding {
  fetch: (request: Request) => Promise<Response>;
}

const ASSETS_PREFIX = "/assets/";
const HTML_TYPE = /^text\/html/i;
// the Worker's own answers are not pages (`api`); a file of the build has the policy of the shell, as `_headers` gives it
const REFUSAL_HEADERS = Object.entries(securityHeaders("api"));
const FILE_HEADERS = Object.entries(securityHeaders("app-shell"));

export function isBuiltAssetRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(ASSETS_PREFIX);
}

/** An answer of the Worker itself (not a file): never cached, with the security headers of the Worker's answers. */
function refusal(status: number, body: string | null, init: HeadersInit = {}) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    ...init,
  });
  for (const [name, value] of REFUSAL_HEADERS) {
    headers.set(name, value);
  }
  return new Response(body, { headers, status });
}

export async function serveBuiltAsset(
  request: Request,
  assets: AssetsBinding
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return refusal(405, null, { Allow: "GET, HEAD" });
  }
  const response = await assets.fetch(request);
  const type = response.headers.get("Content-Type") ?? "";
  if (response.status === 404 || (response.ok && HTML_TYPE.test(type))) {
    await response.body?.cancel();
    return refusal(404, "Not found");
  }
  // the file keeps what the platform gave it (`_headers` included) and gets the headers of the shell (the same
  // module, so the same values) where there are none, so it does not depend on `_headers` having matched this path:
  // a script worker takes its CSP from its own response, so it must be the app's, never the `api` one
  const served = new Response(response.body, response);
  for (const [name, value] of FILE_HEADERS) {
    if (!served.headers.has(name)) {
      served.headers.set(name, value);
    }
  }
  return served;
}
