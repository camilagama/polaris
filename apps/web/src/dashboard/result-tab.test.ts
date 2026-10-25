import { describe, expect, it } from "vitest";
import { addressWithTab, readResultTab } from "./result-tab";

describe("the tab an address opens (AC-13)", () => {
  it("is the Resultado tab with no parameter, and for anything that is not metas", () => {
    expect(readResultTab("")).toBe("resultado");
    expect(readResultTab("?aba=resultado")).toBe("resultado");
    expect(readResultTab("?aba=outra")).toBe("resultado");
    expect(readResultTab("?x=1")).toBe("resultado");
  });

  it("is the Metas tab for aba=metas", () => {
    expect(readResultTab("?aba=metas")).toBe("metas");
  });

  it("is the Metas tab for the two links of the Início, which win over aba", () => {
    expect(readResultTab("?meta=nova")).toBe("metas");
    expect(readResultTab("?meta=lista")).toBe("metas");
    expect(readResultTab("?aba=resultado&meta=nova")).toBe("metas");
    expect(readResultTab("?meta=lista&aba=resultado")).toBe("metas");
  });

  it("ignores a meta value that is not a link of the Início", () => {
    expect(readResultTab("?meta=outra")).toBe("resultado");
  });
});

describe("the address with the tab written in", () => {
  const base = "https://polaris.example/dashboard";

  it("adds aba=metas and keeps the rest", () => {
    expect(addressWithTab(`${base}?x=1#topo`, "metas")).toBe(
      "/dashboard?x=1&aba=metas#topo"
    );
    expect(addressWithTab(base, "metas")).toBe("/dashboard?aba=metas");
  });

  it("takes aba out for the Resultado tab, so the plain address is the Resultado", () => {
    expect(addressWithTab(`${base}?aba=metas`, "resultado")).toBe("/dashboard");
    expect(addressWithTab(`${base}?aba=metas&x=1`, "resultado")).toBe(
      "/dashboard?x=1"
    );
  });
});
