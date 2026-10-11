import { describe, expect, it } from "vitest";
import {
  InvalidCustomerDuplicateSearchError,
  InvalidCustomerProfileError,
  deriveCustomerLifecycle,
  normalizeCustomerDuplicateSearch,
  normalizeCustomerProfile,
  transitionCustomerLifecycle,
} from "./customer";

describe("normalizeCustomerProfile", () => {
  it("requires a name and at least one contact method", () => {
    expect(() =>
      normalizeCustomerProfile({ name: " Ana ", phone: "  " })
    ).toThrow(InvalidCustomerProfileError);
    expect(() =>
      normalizeCustomerProfile({ name: "  ", email: "ana@example.com" })
    ).toThrow(InvalidCustomerProfileError);
  });

  it("trims values, preserves phone/email spelling, and nulls blank optional notes", () => {
    expect(
      normalizeCustomerProfile({
        email: " Ana@Example.com ",
        name: " Ana Silva ",
        notes: "   ",
        phone: " +55 (11) 99999-0000 ",
      })
    ).toEqual({
      email: "Ana@Example.com",
      name: "Ana Silva",
      notes: null,
      phone: "+55 (11) 99999-0000",
    });
  });

  it("accepts either phone or email without requiring the other", () => {
    expect(
      normalizeCustomerProfile({ email: "ana@example.com", name: "Ana" })
    ).toMatchObject({ email: "ana@example.com", phone: null });
    expect(
      normalizeCustomerProfile({ name: "Ana", phone: "+5511999990000" })
    ).toMatchObject({ email: null, phone: "+5511999990000" });
  });
});

describe("normalizeCustomerDuplicateSearch", () => {
  it("trims search contacts without normalizing phone punctuation or email case", () => {
    expect(
      normalizeCustomerDuplicateSearch({
        email: " Ana@Example.com ",
        phone: " +55 (11) 99999-0000 ",
      })
    ).toEqual({
      email: "Ana@Example.com",
      phone: "+55 (11) 99999-0000",
    });
  });

  it("rejects a duplicate search without any usable contact", () => {
    expect(() =>
      normalizeCustomerDuplicateSearch({ email: "  ", phone: null })
    ).toThrow(InvalidCustomerDuplicateSearchError);
  });
});

describe("customer lifecycle", () => {
  it("derives active and archived states from archivedAt", () => {
    expect(deriveCustomerLifecycle(null)).toBe("active");
    expect(deriveCustomerLifecycle(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "archived"
    );
  });

  it("archives and restores reversibly, with same-state transitions idempotent", () => {
    const archivedAt = new Date("2026-10-10T12:00:00.000Z");
    expect(transitionCustomerLifecycle(null, "archive", archivedAt)).toEqual({
      archivedAt,
      changed: true,
      lifecycle: "archived",
    });
    expect(
      transitionCustomerLifecycle(archivedAt, "archive", new Date())
    ).toEqual({ archivedAt, changed: false, lifecycle: "archived" });
    expect(transitionCustomerLifecycle(archivedAt, "restore")).toEqual({
      archivedAt: null,
      changed: true,
      lifecycle: "active",
    });
  });
});
