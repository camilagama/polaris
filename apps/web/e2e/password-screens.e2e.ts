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

/** Each state at 360 and 1280 px, light and dark (V7); only when asked, and only once (desktop project). */
async function shot(page: Page, name: string) {
  if (!SHOTS || test.info().project.name !== "chromium-desktop") {
    return;
  }
  const size = page.viewportSize();
  for (const [width, height] of [
    [360, 740],
    [1280, 800],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one size after the other on the same page
    await page.setViewportSize({ height, width });
    for (const scheme of ["light", "dark"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one scheme after the other on the same page
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        fullPage: true,
        path: `${SHOTS}/${name}-${width}-${scheme}.png`,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
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
    await expect(
      page.getByRole("link", { name: "Esqueci a senha" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Criar conta" })).toBeVisible();
    await shot(page, "entrar-pronta");

    const email = page.getByLabel("E-mail", { exact: true });
    const password = page.getByLabel("Senha", { exact: true });
    await expect(email).toHaveAttribute("autocomplete", "username");
    await expect(password).toHaveAttribute("autocomplete", "current-password");

    // the fields say what is missing, the first one takes the focus
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toBeFocused();
    await expect(page.getByText("Digite seu e-mail.")).toBeVisible();
    await shot(page, "entrar-campos-vazios");

    await email.fill("quem@exemplo.com");
    await password.fill(PASSWORD);
    // show and hide: a 44 px toggle with its state, hidden again on submit (AC-72)
    const reveal = page.getByRole("button", { name: "Mostrar senha" });
    await reveal.click();
    await expect(reveal).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
    const box = await reveal.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "E-mail ou senha incorretos."
    );
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("");
    await expect(email).toHaveValue("quem@exemplo.com");
    await expect(email).toBeFocused();
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
    await expect(page.getByRole("alert")).toContainText(
      "Pausamos a entrada com senha deste e-mail"
    );
    await expect(page.getByRole("alert")).toContainText("14 minutos");
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
    await expect(
      page.getByText("Reenviamos. Olhe também o spam.")
    ).toBeVisible();
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
    await expect(page.getByRole("alert")).toContainText(
      "Não conseguimos carregar a confirmação de que você é uma pessoa."
    );
    await shot(page, "criar-conta-desafio-bloqueado");
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
    page.getByText("Use pelo menos 15 caracteres.", { exact: false })
  ).toBeVisible();
  const accept = page.getByRole("checkbox");
  await expect(accept).not.toBeChecked();
  await expect(page.getByRole("link", { name: TERMS }).first()).toHaveAttribute(
    "rel",
    NOOPENER
  );
  await shot(page, "criar-conta-pronta");

  await page.getByLabel("E-mail", { exact: true }).fill("nova@exemplo.com");
  await page.getByLabel("Senha", { exact: true }).fill("curta");
  const create = page.getByRole("button", { exact: true, name: "Criar conta" });
  await expect(create).toBeEnabled();
  await create.click();
  const password = page.getByLabel("Senha", { exact: true });
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toBeFocused();
  await expect(
    page.getByText("A senha precisa ter pelo menos 15 caracteres.")
  ).toBeVisible();
  await password.fill(PASSWORD);
  await create.click();
  await expect(accept).toBeFocused();
  await expect(
    page.getByText("Para criar a conta, marque", { exact: false })
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
    page.getByText("Enviamos um link para nova@exemplo.com.")
  ).toBeVisible();
  const signUps = callsTo(server, "/api/auth/sign-up/email");
  expect(signUps.at(-1)?.body).toMatchObject({
    email: "nova@exemplo.com",
    legalAcceptance: { privacy: expect.any(Number), terms: expect.any(Number) },
    password: PASSWORD,
  });
  expect(signUps.at(-1)?.turnstile).toMatch(SIGNUP_TOKEN);
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
  await page.getByRole("button", { name: "Enviar o link" }).click();
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
  await page.getByRole("button", { name: "Enviar o link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Você pediu e-mails demais. Espere alguns minutos."
  );
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
    await page.getByRole("button", { name: "Trocar a senha" }).click();
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
    await shot(page, "nova-senha-trocada");
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
    await page.getByRole("button", { name: "Trocar a senha" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Este link venceu ou já foi usado. Peça outro."
    );
    await shot(page, "nova-senha-link-vencido");
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(
      "toque no link que enviamos por e-mail"
    );
    await expect(
      page.getByRole("link", { name: "Pedir outro link" })
    ).toBeVisible();
    await shot(page, "nova-senha-sem-link");
  });

  test("confirmar e-mail: confirmado, vencido com reenvio, e a tela de espera", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/confirmar-email#token=tok-verifica");
    await expect(
      page.getByText("E-mail confirmado. Agora é só entrar.")
    ).toBeVisible();
    expect(page.url()).not.toMatch(TOKEN_IN_URL);
    expect(callsTo(server, "/api/email-verification")[0]?.body).toEqual({
      token: "tok-verifica",
    });
    // no challenge on a page that does not need one yet
    expect(server.urlAtTurnstile).toEqual([]);
    await shot(page, "confirmar-email-confirmado");

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
    await expect(
      page.getByText("Reenviamos. Olhe também o spam.")
    ).toBeVisible();
    await shot(page, "confirmar-email-vencido-reenviado");
  });

  test("desbloquear: liberado, e o link inválido com as saídas", async ({
    page,
  }) => {
    const server = newServer();
    await serve(page, server);
    await page.goto("/desbloquear#token=user.tok");
    await expect(
      page.getByText("Pronto: a entrada com senha está liberada.", {
        exact: false,
      })
    ).toBeVisible();
    expect(page.url()).not.toMatch(TOKEN_IN_URL);
    expect(callsTo(server, "/api/login-unlock")[0]?.body).toEqual({
      token: "user.tok",
    });
    expect(server.urlAtTurnstile).toEqual([]);
    await shot(page, "desbloquear-liberado");

    server.answers["/api/login-unlock"] = {
      body: { error: { code: "unlock_link_invalid" } },
      status: 400,
    };
    await page.goto("about:blank");
    await page.goto("/desbloquear#token=user.velho");
    await expect(page.getByRole("alert")).toContainText(
      "Este link venceu ou já foi usado."
    );
    await expect(
      page.getByRole("link", { name: "Esqueci a senha" })
    ).toBeVisible();
    await shot(page, "desbloquear-link-invalido");
  });
});

test("a entrada carrega o desafio sob a CSP do _headers, sem violação (AC-7)", async ({
  page,
}) => {
  const server = newServer();
  await serve(page, server);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      violations.push(message.text().slice(0, 200));
    }
  });
  await page.route("**/*", async (route) => {
    const request: Request = route.request();
    if (request.resourceType() !== "document") {
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
  await page.goto("/redefinir-senha/?x=1#token=abc");
  await expect(page).toHaveURL(RESET_EXACT);
  await expect(newPasswordField(page)).toBeVisible();

  // the unlock page keeps the shell policy: a script from the challenge origin is refused there
  expect(policyFor("/desbloquear")).not.toContain("challenges.cloudflare.com");
  expect(policyFor("/entrar")).toContain(
    "frame-src https://challenges.cloudflare.com"
  );
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
    await shot(page, "trocar-senha-login-antigo");
  });
});
