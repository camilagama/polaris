import { useEffect } from "react";
import { replaceAddress, useAddress } from "../app-shell/address";
import { lazyScreen } from "../app-shell/lazy-screen";
import { ACCOUNT_LABEL, requestedTab } from "../app-shell/navigation-model";
import { PageLoading } from "../app-shell/page-loading";
import { ScreenTabs, type TabPanel } from "../app-shell/screen-tabs";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { accountTabsShown, usePasswordOn } from "./settings-tabs";

const HOME_ADDRESS = "/";

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
  senha: {
    Screen: lazyScreen(() =>
      import("../sign-in/change-password-page").then((module) => ({
        default: module.ChangePasswordPage,
      }))
    ),
    value: "senha",
  },
};

/**
 * Minha conta (map of navigation, § 1): what belongs to the person and holds in every store, from the menu of the
 * circle. Senha only with the password on, Aparelhos only with the offline runtime; with one tab the screen shows its
 * content under the title, with no strip. A tab the address names is drawn even without its condition (an old link to
 * `/devices`): its screen says itself what this person cannot do there. Senha is the exception once the server said
 * the password is off (its page would be a 404). A person with no tab at all has no screen: the address opens the Início.
 */
export function AccountScreen() {
  const passwordOn = usePasswordOn();
  const { search } = useAddress();
  const asked = requestedTab("account", search).value;
  const shows = accountTabsShown({
    offline: OFFLINE_RUNTIME_ENABLED,
    passwordOn: passwordOn === true,
  });
  const panels = Object.entries(PANELS)
    .filter(
      ([value]) =>
        shows[value] ||
        // Senha waits for the server to say whether the password is on; off, there is nothing to show there
        (value === asked && (value !== "senha" || passwordOn === null))
    )
    .map(([, panel]) => panel);
  const reserved = passwordOn === null ? ["senha"] : [];
  const nothing = panels.length === 0 && passwordOn !== null;
  useEffect(() => {
    if (nothing) {
      replaceAddress(HOME_ADDRESS);
    }
  }, [nothing]);
  if (panels.length === 0) {
    return <PageLoading />;
  }
  return (
    <ScreenTabs
      label={ACCOUNT_LABEL}
      panels={panels}
      reserved={reserved}
      screen="account"
      title={ACCOUNT_LABEL}
    />
  );
}
