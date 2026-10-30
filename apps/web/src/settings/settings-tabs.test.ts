import { describe, expect, it } from "vitest";
import { SCREEN_TABS } from "../app-shell/navigation-model";
import { firstSettingsTab, settingsTabsShown } from "./settings-tabs";

const NONE = {
  billing: false,
  dataExport: false,
  offline: false,
  passwordOn: false,
};

describe("the tabs of Configurações a person has", () => {
  it("always has Formas de receber and Catálogo público, and the others by condition", () => {
    expect(settingsTabsShown(NONE)).toEqual({
      aparelhos: false,
      assinatura: false,
      "catalogo-publico": true,
      "formas-de-receber": true,
      senha: false,
      "seus-dados": false,
    });
    expect(
      settingsTabsShown({
        billing: true,
        dataExport: true,
        offline: true,
        passwordOn: true,
      })
    ).toMatchObject({
      aparelhos: true,
      assinatura: true,
      senha: true,
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

  it("goes back to Formas de receber from Senha with the offline runtime off (Aparelhos is not in the menu)", () => {
    const tab = firstSettingsTab({ ...NONE, passwordOn: true });
    expect(tab.value).toBe("formas-de-receber");
  });
});
