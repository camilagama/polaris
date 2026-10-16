import { describe, expect, it } from "vitest";
import {
  InvalidPublicCatalogProfileError,
  MAX_PUBLIC_DESCRIPTION_LENGTH,
  normalizePublicProfile,
  normalizeSlug,
  type PublicProfileInput,
  RESERVED_SLUGS,
} from "./public-catalog";

const input = (
  overrides: Partial<PublicProfileInput> = {}
): PublicProfileInput => ({
  publicName: "Loja da Ana",
  slug: "loja-da-ana",
  ...overrides,
});

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(InvalidPublicCatalogProfileError);
    return (error as InvalidPublicCatalogProfileError).code;
  }
  throw new Error("expected a refusal");
};

describe("the public address", () => {
  it("is lowercase letters, digits and single hyphens, 3 to 40 characters", () => {
    expect(normalizeSlug("  Loja-da-Ana ")).toBe("loja-da-ana");
    expect(normalizeSlug("a1b")).toBe("a1b");
    for (const bad of [
      "ab",
      "x".repeat(41),
      "-loja",
      "loja-",
      "loja--ana",
      "loja_ana",
      "loja ana",
      "lojá",
      "loja/ana",
      "",
    ]) {
      expect(refusal(() => normalizeSlug(bad))).toBe("invalid_slug");
    }
  });

  it("never takes a name the catalog needs for itself", () => {
    for (const reserved of RESERVED_SLUGS.filter((name) => name.length >= 3)) {
      expect(refusal(() => normalizeSlug(reserved))).toBe("reserved_slug");
      expect(refusal(() => normalizeSlug(reserved.toUpperCase()))).toBe(
        "reserved_slug"
      );
    }
  });
});

describe("the public profile", () => {
  it("keeps only what was typed: a name, an address and optional contacts", () => {
    expect(normalizePublicProfile(input())).toEqual({
      description: null,
      instagram: null,
      publicName: "Loja da Ana",
      slug: "loja-da-ana",
      whatsapp: null,
    });
    expect(
      normalizePublicProfile(
        input({
          description: "  Roupas feitas à mão  ",
          instagram: "@Loja.Da_Ana",
          whatsapp: "+55 (11) 91234-5678",
        })
      )
    ).toEqual({
      description: "Roupas feitas à mão",
      instagram: "loja.da_ana",
      publicName: "Loja da Ana",
      slug: "loja-da-ana",
      whatsapp: "5511912345678",
    });
  });

  it("treats a blank optional field as not published", () => {
    expect(
      normalizePublicProfile(
        input({ description: "  ", instagram: " ", whatsapp: "" })
      )
    ).toMatchObject({ description: null, instagram: null, whatsapp: null });
  });

  it("refuses an empty or long name and description, and malformed contacts", () => {
    expect(
      refusal(() => normalizePublicProfile(input({ publicName: "  " })))
    ).toBe("invalid_name");
    expect(
      refusal(() =>
        normalizePublicProfile(input({ publicName: "x".repeat(81) }))
      )
    ).toBe("invalid_name");
    expect(
      refusal(() =>
        normalizePublicProfile(
          input({ description: "x".repeat(MAX_PUBLIC_DESCRIPTION_LENGTH + 1) })
        )
      )
    ).toBe("invalid_description");
    for (const whatsapp of ["123", "abc", "5511".padEnd(16, "9")]) {
      expect(refusal(() => normalizePublicProfile(input({ whatsapp })))).toBe(
        "invalid_whatsapp"
      );
    }
    for (const instagram of ["a b", "loja!", "x".repeat(31)]) {
      expect(refusal(() => normalizePublicProfile(input({ instagram })))).toBe(
        "invalid_instagram"
      );
    }
  });

  it("refuses text that hides what it shows", () => {
    for (const hidden of [
      "a\u0000b",
      "a\u200bb",
      "a\u202eb",
      "a\u0007b",
      "a\ufeffb",
    ]) {
      expect(
        refusal(() => normalizePublicProfile(input({ publicName: hidden })))
      ).toBe("invalid_name");
      expect(
        refusal(() => normalizePublicProfile(input({ description: hidden })))
      ).toBe("invalid_description");
    }
    expect(
      refusal(() => normalizePublicProfile(input({ publicName: "a\nb" })))
    ).toBe("invalid_name");
    expect(
      normalizePublicProfile(input({ description: "linha um\nlinha dois" }))
        .description
    ).toBe("linha um\nlinha dois");
  });

  it("counts characters, not bytes, for the length of a description", () => {
    const description = "é".repeat(MAX_PUBLIC_DESCRIPTION_LENGTH);
    expect(normalizePublicProfile(input({ description })).description).toBe(
      description
    );
  });
});
