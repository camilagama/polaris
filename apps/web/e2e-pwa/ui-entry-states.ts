/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

/**
 * The states of `/entrar` and `/criar-conta` (v5.2) the interface guardrails measure: the pages of the pwa-e2e
 * build under the CSP of `_headers`, with the auth server answered by the test (`page.route`), a stand-in for
 * the Turnstile script where the state needs the challenge, and synthetic addresses only.
 */
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js**";
const SITE_KEY = "1x00000000000000000000AA";
export const EMAIL = "ana@lojadaana.com.br";
export const PASSWORD = "uma frase longa de teste";

export const json = (status: number, body: unknown) => ({
  body: JSON.stringify(body),
  headers: { ...WORKER_MARK },
  contentType: "application/json",
  status,
});

export type Challenge =
  | "blocked"
  | "checking"
  | "failed"
  | "interactive"
  | "none";

/**
 * A stand-in with the `render`/`execute` contract of the real script. `interactive` asks for the person (and
 * draws a box of the widget's size where the real iframe would be); `checking` never answers; `failed` answers
 * with the error callback.
 */
const turnstileStandIn = (mode: "checking" | "failed" | "interactive") => `
(() => {
  const options = {};
  let widgets = 0;
  window.turnstile = {
    render(container, given) {
      widgets += 1;
      const id = "w" + widgets;
      options[id] = { container, given };
      return id;
    },
    execute(id) {
      const { container, given } = options[id];
      if (${JSON.stringify(mode)} === "failed") {
        setTimeout(() => given["error-callback"](), 20);
        return;
      }
      if (${JSON.stringify(mode)} !== "interactive") return;
      setTimeout(() => {
        const box = document.createElement("div");
        box.dataset.widget = "";
        box.style.width = "300px";
        box.style.maxWidth = "100%";
        box.style.height = "65px";
        box.style.border = "1px solid var(--input)";
        box.style.borderRadius = "0.5rem";
        container.append(box);
        given["before-interactive-callback"]();
      }, 20);
    },
    reset() {},
    remove() {},
  };
})();
`;

/** The auth server of the entry pages: no session, the methods asked for, and nothing else unless the state says. */
export async function serveEntry(
  page: Page,
  {
    challenge = "none",
    password = true,
  }: { challenge?: Challenge; password?: boolean } = {}
) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(json(200, null))
  );
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json(200, {
        emailPassword: password,
        google: true,
        turnstileSiteKey: challenge === "none" ? null : SITE_KEY,
      })
    )
  );
  if (challenge === "none") {
    return;
  }
  await page.route(TURNSTILE_SCRIPT, (route) =>
    challenge === "blocked"
      ? route.abort("blockedbyclient")
      : route.fulfill({
          body: turnstileStandIn(challenge),
          contentType: "text/javascript",
        })
  );
}

/** A request that never answers: the screen stays in its pending state while it is measured. */
export const hold = (_route: Route) => new Promise<void>(() => undefined);

export async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // the region of the password opens in 220 ms; the alert and the card fade in as long
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running")
  );
  await page.waitForTimeout(260);
}

async function openPage(page: Page, path: string, title: string) {
  await page.goto(path);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await page.getByRole("button", { name: "Continuar com o Google" }).waitFor();
}

export const emailField = (page: Page) =>
  page.getByLabel("E-mail", { exact: true });
const passwordField = (page: Page) => page.getByLabel("Senha", { exact: true });

async function openSignIn(
  page: Page,
  options?: Parameters<typeof serveEntry>[1]
) {
  await serveEntry(page, options);
  await openPage(page, "/entrar", "Entrar no Polaris");
  await emailField(page).waitFor();
}

async function openSignUp(
  page: Page,
  options?: Parameters<typeof serveEntry>[1]
) {
  await serveEntry(page, options);
  await openPage(page, "/criar-conta", "Criar conta");
  await emailField(page).waitFor();
}

async function typeCompleteEmail(page: Page, address = EMAIL) {
  await emailField(page).fill(address);
  await passwordField(page).waitFor({ state: "visible" });
}

/** The sign-up form filled up to the box, which the state decides. */
async function fillSignUp(page: Page, accept: boolean) {
  await typeCompleteEmail(page, "nova@exemplo.com");
  await passwordField(page).fill(PASSWORD);
  if (accept) {
    await page.getByRole("checkbox").click();
  }
}

const submitSignUp = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Criar conta" }).click();

export const entryStates = {
  /** `/entrar` with the password off: Google alone. */
  googleOnly: async (page: Page) => {
    await serveEntry(page, { password: false });
    await openPage(page, "/entrar", "Entrar no Polaris");
    await settle(page);
  },
  /** `/entrar` ready: Google and the e-mail, the password still closed. */
  signIn: async (page: Page) => {
    await openSignIn(page);
    await settle(page);
  },
  signInBlocked: async (page: Page) => {
    await openSignIn(page, { challenge: "blocked" });
    await typeCompleteEmail(page);
    await passwordField(page).fill(PASSWORD);
    await page.getByRole("button", { name: "Tentar de novo" }).waitFor();
    await settle(page);
  },
  signInEmailComplete: async (page: Page) => {
    await openSignIn(page);
    await typeCompleteEmail(page);
    await settle(page);
  },
  signInEmailIncomplete: async (page: Page) => {
    await openSignIn(page);
    await emailField(page).fill("ana@lojadaana");
    await emailField(page).press("Enter");
    await page
      .getByText("Digite um e-mail completo, como nome@exemplo.com.")
      .waitFor();
    await settle(page);
  },
  /** A password manager filled both fields: the region opens with the password. */
  signInFilled: async (page: Page) => {
    await openSignIn(page);
    await page.evaluate(
      ({ address, secret }) => {
        // as a manager does: the value set on the element, then the event, the password while still hidden
        const set = (selector: string, value: string) => {
          const input = document.querySelector<HTMLInputElement>(selector);
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )?.set;
          if (input && setter) {
            setter.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        };
        set("input[type=password]", secret);
        set("input[type=email]", address);
      },
      { address: EMAIL, secret: PASSWORD }
    );
    await passwordField(page).waitFor({ state: "visible" });
    await settle(page);
  },
  signInGooglePending: async (page: Page) => {
    await openSignIn(page);
    await page.route("**/api/auth/sign-in/social", hold);
    await page.getByRole("button", { name: "Continuar com o Google" }).click();
    await page.getByRole("button", { name: "Abrindo o Google…" }).waitFor();
    await settle(page);
  },
  signInIncorrect: async (page: Page) => {
    await openSignIn(page);
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill(json(401, { code: "INVALID_EMAIL_OR_PASSWORD" }))
    );
    await typeCompleteEmail(page);
    await passwordField(page).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await page.getByText("E-mail ou senha incorretos.").waitFor();
    await settle(page);
  },
  /** No connection, sent here because the session ended. */
  signInOffline: async (
    page: Page,
    context: { setOffline: (offline: boolean) => Promise<void> }
  ) => {
    await serveEntry(page);
    await openPage(
      page,
      "/entrar?motivo=sessao&voltar=%2Fsales",
      "Entrar no Polaris"
    );
    await emailField(page).waitFor();
    await context.setOffline(true);
    await page.getByText("Sem conexão. Conecte-se para entrar.").waitFor();
    await settle(page);
  },
  signInPaused: async (page: Page) => {
    await openSignIn(page);
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill(
        json(429, { code: "auth_login_locked", retryAfterSeconds: 14 * 60 })
      )
    );
    await typeCompleteEmail(page);
    await passwordField(page).fill(PASSWORD);
    await page.getByRole("button", { exact: true, name: "Entrar" }).click();
    await page.getByText("Espere 14 minutos", { exact: false }).waitFor();
    await settle(page);
  },
  signUp: async (page: Page) => {
    await openSignUp(page);
    await settle(page);
  },
  /** The box left unchecked: the error under it, the button still on (V6b). */
  signUpAcceptMissing: async (page: Page) => {
    await openSignUp(page);
    await fillSignUp(page, false);
    await submitSignUp(page);
    await page.getByText("Marque o aceite para criar a conta.").waitFor();
    await settle(page);
  },
  signUpBlocked: async (page: Page) => {
    await openSignUp(page, { challenge: "blocked" });
    await typeCompleteEmail(page, "nova@exemplo.com");
    await page.getByRole("button", { name: "Tentar de novo" }).waitFor();
    await settle(page);
  },
  signUpChecking: async (page: Page) => {
    await openSignUp(page, { challenge: "checking" });
    await fillSignUp(page, true);
    await submitSignUp(page);
    await page.getByText("Confirmando que você é uma pessoa…").waitFor();
    await settle(page);
  },
  signUpCompromised: async (page: Page) => {
    await openSignUp(page);
    await page.route("**/api/auth/sign-up/email", (route) =>
      route.fulfill(json(400, { code: "password_compromised" }))
    );
    await fillSignUp(page, true);
    await submitSignUp(page);
    await page
      .getByText("Essa senha já apareceu em vazamentos. Escolha outra.")
      .waitFor();
    await settle(page);
  },
  /** The account was made: "Confirme seu e-mail" with the address of the form. */
  signUpConfirm: async (page: Page) => {
    await openSignUp(page);
    await page.route("**/api/auth/sign-up/email", (route) =>
      route.fulfill(json(200, { status: true }))
    );
    await fillSignUp(page, true);
    await submitSignUp(page);
    await page
      .getByRole("heading", { level: 1, name: "Confirme seu e-mail" })
      .waitFor();
    await settle(page);
  },
  signUpCreating: async (page: Page) => {
    await openSignUp(page);
    await page.route("**/api/auth/sign-up/email", hold);
    await fillSignUp(page, true);
    await submitSignUp(page);
    await page.getByRole("button", { name: "Criando a conta…" }).waitFor();
    await settle(page);
  },
  signUpEmailComplete: async (page: Page) => {
    await openSignUp(page);
    await typeCompleteEmail(page, "nova@exemplo.com");
    await settle(page);
  },
  signUpEmailIncomplete: async (page: Page) => {
    await openSignUp(page);
    await emailField(page).fill("nova@exemplo");
    await emailField(page).press("Enter");
    await page
      .getByText("Digite um e-mail completo, como nome@exemplo.com.")
      .waitFor();
    await settle(page);
  },
  signUpGooglePending: async (page: Page) => {
    await openSignUp(page);
    await page.route("**/api/auth/sign-in/social", hold);
    await page.getByRole("button", { name: "Continuar com o Google" }).click();
    await page.getByRole("button", { name: "Abrindo o Google…" }).waitFor();
    await settle(page);
  },
  signUpInteractive: async (page: Page) => {
    await openSignUp(page, { challenge: "interactive" });
    await fillSignUp(page, true);
    await submitSignUp(page);
    await page.getByText("Confirme que você é uma pessoa.").waitFor();
    await settle(page);
  },
};
