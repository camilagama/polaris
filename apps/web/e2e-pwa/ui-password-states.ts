/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import {
  type Challenge,
  EMAIL,
  emailField,
  hold,
  json,
  PASSWORD,
  serveEntry,
  settle,
} from "./ui-entry-states";
import { serveLabWorker } from "./worker-mark";

/**
 * The states of the other password pages (v5.2) the interface guardrails measure: "Confirme seu e-mail",
 * `/confirmar-email`, `/esqueci-a-senha`, `/redefinir-senha`, `/desbloquear`, and "Trocar senha" inside the app
 * (in the lab of the screens, over the real runtime). Same harness as `ui-entry-states.ts`: the auth server is
 * answered by the test (`page.route`), the Turnstile script is a stand-in, the addresses and tokens are synthetic.
 */
const TOKEN = "tok-de-teste";
const SHORT_PASSWORD = "curta";

const newPasswordField = (page: Page) =>
  page.getByLabel("Nova senha", { exact: true });
const submit = (page: Page, name: string) =>
  page.getByRole("button", { exact: true, name }).click();
const title = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();

async function openPath(
  page: Page,
  path: string,
  heading: string,
  options?: { challenge?: Challenge }
) {
  await serveEntry(page, options);
  await page.goto(path);
  await title(page, heading);
}

/** `/confirmar-email` with a link whose check the test answers. */
async function openConfirm(
  page: Page,
  answer: Parameters<Page["route"]>[1] | null,
  heading = "Confirme seu e-mail"
) {
  if (answer) {
    await page.route("**/api/email-verification", answer);
  }
  await openPath(page, `/confirmar-email#token=${TOKEN}`, heading);
}

/** An expired link: the panel asks for the address to send another. */
async function openExpired(page: Page) {
  await openConfirm(page, (route: Route) =>
    route.fulfill(json(400, { code: "verification_link_expired" }))
  );
  await page.getByText("Este link venceu. Peça outro.").waitFor();
}

async function openForgot(page: Page, challenge?: Challenge) {
  await openPath(
    page,
    "/esqueci-a-senha",
    "Esqueci a senha",
    challenge ? { challenge } : undefined
  );
  await emailField(page).waitFor();
}

async function openReset(page: Page, challenge?: Challenge) {
  await openPath(
    page,
    `/redefinir-senha#token=${TOKEN}`,
    "Nova senha",
    challenge ? { challenge } : undefined
  );
  await newPasswordField(page).waitFor();
}

async function openUnlock(
  page: Page,
  answer: Parameters<Page["route"]>[1] | null,
  fragment = `#token=${TOKEN}`
) {
  if (answer) {
    await page.route("**/api/login-unlock", answer);
  }
  await openPath(page, `/desbloquear${fragment}`, "Liberar a entrada");
}

const ok = (route: Route) => route.fulfill(json(200, { status: true }));

/** "Trocar senha" in the lab of the screens: the page over the runtime, the methods answered by the test. */
async function openChangePassword(page: Page) {
  await serveEntry(page);
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=change-password");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await title(page, "Trocar senha");
  await newPasswordField(page).waitFor();
}

/** Fills the two fields and sends; the server's answer is what the state routes before. */
async function sendChange(page: Page) {
  await page
    .getByLabel("Senha atual", { exact: true })
    .fill("senha-antiga-aqui");
  await newPasswordField(page).fill(PASSWORD);
  await submit(page, "Trocar senha");
}

/** Hides the lab's own controls: what stays is the screen. */
async function showChangeAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await settle(page);
}

export const passwordStates = {
  changePassword: async (page: Page) => {
    await openChangePassword(page);
    await showChangeAlone(page);
  },
  changePasswordChanging: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", hold);
    await sendChange(page);
    await page.getByRole("button", { name: "Trocando…" }).waitFor();
    await showChangeAlone(page);
  },
  changePasswordDone: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", ok);
    await sendChange(page);
    await page
      .getByText("Senha trocada. Os outros aparelhos saíram da sua conta.")
      .waitFor();
    await showChangeAlone(page);
  },
  changePasswordNoPassword: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", (route) =>
      route.fulfill(json(400, { code: "CREDENTIAL_ACCOUNT_NOT_FOUND" }))
    );
    await sendChange(page);
    await page
      .getByText("Conta do Google: não há senha para trocar.")
      .waitFor();
    // no form: only the alert and "Cancelar"
    await page.getByLabel("Senha atual").waitFor({ state: "detached" });
    await page
      .getByRole("link", { name: "Cancelar e voltar para Formas de receber" })
      .waitFor();
    await showChangeAlone(page);
  },
  changePasswordPaused: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", (route) =>
      route.fulfill(
        json(429, { code: "auth_login_locked", retryAfterSeconds: 14 * 60 })
      )
    );
    await sendChange(page);
    await page.getByText("Espere 14 minutos.", { exact: false }).waitFor();
    await page
      .locator('button[aria-disabled="true"]', { hasText: "Trocar senha" })
      .waitFor();
    await showChangeAlone(page);
  },
  changePasswordRecent: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", (route) =>
      route.fulfill(json(403, { code: "fresh_session_required" }))
    );
    await sendChange(page);
    await page
      .getByText("Por segurança, entre de novo para trocar a senha.")
      .waitFor();
    await showChangeAlone(page);
  },
  changePasswordWrongCurrent: async (page: Page) => {
    await openChangePassword(page);
    await page.route("**/api/auth/change-password", (route) =>
      route.fulfill(json(400, { code: "INVALID_PASSWORD" }))
    );
    await sendChange(page);
    await page.getByText("A senha atual não confere.").waitFor();
    await showChangeAlone(page);
  },
  confirmChecking: async (page: Page) => {
    await openConfirm(page, hold);
    await page.getByText("Confirmando o e-mail…").waitFor();
    await settle(page);
  },
  confirmDone: async (page: Page) => {
    await openConfirm(page, ok, "E-mail confirmado");
    await page.getByText("Agora é só entrar.").waitFor();
    await settle(page);
  },
  confirmExpired: async (page: Page) => {
    await openExpired(page);
    await settle(page);
  },
  confirmExpiredResent: async (page: Page) => {
    await openExpired(page);
    await page.route("**/api/auth/send-verification-email", ok);
    await emailField(page).fill("quem@exemplo.com");
    await submit(page, "Reenviar e-mail");
    await page
      .getByText(
        "Se esse e-mail precisar de confirmação, enviamos outro. Veja o spam."
      )
      .waitFor();
    await settle(page);
  },
  confirmLimit: async (page: Page) => {
    await openExpired(page);
    await page.route("**/api/auth/send-verification-email", (route) =>
      route.fulfill(json(429, { code: "rate_limited" }))
    );
    await emailField(page).fill("quem@exemplo.com");
    await submit(page, "Reenviar e-mail");
    await page.getByText("Muitos pedidos. Espere alguns minutos.").waitFor();
    await settle(page);
  },
  confirmNoLink: async (page: Page) => {
    await openPath(page, "/confirmar-email", "Confirme seu e-mail");
    await page
      .getByText(
        "Toque no link que enviamos por e-mail. Venceu? Peça outro aqui."
      )
      .waitFor();
    await settle(page);
  },
  confirmUnavailable: async (page: Page) => {
    await openConfirm(page, (route: Route) =>
      route.fulfill(json(503, { code: "unavailable" }))
    );
    await page
      .getByText("Não conseguimos agora. Tente de novo em instantes.")
      .waitFor();
    await settle(page);
  },
  forgot: async (page: Page) => {
    await openForgot(page);
    await settle(page);
  },
  forgotBlocked: async (page: Page) => {
    await openForgot(page, "blocked");
    await page.getByRole("button", { name: "Tentar novamente" }).waitFor();
    await settle(page);
  },
  forgotIncompleteEmail: async (page: Page) => {
    await openForgot(page);
    await emailField(page).fill("quem@exemplo");
    await submit(page, "Enviar link");
    await page
      .getByText("Digite um e-mail completo, como nome@exemplo.com.")
      .waitFor();
    await settle(page);
  },
  forgotLimit: async (page: Page) => {
    await openForgot(page);
    await page.route("**/api/auth/request-password-reset", (route) =>
      route.fulfill(json(429, { code: "rate_limited" }))
    );
    await emailField(page).fill(EMAIL);
    await submit(page, "Enviar link");
    await page.getByText("Muitos pedidos. Espere alguns minutos.").waitFor();
    await settle(page);
  },
  forgotSending: async (page: Page) => {
    await openForgot(page);
    await page.route("**/api/auth/request-password-reset", hold);
    await emailField(page).fill(EMAIL);
    await submit(page, "Enviar link");
    await page.getByRole("button", { name: "Enviando…" }).waitFor();
    await settle(page);
  },
  forgotSent: async (page: Page) => {
    await openForgot(page);
    await page.route("**/api/auth/request-password-reset", ok);
    await emailField(page).fill(EMAIL);
    await submit(page, "Enviar link");
    await page
      .getByText("Se esse e-mail tiver conta, enviamos um link. Veja o spam.")
      .waitFor();
    await settle(page);
  },
  reset: async (page: Page) => {
    await openReset(page);
    await settle(page);
  },
  resetBlocked: async (page: Page) => {
    await openReset(page, "blocked");
    await page
      .getByText(
        "Não deu para carregar a confirmação. Libere este site no bloqueador de anúncios e abra o link de novo."
      )
      .waitFor();
    await settle(page);
  },
  resetChallengeFailed: async (page: Page) => {
    await openReset(page, "failed");
    await newPasswordField(page).fill(PASSWORD);
    await submit(page, "Trocar senha");
    await page
      .getByText(
        "Não foi possível confirmar que você é uma pessoa. Tente de novo."
      )
      .waitFor();
    await settle(page);
  },
  resetChanging: async (page: Page) => {
    await openReset(page);
    await page.route("**/api/auth/reset-password", hold);
    await newPasswordField(page).fill(PASSWORD);
    await submit(page, "Trocar senha");
    await page.getByRole("button", { name: "Trocando…" }).waitFor();
    await settle(page);
  },
  resetDone: async (page: Page) => {
    await openReset(page);
    await page.route("**/api/auth/reset-password", ok);
    await newPasswordField(page).fill(PASSWORD);
    await submit(page, "Trocar senha");
    await page.getByText("Senha trocada. Entre com a nova senha.").waitFor();
    await settle(page);
  },
  resetLinkExpired: async (page: Page) => {
    await openReset(page);
    await page.route("**/api/auth/reset-password", (route) =>
      route.fulfill(json(400, { code: "INVALID_TOKEN" }))
    );
    await newPasswordField(page).fill(PASSWORD);
    await submit(page, "Trocar senha");
    await page
      .getByText("Este link venceu ou já foi usado. Peça outro.")
      .waitFor();
    await settle(page);
  },
  resetNoLink: async (page: Page) => {
    await openPath(page, "/redefinir-senha", "Nova senha");
    await page
      .getByText("Toque no link que enviamos por e-mail. Venceu? Peça outro.")
      .waitFor();
    await settle(page);
  },
  resetShort: async (page: Page) => {
    await openReset(page);
    await newPasswordField(page).fill(SHORT_PASSWORD);
    await submit(page, "Trocar senha");
    await page.getByText("Use pelo menos 15 caracteres.").waitFor();
    await settle(page);
  },
  unlockChecking: async (page: Page) => {
    await openUnlock(page, hold);
    await page.getByText("Liberando a entrada…").waitFor();
    await settle(page);
  },
  unlockDone: async (page: Page) => {
    await openUnlock(page, ok);
    await page.getByText("Entrada liberada. Você já pode entrar.").waitFor();
    await settle(page);
  },
  unlockInvalid: async (page: Page) => {
    await openUnlock(page, (route: Route) =>
      route.fulfill(json(400, { code: "INVALID_TOKEN" }))
    );
    await page
      .getByText(
        "Link vencido ou já usado. Espere a pausa acabar ou use Esqueci a senha."
      )
      .waitFor();
    await settle(page);
  },
  unlockNoLink: async (page: Page) => {
    await openUnlock(page, null, "");
    await page
      .getByText(
        "Toque no link que enviamos por e-mail ou espere a pausa acabar."
      )
      .waitFor();
    await settle(page);
  },
  unlockUnavailable: async (page: Page) => {
    await openUnlock(page, (route: Route) =>
      route.fulfill(json(503, { code: "unavailable" }))
    );
    await page
      .getByText("Não conseguimos agora. Tente de novo em instantes.")
      .waitFor();
    await settle(page);
  },
};
