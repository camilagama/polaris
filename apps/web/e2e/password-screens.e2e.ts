/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import type { Page, Request, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The password screens behind the flag (P9, ADR 0100; AC-7, 46, 50, 51, 53, 62, 71 to 76), with the server
 * played by interception and a stand-in for the Turnstile script (the same `render`/`execute` contract).
 * `T163_SHOTS=<dir>` writes a capture of each state at 360 and 1280 px, light and dark.
 */
const SHOTS = process.env.T163_SHOTS;
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js**";
const SITE_KEY = "1x00000000000000000000AA";
const PASSWORD = "uma frase longa de teste";
const TECHNICAL =
  /\b(40[0-9]|429|50[0-9])\b|auth_|password_|_required|rate_limited|INVALID|turnstile/i;
const TOKEN_IN_URL = /token/;
const RESET_EXACT = /\/redefinir-senha\?x=1$/;
const AUTH_ENTRY_PATHS = [
  "/entrar",
  "/criar-conta",
  "/esqueci-a-senha",
  "/redefinir-senha",
  "/confirmar-email",
];
const APP_ORIGIN = "http://127.0.0.1:4173";
const SHELL_POLICY = /\n\/\*\n {2}Content-Security-Policy: (.*)\n/;
const AT_SIGN_IN = /\/entrar$/;
const LOGIN_TOKEN = /^tt-login-\d+$/;
const VERIFICATION_TOKEN = /^tt-verification_email-/;
const AT_DEVICES = /\/devices$/;
const TERMS = /Termos de Uso/;
const NOOPENER = /noopener/;
const SIGNUP_TOKEN = /^tt-signup-/;
const RESET_REQUEST_TOKEN = /^tt-password_reset_request-/;
const RESET_TOKEN = /^tt-password_reset-/;
const CSP_VIOLATION = /Content Security Policy/i;
const HEADERS = readFileSync(
  new URL("../public/_headers", import.meta.url),
  "utf8"
);

/** The policy `public/_headers` gives a path: its own block, or the one of `/*`. */
function policyFor(path: string): string {
  const block = new RegExp(
    `\\n${path}\\n  ! Content-Security-Policy\\n  Content-Security-Policy: (.*)\\n`
  ).exec(HEADERS);
  return block?.[1] ?? SHELL_POLICY.exec(HEADERS)?.[1] ?? "";
}

interface Answer {
  body: unknown;
  status: number;
}

interface Server {
  answers: Record<string, Answer>;
  calls: { body: unknown; path: string; turnstile: string | null }[];
  emailPassword: boolean;
  /** `ok` gives a token per execute; `fail` calls the error callback; `blocked` aborts the script. */
  turnstile: "blocked" | "fail" | "ok";
  /** The address of the page when the Turnstile script was asked for (the token must be gone). */
  urlAtTurnstile: string[];
}

const ok: Answer = { body: { status: true }, status: 200 };

function newServer(overrides: Partial<Server> = {}): Server {
  return {
    answers: {},
    calls: [],
    emailPassword: true,
    turnstile: "ok",
    urlAtTurnstile: [],
    ...overrides,
  };
}

const TURNSTILE_STAND_IN = `
(() => {
  let widgets = 0;
  let tokens = 0;
  const options = {};
  window.turnstile = {
    render(container, given) {
      widgets += 1;
      const id = "w" + widgets;
      options[id] = given;
      container.dataset.action = given.action;
      return id;
    },
    execute(id) {
      const given = options[id];
      setTimeout(() => {
        if (window.__turnstileFails) {
          given["error-callback"]();
        } else {
          tokens += 1;
          given.callback("tt-" + given.action + "-" + tokens);
        }
      }, 20);
    },
    reset() {},
    remove() {},
  };
})();
`;

async function serve(page: Page, server: Server) {
  await page.route(TURNSTILE_SCRIPT, async (route) => {
    server.urlAtTurnstile.push(page.url());
    if (server.turnstile === "blocked") {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({
      body: `${server.turnstile === "fail" ? "window.__turnstileFails = true;" : ""}${TURNSTILE_STAND_IN}`,
      contentType: "text/javascript",
    });
  });
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: server.emailPassword,
        google: true,
        turnstileSiteKey: server.emailPassword ? SITE_KEY : null,
      }),
      contentType: "application/json",
    })
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ body: "null", contentType: "application/json" })
  );
  const answerPost = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    server.calls.push({
      body: request.postDataJSON(),
      path,
      turnstile: (await request.headerValue("x-turnstile-token")) ?? null,
    });
    const answer = server.answers[path] ?? ok;
    await route.fulfill({
      body: JSON.stringify(answer.body),
      contentType: "application/json",
      status: answer.status,
    });
  };
  for (const path of [
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/send-verification-email",
    "/api/auth/change-password",
    "/api/email-verification",
    "/api/login-unlock",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one route each, registered before the page opens
    await page.route(`**${path}`, answerPost);
  }
}

/** The transitions of the page (the buttons change color in 120 ms) are over: a capture is never taken in the middle. */
const transitionsEnded = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        // a cancelled animation rejects: it is over as well
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );

/**
 * Each state at 360 and 1280 px, light and dark (V7), taken after the transitions; only when asked, and only
 * once (desktop project). `narrow` adds 320 px, where a button wider than its card shows first.
 */
async function shot(page: Page, name: string, narrow = false) {
  if (!SHOTS || test.info().project.name !== "chromium-desktop") {
    return;
  }
  const size = page.viewportSize();
  const sizes: [number, number][] = [
    [360, 740],
    [1280, 800],
  ];
  if (narrow) {
    sizes.push([320, 640]);
  }
  for (const [width, height] of sizes) {
    // biome-ignore lint/performance/noAwaitInLoops: one size after the other on the same page
    await page.setViewportSize({ height, width });
    for (const scheme of ["light", "dark"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one scheme after the other on the same page
      await page.emulateMedia({ colorScheme: scheme });
      // the theme is the `dark` class on <html>, set at load: changing the media after it does not flip it
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        scheme === "dark"
      );
      await transitionsEnded(page);
      await page.screenshot({
        fullPage: true,
        path: `${SHOTS}/${name}-${width}-${scheme}.png`,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  if (size) {
    await page.setViewportSize(size);
  }
}

/**
 * Nothing inside the card passes its content box, at 360 and at 320 px (P1: an `<a>` with `width: 100%`
 * and padding was 34 px wider than its card). Measured on the boxes, not on a capture.
 */
async function expectFitsCard(page: Page) {
  const size = page.viewportSize();
  for (const width of [360, 320]) {
    // biome-ignore lint/performance/noAwaitInLoops: one width after the other on the same page
    await page.setViewportSize({ height: 740, width });
    const overflow = await page.evaluate(() => {
      const card = document.querySelector("[data-slot=card-content]");
      if (!card) {
        return ["no card"];
      }
      const style = getComputedStyle(card);
      const right =
        card.getBoundingClientRect().right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight);
      return [...card.querySelectorAll("a, button, input, p")]
        .filter(
          (element) => element.getBoundingClientRect().right > right + 0.5
        )
        .map(
          (element) =>
            `${element.tagName}.${element.className} ${element.getBoundingClientRect().right} > ${right}`
        );
    });
    expect(overflow, `at ${width} px`).toEqual([]);
  }
  if (size) {
    await page.setViewportSize(size);
  }
}

async function expectNoTechnicalText(page: Page) {
  await expect(page.locator("main")).not.toContainText(TECHNICAL);
}

/** The field, not the card: the card of `/redefinir-senha` is labelled "Nova senha" by its title. */
const newPasswordField = (page: Page) =>
  page.locator("input").and(page.getByLabel("Nova senha"));

const BLOCKED_DESCRIPTION = /Recarregue a página/;
const callsTo = (server: Server, path: string) =>
  server.calls.filter((call) => call.path === path);

test.describe("com a senha desligada (AC-46)", () => {
  test("a entrada mostra só o Google e as páginas de senha levam a /entrar", async ({
    page,
  }) => {
    const server = newServer({ emailPassword: false });
    await serve(page, server);
    await page.goto("/entrar");
    await expect(
      page.getByRole("button", { name: "Continuar com o Google" })
    ).toBeVisible();
    await expect(page.getByLabel("Senha", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Criar conta" })).toHaveCount(
      0
    );
    for (const path of [
      "/criar-conta",
      "/esqueci-a-senha",
      "/redefinir-senha#token=abc",
      "/confirmar-email#token=abc",
      "/desbloquear#token=abc",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one page after the other in the same tab
      await page.goto(path);
      await expect(page).toHaveURL(AT_SIGN_IN);
    }
    expect(server.calls).toEqual([]);
    expect(server.urlAtTurnstile).toEqual([]);
  });
});

test.describe("entrar com e-mail e senha", () => {
  test("credencial incorreta: a mesma frase, a senha limpa, o e-mail fica, e cada envio leva um token novo (AC-50, AC-51, AC-71)", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/sign-in/email": {
          body: { code: "INVALID_EMAIL_OR_PASSWORD" },
          status: 401,
        },
      },
    });
    await serve(page, server);
    await page.goto("/entrar");
    await expect(page.getByRole("link", { name: "Criar conta" })).toBeVisible();
    const email = page.getByLabel("E-mail", { exact: true });
    const password = page.getByLabel("Senha", { exact: true });
    // v5.2: only the e-mail at first; the password, "Esqueci a senha" and "Entrar" are in the DOM for a password
    // manager, but hidden until the address has a complete shape
    await expect(email).toBeVisible();
    await expect(password).toHaveCount(1);
    await expect(password).toBeHidden();
    await expect(
      page.getByRole("button", { exact: true, name: "Entrar" })
    ).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Esqueci a senha" })
    ).toHaveCount(0);
    await expect(email).toHaveAttribute("autocomplete", "username");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await shot(page, "entrar-pronta");
    // closed, the password is out of the Tab order: from the e-mail, Tab goes to "Criar conta"
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Criar conta" })).toBeFocused();

    // Enter with an incomplete address: the local error, the password still closed
    await email.fill("quem@exemplo");
    await email.press("Enter");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.getByText("Digite um e-mail completo, como nome@exemplo.com.")
    ).toBeVisible();
    await expect(password).toBeHidden();
    expect(server.calls).toEqual([]);
    await shot(page, "entrar-email-incompleto");

    // the complete address opens the password without taking the focus from the e-mail, and asks no server
    await email.fill("quem@exemplo.com");
    await expect(password).toBeVisible();
    await expect(email).toBeFocused();
    // Enter in the complete address takes the focus to the password; Tab from the e-mail reaches it too
    await email.press("Enter");
    await expect(password).toBeFocused();
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    // an address that stops being complete leaves the password open; only an empty field closes it
    await email.fill("quem@exemplo");
    await expect(password).toBeVisible();
    await email.fill("");
    await expect(password).toBeHidden();
    await expect(password).toHaveCount(1);
    await email.fill("quem@exemplo");
    await expect(password).toBeHidden();
    await email.fill("quem@exemplo.com");
    await expect(password).toBeVisible();
    await expect(email).not.toHaveAttribute("aria-invalid", "true");
    await expect(
      page.getByRole("link", { name: "Esqueci a senha" })
    ).toBeVisible();
    expect(server.calls).toEqual([]);

    // the fields say what is missing
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toBeFocused();
    await expect(page.getByText("Digite a senha.")).toBeVisible();
    await shot(page, "entrar-senha-vazia");

    await password.fill(PASSWORD);
    // show and hide: the toggle says its state in its name, hidden again on submit (AC-72); its touch area
    // is measured by the screen checks (ui-guardrails)
    const reveal = page.getByRole("button", { name: "Mostrar senha" });
    await expect(reveal).toHaveText("Mostrar");
    const wide = await password.boundingBox();
    expect(wide?.width ?? 0).toBeGreaterThanOrEqual(190);
    await reveal.click();
    // the name says what the next tap does: "Mostrar senha" becomes "Ocultar senha" (P5)
    const hide = page.getByRole("button", { name: "Ocultar senha" });
    await expect(hide).toHaveText("Ocultar");
    await expect(
      page.getByRole("button", { name: "Mostrar senha" })
    ).toHaveCount(0);
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "E-mail ou senha incorretos."
    );
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("");
    await expect(email).toHaveValue("quem@exemplo.com");
    // the focus goes to the field that is typed again, and the alert is read with both fields
    await expect(password).toBeFocused();
    const alertId = await page.getByRole("alert").getAttribute("id");
    expect(alertId).toBeTruthy();
    await expect(email).toHaveAttribute(
      "aria-describedby",
      alertId ?? "no alert"
    );
    await expect(password).toHaveAttribute(
      "aria-describedby",
      alertId ?? "no alert"
    );
    await shot(page, "entrar-credencial-incorreta");

    await password.fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect
      .poll(() => callsTo(server, "/api/auth/sign-in/email").length)
      .toBe(2);
    const [first, second] = callsTo(server, "/api/auth/sign-in/email");
    expect(first?.turnstile).toMatch(LOGIN_TOKEN);
    expect(second?.turnstile).toMatch(LOGIN_TOKEN);
    expect(second?.turnstile).not.toBe(first?.turnstile);
    expect(first?.body).toEqual({
      email: "quem@exemplo.com",
      password: PASSWORD,
      rememberMe: true,
    });
    await expectNoTechnicalText(page);

    // nothing of the form is kept by the browser, nor in the address (AC-26, AC-50)
    const stored = await page.evaluate(() =>
      JSON.stringify([
        { ...localStorage },
        { ...sessionStorage },
        document.cookie,
      ])
    );
    expect(stored).not.toContain("quem@exemplo.com");
    expect(stored).not.toContain(PASSWORD);
    expect(page.url()).not.toContain("quem");
  });

  test("entrada pausada: a frase do e-mail, o botão desligado só para esse e-mail (AC-62, V4)", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/sign-in/email": {
          body: {
            error: { code: "auth_login_locked" },
            retryAfterSeconds: 840,
          },
          status: 429,
        },
      },
    });
    await serve(page, server);
    await page.goto("/entrar");
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Muitas tentativas. Espere 14 minutos ou use Esqueci a senha. Se este e-mail tem conta com senha, enviamos um link para liberar agora."
    );
    const enter = page.getByRole("button", { exact: true, name: "Entrar" });
    await expect(enter).toBeDisabled();
    await shot(page, "entrar-pausada");
    await page.getByLabel("E-mail", { exact: true }).fill("outra@exemplo.com");
    await expect(enter).toBeEnabled();
    await expectNoTechnicalText(page);
  });

  test("e-mail não confirmado: 'Confirme seu e-mail' e o reenvio com o desafio certo (AC-48, AC-50)", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/sign-in/email": {
          body: { code: "EMAIL_NOT_VERIFIED" },
          status: 403,
        },
      },
    });
    await serve(page, server);
    await page.goto("/entrar");
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirme seu e-mail" })
    ).toBeVisible();
    await shot(page, "entrar-email-nao-confirmado");
    await page.getByRole("button", { name: "Reenviar e-mail" }).click();
    await expect(page.getByText("Reenviamos. Veja o spam.")).toBeVisible();
    const [resend] = callsTo(server, "/api/auth/send-verification-email");
    expect(resend?.body).toEqual({ email: "quem@exemplo.com" });
    expect(resend?.turnstile).toMatch(VERIFICATION_TOKEN);
    await shot(page, "entrar-reenviado");
  });

  test("entrar dá certo e vai ao destino do voltar", async ({ page }) => {
    const server = newServer();
    await serve(page, server);
    await page.route("**/rpc/**", (route) =>
      route.abort("internetdisconnected")
    );
    await page.goto("/entrar?voltar=/devices");
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(page).toHaveURL(AT_DEVICES);
  });

  test("desafio que falha e script bloqueado: cada um com a sua frase (AC-51, V5)", async ({
    page,
  }) => {
    const server = newServer({ turnstile: "fail" });
    await serve(page, server);
    await page.goto("/entrar");
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível confirmar que você é uma pessoa. Tente de novo."
    );
    expect(callsTo(server, "/api/auth/sign-in/email")).toEqual([]);
    await shot(page, "entrar-desafio-falhou");
  });

  test("script do desafio bloqueado (bloqueador de anúncios): a frase diz o que fazer (V5)", async ({
    page,
  }) => {
    const server = newServer({ turnstile: "blocked" });
    await serve(page, server);
    await page.goto("/criar-conta");
    // the challenge opens with the password, after the e-mail
    await page.getByLabel("E-mail", { exact: true }).fill("nova@exemplo.com");
    await expect(page.getByRole("alert")).toHaveText(
      "Não deu para carregar a confirmação. Recarregue a página ou libere este site no bloqueador de anúncios."
    );
    await shot(page, "criar-conta-desafio-bloqueado");
  });
});

test.describe("desafio bloqueado (P2)", () => {
  test("entrar, criar conta e esqueci a senha: a frase e 'Tentar de novo', sem recarregar o que foi digitado", async ({
    page,
  }) => {
    const server = newServer({ turnstile: "blocked" });
    await serve(page, server);
    await page.goto("/esqueci-a-senha");
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await expect(page.getByRole("alert")).toContainText("Recarregue a página");
    await shot(page, "esqueci-desafio-bloqueado");
    // the person freed the site in the blocker: asking again loads the script, the form keeps its text
    // still blocked: the button stays where it was, with the focus, and the alert comes back unchanged
    const again = page.getByRole("button", { name: "Tentar de novo" });
    await again.click();
    await expect(again).toBeFocused();
    await expect(again).toHaveText("Tentar de novo");
    await expect(page.getByRole("alert")).toContainText("Recarregue a página");
    server.turnstile = "ok";
    await again.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // the block went away with the focus on it: the focus moves to the first field of the form
    await expect(page.getByLabel("E-mail", { exact: true })).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Tentar de novo" })
    ).toHaveCount(0);
    await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue(
      "quem@exemplo.com"
    );
    await page.getByRole("button", { name: "Enviar link" }).click();
    await expect(
      page.getByText("Se esse e-mail tiver conta, enviamos um link.", {
        exact: false,
      })
    ).toBeVisible();

    for (const path of ["/entrar", "/criar-conta"]) {
      server.turnstile = "blocked";
      // biome-ignore lint/performance/noAwaitInLoops: one page after the other in the same tab
      await page.goto(path);
      await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
      await expect(
        page.getByRole("button", { name: "Tentar de novo" })
      ).toBeVisible();
    }
  });

  test("com o script bloqueado, o botão do formulário fica aria-disabled e aponta para o alerta; volta ao normal quando o script carrega (N-1)", async ({
    page,
  }) => {
    const server = newServer({ turnstile: "blocked" });
    await serve(page, server);
    const cases = [
      { button: "Criar conta", path: "/criar-conta", shot: "criar-conta" },
      { button: "Entrar", path: "/entrar", shot: "entrar" },
    ];
    for (const { button, path, shot: name } of cases) {
      server.turnstile = "blocked";
      // biome-ignore lint/performance/noAwaitInLoops: one page after the other in the same tab
      await page.goto(path);
      await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
      if (path === "/entrar") {
        await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
      }
      const submit = page.getByRole("button", { exact: true, name: button });
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("Recarregue a página");
      await expect(submit).toHaveAttribute("aria-disabled", "true");
      // still a button the focus reaches (not `disabled`), and it names the alert that says why
      expect(await submit.getAttribute("disabled")).toBeNull();
      const alertId = await alert.getAttribute("id");
      expect(alertId).toBeTruthy();
      await expect(submit).toHaveAttribute("aria-describedby", alertId ?? "");
      await expect(submit).toHaveAccessibleDescription(BLOCKED_DESCRIPTION);
      // a press, and Enter in a field, do nothing: no request leaves the page
      // forced: Playwright treats aria-disabled as not actionable, and a person can still press it
      await submit.click({ force: true });
      await page.getByLabel("E-mail", { exact: true }).press("Enter");
      expect(callsTo(server, "/api/auth/sign-in/email")).toEqual([]);
      expect(callsTo(server, "/api/auth/sign-up/email")).toEqual([]);
      // and the form did not run its submit: no second alert, the button is not pending, its name is the same
      await expect(alert).toHaveCount(1);
      expect(await submit.getAttribute("aria-busy")).toBeNull();
      await expect(submit).toHaveText(button);
      await shot(page, `${name}-desafio-bloqueado-botao`);
      // the script loads: the button is normal again
      server.turnstile = "ok";
      await page.getByRole("button", { name: "Tentar de novo" }).click();
      await expect(
        page.getByRole("button", { name: "Tentar de novo" })
      ).toHaveCount(0);
      expect(await submit.getAttribute("aria-disabled")).toBeNull();
      expect(await submit.getAttribute("aria-describedby")).toBeNull();
    }
  });

  test("nova senha: manda abrir de novo o link do e-mail, nunca recarregar, e não oferece tentar de novo", async ({
    page,
  }) => {
    const server = newServer({ turnstile: "blocked" });
    await serve(page, server);
    await page.goto("/redefinir-senha#token=tok-de-teste.123");
    await expect(page.getByRole("alert")).toHaveText(
      "Não deu para carregar a confirmação. Libere este site no bloqueador de anúncios e abra o link de novo."
    );
    await expect(
      page.getByRole("button", { name: "Tentar de novo" })
    ).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Recarregue");
    // a try with the script missing does nothing: the button is off (`aria-disabled`, still reachable), names the
    // alert that says why, and no request leaves the page
    await newPasswordField(page).fill(PASSWORD);
    const change = page.getByRole("button", { name: "Trocar senha" });
    await expect(change).toHaveAttribute("aria-disabled", "true");
    await expect(change).toHaveAttribute(
      "aria-describedby",
      (await page.getByRole("alert").getAttribute("id")) ?? ""
    );
    // forced: Playwright treats aria-disabled as not actionable, and a person can still press it
    await change.click({ force: true });
    await newPasswordField(page).press("Enter");
    expect(callsTo(server, "/api/auth/reset-password")).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText("abra o link de novo");
    await shot(page, "nova-senha-desafio-bloqueado");
  });
});

test("criar conta: regra antes de digitar, erros junto do campo, aceite obrigatório e o mesmo 'Confirme seu e-mail' (AC-47, 49, 68, 71)", async ({
  page,
}) => {
  const server = newServer();
  await serve(page, server);
  await page.goto("/criar-conta");
  await expect(page).toHaveTitle("Criar conta · Polaris");
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeEnabled();
  await shot(page, "criar-conta-pronta");
  // the rule, the box and the button open with the password, after the e-mail
  await expect(page.getByRole("checkbox")).toBeHidden();
  await page.getByLabel("E-mail", { exact: true }).fill("nova@exemplo.com");
  await expect(
    page.getByText(
      "No mínimo 15 caracteres. Vale frase com espaços. Senha que já vazou não serve."
    )
  ).toBeVisible();
  const accept = page.getByRole("checkbox");
  await expect(accept).not.toBeChecked();
  await expect(page.getByRole("link", { name: TERMS }).first()).toHaveAttribute(
    "rel",
    NOOPENER
  );
  await page.getByLabel("Senha", { exact: true }).fill("curta");
  const create = page.getByRole("button", { exact: true, name: "Criar conta" });
  await expect(create).toBeEnabled();
  await create.click();
  const password = page.getByLabel("Senha", { exact: true });
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toBeFocused();
  await expect(page.getByText("Use pelo menos 15 caracteres.")).toBeVisible();
  await password.fill(PASSWORD);
  await create.click();
  await expect(accept).toBeFocused();
  await expect(
    page.getByText("Marque o aceite para criar a conta.")
  ).toBeVisible();
  await shot(page, "criar-conta-erros");
  expect(callsTo(server, "/api/auth/sign-up/email")).toEqual([]);

  server.answers["/api/auth/sign-up/email"] = {
    body: { code: "password_compromised" },
    status: 400,
  };
  await accept.check();
  await create.click();
  await expect(
    page.getByText("Essa senha já apareceu em vazamentos. Escolha outra.")
  ).toBeVisible();
  await shot(page, "criar-conta-senha-vazada");

  server.answers["/api/auth/sign-up/email"] = ok;
  await create.click();
  await expect(
    page.getByRole("heading", { name: "Confirme seu e-mail" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Enviamos um e-mail para nova@exemplo.com. Siga as instruções nele."
    )
  ).toBeVisible();
  const signUps = callsTo(server, "/api/auth/sign-up/email");
  expect(signUps.at(-1)?.body).toMatchObject({
    email: "nova@exemplo.com",
    legalAcceptance: { privacy: expect.any(Number), terms: expect.any(Number) },
    password: PASSWORD,
  });
  expect(signUps.at(-1)?.turnstile).toMatch(SIGNUP_TOKEN);
  // "e-mail" in the title never breaks into "e-" and "mail" at 360 px
  await page.setViewportSize({ height: 740, width: 360 });
  const wordLines = await page
    .locator("h1 > span")
    .evaluate((word) => word.getClientRects().length);
  expect(wordLines).toBe(1);
  await shot(page, "criar-conta-confirme");
  await expectNoTechnicalText(page);
});

test("esqueci a senha: a resposta igual exista ou não a conta (AC-49, AC-51)", async ({
  page,
}) => {
  const server = newServer();
  await serve(page, server);
  await page.goto("/esqueci-a-senha");
  await shot(page, "esqueci-pronta");
  await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(
    page.getByText("Se esse e-mail tiver conta, enviamos um link.", {
      exact: false,
    })
  ).toBeVisible();
  const [request] = callsTo(server, "/api/auth/request-password-reset");
  expect(request?.body).toEqual({ email: "quem@exemplo.com" });
  expect(request?.turnstile).toMatch(RESET_REQUEST_TOKEN);
  await shot(page, "esqueci-enviado");

  server.answers["/api/auth/request-password-reset"] = {
    body: { error: { code: "auth_rate_limited" } },
    status: 429,
  };
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Muitos pedidos. Espere alguns minutos."
  );
  // the green line of the first send goes away when a new result arrives
  await expect(page.getByText("Se esse e-mail tiver conta")).toHaveCount(0);
  await shot(page, "esqueci-limite");
});

test.describe("links com o token no fragmento (AC-53, AC-64, consolidação item 3)", () => {
  test("nova senha: o token sai da barra antes do script do desafio e vai no corpo", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/redefinir-senha#token=tok-de-teste.123");
    await expect(newPasswordField(page)).toBeVisible();
    await expect(newPasswordField(page)).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
    expect(page.url()).not.toMatch(TOKEN_IN_URL);
    await expect.poll(() => server.urlAtTurnstile.length).toBeGreaterThan(0);
    for (const url of server.urlAtTurnstile) {
      expect(url).not.toMatch(TOKEN_IN_URL);
    }
    await shot(page, "nova-senha-pronta");
    await newPasswordField(page).fill(PASSWORD);
    await page.getByRole("button", { name: "Trocar senha" }).click();
    await expect(
      page.getByText("Senha trocada. Entre com a nova senha.")
    ).toBeVisible();
    const [reset] = callsTo(server, "/api/auth/reset-password");
    expect(reset?.body).toEqual({
      newPassword: PASSWORD,
      token: "tok-de-teste.123",
    });
    expect(reset?.turnstile).toMatch(RESET_TOKEN);
    await expect(page.getByRole("link", { name: "Entrar" })).toHaveAttribute(
      "href",
      "/entrar"
    );
    await expectFitsCard(page);
    await shot(page, "nova-senha-trocada", true);
    await expect(page.locator("main")).not.toContainText("tok-de-teste");
  });

  test("nova senha: link vencido ou usado, e a recarga sem token não diz 'venceu' (V2)", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/reset-password": {
          body: { code: "INVALID_TOKEN" },
          status: 400,
        },
      },
    });
    await serve(page, server);
    await page.goto("/redefinir-senha#token=velho");
    await newPasswordField(page).fill(PASSWORD);
    await page.getByRole("button", { name: "Trocar senha" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Este link venceu ou já foi usado. Peça outro."
    );
    await expectFitsCard(page);
    await shot(page, "nova-senha-link-vencido", true);
    await page.reload();
    // opened without its link: an instruction in a neutral panel, not a red failure
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "Toque no link que enviamos por e-mail. Venceu? Peça outro."
    );
    await expect(
      page.getByRole("link", { name: "Pedir outro link" })
    ).toBeVisible();
    await expectFitsCard(page);
    await shot(page, "nova-senha-sem-link", true);
  });

  test("confirmar e-mail: confirmado, vencido com reenvio, e a tela de espera", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/confirmar-email#token=tok-verifica");
    await expect(page.getByText("Agora é só entrar.")).toBeVisible();
    expect(page.url()).not.toMatch(TOKEN_IN_URL);
    expect(callsTo(server, "/api/email-verification")[0]?.body).toEqual({
      token: "tok-verifica",
    });
    // no challenge on a page that does not need one yet
    expect(server.urlAtTurnstile).toEqual([]);
    await expectFitsCard(page);
    await shot(page, "confirmar-email-confirmado", true);

    server.answers["/api/email-verification"] = {
      body: { error: { code: "verification_link_expired" } },
      status: 400,
    };
    // a link opens a new document: a hash change in the same page would not
    await page.goto("about:blank");
    await page.goto("/confirmar-email#token=tok-velho");
    await expect(page.getByText("Este link venceu. Peça outro.")).toBeVisible();
    await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
    await page.getByRole("button", { name: "Reenviar e-mail" }).click();
    // an address typed here gets the same answer with or without an account: no "Reenviamos" (P4)
    await expect(
      page.getByText(
        "Se esse e-mail precisar de confirmação, enviamos outro. Veja o spam."
      )
    ).toBeVisible();
    await expect(page.getByText("Reenviamos.")).toHaveCount(0);
    await shot(page, "confirmar-email-vencido-reenviado");
  });

  test("desbloquear: liberado, e o link inválido com as saídas", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/desbloquear#token=user.tok");
    await expect(
      page.getByText("Entrada liberada. Você já pode entrar.")
    ).toBeVisible();
    expect(page.url()).not.toMatch(TOKEN_IN_URL);
    expect(callsTo(server, "/api/login-unlock")[0]?.body).toEqual({
      token: "user.tok",
    });
    expect(server.urlAtTurnstile).toEqual([]);
    await expectFitsCard(page);
    await shot(page, "desbloquear-liberado", true);

    server.answers["/api/login-unlock"] = {
      body: { error: { code: "unlock_link_invalid" } },
      status: 400,
    };
    await page.goto("about:blank");
    await page.goto("/desbloquear#token=user.velho");
    await expect(page.getByRole("alert")).toContainText(
      "Link vencido ou já usado."
    );
    await expect(
      page.getByRole("link", { name: "Esqueci a senha" })
    ).toBeVisible();
    await expectFitsCard(page);
    await shot(page, "desbloquear-link-invalido", true);
  });
});

test("a entrada carrega o desafio sob a CSP do _headers, sem violação (AC-7)", async ({
  page,
}) => {
  // a refused sign-in: the page stays, for the next check
  const server = newServer({
    answers: {
      "/api/auth/sign-in/email": {
        body: { code: "INVALID_EMAIL_OR_PASSWORD" },
        status: 401,
      },
    },
  });
  await serve(page, server);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      violations.push(message.text().slice(0, 200));
    }
  });
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
  await page.goto("/entrar");
  await expect.poll(() => server.urlAtTurnstile.length).toBe(1);
  await page.getByLabel("E-mail", { exact: true }).fill("quem@exemplo.com");
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { exact: true, name: "Entrar" }).click();
  await expect
    .poll(() => callsTo(server, "/api/auth/sign-in/email").length)
    .toBe(1);
  expect(violations.filter((text) => CSP_VIOLATION.test(text))).toEqual([]);

  // `/entrar/` would not match its rule in `_headers`: the app goes to the exact path first
  // the page replaces itself at once: the navigation ends the context of the call, which is expected
  await page
    .evaluate(() => window.location.assign("/redefinir-senha/?x=1#token=abc"))
    .catch(() => undefined);
  await expect(page).toHaveURL(RESET_EXACT);
  await expect(newPasswordField(page)).toBeVisible();

  // the unlock page keeps the shell policy: a script from the challenge origin is refused there
  expect(policyFor("/desbloquear")).not.toContain("challenges.cloudflare.com");
  expect(policyFor("/entrar")).toContain(
    "frame-src https://challenges.cloudflare.com"
  );
  // the same rule for the path with the final slash, so even that first load has the challenge policy
  for (const path of AUTH_ENTRY_PATHS) {
    expect(policyFor(path)).toContain(
      "frame-src https://challenges.cloudflare.com"
    );
    expect(policyFor(`${path}/`)).toBe(policyFor(path));
  }
});

test.describe("trocar senha dentro do app (AC-57, V8)", () => {
  const ORGANIZATION = {
    id: "0199c2d0-0000-7000-8000-00000000a001",
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  };

  async function openAccount(page: Page, server: Server) {
    await serve(page, server);
    await page.unroute("**/api/auth/get-session");
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
        contentType: "application/json",
      })
    );
    await page.route("**/rpc/**", (route) => {
      const procedure = new URL(route.request().url()).pathname;
      if (procedure.endsWith("/organization/listMine")) {
        return route.fulfill({
          body: JSON.stringify({
            json: { organizations: [ORGANIZATION] },
            meta: [],
          }),
          contentType: "application/json",
        });
      }
      return route.abort("internetdisconnected");
    });
    await page.goto("/conta/seguranca");
  }

  test("diz o que acontece com os outros aparelhos e troca a senha", async ({
    page,
  }) => {
    const server = newServer();
    await openAccount(page, server);
    await expect(
      page.getByRole("heading", { level: 1, name: "Trocar senha" })
    ).toBeVisible();
    await expect(
      page.getByText("os outros aparelhos saem da sua conta", { exact: false })
    ).toBeVisible();
    await shot(page, "trocar-senha-pronta");
    await page.getByLabel("Senha atual").fill("a senha antiga dele");
    await newPasswordField(page).fill(PASSWORD);
    await page
      .getByRole("button", { exact: true, name: "Trocar senha" })
      .click();
    await expect(
      page.getByText("Senha trocada. Os outros aparelhos saíram da sua conta.")
    ).toBeVisible();
    expect(callsTo(server, "/api/auth/change-password")[0]).toMatchObject({
      body: { currentPassword: "a senha antiga dele", newPassword: PASSWORD },
      turnstile: null,
    });
    await shot(page, "trocar-senha-trocada");
  });

  test("senha atual errada e login antigo: cada um com a sua saída", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/change-password": {
          body: { code: "INVALID_PASSWORD" },
          status: 400,
        },
      },
    });
    await openAccount(page, server);
    await page.getByLabel("Senha atual").fill("errada errada errada");
    await newPasswordField(page).fill(PASSWORD);
    await page
      .getByRole("button", { exact: true, name: "Trocar senha" })
      .click();
    await expect(page.getByText("A senha atual não confere.")).toBeVisible();
    await expect(page.getByLabel("Senha atual")).toBeFocused();
    await shot(page, "trocar-senha-atual-errada");

    server.answers["/api/auth/change-password"] = {
      body: { error: { code: "fresh_session_required" } },
      status: 403,
    };
    await page.getByLabel("Senha atual").fill("a senha antiga dele");
    await page
      .getByRole("button", { exact: true, name: "Trocar senha" })
      .click();
    await expect(
      page.getByText("Por segurança, entre de novo para trocar a senha.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Entrar de novo" })
    ).toBeVisible();
    await expect(page.getByLabel("Senha atual")).toHaveCount(0);
    await expect(
      page.getByRole("button", { exact: true, name: "Trocar senha" })
    ).toHaveCount(0);
    await shot(page, "trocar-senha-login-antigo");
  });

  test("pausa por tentativas: diz o que fazer nesta tela, não na da entrada (P3)", async ({
    page,
  }) => {
    const server = newServer({
      answers: {
        "/api/auth/change-password": {
          body: {
            error: { code: "auth_login_locked" },
            retryAfterSeconds: 840,
          },
          status: 429,
        },
      },
    });
    await openAccount(page, server);
    await page.getByLabel("Senha atual").fill("errada errada errada");
    await newPasswordField(page).fill(PASSWORD);
    await page
      .getByRole("button", { exact: true, name: "Trocar senha" })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      "Muitas tentativas. Espere 14 minutos. Não lembra a senha atual? Saia e use Esqueci a senha."
    );
    await expect(page.locator("main")).not.toContainText("Pausamos");
    await expectNoTechnicalText(page);
    await shot(page, "trocar-senha-pausada");
  });
});
