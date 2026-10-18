import { execFileSync } from "node:child_process";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ORIGIN_HOST } from "./config";

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};
const WORKER_PATHS = ["/api/", "/rpc/"];

/** Certificado autoassinado e descartável: vive num diretório temporário privado e some ao final. */
export function selfSignedCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "polaris-gate5-cert-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      `/CN=${ORIGIN_HOST}`,
      "-addext",
      `subjectAltName=DNS:${ORIGIN_HOST},DNS:localhost`,
    ],
    { stdio: "ignore" }
  );
  return {
    cert: readFileSync(certPath),
    dispose: () => rmSync(directory, { force: true, recursive: true }),
    key: readFileSync(keyPath),
  };
}

function fileFor(root: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = normalize(join(root, decoded));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    return null;
  }
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Serve um build estático em HTTPS, com fallback de página única; `/api/` e `/rpc/` respondem 404. */
export function serveBuild(
  directory: string,
  port: number,
  tls: { cert: Buffer; key: Buffer }
): Promise<Server> {
  const root = resolve(directory);
  const server = createServer(tls, (request, response) => {
    try {
      const { pathname } = new URL(request.url ?? "/", "https://localhost");
      if (WORKER_PATHS.some((prefix) => pathname.startsWith(prefix))) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      let file = fileFor(root, pathname);
      if (!file && extname(pathname) === "") {
        file = fileFor(root, "/index.html");
      }
      if (!file) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}
