/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import type { Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The real Cloudflare Turnstile script on the five pages that load it (ADR 0100, AC-7), under the policy
 * `public/_headers` gives each one, listening to `securitypolicyviolation`: zero violations. The page asks
 * for the script, renders the widget with the Cloudflare test key that always passes (`1x00000000000000000000AA`,
 * a public test key, not a secret), runs it on submit and sends the token it got. Only the server of the app
 * is played by interception.
 *
 * It needs the network to reach `challenges.cloudflare.com`. Without it the test is skipped with that reason;
 * `TURNSTILE_REAL=1` makes the missing network a failure instead (the manual job: `TURNSTILE_REAL=1 bunx
 * playwright test --config playwright.offline-poc.config.ts e2e/turnstile-real.e2e.ts` in apps/web, see
 * docs/runbooks/auth-abuse-protection.md).
 */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SITE_KEY = "1x00000000000000000000AA";
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const REQUIRED = process.env.TURNSTILE_REAL === "1";
const PASSWORD = "uma frase longa de teste";
const HEADERS = readFileSync(
  new URL("../public/_headers", import.meta.url),
  "utf8"
);
const APP_ORIGIN = "http://127.0.0.1:4173";
const SHELL_POLICY = /\n\/\*\n {2}Content-Security-Policy: (.*)\n/;
const STAND_IN_TOKEN = /^tt-/;
const CSP_MESSAGE = /Content Security Policy|Refused to/i;

/** The policy `public/_headers` gives a path: its own block, or the one of `/*`. */
function policyFor(path: string): string {
  const block = new RegExp(
    `\\n${path}\\n  ! Content-Security-Policy\\n  Content-Security-Policy: (.*)\\n`
  ).exec(HEADERS);
  return block?.[1] ?? SHELL_POLICY.exec(HEADERS)?.[1] ?? "";
}

interface Seen {
  headers: (string | null)[];
  paths: string[];
}

/** The server of the app by interception; every POST is recorded with the token it carried. */
async function serve(page: Page, seen: Seen) {
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: true,
        google: true,
        turnstileSiteKey: SITE_KEY,
      }),
      contentType: "application/json",
    })
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ body: "null", contentType: "application/json" })
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    seen.paths.push(new URL(request.url()).pathname);
    seen.headers.push(await request.headerValue("x-turnstile-token"));
    await route.fulfill({
      body: JSON.stringify({ status: true }),
      contentType: "application/json",
    });
  });
  // the documents get the policy of `_headers`, as Workers Static Assets gives it in production
  await page.route("**/*", async (route) => {
    const request: Request = route.request();
    // the app's documents only: the iframe of the challenge keeps the policy Cloudflare sends with it
    if (
      request.resourceType() !== "document" ||
      !request.url().startsWith(APP_ORIGIN)
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      headers: {
        ...response.headers(),
        "content-security-policy": policyFor(new URL(request.url()).pathname),
      },
      response,
    });
  });
}

const email = (page: Page) => page.getByLabel("E-mail", { exact: true });

const ROUTES = [
  {
    path: "/entrar",
    posts: "/api/auth/sign-in/email",
    submit: async (page: Page) => {
      await email(page).fill("quem@exemplo.com");
      await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    },
  },
  {
    path: "/criar-conta",
    posts: "/api/auth/sign-up/email",
    submit: async (page: Page) => {
      await email(page).fill("nova@exemplo.com");
      await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
      await page.getByRole("checkbox").check();
      await page
        .getByRole("button", { exact: true, name: "Criar conta" })
        .click();
    },
  },
  {
    path: "/esqueci-a-senha",
    posts: "/api/auth/request-password-reset",
    submit: async (page: Page) => {
      await email(page).fill("quem@exemplo.com");
      await page.getByRole("button", { name: "Enviar o link" }).click();
    },
  },
  {
    path: "/redefinir-senha#token=tok-de-teste.123",
    posts: "/api/auth/reset-password",
    submit: async (page: Page) => {
      await page
        .locator("input")
        .and(page.getByLabel("Nova senha"))
        .fill(PASSWORD);
      await page.getByRole("button", { name: "Trocar a senha" }).click();
    },
  },
  {
    path: "/confirmar-email",
    posts: "/api/auth/send-verification-email",
    submit: async (page: Page) => {
      await email(page).fill("quem@exemplo.com");
      await page.getByRole("button", { name: "Reenviar e-mail" }).click();
    },
  },
];

test.describe("com o script real da Cloudflare", () => {
  test.beforeAll(async () => {
    const reachable = await fetch(SCRIPT_URL, {
      signal: AbortSignal.timeout(15_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    if (!reachable) {
      expect(
        REQUIRED,
        "challenges.cloudflare.com is not reachable and TURNSTILE_REAL=1 asks for the proof"
      ).toBe(false);
    }
    test.skip(
      !reachable,
      "challenges.cloudflare.com is not reachable from here: run it where the network reaches Cloudflare (TURNSTILE_REAL=1)"
    );
  });

  for (const route of ROUTES) {
    const pathname = route.path.split("#")[0] ?? route.path;
    test(`${pathname}: o script real do Turnstile roda sob a CSP do _headers, sem violação`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const seen: Seen = { headers: [], paths: [] };
      const events: string[] = [];
      const messages: string[] = [];
      await page.addInitScript(() => {
        (window as unknown as { __violations: string[] }).__violations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          (window as unknown as { __violations: string[] }).__violations.push(
            `${event.violatedDirective} ${event.blockedURI}`
          );
        });
      });
      page.on("console", (message) => {
        if (CSP_MESSAGE.test(message.text())) {
          messages.push(message.text().slice(0, 300));
        }
      });
      const framed: string[] = [];
      page.on("framenavigated", (frame) => framed.push(frame.url()));
      await serve(page, seen);
      await page.goto(route.path);

      // the script came from Cloudflare, not from a stand-in, and the form is ready for the challenge
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              typeof (
                window as unknown as { turnstile?: { execute?: unknown } }
              ).turnstile?.execute
          )
        )
        .toBe("function");
      await expect(page.getByRole("alert")).toHaveCount(0);

      await route.submit(page);
      await expect
        .poll(() => seen.paths, { timeout: 45_000 })
        .toContain(route.posts);

      // the token is the one the test key gives (never empty, never the stand-in's)
      const token = seen.headers[seen.paths.indexOf(route.posts)];
      expect(token).toBeTruthy();
      expect(token).not.toMatch(STAND_IN_TOKEN);
      // the widget is an iframe of the challenge origin, allowed by `frame-src` (it leaves the page once it answers)
      expect(framed.some((url) => url.startsWith(`${TURNSTILE_ORIGIN}/`))).toBe(
        true
      );

      events.push(
        ...(await page.evaluate(
          () => (window as unknown as { __violations: string[] }).__violations
        ))
      );
      expect(events).toEqual([]);
      expect(messages).toEqual([]);
    });
  }
});

test("a página sem desafio (/desbloquear) recusa o script da Cloudflare: a política dela é a do shell", async ({
  page,
}) => {
  const seen: Seen = { headers: [], paths: [] };
  const events: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations.push(
        `${event.violatedDirective} ${event.blockedURI}`
      );
    });
  });
  await serve(page, seen);
  await page.goto("/desbloquear#token=user.tok");
  await expect(
    page.getByText("Pronto: a entrada com senha está liberada.", {
      exact: false,
    })
  ).toBeVisible();
  const refused = await page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const script = document.createElement("script");
        script.src = url;
        script.addEventListener("load", () => resolve(false));
        script.addEventListener("error", () => resolve(true));
        document.head.append(script);
      }),
    SCRIPT_URL
  );
  expect(refused).toBe(true);
  events.push(
    ...(await page.evaluate(
      () => (window as unknown as { __violations: string[] }).__violations
    ))
  );
  expect(events.join(" ")).toContain("script-src-elem");
});
