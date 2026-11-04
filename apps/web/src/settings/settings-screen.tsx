import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { useEffect, useState } from "react";
import { useAddress } from "../app-shell/address";
import { PageLoading } from "../app-shell/page-loading";
import { lazyScreen } from "../app-shell/lazy-screen";
import { requestedTab } from "../app-shell/navigation-model";
import { ScreenTabs, type TabPanel } from "../app-shell/screen-tabs";
import { canManageBilling } from "../lib/billing-access";
import { useCurrentOrganization } from "../lib/current-organization";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { loadAuthMethods } from "../sign-in/sign-in-model";
import { AppVersionLine } from "./app-version-line";
import { settingsTabsShown } from "./settings-tabs";

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
  "seus-dados": {
    Screen: lazyScreen(() =>
      import("../data-export/data-export-page").then((module) => ({
        default: module.DataExportPage,
      }))
    ),
    value: "seus-dados",
  },
};

/** The server's last answer in this page: a second visit to Configurações draws its tabs at once. */
let passwordOnAnswer: boolean | null = null;

/** Whether the password is on (ADR 0100, AC-46); null while the server has not said. */
function usePasswordOn(): boolean | null {
  const [on, setOn] = useState<boolean | null>(passwordOnAnswer);
  useEffect(() => {
    let current = true;
    loadAuthMethods()
      .then((methods) => {
        passwordOnAnswer = methods?.emailPassword === true;
        if (current) {
          setOn(passwordOnAnswer);
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
 * Assinatura only with `billing:manage` and the self-service on (AS-19), Senha only with the password on, and Seus dados
 * only with `organization:export`. A tab the address names is drawn even without its condition (an old link to
 * `/subscription` or `/devices`): its screen says itself what this person cannot do there, as it did as a page of its
 * own. Senha is the exception when the server says the password is off (its page would be a 404): the address opens
 * the first tab. The tabs are drawn once the server said it, so Senha never comes or goes under the finger.
 */
export function SettingsScreen() {
  const { billingSelfService, organization } = useCurrentOrganization();
  const passwordOn = usePasswordOn();
  const { search } = useAddress();
  const asked = requestedTab("settings", search).value;
  const shows = settingsTabsShown({
    billing: canManageBilling(billingSelfService, organization.role),
    dataExport: hasCapabilityForRole(organization.role, "organization:export"),
    offline: OFFLINE_RUNTIME_ENABLED,
    passwordOn: passwordOn === true,
  });
  // the tabs wait for the server to say whether the password is on: a Senha that comes or goes after them would move
  // the tabs on its right
  if (passwordOn === null) {
    return <PageLoading />;
  }
  const panels = Object.entries(PANELS)
    .filter(([value]) => shows[value] || (value === asked && value !== "senha"))
    .map(([, panel]) => panel);
  return (
    <>
      <ScreenTabs
        label="Configurações"
        panels={panels}
        screen="settings"
        title="Configurações"
      />
      <AppVersionLine />
    </>
  );
}
