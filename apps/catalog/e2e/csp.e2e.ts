/// <reference lib="dom" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PRODUCT_WITH_PHOTOS } from "./fixtures/public-catalog-reader";
import { servePhotos } from "./photos";

/**
 * The public catalog under its production Content-Security-Policy (ADR 0090), end to end: the policy
 * the response carries is the one the browser enforces on the page the Worker really rendered.
 */
const BARE_ORIGIN = "http://127.0.0.1:5175";
// the pages of a store with products come from the fixture build (vite.config.ts, "fixture-data")
const FIXTURE_ORIGIN = "http://127.0.0.1:5176";
const STORE = `${FIXTURE_ORIGIN}/loja-horizonte`;
const PRODUCT = `${STORE}/p/${PRODUCT_WITH_PHOTOS}`;
const PAGES = [
  "/",
  "/A_B",
  STORE,
  PRODUCT,
  `${FIXTURE_ORIGIN}/vazia`,
  `${FIXTURE_ORIGIN}/nao-existe`,
] as const;
const NONCE_IN_POLICY = /script-src 'self' 'nonce-([^']+)'/;
const TAG = /<script\b([^>]*)>/gi;
const NONCE_ATTRIBUTE = /\bnonce="([^"]*)"/i;
const SRC_ATTRIBUTE = /\bsrc=/i;
const LINK = /<link\b[^>]*>/gi;
const STYLESHEET = /\brel="stylesheet"/i;
const HREF = /\bhref="([^"]+)"/i;
const STYLESHEET_PATH = /^\/assets\/styles-[\w-]+\.css$/;
const FONT_URL = /url\((\/assets\/geist-latin-wght-[\w-]+\.woff2)\)/;

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

/** Records every securitypolicyviolation before any script of the page runs. */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push(
        `${event.violatedDirective} ${event.blockedURI}`
      );
    });
  });
}

for (const path of PAGES) {
  test.describe(`a página ${path}`, () => {
    test("toda tag script inline do SSR tem o nonce do cabeçalho CSP", async ({
      request,
    }) => {
      const response = await request.get(path);
      const policy = response.headers()["content-security-policy"] ?? "";
      const nonce = NONCE_IN_POLICY.exec(policy)?.[1];
      expect(nonce, "o nonce está na política").toBeTruthy();
      expect(policy).not.toContain("unsafe-inline");
      expect(policy).not.toContain("unsafe-eval");
      expect(response.headers()["cache-control"]).toContain("no-cache");

      const html = await response.text();
      const scripts = [...html.matchAll(TAG)].map((match) => match[1] ?? "");
      const inline = scripts.filter(
        (attributes) => !SRC_ATTRIBUTE.test(attributes)
      );
      expect(inline.length, "o SSR escreve scripts inline").toBeGreaterThan(0);
      for (const attributes of scripts) {
        expect(NONCE_ATTRIBUTE.exec(attributes)?.[1]).toBe(nonce);
      }
    });

    test("cada resposta tem um nonce novo", async ({ request }) => {
      const responses = await Promise.all(
        [1, 2, 3].map(() => request.get(path))
      );
      const nonces = new Set(
        responses.map(
          (response) =>
            NONCE_IN_POLICY.exec(
              response.headers()["content-security-policy"] ?? ""
            )?.[1]
        )
      );
      expect(nonces.size).toBe(3);
      expect(nonces.has(undefined)).toBe(false);
    });

    test("não há style= nem <style> inline (style-src 'self')", async ({
      browser,
      page,
    }) => {
      // The HTML as the Worker served it, parsed by the browser with scripts off: the state serialized
      // in the inline scripts is text there, so only real markup can match.
      const served = await browser.newContext({ javaScriptEnabled: false });
      try {
        const bare = await served.newPage();
        const response = await bare.goto(path);
        const policy = response?.headers()["content-security-policy"] ?? "";
        expect(policy).toContain("style-src 'self';");
        await expect(bare.locator("main.page")).toBeVisible();
        expect(await bare.locator("[style], style").count()).toBe(0);
        // streamed Suspense blocks sit inside <template>, which locators do not enter
        expect(
          await bare.evaluate(
            () =>
              [...document.querySelectorAll("template")].filter((template) =>
                template.content.querySelector("[style], style")
              ).length
          )
        ).toBe(0);
      } finally {
        await served.close();
      }

      // and the DOM after hydration
      await servePhotos(page);
      await page.goto(path);
      await expect(page.locator("main.page")).toBeVisible();
      expect(await page.locator("[style], style").count()).toBe(0);
    });

    test("a hidratação roda sem violação de CSP (inclusive font-src e style-src)", async ({
      page,
    }) => {
      await watchViolations(page);
      await servePhotos(page);
      const errors: string[] = [];
      page.on("console", (message) => {
        // the browser logs the status of the document itself (the 404 page); that is not a script error
        const isDocument = message.location().url.endsWith(path);
        if (message.type() === "error" && !isDocument) {
          errors.push(message.text().slice(0, 200));
        }
      });
      page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
      const response = await page.goto(path);
      expect(response?.headers()["content-security-policy"]).toBeTruthy();

      // Start removes its stream state once the client has hydrated the router.
      await page.waitForFunction(() => !("$_TSR" in self));
      await expect(page.locator("main.page h1")).toBeVisible();
      // the font is requested by the page's own text; font-src and style-src are among the directives watched
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

test("o CSS construído e a fonte: um arquivo estático, a fonte em /assets, nada em data:", async ({
  page,
  request,
}) => {
  const response = await request.get(STORE);
  const html = await response.text();
  const policy = response.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("font-src 'self'");
  expect(policy).toContain("style-src 'self';");
  const sheets = (html.match(LINK) ?? [])
    .filter((tag) => STYLESHEET.test(tag))
    .map((tag) => HREF.exec(tag)?.[1] ?? "");
  expect(sheets, "uma folha de estilo, do próprio Worker").toHaveLength(1);
  expect(sheets[0]).toMatch(STYLESHEET_PATH);

  // the CSS the build wrote, as the browser receives it
  const css = await (await request.get(sheets[0] ?? "")).text();
  expect(css).not.toContain("data:");
  expect(css).not.toContain("@import");
  const fontUrl = FONT_URL.exec(css)?.[1];
  expect(fontUrl, "a fonte aponta para /assets").toBeTruthy();
  const font = await request.get(fontUrl ?? "");
  expect(font.status()).toBe(200);
  expect(font.headers()["content-type"]).toContain("font/woff2");

  // and the build on disk: no inlined data: anywhere in the stylesheets
  for (const directory of [
    "dist/client/assets",
    "dist-fixture/client/assets",
  ]) {
    const folder = resolve(import.meta.dirname, "..", directory);
    for (const name of readdirSync(folder).filter((file) =>
      file.endsWith(".css")
    )) {
      expect(readFileSync(resolve(folder, name), "utf8"), name).not.toContain(
        "data:"
      );
    }
  }

  await servePhotos(page);
  await page.goto(STORE);
  await page.waitForFunction(() => !("$_TSR" in self));
  await page.evaluate(() => document.fonts.load("1em Geist"));
  expect(await page.evaluate(() => document.fonts.check("1em Geist"))).toBe(
    true
  );
  expect(
    await page.evaluate(
      () =>
        [...document.fonts].filter(
          (face) =>
            face.family.replaceAll('"', "") === "Geist" &&
            face.status === "loaded"
        ).length
    )
  ).toBeGreaterThan(0);
});

test("o detector enxerga uma violação (controle da prova)", async ({
  page,
}) => {
  await watchViolations(page);
  await page.goto("/");
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__injected = true";
    document.body.appendChild(script);
  });
  await expect
    .poll(() => page.evaluate(() => window.__cspViolations.length))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => "__injected" in window)).toBe(false);
});

test("catalog_nonce_missing: sem a entrada do servidor a página não é renderizada", async ({
  request,
}) => {
  const bare = await request.get(`${BARE_ORIGIN}/`);
  expect(bare.status()).toBe(500);
  const body = await bare.text();
  expect(body).not.toContain("Catálogo Polaris");
  expect(body).not.toContain("<script");
  expect(bare.headers()["content-security-policy"]).toBeUndefined();

  // the same page, through the real entry, is served
  expect((await request.get("/")).status()).toBe(200);
});

test("o redirect de deploy do wrangler aponta para o build real, nunca dist-bare nem dist-fixture", () => {
  test.skip(
    test.info().project.name !== "chromium-desktop",
    "o estado do disco é o mesmo em todos os projetos"
  );
  const redirect = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../.wrangler/deploy/config.json"),
      "utf8"
    )
  ) as { configPath: string };
  const target = resolve(
    import.meta.dirname,
    "../.wrangler/deploy",
    redirect.configPath
  );
  expect(target).toBe(
    resolve(import.meta.dirname, "../dist/server/wrangler.json")
  );
  expect(redirect.configPath).not.toContain("dist-bare");
  expect(redirect.configPath).not.toContain("dist-fixture");
});
