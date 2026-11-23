import { describe, expect, it } from "vitest";
import { SCREEN_TABS } from "../app-shell/navigation-model";
import { accountTabsShown, settingsTabsShown } from "./settings-tabs";

const NONE = { billing: false, dataExport: false };

describe("the tabs of Configurações da loja a person has", () => {
  it("always has Formas de receber and Catálogo público, and the others by condition", () => {
    expect(settingsTabsShown(NONE)).toEqual({
      assinatura: false,
      "catalogo-publico": true,
      "formas-de-receber": true,
      "seus-dados": false,
    });
    expect(settingsTabsShown({ billing: true, dataExport: true })).toEqual({
      assinatura: true,
      "catalogo-publico": true,
      "formas-de-receber": true,
      "seus-dados": true,
    });
  });

  it("shows Seus dados only with organization:export, last in the tab list", () => {
    expect(settingsTabsShown({ ...NONE, dataExport: true })).toMatchObject({
      "seus-dados": true,
    });
    expect(SCREEN_TABS.settings.at(-1)).toEqual({
      label: "Seus dados",
      route: "data-export",
      value: "seus-dados",
    });
  });

  it("has the four tabs of the store, in order, and neither Senha nor Aparelhos", () => {
    expect(SCREEN_TABS.settings.map((tab) => tab.value)).toEqual([
      "formas-de-receber",
      "catalogo-publico",
      "assinatura",
      "seus-dados",
    ]);
  });
});

describe("the tabs of Minha conta a person has", () => {
  it("has Senha with the password on and Aparelhos with the offline runtime, each alone or both", () => {
    expect(accountTabsShown({ offline: false, passwordOn: false })).toEqual({
      aparelhos: false,
      senha: false,
    });
    expect(accountTabsShown({ offline: false, passwordOn: true })).toEqual({
      aparelhos: false,
      senha: true,
    });
    expect(accountTabsShown({ offline: true, passwordOn: false })).toEqual({
      aparelhos: true,
      senha: false,
    });
    expect(accountTabsShown({ offline: true, passwordOn: true })).toEqual({
      aparelhos: true,
      senha: true,
    });
  });

  it("lists Senha first, then Aparelhos, and together with Configurações they are the six tabs of before", () => {
    expect(SCREEN_TABS.account.map((tab) => tab.value)).toEqual([
      "senha",
      "aparelhos",
    ]);
    expect(
      [...SCREEN_TABS.settings, ...SCREEN_TABS.account]
        .map((tab) => tab.value)
        .sort()
    ).toEqual(
      [
        "aparelhos",
        "assinatura",
        "catalogo-publico",
        "formas-de-receber",
        "senha",
        "seus-dados",
      ].sort()
    );
  });
});
