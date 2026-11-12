import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import ChevronLeftIcon from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Card } from "@/ui/card";
import {
  isMarkedEntry,
  pushAddress,
  replaceAddress,
  useAddress,
} from "../app-shell/address";
import { lazyScreen } from "../app-shell/lazy-screen";
import {
  addressWithTab,
  listedTabs,
  namesTab,
  requestedTab,
  type ScreenTab,
} from "../app-shell/navigation-model";
import {
  groupedTabsOf,
  ScreenTabs,
  type TabPanel,
} from "../app-shell/screen-tabs";
import { canManageBilling } from "../lib/billing-access";
import { useCurrentOrganization } from "../lib/current-organization";
import { useIsMobile } from "../lib/use-mobile";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { loadAuthMethods } from "../sign-in/sign-in-model";
import { AppVersionLine } from "./app-version-line";
import { SETTINGS_GROUPS, settingsTabsShown } from "./settings-tabs";

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

/** What the server last said about the password (not a failed read), kept for the life of the page so Configurações opens with its tabs settled. */
let knownPasswordOn: boolean | null = null;

/** Whether the password is on (ADR 0100, AC-46); null while the server has not said. */
function usePasswordOn(): boolean | null {
  const [on, setOn] = useState<boolean | null>(knownPasswordOn);
  useEffect(() => {
    let current = true;
    loadAuthMethods()
      .then((methods) => {
        if (methods !== null) {
          knownPasswordOn = methods.emailPassword;
        }
        if (current) {
          setOn(methods?.emailPassword ?? knownPasswordOn === true);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return on;
}

const SETTINGS_ADDRESS = "/configuracoes";

/** Marks the history step a row of the list added, so "Voltar" knows the list is the step before it. */
const FROM_LIST = "polarisSettingsFromList";

const MENU_ROW =
  "flex min-h-12 items-center justify-between gap-3 px-4 py-2 font-medium text-sm";

/** Where the focus goes on the next screen of the phone. */
interface PhoneFocus {
  /** A row was pressed: the tab's screen takes the focus on its "Voltar". */
  entering: boolean;
  /** The tab the person came from, by a row or by "Voltar": its row takes the focus when the list is drawn again. */
  row: string | null;
}

/** A plain click on a link of the phone is handled by the screen; a click to open elsewhere goes on as a link. */
function opensInPlace(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
    return false;
  }
  event.preventDefault();
  return true;
}

function SettingsBack({ focus }: { focus: RefObject<PhoneFocus> }) {
  const back = useRef<HTMLAnchorElement>(null);
  const { search } = useAddress();
  const open = requestedTab("settings", search).value;
  useEffect(() => {
    focus.current.row = open;
    if (focus.current.entering) {
      focus.current.entering = false;
      back.current?.focus();
    }
  }, [focus, open]);
  const leave = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (opensInPlace(event)) {
        focus.current.row = open;
        if (isMarkedEntry(FROM_LIST)) {
          window.history.back();
        } else {
          replaceAddress(SETTINGS_ADDRESS);
        }
      }
    },
    [focus, open]
  );
  return (
    <a
      className="touch-hit focus-ring inline-flex w-fit items-center gap-1 rounded-md font-medium text-muted-foreground text-sm hover:text-foreground"
      href={SETTINGS_ADDRESS}
      onClick={leave}
      ref={back}
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4" />
      Voltar
      <span className="sr-only"> para Configurações</span>
    </a>
  );
}

function SettingsRow({
  focus,
  reserved,
  tab,
}: {
  focus: RefObject<PhoneFocus>;
  reserved: boolean;
  tab: ScreenTab;
}) {
  const href = addressWithTab(SETTINGS_ADDRESS, "settings", tab.value, true);
  const open = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (opensInPlace(event)) {
        focus.current.entering = true;
        focus.current.row = tab.value;
        pushAddress(href, FROM_LIST);
      }
    },
    [focus, href, tab.value]
  );
  if (reserved) {
    return (
      <span
        aria-busy="true"
        aria-disabled="true"
        className={`${MENU_ROW} opacity-50`}
      >
        {tab.label}
      </span>
    );
  }
  return (
    <a
      className={`${MENU_ROW} focus-ring hover:bg-muted/50 focus-visible:-outline-offset-3`}
      data-settings-row={tab.value}
      href={href}
      onClick={open}
    >
      {tab.label}
      <ChevronRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
    </a>
  );
}

/**
 * The list of Configurações on a phone: the tabs this person has, in the two groups of the screen, each row opening its
 * tab as a step of the history, so "voltar" of the browser comes back to the list as "Voltar" of the screen does. The group names are headings and the rows a list, as
 * there is no `tablist` here to forbid either; a group with no row has neither. A tab that waits for the server (Senha)
 * keeps its row, off and busy, so the rows do not move when the answer arrives.
 */
function SettingsMenu({
  focus,
  panels,
  reserved,
}: {
  focus: RefObject<PhoneFocus>;
  panels: readonly TabPanel[];
  reserved: readonly string[];
}) {
  const namesId = useId();
  const root = useRef<HTMLDivElement>(null);
  const tabs = listedTabs(
    "settings",
    panels.map((panel) => panel.value),
    reserved
  );
  useEffect(() => {
    const from = focus.current.row;
    focus.current.row = null;
    if (from) {
      root.current
        ?.querySelector<HTMLElement>(
          `[data-settings-row="${CSS.escape(from)}"]`
        )
        ?.focus();
    }
  }, [focus]);
  return (
    <div className="grid gap-5" ref={root}>
      {groupedTabsOf(tabs, SETTINGS_GROUPS).map((group, index) => {
        const headingId = `${namesId}-${index}`;
        return (
          <section className="grid gap-2" key={group.label}>
            <h2 className="text-muted-foreground text-xs" id={headingId}>
              {group.label}
            </h2>
            <Card className="gap-0 py-0">
              <ul
                aria-labelledby={headingId}
                className="divide-y divide-border"
              >
                {group.tabs.map((tab) => (
                  <li key={tab.value}>
                    <SettingsRow
                      focus={focus}
                      reserved={tab.reserved}
                      tab={tab}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Configurações (map of navigation, § 1): Formas de receber, Catálogo público, Aparelhos only with the offline runtime,
 * Assinatura only with `billing:manage` and the self-service on (AS-19), Senha only with the password on, and Seus dados
 * only with `organization:export`. A tab the address names is drawn even without its condition (an old link to
 * `/subscription` or `/devices`): its screen says itself what this person cannot do there, as it did as a page of its
 * own. Senha is the exception once the server said the password is off (its page would be a 404): the address opens
 * the first tab.
 */
export function SettingsScreen() {
  const { billingSelfService, organization } = useCurrentOrganization();
  const passwordOn = usePasswordOn();
  const phone = useIsMobile();
  const focus = useRef<PhoneFocus>({ entering: false, row: null });
  const { search } = useAddress();
  const asked = requestedTab("settings", search).value;
  const shows = settingsTabsShown({
    billing: canManageBilling(billingSelfService, organization.role),
    dataExport: hasCapabilityForRole(organization.role, "organization:export"),
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
  const phoneTabs = phone
    ? {
        back: <SettingsBack focus={focus} />,
        menu: (
          <SettingsMenu focus={focus} panels={panels} reserved={reserved} />
        ),
        showMenu: !namesTab("settings", search),
      }
    : undefined;
  return (
    <>
      <ScreenTabs
        groups={phone ? undefined : SETTINGS_GROUPS}
        label="Configurações"
        panels={panels}
        phone={phoneTabs}
        reserved={reserved}
        screen="settings"
        title="Configurações"
      />
      <AppVersionLine />
    </>
  );
}
