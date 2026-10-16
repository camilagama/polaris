import type { PublicCatalogProfileReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  blankProfileDraft,
  draftFromProfile,
  hasProfileChanges,
  inBatches,
  profileRequest,
  publicUrl,
  slugFromName,
  visibilityOf,
} from "./public-catalog-model";

const profile: PublicCatalogProfileReadModel = {
  description: "Roupas feitas à mão",
  instagram: "loja.ana",
  publicName: "Loja da Ana",
  published: true,
  slug: "loja-da-ana",
  version: 4,
  whatsapp: "5511912345678",
};

describe("slugFromName", () => {
  it("makes an address from a name: lowercase, no accents, single hyphens", () => {
    expect(slugFromName("Ateliê da Maria & Filhas!")).toBe(
      "atelie-da-maria-filhas"
    );
    expect(slugFromName("  --Loja   Ana--  ")).toBe("loja-ana");
    expect(slugFromName("ÇÃO")).toBe("cao");
  });

  it("stops at the longest address and never ends on a hyphen", () => {
    const slug = slugFromName(`${"a".repeat(39)} bbbb`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("gives nothing for a name with no letters or digits", () => {
    expect(slugFromName("!!!")).toBe("");
  });
});

describe("publicUrl", () => {
  it("joins the origin and the address, and is null without an origin", () => {
    expect(publicUrl("https://catalogo.example/", "loja")).toBe(
      "https://catalogo.example/loja"
    );
    expect(publicUrl(null, "loja")).toBeNull();
  });
});

describe("the profile draft", () => {
  it("starts blank without a profile and mirrors a saved one", () => {
    expect(draftFromProfile(null)).toEqual(blankProfileDraft);
    expect(draftFromProfile(profile)).toEqual({
      description: "Roupas feitas à mão",
      instagram: "loja.ana",
      publicName: "Loja da Ana",
      slug: "loja-da-ana",
      whatsapp: "5511912345678",
    });
  });

  it("sends blanks as nothing, and the version only when editing", () => {
    expect(
      profileRequest(
        {
          description: "  ",
          instagram: "",
          publicName: " Loja ",
          slug: " LOJA-Ana ",
          whatsapp: " 11 91234-5678 ",
        },
        undefined
      )
    ).toEqual({
      description: null,
      instagram: null,
      publicName: "Loja",
      slug: "loja-ana",
      whatsapp: "11 91234-5678",
    });
    expect(profileRequest(draftFromProfile(profile), 4)).toMatchObject({
      expectedVersion: 4,
    });
  });

  it("notices a change and ignores whitespace and case of the address", () => {
    const saved = draftFromProfile(profile);
    expect(hasProfileChanges(saved, profile)).toBe(false);
    expect(
      hasProfileChanges({ ...saved, slug: " LOJA-DA-ANA " }, profile)
    ).toBe(false);
    expect(hasProfileChanges({ ...saved, publicName: "Outra" }, profile)).toBe(
      true
    );
    expect(hasProfileChanges(blankProfileDraft, null)).toBe(false);
    expect(hasProfileChanges({ ...blankProfileDraft, slug: "x" }, null)).toBe(
      true
    );
  });
});

describe("inBatches", () => {
  it("splits into calls of at most the size the server takes", () => {
    const ids = Array.from({ length: 450 }, (_, index) => String(index));
    expect(inBatches(ids).map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(inBatches([])).toEqual([]);
  });
});

describe("visibilityOf", () => {
  it("is live only with the switch on and the plan including the catalog", () => {
    expect(visibilityOf({ enabled: true, profile })).toBe("live");
    expect(visibilityOf({ enabled: false, profile })).toBe("waiting-plan");
    expect(
      visibilityOf({ enabled: true, profile: { ...profile, published: false } })
    ).toBe("off");
    expect(visibilityOf({ enabled: true, profile: null })).toBe("off");
  });
});
