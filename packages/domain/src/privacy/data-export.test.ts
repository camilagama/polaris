import { describe, expect, it } from "vitest";
import {
  EXPORT_VALIDITY_HOURS,
  exportExpiry,
  exportFileName,
  InvalidExportRequestError,
  isExportAvailable,
  normalizeExportFormats,
} from "./data-export";

const FILE_NAME_RULE =
  /^polaris-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}(-parte-[0-9]{3})?.zip$/;

describe("normalizeExportFormats", () => {
  it("keeps the canonical order whatever order was asked", () => {
    expect(normalizeExportFormats(["images", "json"])).toEqual([
      "json",
      "images",
    ]);
    expect(normalizeExportFormats(["csv", "images", "json"])).toEqual([
      "json",
      "csv",
      "images",
    ]);
  });

  it.each([
    [[]],
    [["pdf"]],
    [["json", "json"]],
    [["json", "csv", "images", "json"]],
    [[1]],
    ["json"],
    [null],
    [undefined],
    [{ length: 1 }],
  ])("refuses %j", (input) => {
    expect(() => normalizeExportFormats(input)).toThrow(
      InvalidExportRequestError
    );
  });
});

describe("export availability", () => {
  const readyAt = new Date("2026-10-01T12:00:00.000Z");

  it("expires the configured number of hours after it is ready", () => {
    expect(exportExpiry(readyAt).toISOString()).toBe(
      "2026-10-02T12:00:00.000Z"
    );
    expect(EXPORT_VALIDITY_HOURS).toBe(24);
  });

  it("is available only while ready and before it expires", () => {
    const expiresAt = exportExpiry(readyAt);
    expect(isExportAvailable("ready", expiresAt, readyAt)).toBe(true);
    expect(isExportAvailable("ready", expiresAt, expiresAt)).toBe(false);
    expect(isExportAvailable("ready", null, readyAt)).toBe(false);
    for (const status of ["requested", "running", "failed", "expired"]) {
      expect(isExportAvailable(status, expiresAt, readyAt)).toBe(false);
    }
  });
});

describe("exportFileName", () => {
  const at = new Date("2026-10-01T23:59:59.000Z");

  it("names files by date and part and never by organization", () => {
    expect(exportFileName("data", 1, at)).toBe("polaris-dados-2026-10-01.zip");
    expect(exportFileName("images", 2, at)).toBe(
      "polaris-imagens-2026-10-01-parte-002.zip"
    );
  });

  it("matches the database file-name rule", () => {
    expect(FILE_NAME_RULE.test(exportFileName("data", 1, at))).toBe(true);
    expect(FILE_NAME_RULE.test(exportFileName("images", 999, at))).toBe(true);
  });
});
