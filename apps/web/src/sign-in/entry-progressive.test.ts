import { describe, expect, it } from "vitest";
import {
  emailEnter,
  isCompleteEmail,
  openAfterEmail,
  openAfterPassword,
} from "./entry-progressive";

describe("the password that shows after the e-mail", () => {
  it("opens only with a complete address, whatever account it is", () => {
    expect(openAfterEmail(false, "ana@loja")).toBe(false);
    expect(openAfterEmail(false, "ana@loja.c")).toBe(false);
    expect(openAfterEmail(false, "ana@loja.com")).toBe(true);
    expect(openAfterEmail(false, "  ana@loja.com.br ")).toBe(true);
    expect(openAfterEmail(false, "ana loja@x.com")).toBe(false);
  });

  it("stays open while the address is being corrected, and closes only when the field is empty", () => {
    expect(openAfterEmail(true, "ana@loja")).toBe(true);
    expect(openAfterEmail(true, "a")).toBe(true);
    expect(openAfterEmail(true, "")).toBe(false);
    expect(openAfterEmail(true, "   ")).toBe(false);
  });

  it("opens when a password arrives (a manager filled both fields)", () => {
    expect(openAfterPassword(false, "")).toBe(false);
    expect(openAfterPassword(false, "x")).toBe(true);
    expect(openAfterPassword(true, "")).toBe(true);
  });

  it("answers Enter in the e-mail: the password for a complete address, the local error otherwise", () => {
    expect(emailEnter("ana@loja.com")).toBe("focus-password");
    expect(emailEnter("ana@loja")).toBe("incomplete");
    expect(emailEnter("")).toBe("incomplete");
  });

  it("looks at the shape only", () => {
    expect(isCompleteEmail("quem@exemplo.com")).toBe(true);
    expect(isCompleteEmail("quem@@exemplo.com")).toBe(false);
  });
});
