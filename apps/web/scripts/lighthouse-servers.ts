// The servers of the Lighthouse run (`bun run test:lighthouse`), none of them the real Worker: Lighthouse needs
// the production client over HTTP, a session and reads that never change, and the Worker would need a database.
//   web-out:  the production client (`dist/client`) with no session: /entrar
//   web-in:   the same client; `POST /__lighthouse/login` (the puppeteer script) opens a fake session, the reads of
//             the Início are answered with the fixtures of the e2e-pwa (`ui-home-states.ts`), and the clock stands at
//             the date of those fixtures
//   catalog:  the public catalog built over fixture stores (apps/catalog, "fixture-data"), with the photos answered here
// Under Bun, because the fixtures are TypeScript of the e2e-pwa. Prints one line, `ready {...ports}`, when all listen.
import { readdirSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import { extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  answer,
  HOME_READS,
  NOW,
  ORGANIZATION,
} from "../e2e-pwa/ui-home-states";
import { WORKER_MARK } from "../e2e-pwa/worker-mark";
import { headersForPath, parseHeadersFile } from "./static-headers.mjs";

const [webOutPort, webInPort, catalogPort, upstreamPort] = process.argv
  .slice(2)
  .map(Number);
const CLIENT = resolve(import.meta.dirname, "../dist/client");

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".webmanifest",
]);
const GZIP = /\bgzip\b/;
const RPC_PREFIX = /^\/rpc\//;

/**
 * The page's own clock, before anything of the app runs: the figures of the Início are of the month of `NOW`, and
 * a run on another day would draw another page. Prepended to `theme-init.js`, which every page already loads first.
 */
const CLOCK = `(() => {
  const fixed = ${Date.parse(NOW)};
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixed] : args));
    }
    static now() {
      return fixed;
    }
  };
})();
`;

interface Asset {
  body: Buffer;
  compressed: Buffer | null;
  type: string;
}

/**
 * What Workers Static Assets leaves out of what it serves: the patterns of `.assetsignore` (here `*.map`,
 * `wrangler.json`, `.dev.vars`), and its own configuration files.
 */
function ignoredBy(patterns: string[]) {
  return (path: string) =>
    path === "/.assetsignore" ||
    path === "/_headers" ||
    patterns.some((pattern) =>
      pattern.startsWith("*")
        ? path.endsWith(pattern.slice(1))
        : path === `/${pattern}`
    );
}

/** Every file of the build, read once and gzipped once (the same level every run, as the precache budget measures). */
function readClient(withClock: boolean) {
  const assets = new Map<string, Asset>();
  const ignored = ignoredBy(
    readFileSync(join(CLIENT, ".assetsignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${prefix}/${entry.name}`);
        continue;
      }
      const path = `${prefix}/${entry.name}`;
      if (ignored(path)) {
        continue;
      }
      const extension = extname(entry.name);
      let body = readFileSync(join(directory, entry.name));
      if (withClock && path === "/theme-init.js") {
        body = Buffer.concat([Buffer.from(CLOCK), body]);
      }
      assets.set(path, {
        body,
        compressed: COMPRESSIBLE.has(extension)
          ? gzipSync(body, { level: 9 })
          : null,
        type: TYPES[extension] ?? "application/octet-stream",
      });
    }
  };
  walk(CLIENT, "");
  return assets;
}

const rules = parseHeadersFile(readFileSync(join(CLIENT, "_headers"), "utf8"));

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body: Buffer | string
) {
  response.writeHead(status, headers);
  response.end(body);
}

/** What the Worker would answer, with its mark (without it the client treats the answer as none). */
interface Reply {
  body: string;
  status: number;
}

const ok = (value: unknown): Reply => ({
  body: JSON.stringify(value),
  status: 200,
});

const BODY_LIMIT = 65_536;

function readBody(incoming: IncomingMessage) {
  return new Promise<string>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) {
        chunks.push(chunk);
      }
    });
    incoming.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

const NOT_FOUND: Reply = { body: "{}", status: 404 };

/** The reads of the Início, from the fixtures of the e2e-pwa; any other call of the Worker is a 404. */
function rpcReply(asked: string, input: string): Reply {
  if (asked === "organization/listMine") {
    return ok({ json: { organizations: [ORGANIZATION] }, meta: [] });
  }
  if (!HOME_READS.includes(asked)) {
    return NOT_FOUND;
  }
  let sent: { json?: Record<string, unknown> } | null;
  try {
    sent = JSON.parse(input || "{}");
  } catch {
    return { body: "{}", status: 400 };
  }
  const served = answer(asked, sent?.json ?? {}, {
    failing: false,
    fresh: false,
  });
  return { body: served.body, status: 200 };
}

async function workerReply(
  incoming: IncomingMessage,
  pathname: string,
  signedIn: boolean
): Promise<Reply | null> {
  if (pathname === "/health") {
    return ok({ status: "ok" });
  }
  if (pathname === "/api/auth/get-session") {
    return ok(signedIn ? { session: { id: "s" }, user: { id: "u" } } : null);
  }
  // the methods of the production Worker today: the password is off, so no form and no challenge on /entrar
  if (pathname === "/api/auth-methods") {
    return ok({ emailPassword: false, google: true, turnstileSiteKey: null });
  }
  if (pathname.startsWith("/rpc/")) {
    const input = await readBody(incoming);
    return signedIn
      ? rpcReply(pathname.replace(RPC_PREFIX, ""), input)
      : NOT_FOUND;
  }
  // the Worker's own paths never answer with the page
  return pathname.startsWith("/api/") ? NOT_FOUND : null;
}

function sendAsset(
  incoming: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  assets: Map<string, Asset>
) {
  const asset =
    assets.get(pathname) ??
    (extname(pathname) ? undefined : assets.get("/index.html"));
  if (!asset) {
    return send(response, 404, {}, "");
  }
  const gzipped =
    asset.compressed !== null &&
    GZIP.test(incoming.headers["accept-encoding"] ?? "");
  const body = gzipped && asset.compressed ? asset.compressed : asset.body;
  return send(
    response,
    200,
    {
      ...headersForPath(rules, pathname),
      "content-length": body.length,
      "content-type": asset.type,
      ...(gzipped ? { "content-encoding": "gzip" } : {}),
      vary: "accept-encoding",
    },
    body
  );
}

/** `withLogin`: the Início's server, which stays signed out until the puppeteer script signs in. */
function webServer(withLogin: boolean) {
  const assets = readClient(withLogin);
  let signedIn = false;
  return createServer(async (incoming, response) => {
    const { pathname } = new URL(incoming.url ?? "/", "http://localhost");
    if (withLogin && pathname === "/__lighthouse/login") {
      signedIn = true;
      return send(response, 204, {}, "");
    }
    const reply = await workerReply(incoming, pathname, signedIn);
    if (reply) {
      return send(
        response,
        reply.status,
        { "content-type": "application/json", ...WORKER_MARK },
        reply.body
      );
    }
    return sendAsset(incoming, response, pathname, assets);
  });
}

/**
 * A 1 x 1 gray PNG for every photo: the fixture build has no bucket. Too sparse for Chrome to count it as the largest
 * contentful paint (under 0.05 bits per pixel), so the LCP of the store is its text. A photo of real size makes the
 * LCP the lazy-loaded image, and the median of the simulated LCP then jumps between two values from one run to the next.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8c+fOfwAIBAPD5uLZNgAAAABJRU5ErkJggg==",
  "base64"
);
const PHOTO_ROUTE = /^\/(?:[^/]+\/)?m\/[^/]+\/[^/?]+/;

/**
 * The stylesheet of the catalog answers this long after it is asked for. The first paint waits for it, while the scripts
 * are asked for at the top of the page; over a real network the first paint comes a round trip or more after the
 * scripts finish downloading. Here the stylesheet arrives within milliseconds, so the first paint came before or after
 * the scripts finished downloading from one round to the next, and the Lantern graph of the FCP and the LCP held them
 * or not (it keeps what ended before the paint: FirstContentfulPaint.js of the Lantern in Lighthouse): the simulated LCP
 * of the page jumped by about a second while the LCP the browser saw was the same.
 */
const STYLESHEET_DELAY_MS = 600;
const STYLESHEET = /\.css$/;

/** In front of the catalog Worker of the fixture build: its photos answered here, the rest passed on, gzipped like the edge does. */
function catalogServer() {
  return createServer((incoming, response) => {
    const path = incoming.url ?? "/";
    const delay = STYLESHEET.test(new URL(path, "http://localhost").pathname)
      ? STYLESHEET_DELAY_MS
      : 0;
    if (PHOTO_ROUTE.test(path)) {
      return send(
        response,
        200,
        { "content-length": PNG.length, "content-type": "image/png" },
        PNG
      );
    }
    const upstream = request(
      {
        headers: { ...incoming.headers, "accept-encoding": "identity" },
        host: "127.0.0.1",
        method: incoming.method,
        path,
        port: upstreamPort,
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("end", () => {
          const body = Buffer.concat(chunks);
          const type = String(reply.headers["content-type"] ?? "");
          const gzipped =
            GZIP.test(incoming.headers["accept-encoding"] ?? "") &&
            (type.startsWith("text/") || type.includes("javascript"));
          const out = gzipped ? gzipSync(body, { level: 9 }) : body;
          // the body is whole here, so the upstream's chunked framing no longer applies
          const { "transfer-encoding": _chunked, ...passed } = reply.headers;
          setTimeout(
            () =>
              send(
                response,
                reply.statusCode ?? 502,
                {
                  ...(passed as Record<string, string>),
                  "content-length": out.length,
                  ...(gzipped ? { "content-encoding": "gzip" } : {}),
                },
                out
              ),
            delay
          );
        });
      }
    );
    upstream.on("error", () => send(response, 502, {}, ""));
    incoming.pipe(upstream);
  });
}

await Promise.all([
  new Promise<void>((done) =>
    webServer(false).listen(webOutPort, "127.0.0.1", done)
  ),
  new Promise<void>((done) =>
    webServer(true).listen(webInPort, "127.0.0.1", done)
  ),
  new Promise<void>((done) =>
    catalogServer().listen(catalogPort, "127.0.0.1", done)
  ),
]);
process.stdout.write(
  `ready ${JSON.stringify({ catalogPort, webInPort, webOutPort })}\n`
);
