// The static server of the browser checks (see serve-static.mjs for what it does), as a function: the
// update checks start one of their own on a free port, over a build directory of their own.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { headersForPath, parseHeadersFile } from "./static-headers.mjs";

const types = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
const workerPaths = ["/api/", "/rpc/"];

export function createStaticServer(directory) {
  const root = resolve(directory);

  function headersOfBuild(pathname) {
    const file = join(root, "_headers");
    return existsSync(file)
      ? headersForPath(parseHeadersFile(readFileSync(file, "utf8")), pathname)
      : {};
  }

  function fileFor(pathname) {
    const path = normalize(join(root, decodeURIComponent(pathname)));
    if (!path.startsWith(root)) {
      return null;
    }
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  return createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (workerPaths.some((prefix) => pathname.startsWith(prefix))) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    let file = fileFor(pathname);
    if (!file && extname(pathname) === "") {
      file = fileFor("/index.html"); // single-page fallback
    }
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headersOfBuild(pathname),
      "cache-control": "no-cache",
      "content-type": types[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });
}
