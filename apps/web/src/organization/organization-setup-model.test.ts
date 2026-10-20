import { describe, expect, it } from "vitest";
import {
  defaultTimezone,
  firstInvalidField,
  isValidTimezone,
  MAX_ORGANIZATION_NAME_LENGTH,
  setupErrorMessage,
  validateSetup,
} from "./organization-setup-model";

describe("validateSetup", () => {
  it("accepts a trimmed name and an IANA zone", () => {
    expect(
      validateSetup({
        name: "  Loja Horizonte ",
        timezone: " America/Sao_Paulo ",
      })
    ).toEqual({
      errors: {},
      input: { name: "Loja Horizonte", timezone: "America/Sao_Paulo" },
    });
  });

  it("explains each invalid field and blocks the request", () => {
    const empty = validateSetup({ name: "   ", timezone: "" });
    expect(empty.input).toBeNull();
    expect(empty.errors.name).toContain("nome");
    expect(empty.errors.timezone).toContain("fuso");

    const tooLong = validateSetup({
      name: "x".repeat(MAX_ORGANIZATION_NAME_LENGTH + 1),
      timezone: "America/Sao_Paulo",
    });
    expect(tooLong.errors.name).toContain(`${MAX_ORGANIZATION_NAME_LENGTH}`);

    expect(
      validateSetup({ name: "Loja", timezone: "Marte/Olympus" }).errors.timezone
    ).toContain("desconhecido");
  });

  it("counts the name in code points", () => {
    expect(
      validateSetup({
        name: "😀".repeat(MAX_ORGANIZATION_NAME_LENGTH),
        timezone: "UTC",
      }).input
    ).not.toBeNull();
  });
});

describe("firstInvalidField", () => {
  it("focuses the name before the zone", () => {
    expect(firstInvalidField({ name: "a", timezone: "b" })).toBe("name");
    expect(firstInvalidField({ timezone: "b" })).toBe("timezone");
    expect(firstInvalidField({})).toBeNull();
  });
});

describe("time zones", () => {
  it("detects the device zone and validates identifiers", () => {
    expect(isValidTimezone(defaultTimezone())).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("setupErrorMessage", () => {
  it("maps the server's answers to actionable messages", () => {
    expect(setupErrorMessage({ code: "UNAUTHORIZED" })).toBe(
      "A organização não foi aberta."
    );
    expect(setupErrorMessage({ code: "FORBIDDEN" })).toContain("email");
    expect(setupErrorMessage({ code: "BAD_REQUEST" })).toContain("Revise");
    expect(setupErrorMessage({ code: "CONFLICT" })).toContain("suporte");
    expect(setupErrorMessage({ code: "SERVICE_UNAVAILABLE" })).toContain(
      "indisponível"
    );
    expect(setupErrorMessage(new TypeError("x"))).toContain("Tente novamente");
  });
});
