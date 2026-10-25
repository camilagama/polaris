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
const SECURITY_HEADERS = Object.entries(securityHeaders("api"));

export function isBuiltAssetRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(ASSETS_PREFIX);
}

function notFound(): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  for (const [name, value] of SECURITY_HEADERS) {
    headers.set(name, value);
  }
  return new Response("Not found", { headers, status: 404 });
}

export async function serveBuiltAsset(
  request: Request,
  assets: AssetsBinding
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { headers: { Allow: "GET, HEAD" }, status: 405 });
  }
  const response = await assets.fetch(request);
  const type = response.headers.get("Content-Type") ?? "";
  if (response.status === 404 || (response.ok && HTML_TYPE.test(type))) {
    await response.body?.cancel();
    return notFound();
  }
  return response;
}
