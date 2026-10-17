import { describe, expect, it } from "vitest";
import {
  ANONYMIZED_CUSTOMER_NAME,
  anonymizedCustomerProfile,
  CustomerAnonymizedError,
  deriveCustomerLifecycle,
  hasAnonymizedShape,
  InvalidCustomerDuplicateSearchError,
  InvalidCustomerProfileError,
  isCustomerAnonymized,
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
      normalizeCustomerProfile({ email: "ana@example.com", name: "  " })
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

describe("customer text limits", () => {
  const valid = { email: "a@example.com", name: "Ana" };

  it("accepts the limits and refuses one character beyond them", () => {
    expect(() =>
      normalizeCustomerProfile({ ...valid, name: "n".repeat(200) })
    ).not.toThrow();
    expect(() =>
      normalizeCustomerProfile({ ...valid, name: "n".repeat(201) })
    ).toThrow(InvalidCustomerProfileError);
    expect(() =>
      normalizeCustomerProfile({ ...valid, phone: "1".repeat(41) })
    ).toThrow(InvalidCustomerProfileError);
    expect(() =>
      normalizeCustomerProfile({ ...valid, email: `${"e".repeat(250)}@x.co` })
    ).toThrow(InvalidCustomerProfileError);
    expect(() =>
      normalizeCustomerProfile({ ...valid, notes: "n".repeat(2001) })
    ).toThrow(InvalidCustomerProfileError);
    expect(() =>
      normalizeCustomerDuplicateSearch({ phone: "1".repeat(41) })
    ).toThrow(InvalidCustomerDuplicateSearchError);
  });
});

describe("anonymizing a customer for privacy", () => {
  it("replaces everything about the person with a fixed text and nothing else", () => {
    expect(anonymizedCustomerProfile()).toEqual({
      email: null,
      name: ANONYMIZED_CUSTOMER_NAME,
      notes: null,
      phone: null,
    });
    expect(ANONYMIZED_CUSTOMER_NAME).toBe("Cliente anonimizado");
  });

  it("is recognized by the moment it happened", () => {
    expect(isCustomerAnonymized(null)).toBe(false);
    expect(isCustomerAnonymized(new Date("2026-10-17T12:00:00.000Z"))).toBe(
      true
    );
  });

  it("has a refusal with a stable code for edits and restores", () => {
    const error = new CustomerAnonymizedError();
    expect(error.code).toBe("customer_anonymized");
    expect(error.message).toBe("customer_anonymized");
  });
});

describe("recognizing an anonymized record without its mark", () => {
  it("is the shape only an anonymized customer can have: no phone and no e-mail", () => {
    expect(hasAnonymizedShape({ email: null, phone: null })).toBe(true);
    expect(hasAnonymizedShape({ email: "a@b.co", phone: null })).toBe(false);
    expect(
      hasAnonymizedShape({ email: null, phone: "+55 11 90000-0000" })
    ).toBe(false);
    // an ordinary customer always has a contact, so the shape never mistakes one for an anonymized one
    expect(() => normalizeCustomerProfile({ name: "Ana" })).toThrow(
      InvalidCustomerProfileError
    );
  });
});
