import { describe, expect, it } from "vitest";
import { firstSettingsTab, settingsTabsShown } from "./settings-tabs";

const NONE = { billing: false, offline: false, passwordOn: false };

describe("the tabs of Configurações a person has", () => {
  it("always has Formas de receber and Catálogo público, and the others by condition", () => {
    expect(settingsTabsShown(NONE)).toEqual({
      aparelhos: false,
      assinatura: false,
      "catalogo-publico": true,
      "formas-de-receber": true,
      senha: false,
    });
    expect(
      settingsTabsShown({ billing: true, offline: true, passwordOn: true })
    ).toMatchObject({ aparelhos: true, assinatura: true, senha: true });
  });

  it("goes back to Formas de receber from Senha with the offline runtime off (Aparelhos is not in the menu)", () => {
    const tab = firstSettingsTab({ ...NONE, passwordOn: true });
    expect(tab.value).toBe("formas-de-receber");
  });
});
