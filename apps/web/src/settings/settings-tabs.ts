import { SCREEN_TABS, type ScreenTab } from "../app-shell/navigation-model";
import type { TabGroup } from "../app-shell/screen-tabs";

/** What decides which tabs of Configurações a person has. */
export interface SettingsTabConditions {
  /** `billing:manage` with the self-service on (AS-19). */
  billing: boolean;
  /** `organization:export`: asking for and downloading the copy of the store's data (ADR 0078). */
  dataExport: boolean;
  /** The offline runtime is built in. */
  offline: boolean;
  /** The server said the password is on; false while it has not said, or when it is off. */
  passwordOn: boolean;
}

/** Which tab of Configurações this person has: Formas de receber and Catálogo público always, the rest by condition. */
export function settingsTabsShown(
  conditions: SettingsTabConditions
): Record<string, boolean> {
  return {
    aparelhos: conditions.offline,
    assinatura: conditions.billing,
    "catalogo-publico": true,
    "formas-de-receber": true,
    senha: conditions.passwordOn,
    "seus-dados": conditions.dataExport,
  };
}

/** The first tab of Configurações this person has, in the order of the screen: where a way back from a tab goes. */
export function firstSettingsTab(conditions: SettingsTabConditions): ScreenTab {
  const shown = settingsTabsShown(conditions);
  return (
    SCREEN_TABS.settings.find((tab) => shown[tab.value]) ??
    (SCREEN_TABS.settings[0] as ScreenTab)
  );
}

/**
 * The rows of the tabs from 760 px: what belongs to the store, then what belongs to the account of the person. Together
 * they are the tabs of `SCREEN_TABS.settings`, in its order, and a row with no tab this person has is not drawn.
 */
export const SETTINGS_GROUPS: readonly TabGroup[] = [
  { label: "Da loja", values: ["formas-de-receber", "catalogo-publico"] },
  {
    label: "Da conta",
    values: ["aparelhos", "assinatura", "senha", "seus-dados"],
  },
];
