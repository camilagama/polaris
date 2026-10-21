// A tiny static server for the browser checks of the service worker: it reads the
// build directory on every request, so a test can rebuild the app while it runs
// ("a new version"), which `vite preview` does not survive. Single-page fallback
// like the Worker's static assets; the Worker's own paths answer 404. The headers
// are the build's own `_headers` file, applied the way Workers Static Assets does
// (every matching rule in order, `! Name` detaching a header), so the browser
// checks run under the shell's real Content-Security-Policy (ADR 0103, condition 2).
//   node scripts/serve-static.mjs <dir> <port>
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { headersForPath, parseHeadersFile } from "./static-headers.mjs";

const [directory = "dist/pwa-e2e", port = "4174"] = process.argv.slice(2);
const root = resolve(directory);
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

createServer((request, response) => {
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
}).listen(Number(port), "127.0.0.1");
