import { unmetPasswordRequirements } from "@polaris/domain/auth/password-rules";
import { describe, expect, it } from "vitest";
import {
  normalizePassword,
  PasswordPolicyError,
  passwordPolicyErrorDetails,
  validateNewPassword,
} from "./password-policy";

const BREACH = /breach/i;

function refusal(password: string): string | null {
  try {
    validateNewPassword(password);
    return null;
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      return error.code;
    }
    throw error;
  }
}

describe("password policy", () => {
  it("normalizes NFC and counts code points: 7 letters and a decomposed accent make 8", () => {
    const decomposed = "Abcdef1é";
    expect(validateNewPassword(decomposed)).toBe("Abcdef1é");
    expect(refusal("Abcde1é")).toBe("password_too_short");
  });

  it("refuses with one error per rule, the first missing in the order of the screen", () => {
    expect(refusal("")).toBe("password_too_short");
    expect(refusal("Abc1")).toBe("password_too_short");
    expect(refusal("Abcdefgh")).toBe("password_missing_number");
    expect(refusal("abcdefg1")).toBe("password_missing_uppercase");
    expect(refusal("ABCDEFG1")).toBe("password_missing_lowercase");
    expect(refusal("Abcdefg1")).toBeNull();
  });

  it("accepts a special character but never requires one, and counts accented letters as letters", () => {
    expect(refusal("Abcdef1!")).toBeNull();
    expect(refusal("Ação2026")).toBeNull();
    expect(refusal("ÉÇÃO2026ñ")).toBeNull();
  });

  it("refuses more than 128 code points", () => {
    expect(refusal(`Aa1${"x".repeat(125)}`)).toBeNull();
    expect(refusal(`Aa1${"x".repeat(126)}`)).toBe("password_too_long");
  });

  it("is the same rule as the screen's: refused here exactly when the domain lists a rule missing", () => {
    for (const password of [
      "",
      "a",
      "Abcdefgh",
      "abcdefg1",
      "ABCDEFG1",
      "Abcdefg1",
      "Senha forte 2026!",
      "１２３４ＡＢｃｄ",
      "Ação2026",
    ]) {
      expect(refusal(password) !== null, password).toBe(
        unmetPasswordRequirements(password).length > 0
      );
    }
  });

  it("answers every refusal with 400 and never mentions a breach", () => {
    for (const code of [
      "password_invalid_unicode",
      "password_missing_lowercase",
      "password_missing_number",
      "password_missing_uppercase",
      "password_too_long",
      "password_too_short",
    ] as const) {
      const details = passwordPolicyErrorDetails(new PasswordPolicyError(code));
      expect(details.status).toBe(400);
      expect(details.message).not.toMatch(BREACH);
    }
  });

  it("refuses unpaired surrogates", () => {
    expect(() => normalizePassword("Abcdefg1\ud800")).toThrow(
      PasswordPolicyError
    );
    expect(refusal("Abcdefg1\udc00")).toBe("password_invalid_unicode");
  });
});
