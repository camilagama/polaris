import { describe, expect, it } from "vitest";

// every export at once, to scan all of the lines
const texts = await import("./password-texts");

const TECHNICAL =
  /\b(40[0-9]|429|50[0-9])\b|auth_|password_|_required|_failed|rate_limited|UNAUTHORIZED|INVALID|token|turnstile|HIBP|\bHTTP\b|erro=/i;
const TOUCH_OR_PAUSED = /toque|Pausamos/;
const RELOAD = /recarregue/i;
const ACCOUNT_LOCKED = /conta (foi )?bloqueada|bloqueamos/i;

const everyText = (): string[] => [
  ...(Object.values(texts) as unknown[]).filter(
    (value): value is string => typeof value === "string"
  ),
  texts.pausedText(1),
  texts.pausedText(15),
  texts.changePausedText(1),
  texts.changePausedText(15),
  texts.confirmSentText(null),
  texts.confirmSentText("quem@exemplo.com"),
  ...(
    [
      "blocked",
      "challenge",
      "hibp_unavailable",
      "limit",
      "unavailable",
    ] as const
  ).flatMap((failure) =>
    (["email", "other", "reset", "sign-in", "sign-up"] as const).map((form) =>
      texts.failureText(failure, form)
    )
  ),
  ...(
    ["compromised", "invalid_characters", "too_long", "too_short"] as const
  ).map(texts.newPasswordText),
];

describe("the password screen texts", () => {
  it("never show a status, a code or a technical word (AC-76)", () => {
    for (const text of everyText()) {
      expect(text).not.toMatch(TECHNICAL);
    }
  });

  it("say the lock in the same words whether the e-mail has an account or not, never that the account is 'blocked' (V4, v5.2)", () => {
    expect(texts.pausedText(14)).toBe(
      "Muitas tentativas. Espere 14 minutos ou use Esqueci a senha. Se este e-mail tem conta, enviamos um link para liberar agora."
    );
    expect(texts.pausedText(1)).toContain("1 minuto ");
    for (const text of everyText()) {
      expect(text).not.toMatch(ACCOUNT_LOCKED);
    }
  });

  it("tell 'Trocar senha' what to do with the screen it has: no 'Esqueci a senha' to touch, no 'entrada' (P3)", () => {
    expect(texts.changePausedText(15)).toBe(
      "Muitas tentativas com a senha atual. Espere 15 minutos e tente de novo. Se não lembra a senha atual, saia e use Esqueci a senha na tela de entrada."
    );
    expect(texts.changePausedText(1)).toContain("Espere 1 minuto e");
    expect(texts.changePausedText(15)).not.toMatch(TOUCH_OR_PAUSED);
  });

  it("never tell /redefinir-senha to reload: the link lives in memory and a reload loses it (P2)", () => {
    expect(texts.failureText("blocked", "reset")).toBe(
      texts.CHALLENGE_BLOCKED_LINK
    );
    expect(texts.CHALLENGE_BLOCKED_LINK).toContain("abra de novo o link");
    expect(texts.CHALLENGE_BLOCKED_LINK).not.toMatch(RELOAD);
    expect(texts.failureText("blocked", "sign-in")).toContain("Recarregue");
    expect(texts.failureText("blocked", "sign-up")).toBe(
      texts.CHALLENGE_BLOCKED_SHORT
    );
    expect(texts.failureText("blocked", "email")).toBe(texts.CHALLENGE_BLOCKED);
  });

  it("neither the intro nor the resend promise a link or a send the server cannot know (P4)", () => {
    expect(texts.confirmSentText("quem@exemplo.com")).toBe(
      "Enviamos um e-mail para quem@exemplo.com. Siga as instruções nele."
    );
    expect(texts.RESENT_TYPED).toBe(
      "Se esse e-mail precisar de confirmação, enviamos outro. Olhe também o spam."
    );
    expect(texts.RESENT).toBe("Reenviamos. Olhe também o spam.");
  });

  it("name the toggle by what it does to the field, short on the button and whole for the reader (P5)", () => {
    expect(texts.SHOW_PASSWORD).toBe("Mostrar");
    expect(texts.HIDE_PASSWORD).toBe("Ocultar");
    expect(texts.SHOW_PASSWORD_LABEL).toBe("Mostrar senha");
    expect(texts.HIDE_PASSWORD_LABEL).toBe("Ocultar senha");
  });

  it("say the size rule before typing, with the numbers the server applies (AC-47)", () => {
    expect(texts.PASSWORD_RULE).toContain("15 caracteres");
    expect(texts.SIGN_UP_PASSWORD_RULE).toBe(
      "No mínimo 15 caracteres. Vale frase com espaços. Senha que já vazou não serve."
    );
    expect(texts.PASSWORD_TOO_LONG).toContain("128");
  });

  it("show the address only when it is in memory, and 'o seu e-mail' otherwise", () => {
    expect(texts.confirmSentText(null)).toContain("o seu e-mail");
    expect(texts.confirmSentText("quem@exemplo.com")).toContain(
      "quem@exemplo.com"
    );
  });

  it("say 'e-mails demais' only on the forms that send an e-mail", () => {
    expect(texts.failureText("limit", "email")).toBe(texts.TOO_MANY_EMAILS);
    expect(texts.failureText("limit", "sign-up")).toBe(texts.TOO_MANY_EMAILS);
    expect(texts.failureText("limit", "sign-in")).toBe(texts.TOO_MANY_TRIES);
  });
});
