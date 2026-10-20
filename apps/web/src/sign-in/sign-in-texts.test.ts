import { describe, expect, it } from "vitest";

// every export at once, to scan all of the lines (a namespace import would defeat tree shaking in the app)
const texts = await import("./sign-in-texts");
const SEVENTY_TWO = /72/;

const TECHNICAL =
  /\b(40[13]|429|50[023])\b|auth_|rate_limited|UNAUTHORIZED|idToken|OAuth|callback|token|erro=|\bHTTP\b/i;
const CLAIMS_TO_KEEP_TYPED_TEXT = /continuam? no formulário|não se perde/i;

const everyText = (): string[] =>
  (Object.values(texts) as unknown[]).filter(
    (value): value is string => typeof value === "string"
  );

describe("the sign-in texts", () => {
  it("never show a status, a code or a technical word to the shopkeeper", () => {
    for (const text of everyText()) {
      expect(text).not.toMatch(TECHNICAL);
    }
  });

  it("never promise that what was typed stays after signing in again (AC-22)", () => {
    for (const text of everyText()) {
      expect(text).not.toMatch(CLAIMS_TO_KEEP_TYPED_TEXT);
    }
  });

  it("never say 72 hours as if it were the session (AC-42)", () => {
    for (const text of everyText()) {
      expect(text).not.toMatch(SEVENTY_TWO);
    }
  });

  it("say the same thing for every Google failure (AC-5)", () => {
    expect(texts.errorText("google")).toBe(texts.GOOGLE_ERROR);
  });

  it("have a line for each state the address can carry, and none for what it cannot", () => {
    expect(texts.errorText("limite")).toBe(texts.SIGN_IN_LIMIT);
    expect(texts.errorText("indisponivel")).toBe(texts.SIGN_IN_UNAVAILABLE);
    expect(texts.errorText(undefined)).toBeNull();
    expect(texts.reasonText("sessao")).toBe(texts.SESSION_ENDED_REASON);
    expect(texts.reasonText("recente")).toBe(texts.RECENT_LOGIN_REASON);
    expect(texts.reasonText(undefined)).toBeNull();
  });

  it("tell a first-time visitor that the same button creates the account", () => {
    expect(texts.SIGN_IN_FIRST_TIME).toBe(
      "Primeira vez? É o mesmo botão: sua conta é criada ao continuar."
    );
  });
});
