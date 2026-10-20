import { describe, expect, it } from "vitest";

// every export at once, to scan all of the lines
const texts = await import("./password-texts");

const TECHNICAL =
  /\b(40[0-9]|429|50[0-9])\b|auth_|password_|_required|_failed|rate_limited|UNAUTHORIZED|INVALID|token|turnstile|HIBP|\bHTTP\b|erro=/i;
const ACCOUNT_LOCKED = /conta (foi )?bloqueada|bloqueamos/i;

const everyText = (): string[] => [
  ...(Object.values(texts) as unknown[]).filter(
    (value): value is string => typeof value === "string"
  ),
  texts.pausedText(1),
  texts.pausedText(15),
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
    (["email", "other", "sign-in"] as const).map((form) =>
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

  it("say the lock as the unlock e-mail does: the entry is paused, the account is not 'blocked' (V4)", () => {
    expect(texts.pausedText(15)).toContain("Pausamos a entrada");
    expect(texts.pausedText(15)).toContain("15 minutos");
    expect(texts.pausedText(1)).toContain("1 minuto ");
    for (const text of everyText()) {
      expect(text).not.toMatch(ACCOUNT_LOCKED);
    }
  });

  it("say the size rule before typing, with the numbers the server applies (AC-47)", () => {
    expect(texts.PASSWORD_RULE).toContain("15 caracteres");
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
    expect(texts.failureText("limit", "sign-in")).toBe(texts.TOO_MANY_TRIES);
  });
});
