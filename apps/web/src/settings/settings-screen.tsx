import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
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
  SETTINGS_TITLE,
  type ScreenTab,
} from "../app-shell/navigation-model";
import { ScreenTabs, type TabPanel } from "../app-shell/screen-tabs";
import type { TitleBack } from "../app-shell/screen-title";
import { canManageBilling } from "../lib/billing-access";
import { useCurrentOrganization } from "../lib/current-organization";
import { useIsMobile } from "../lib/use-mobile";
import { AppVersionLine } from "./app-version-line";
import { settingsTabsShown } from "./settings-tabs";

/** Each tab is its own chunk, as each screen was. */
const PANELS: Readonly<Record<string, TabPanel>> = {
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
  "seus-dados": {
    Screen: lazyScreen(() =>
      import("../data-export/data-export-page").then((module) => ({
        default: module.DataExportPage,
      }))
    ),
    value: "seus-dados",
  },
};

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

function useSettingsBack(
  focus: RefObject<PhoneFocus>,
  active: boolean
): TitleBack {
  const back = useRef<HTMLAnchorElement>(null);
  const { search } = useAddress();
  const open = requestedTab("settings", search).value;
  useEffect(() => {
    if (!active) {
      return;
    }
    focus.current.row = open;
    if (focus.current.entering) {
      focus.current.entering = false;
      back.current?.focus();
    }
  }, [active, focus, open]);
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
  return {
    href: SETTINGS_ADDRESS,
    label: "Voltar para Configurações",
    onClick: leave,
    ref: back,
  };
}

function SettingsRow({
  focus,
  tab,
}: {
  focus: RefObject<PhoneFocus>;
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
 * The list of Configurações on a phone: the tabs this person has, each row opening its tab as a step of the history, so
 * "voltar" of the browser comes back to the list as "Voltar" of the screen does.
 */
function SettingsMenu({
  focus,
  panels,
}: {
  focus: RefObject<PhoneFocus>;
  panels: readonly TabPanel[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const tabs = listedTabs(
    "settings",
    panels.map((panel) => panel.value)
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
    <div ref={root}>
      <Card className="gap-0 py-0">
        <ul aria-label={SETTINGS_TITLE} className="divide-y divide-border">
          {tabs.map((tab) => (
            <li key={tab.value}>
              <SettingsRow focus={focus} tab={tab} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Configurações da loja (map of navigation, § 1): Formas de receber and Catálogo público, Assinatura only with
 * `billing:manage` and the self-service on (AS-19), and Seus dados only with `organization:export`. Senha and
 * Aparelhos are Minha conta. A tab the address names is drawn even without its condition (an old link to
 * `/subscription`): its screen says itself what this person cannot do there, as it did as a page of its own.
 */
export function SettingsScreen() {
  const { billingSelfService, organization } = useCurrentOrganization();
  const phone = useIsMobile();
  const focus = useRef<PhoneFocus>({ entering: false, row: null });
  const { search } = useAddress();
  const settingsBack = useSettingsBack(
    focus,
    phone && namesTab("settings", search)
  );
  const asked = requestedTab("settings", search).value;
  const shows = settingsTabsShown({
    billing: canManageBilling(billingSelfService, organization.role),
    dataExport: hasCapabilityForRole(organization.role, "organization:export"),
  });
  const panels = Object.entries(PANELS)
    .filter(([value]) => shows[value] || value === asked)
    .map(([, panel]) => panel);
  const phoneTabs = phone
    ? {
        back: settingsBack,
        menu: <SettingsMenu focus={focus} panels={panels} />,
        showMenu: !namesTab("settings", search),
      }
    : undefined;
  return (
    <>
      <ScreenTabs
        label={SETTINGS_TITLE}
        panels={panels}
        phone={phoneTabs}
        screen="settings"
        title={SETTINGS_TITLE}
      />
      <AppVersionLine />
    </>
  );
}
