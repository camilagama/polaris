import { useEffect, useState } from "react";
import { useAddress } from "../app-shell/address";
import { lazyScreen } from "../app-shell/lazy-screen";
import { requestedTab } from "../app-shell/navigation-model";
import { ScreenTabs, type TabPanel } from "../app-shell/screen-tabs";
import { canManageBilling } from "../lib/billing-access";
import { useCurrentOrganization } from "../lib/current-organization";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { loadAuthMethods } from "../sign-in/sign-in-model";

/** Each tab is its own chunk, as each screen was. */
const PANELS: Readonly<Record<string, TabPanel>> = {
  aparelhos: {
    Screen: lazyScreen(() =>
      import("../offline/runtime/devices-page").then((module) => ({
        default: module.DevicesPage,
      }))
    ),
    value: "aparelhos",
  },
  assinatura: {
    Screen: lazyScreen(() =>
      import("../subscription/subscription-page").then((module) => ({
        default: module.SubscriptionPage,
      }))
    ),
    value: "assinatura",
  },
  "catalogo-publico": {
    Screen: lazyScreen(() =>
      import("../catalog/public-catalog-page").then((module) => ({
        default: module.PublicCatalogPage,
      }))
    ),
    value: "catalogo-publico",
  },
  "formas-de-receber": {
    Screen: lazyScreen(() =>
      import("../payment-profiles/payment-profiles-page").then((module) => ({
        default: module.PaymentProfilesPage,
      }))
    ),
    value: "formas-de-receber",
  },
  senha: {
    Screen: lazyScreen(() =>
      import("../sign-in/change-password-page").then((module) => ({
        default: module.ChangePasswordPage,
      }))
    ),
    value: "senha",
  },
};

/** Whether the password is on (ADR 0100, AC-46); null while the server has not said. */
function usePasswordOn(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    loadAuthMethods()
      .then((methods) => {
        if (current) {
          setOn(methods?.emailPassword === true);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return on;
}

/**
 * Configurações (map of navigation, § 1): Formas de receber, Catálogo público, Aparelhos only with the offline runtime,
 * Assinatura only with `billing:manage` and the self-service on (AS-19), and Senha only with the password on. A tab
 * the address names is drawn even without its condition (an old link to `/subscription` or `/devices`): its screen
 * says itself what this person cannot do there, as it did as a page of its own. Senha is the exception once the
 * server said the password is off (its page would be a 404): the address opens the first tab.
 */
export function SettingsScreen() {
  const { billingSelfService, organization } = useCurrentOrganization();
  const passwordOn = usePasswordOn();
  const { search } = useAddress();
  const asked = requestedTab("settings", search).value;
  const shows: Record<string, boolean> = {
    aparelhos: OFFLINE_RUNTIME_ENABLED,
    assinatura: canManageBilling(billingSelfService, organization.role),
    "catalogo-publico": true,
    "formas-de-receber": true,
    senha: passwordOn === true,
  };
  const panels = Object.entries(PANELS)
    .filter(
      ([value]) =>
        shows[value] ||
        // Senha waits for the server to say whether the password is on; off, there is nothing to show there
        (value === asked && (value !== "senha" || passwordOn === null))
    )
    .map(([, panel]) => panel);
  return (
    <ScreenTabs
      label="Configurações"
      panels={panels}
      screen="settings"
      title="Configurações"
    />
  );
}
