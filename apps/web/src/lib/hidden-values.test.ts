import { describe, expect, it } from "vitest";
import {
  maskMoney,
  moneyParts,
  readHiddenValues,
  saveHiddenValues,
} from "./hidden-values";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("readHiddenValues / saveHiddenValues", () => {
  it("reads true only for polaris-valores = escondidos", () => {
    expect(
      readHiddenValues(fakeStorage({ "polaris-valores": "escondidos" }))
    ).toBe(true);
    expect(readHiddenValues(fakeStorage())).toBe(false);
    expect(readHiddenValues(fakeStorage({ "polaris-valores": "sim" }))).toBe(
      false
    );
    expect(readHiddenValues(fakeStorage({ outra: "escondidos" }))).toBe(false);
    expect(readHiddenValues(undefined)).toBe(false);
  });

  it("reads false, without throwing, from a storage that refuses", () => {
    expect(readHiddenValues(throwing)).toBe(false);
  });

  it("saves the choice and reads it back", () => {
    const storage = fakeStorage();
    saveHiddenValues(storage, true);
    expect(storage.data.get("polaris-valores")).toBe("escondidos");
    expect(readHiddenValues(storage)).toBe(true);
  });

  it("removes the key when saving false", () => {
    const storage = fakeStorage({ "polaris-valores": "escondidos" });
    saveHiddenValues(storage, false);
    expect(storage.data.has("polaris-valores")).toBe(false);
    expect(readHiddenValues(storage)).toBe(false);
  });

  it("does not throw when the storage refuses to save", () => {
    expect(() => saveHiddenValues(throwing, true)).not.toThrow();
    expect(() => saveHiddenValues(throwing, false)).not.toThrow();
    expect(() => saveHiddenValues(undefined, true)).not.toThrow();
  });
});

describe("maskMoney", () => {
  it("replaces every amount with R$ ••••, sign included", () => {
    expect(maskMoney("R$ 1.234,56")).toBe("R$ ••••");
    expect(maskMoney("-R$ 12,00")).toBe("R$ ••••");
    expect(maskMoney("+R$ 436,86")).toBe("R$ ••••");
    expect(maskMoney("Melhor dia: 18/10, R$ 1.840,00 de 3 vendas")).toBe(
      "Melhor dia: 18/10, R$ •••• de 3 vendas"
    );
  });

  it("leaves percents and counts untouched", () => {
    expect(maskMoney("+52,9%")).toBe("+52,9%");
    expect(maskMoney("3 vendas")).toBe("3 vendas");
  });

  it("accepts a replacement", () => {
    expect(maskMoney("Total R$ 10,00", "valor escondido")).toBe(
      "Total valor escondido"
    );
  });
});

describe("moneyParts", () => {
  it("splits a text into plain and money parts", () => {
    expect(moneyParts("Melhor dia: 18/10, R$ 1.840,00")).toEqual([
      { money: false, text: "Melhor dia: 18/10, " },
      { money: true, text: "R$ 1.840,00" },
    ]);
  });

  it("keeps text after an amount and handles several amounts", () => {
    expect(moneyParts("R$ 1,00 e -R$ 2,00 hoje")).toEqual([
      { money: true, text: "R$ 1,00" },
      { money: false, text: " e " },
      { money: true, text: "-R$ 2,00" },
      { money: false, text: " hoje" },
    ]);
  });

  it("returns one plain part for a text without amounts, and none for an empty one", () => {
    expect(moneyParts("3 vendas")).toEqual([
      { money: false, text: "3 vendas" },
    ]);
    expect(moneyParts("")).toEqual([]);
  });
});
