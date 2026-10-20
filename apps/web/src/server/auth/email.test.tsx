import { render } from "react-email";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEmailDelivery } from "../auth";
import { createResendAuthEmailDelivery } from "./email";
import {
  EmailVerificationEmail,
  LoginUnlockEmail,
  PasswordResetEmail,
} from "./emails";
import { LOGIN_LOCK_MINUTES } from "./login-lock";

const apiKey = "re_test_api_key";
const from = "Polaris <auth@example.invalid>";
const recipient = "person@example.invalid";
const appBaseURL = "https://polaris.example.invalid";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const urlPattern = /https?:\/\/\S+/g;
// "email" as a word of the text; "e-mail" and the paths of the links ("confirmar-email") do not count.
const emailWithoutHyphen = /(?<![-\w])email(?![-\w])/i;

function wordsWithoutLinks(text: string): string {
  return text.replace(urlPattern, "");
}

function testUser(): Parameters<
  AuthEmailDelivery["sendVerificationEmail"]
>[0]["user"] {
  return {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    email: recipient,
    emailVerified: false,
    id: "user-test-id",
    image: null,
    name: "Polaris Test User",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("Resend authentication email delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends minimal verification email with a token-derived idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });
    const token = "verification-secret-token";
    const url = `https://polaris.example.invalid/api/auth/verify-email?token=${token}`;

    await delivery.sendVerificationEmail(
      { token, url, user: testUser() },
      new Request("https://polaris.example.invalid/api/auth/sign-up/email")
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      from: string;
      html: string;
      subject: string;
      text: string;
      to: string[];
    };

    expect(String(target)).toBe("https://api.resend.com/emails");
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("idempotency-key")).toBe(
      `polaris-verification-${await sha256Hex(token)}`
    );
    expect(headers.get("idempotency-key")).not.toContain(token);
    expect(body.from).toBe(from);
    expect(body.to).toEqual([recipient]);
    expect(body.subject).toBe("Confirme seu e-mail do Polaris");
    // the link is a page of the app with the token in the fragment, never the Worker route Better Auth built
    const appLink = `${appBaseURL}/confirmar-email#token=${token}`;
    expect(body.html).toContain(appLink);
    expect(body.text).toContain(appLink);
    expect(body.html).not.toContain(url);
    expect(body.text).not.toContain("verify-email");
    expect(body.html).toContain("Confirme seu e-mail");
    expect(body.text).toContain("Confirmar e-mail");
    expect(body.text).not.toContain("Verificar");
    expect(wordsWithoutLinks(body.text)).not.toMatch(emailWithoutHyphen);
  });

  it("sends password reset with a separate idempotency namespace", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });
    const token = "reset-secret-token";
    const url = `https://polaris.example.invalid/api/auth/reset-password/${token}`;

    await delivery.sendPasswordReset(
      { token, url, user: testUser() },
      new Request(
        "https://polaris.example.invalid/api/auth/request-password-reset"
      )
    );

    const [target, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      html: string;
      subject: string;
      text: string;
    };

    expect(String(target)).toBe("https://api.resend.com/emails");
    expect(headers.get("idempotency-key")).toBe(
      `polaris-password-reset-${await sha256Hex(token)}`
    );
    expect(body.subject).toBe("Redefina sua senha do Polaris");
    const appLink = `${appBaseURL}/redefinir-senha#token=${token}`;
    expect(body.html).toContain(appLink);
    expect(body.html).toContain("expira em 1 hora");
    expect(body.text).toContain(appLink);
    expect(body.text).not.toContain(url);
    expect(wordsWithoutLinks(body.text)).not.toMatch(emailWithoutHyphen);
  });

  it("keeps a generic response and log when the provider rejects a send", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(
      Response.json(
        { message: "provider detail containing sensitive account data" },
        { status: 403 }
      )
    );
    vi.stubGlobal("fetch", fetcher);
    const loggerSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });

    await expect(
      delivery.sendPasswordReset(
        {
          token: "reset-secret-token",
          url: "https://polaris.example.invalid/reset-password/reset-secret-token",
          user: testUser(),
        },
        new Request(
          "https://polaris.example.invalid/api/auth/request-password-reset"
        )
      )
    ).resolves.toBeUndefined();

    expect(loggerSpy.mock.calls).toEqual([
      [
        expect.objectContaining({
          errorClass: "Error",
          event: "auth_email_delivery_failed",
          kind: "password-reset",
        }),
      ],
    ]);
    expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain(
      "provider detail containing sensitive account data"
    );
  });

  it("sends the unlock link in the fragment, keyed by the token, never the token in the key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });
    const token = "user-1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    await delivery.sendLoginUnlock({ to: recipient, token });

    const [, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      html: string;
      subject: string;
      text: string;
      to: string[];
    };
    expect(headers.get("idempotency-key")).toBe(
      `polaris-unlock-${await sha256Hex(token)}`
    );
    expect(body.to).toEqual([recipient]);
    expect(body.subject).toBe("Pausamos a entrada na sua conta do Polaris");
    expect(body.text).toContain(`${appBaseURL}/desbloquear#token=${token}`);
    expect(body.text).toContain("1 hora");
    expect(body.text).toContain("“Esqueci a senha”");
    // the length of the pause is the constant of the lock, not a number written in the e-mail
    expect(body.text).toContain(`pausada por ${LOGIN_LOCK_MINUTES} minutos`);
    expect(body.text).toContain(`espere ${LOGIN_LOCK_MINUTES} minutos`);
    expect(body.html).not.toContain("<img");
  });

  it("sends the notice of a changed or an added password, once per event", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });

    await delivery.sendPasswordNotice({
      eventId: "user-1:req-1",
      kind: "changed",
      to: recipient,
    });
    await delivery.sendPasswordNotice({
      eventId: "user-1:req-2",
      kind: "set",
      to: recipient,
    });

    const sent = fetcher.mock.calls.map(([, init]) => ({
      body: JSON.parse(String(init?.body)) as { subject: string; text: string },
      key: new Headers(init?.headers).get("idempotency-key"),
    }));
    expect(sent.map(({ key }) => key)).toEqual([
      `polaris-password-changed-${await sha256Hex("user-1:req-1")}`,
      `polaris-password-set-${await sha256Hex("user-1:req-2")}`,
    ]);
    expect(sent[0]?.body.subject).toBe(
      "A senha da sua conta do Polaris foi trocada"
    );
    expect(sent[1]?.body.subject).toBe("Sua conta do Polaris agora tem senha");
    for (const { body } of sent) {
      expect(body.text).toContain(`${appBaseURL}/esqueci-a-senha`);
      expect(body.text).toContain("Pedir um link para redefinir a senha");
      expect(body.text).toContain(
        "Se não foi você, peça agora um link para redefinir a senha. Enviaremos o link para este e-mail."
      );
      expect(body.text).toContain(
        "Por segurança, os outros aparelhos saíram da sua conta e vão pedir a senha de novo."
      );
      expect(body.text).not.toContain("Redefinir a senha");
    }
  });

  it("tells an address that already has an account, at most once a day per user", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(Response.json({ id: "resend-email-id" }));
    vi.stubGlobal("fetch", fetcher);
    const delivery = createResendAuthEmailDelivery({
      apiKey,
      appBaseURL,
      from,
    });

    await delivery.sendExistingAccount?.({
      user: { email: recipient, id: "user-test-id" },
    });

    const [, init] = fetcher.mock.calls[0] ?? [];
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const day = new Date().toISOString().slice(0, 10);
    expect(key).toBe(
      `polaris-exists-${await sha256Hex("user-test-id")}-${day}`
    );
    const body = JSON.parse(String(init?.body)) as {
      subject: string;
      text: string;
    };
    expect(body.subject).toBe("Você já tem conta no Polaris");
    expect(body.text).toContain(`${appBaseURL}/entrar`);
    expect(body.text).toContain("“Continuar com o Google”");
    expect(body.text).toContain("“Esqueci a senha”");
  });
});

describe("the layout of the e-mails with a link token", () => {
  // tokens of the real size: a verification JWT, a reset token and an unlock token (`<user>.<32 bytes>`)
  const links = {
    unlock: `https://polaris.example.invalid/desbloquear#token=${"u".repeat(32)}.${"A".repeat(43)}`,
    verification: `https://polaris.example.invalid/confirmar-email#token=${"e".repeat(36)}.${"J".repeat(180)}.${"s".repeat(43)}`,
    reset: `https://polaris.example.invalid/redefinir-senha#token=${"r".repeat(24)}`,
  };

  it("breaks the fallback link anywhere and gives the button a 14 px padding, in the three e-mails", async () => {
    const html = await Promise.all([
      render(<EmailVerificationEmail url={links.verification} />),
      render(<PasswordResetEmail url={links.reset} />),
      render(<LoginUnlockEmail url={links.unlock} />),
    ]);
    for (const page of html) {
      expect(page).toMatch(
        /<p[^>]*overflow-wrap:anywhere[^>]*>Se o botão não funcionar/
      );
      expect(page).toContain("padding:14px 20px");
    }
  });
});
