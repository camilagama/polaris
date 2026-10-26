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
/**
 * A marca que o Worker põe em toda resposta (`X-Request-Id` com um UUID, emenda do ADR 0043): sem ela o app toma a
 * resposta por falta de resposta do Worker e o laboratório para em "unavailable" em vez de "ready".
 */
const workerMark = () => ({ "x-request-id": crypto.randomUUID() });
const CALENDAR_CHUNK = /^\/assets\/calendar-[\w-]+\.js$/;

/** A chave de teste do fluxo 4 (a suíte liga e desliga): ligada, o servidor do shell responde 503 ao chunk do calendário. */
export const calendarChunkBlock: { on: boolean } = { on: false };

/** Para `serveBuild({ refuse })`: o chunk do calendário (`/assets/calendar-<hash>.js`, com qualquer query) com a chave ligada. */
export const refuseCalendarChunk = (pathname: string) =>
  calendarChunkBlock.on && CALENDAR_CHUNK.test(pathname);

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

/**
 * Serve um build estático em HTTPS, com fallback de página única; `/api/` e `/rpc/` respondem 404 e `/health` 200,
 * com a marca do Worker, como o Worker responde. `refuse` (só da suíte) responde 503 aos caminhos que ele aceitar.
 */
export function serveBuild(
  directory: string,
  port: number,
  tls: { cert: Buffer; key: Buffer },
  options: { refuse?: (pathname: string) => boolean } = {}
): Promise<Server> {
  const root = resolve(directory);
  const server = createServer(tls, (request, response) => {
    try {
      const { pathname } = new URL(request.url ?? "/", "https://localhost");
      if (options.refuse?.(pathname)) {
        response.writeHead(503, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (pathname === "/health") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json",
          ...workerMark(),
        });
        response.end('{"status":"ok"}');
        return;
      }
      if (WORKER_PATHS.some((prefix) => pathname.startsWith(prefix))) {
        response.writeHead(404, {
          "cache-control": "no-store",
          "content-type": "application/json",
          ...workerMark(),
        });
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
