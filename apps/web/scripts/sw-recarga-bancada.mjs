// Recarga com o service worker no controle: abre PAGES abas, espera o worker controlar cada uma e recarrega
// ROUNDS vezes, cada recarga entre 0 e MAXDELAY ms depois do `load`. Conta a marca do boot-retry
// (`polaris:entry-reload`), o `error` em <script>, os scripts com `requestfailed`, os pedidos de script e os
// avisos "cross-world service worker resource mismatch", só das recargas medidas: a preparação da aba (primeiro
// carregamento e recarga até o worker controlar) não conta. Serve o build com scripts/serve-static.mjs (a CSP real).
//
// Uso, a partir de apps/web, com Node 24 no PATH e o build do e2e PWA feito
// (bunx vite build --config vite.pwa.config.ts --mode pwa-e2e):
//   CHANNEL=chromium PAGES=6 ROUNDS=100 MAXDELAY=300 timeout 590 node scripts/sw-recarga-bancada.mjs
// O aceite são três rodadas dessa linha (3×600 recargas) com marks = 0 e scriptErrors = 0.
//
// Fatores por ambiente: DIST (diretório do build), START (caminho aberto, /entrar), PORT, PAGES, ROUNDS, MAXDELAY,
// CHANNEL (vazio = headless shell; "chromium" = Chrome completo no modo headless novo), SW=0 (worker bloqueado),
// ROUTE=1 (as rotas simuladas de /api e /rpc dos e2e), CDP=1 (Network.enable numa sessão CDP), SEED (atrasos).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = (name, fallback) => process.env[name] ?? fallback;
const PORT = Number(env("PORT", "4375"));
const DIST = env("DIST", "dist/pwa-e2e");
const START = env("START", "/entrar");
const PAGES = Number(env("PAGES", "6"));
const ROUNDS = Number(env("ROUNDS", "100"));
const MAXDELAY = Number(env("MAXDELAY", "300"));
const ROUTE = env("ROUTE", "0") === "1";
const CDP = env("CDP", "0") === "1";
const SW = env("SW", "1") !== "0";
const CHANNEL = env("CHANNEL", "");
const SEED = Number(env("SEED", "1"));
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Park-Miller: the same delays for the same SEED, so two variants meet the same reload times. */
function random(seed) {
  let state = (seed % 2_147_483_646) + 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const server = spawn(
  process.execPath,
  ["scripts/serve-static.mjs", DIST, String(PORT)],
  { cwd: webRoot, stdio: "inherit" }
);
for (let tries = 0; ; tries += 1) {
  try {
    // biome-ignore lint/performance/noAwaitInLoops: polls the server until it answers
    if ((await fetch(ORIGIN)).ok) {
      break;
    }
  } catch (error) {
    if (tries > 100) {
      throw error;
    }
  }
  await sleep(100);
}

const json = (status, body) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  headers: { "x-request-id": "bancada" },
  status,
});

const totals = {
  abortedScripts: 0,
  crossWorld: 0,
  loads: 0,
  marks: 0,
  reloads: 0,
  scriptErrors: 0,
  scriptRequests: 0,
};
const examples = [];
/** The tabs past their setup: only their reloads are counted (marks, `error` of scripts, requests and warnings alike). */
const counting = new WeakSet();

async function one(owner, index) {
  const delay = random(SEED * 1000 + index);
  const context = await owner.newContext({
    serviceWorkers: SW ? "allow" : "block",
  });
  if (ROUTE) {
    await context.route("**/api/auth-methods", (route) =>
      route.fulfill(
        json(200, {
          emailPassword: true,
          google: true,
          turnstileSiteKey: null,
        })
      )
    );
    await context.route("**/api/auth/get-session", (route) =>
      route.fulfill(json(200, null))
    );
    await context.route("**/rpc/**", (route) =>
      route.fulfill(
        json(401, {
          json: {
            code: "UNAUTHORIZED",
            defined: false,
            message: "UNAUTHORIZED",
            status: 401,
          },
          meta: [],
        })
      )
    );
  }
  const page = await context.newPage();
  if (CDP) {
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
  }
  page.on("console", (message) => {
    if (!counting.has(page)) {
      return;
    }
    const text = message.text();
    if (text.startsWith("BANCADA mark")) {
      totals.marks += 1;
      examples.push(`p${index} ${text}`);
    } else if (text.startsWith("BANCADA script-error")) {
      totals.scriptErrors += 1;
      examples.push(`p${index} ${text}`);
    } else if (text.includes("cross-world service worker resource mismatch")) {
      totals.crossWorld += 1;
    }
  });
  page.on("load", () => {
    if (counting.has(page)) {
      totals.loads += 1;
    }
  });
  page.on("request", (request) => {
    if (counting.has(page) && request.resourceType() === "script") {
      totals.scriptRequests += 1;
    }
  });
  page.on("requestfailed", (request) => {
    if (counting.has(page) && request.resourceType() === "script") {
      totals.abortedScripts += 1;
    }
  });
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (
        name === "polaris:entry-reload" ||
        name === "polaris:chunk-reload-at"
      ) {
        console.debug(`BANCADA mark ${name} ${document.readyState}`);
      }
      return set.call(this, name, value);
    };
    window.addEventListener(
      "error",
      ({ target }) => {
        if (target instanceof HTMLScriptElement) {
          console.debug(
            `BANCADA script-error ${target.src} ${document.readyState}`
          );
        }
      },
      true
    );
  });
  await page.goto(`${ORIGIN}${START}`);
  if (SW) {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null
    );
  }
  await page.waitForLoadState("load");
  counting.add(page);
  for (let round = 0; round < ROUNDS; round += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one reload after the other in the same tab is the case measured
    await page.waitForLoadState("load");
    await sleep(Math.floor(delay() * MAXDELAY));
    totals.reloads += 1;
    try {
      await page.reload({ waitUntil: "commit" });
    } catch {
      // a reload that met the boot-retry's own reload; the next round waits for load again
    }
  }
  await page.waitForLoadState("load");
  counting.delete(page);
  await context.close();
}

const launched = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
const started = Date.now();
try {
  await Promise.all(
    Array.from({ length: PAGES }, (_, index) => one(launched, index))
  );
} finally {
  await launched.close();
  server.kill();
}
console.log(
  JSON.stringify({
    CDP,
    CHANNEL: CHANNEL || "headless-shell",
    DIST,
    MAXDELAY,
    PAGES,
    ROUNDS,
    ROUTE,
    SEED,
    SW,
    seconds: Math.round((Date.now() - started) / 1000),
    ...totals,
    scriptRequestsPerLoad: Number(
      (totals.scriptRequests / Math.max(totals.loads, 1)).toFixed(2)
    ),
  })
);
for (const line of examples.slice(0, 12)) {
  console.log(line);
}
