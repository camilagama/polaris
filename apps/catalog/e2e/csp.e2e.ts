/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";

/**
 * The public catalog under its production Content-Security-Policy (ADR 0090), end to end: the policy
 * the response carries is the one the browser enforces on the page the Worker really rendered.
 */
const BARE_ORIGIN = "http://127.0.0.1:5175";
const PAGES = ["/", "/A_B"] as const;
const NONCE_IN_POLICY = /script-src 'self' 'nonce-([^']+)'/;
const TAG = /<script\b([^>]*)>/gi;
const NONCE_ATTRIBUTE = /\bnonce="([^"]*)"/i;
const SRC_ATTRIBUTE = /\bsrc=/i;
const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_ATTRIBUTE = /\sstyle\s*=/i;
const STYLE_ELEMENT = /<style\b/i;

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
      page,
      request,
    }) => {
      const policy =
        (await request.get(path)).headers()["content-security-policy"] ?? "";
      expect(policy).toContain("style-src 'self';");

      // the serialized state in the inline scripts is data, not markup
      const html = (await (await request.get(path)).text()).replace(
        SCRIPT_ELEMENT,
        ""
      );
      expect(html).not.toMatch(STYLE_ATTRIBUTE);
      expect(html).not.toMatch(STYLE_ELEMENT);

      await page.goto(path);
      await expect(page.locator("main.page")).toBeVisible();
      expect(await page.locator("[style], style").count()).toBe(0);
    });

    test("a hidratação roda sem violação de CSP", async ({ page }) => {
      await watchViolations(page);
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
      expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

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
