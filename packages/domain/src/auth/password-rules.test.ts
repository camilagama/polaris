import { describe, expect, it } from "vitest";
import {
  hasSpecialCharacter,
  meetsPasswordRequirement,
  passwordCharacters,
  passwordStrength,
  unmetPasswordRequirements,
} from "./password-rules";

describe("password rules", () => {
  it("requires 8 characters, a number, an uppercase and a lowercase letter, in this order", () => {
    expect(unmetPasswordRequirements("")).toEqual([
      "length",
      "number",
      "uppercase",
      "lowercase",
    ]);
    expect(unmetPasswordRequirements("abcdefgh")).toEqual([
      "number",
      "uppercase",
    ]);
    expect(unmetPasswordRequirements("Abcdefg1")).toEqual([]);
  });

  it("counts the code points of the NFC form", () => {
    expect(passwordCharacters("é")).toBe(1);
    expect(passwordCharacters("😀")).toBe(1);
    expect(meetsPasswordRequirement("Abcde1é", "length")).toBe(false);
    expect(meetsPasswordRequirement("Abcdef1é", "length")).toBe(true);
  });

  it("takes accented letters as letters of their case", () => {
    expect(unmetPasswordRequirements("ção2026É")).toEqual([]);
    expect(meetsPasswordRequirement("É", "uppercase")).toBe(true);
    expect(meetsPasswordRequirement("é", "lowercase")).toBe(true);
  });

  it("takes a special character as a hint only", () => {
    expect(hasSpecialCharacter("Abcdefg1")).toBe(false);
    expect(hasSpecialCharacter("Abcdef g1")).toBe(true);
    expect(hasSpecialCharacter("Abcdef!1")).toBe(true);
    expect(unmetPasswordRequirements("abcdefgh!")).not.toContain("special");
  });

  it("measures 0 empty, 1 and 2 weak, 3 with every rule, 4 with a special character as well", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("a")).toBe(1);
    expect(passwordStrength("aB")).toBe(2);
    expect(passwordStrength("abcdefgh1")).toBe(2);
    expect(passwordStrength("Abcdefg1")).toBe(3);
    expect(passwordStrength("Abcdef!1")).toBe(4);
  });
});
