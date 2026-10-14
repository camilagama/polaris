// A tiny static server for the browser checks of the service worker: it reads the
// build directory on every request, so a test can rebuild the app while it runs
// ("a new version"), which `vite preview` does not survive. Single-page fallback
// like the Worker's static assets; the Worker's own paths answer 404.
//   node scripts/serve-static.mjs <dir> <port>
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

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
};
const workerPaths = ["/api/", "/rpc/"];

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
    "cache-control": "no-cache",
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
}).listen(Number(port), "127.0.0.1");
