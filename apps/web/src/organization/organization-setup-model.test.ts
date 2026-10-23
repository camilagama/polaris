import { describe, expect, it } from "vitest";
import {
  BRASILIA_TIMEZONE,
  BRAZIL_TIMEZONES,
  defaultTimezone,
  firstInvalidField,
  initialTimezone,
  isValidTimezone,
  MAX_ORGANIZATION_NAME_LENGTH,
  setupErrorMessage,
  setupSessionEnded,
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

describe("the zones of the first access", () => {
  it("offers Brasília first and the other zones of Brazil by name", () => {
    expect(BRAZIL_TIMEZONES[0]).toEqual({
      id: BRASILIA_TIMEZONE,
      label: "Horário de Brasília (São Paulo)",
    });
    expect(BRAZIL_TIMEZONES.map((zone) => zone.id)).toEqual([
      "America/Sao_Paulo",
      "America/Manaus",
      "America/Cuiaba",
      "America/Rio_Branco",
      "America/Noronha",
    ]);
    // every one is a zone the server accepts
    for (const zone of BRAZIL_TIMEZONES) {
      expect(isValidTimezone(zone.id)).toBe(true);
    }
  });

  it("starts on the zone of the device when it is one of them, otherwise on Brasília", () => {
    expect(initialTimezone("America/Manaus")).toBe("America/Manaus");
    // the zones with the hour of one in the list stand for it
    expect(initialTimezone("America/Porto_Velho")).toBe("America/Manaus");
    expect(initialTimezone("America/Boa_Vista")).toBe("America/Manaus");
    expect(initialTimezone("America/Campo_Grande")).toBe("America/Cuiaba");
    expect(initialTimezone("America/Eirunepe")).toBe("America/Rio_Branco");
    // and the ones with the hour of Brasília are Brasília
    expect(initialTimezone("America/Recife")).toBe(BRASILIA_TIMEZONE);
    expect(initialTimezone("Europe/Lisbon")).toBe(BRASILIA_TIMEZONE);
    expect(initialTimezone("")).toBe(BRASILIA_TIMEZONE);
  });
});

describe("setupSessionEnded", () => {
  it("is the 401 and nothing else", () => {
    expect(setupSessionEnded({ code: "UNAUTHORIZED" })).toBe(true);
    expect(setupSessionEnded({ code: "FORBIDDEN" })).toBe(false);
    expect(setupSessionEnded(new TypeError("x"))).toBe(false);
  });
});
