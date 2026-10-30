import { browserConnection } from "./browser-connection";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import {
  browserStorage,
  clearLegacyOrganizationId,
  clearOrganizationsCache,
  organizationLoadAfterFailure,
  readOrganizationsCache,
  writeOrganizationsCache,
  type Organization,
  type OrganizationLoad,
  organizationLoadFromList,
  readPreferredOrganizationId,
  selectOrganization,
  writePreferredOrganizationId,
} from "./current-organization-model";
import { orpcClient } from "./orpc";
import { clearPaymentProfileCaches } from "./payment-profile-cache";
import { clearPeriodSummaryCaches } from "./period-summary-cache";
import { rpcErrorCode } from "./rpc-error";
import { clearClosedStores } from "../organization/closed-stores-memory";
import { writeSessionMarker } from "./session-marker";
import { isSigningOut } from "./sign-out";
import {
  clearSaleAttempts,
  sessionStorageOrNull,
} from "../sales/sale-attempt-storage";
import { clearSaleDrafts } from "../sales/sale-draft-storage";

interface OrganizationContextValue {
  /**
   * BILLING_SELF_SERVICE_ENABLED is on (ADR 0104), as `organization.listMine` said: the owner's "Assinatura" may show.
   * False until the server says so, and when the list came from the device's copy.
   */
  billingSelfService: boolean;
  load: OrganizationLoad;
  /** Reads the user's organizations again, e.g. after onboarding. */
  reload: () => void;
  select: (organizationId: string) => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(
  null
);

interface OrganizationProviderProps {
  children: ReactNode;
}

/**
 * Resolves the organization from the signed-in session: the server lists the
 * user's organizations, and the browser only remembers which one was chosen
 * last. That ID is still sent as the requested context on every call, and the
 * server still authorizes it.
 */
export function OrganizationProvider({ children }: OrganizationProviderProps) {
  const [load, setLoad] = useState<OrganizationLoad>({ status: "loading" });
  const [billingSelfService, setBillingSelfService] = useState(false);
  const latestRequest = useRef(0);
  const fromCache = useRef<boolean>(false);
  const opened = useRef(false);

  const loadOrganizations = useCallback(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    orpcClient.organization
      .listMine()
      .then(({ billingSelfService: billing, organizations }) => {
        if (request === latestRequest.current) {
          opened.current = true;
          setBillingSelfService(billing === true);
          fromCache.current = false;
          if (!isSigningOut()) {
            writeSessionMarker("ativa");
          }
          if (OFFLINE_RUNTIME_ENABLED && !isSigningOut()) {
            writeOrganizationsCache(browserStorage(), organizations);
          }
          setLoad(
            organizationLoadFromList(
              organizations,
              readPreferredOrganizationId(browserStorage())
            )
          );
        }
      })
      .catch((error: unknown) => {
        if (request !== latestRequest.current) {
          return;
        }
        if (rpcErrorCode(error) === "UNAUTHORIZED") {
          // The session is over: its organizations must not be offered offline.
          clearOrganizationsCache(browserStorage());
          clearClosedStores(browserStorage());
          clearPaymentProfileCaches(browserStorage());
          clearPeriodSummaryCaches(browserStorage());
          clearSaleDrafts(sessionStorageOrNull());
          clearSaleAttempts(sessionStorageOrNull());
        }
        // the flag is the server's word: a list from the device's copy does not carry it
        setBillingSelfService(false);
        const outcome = organizationLoadAfterFailure({
          atOpen: !opened.current,
          cached: readOrganizationsCache(browserStorage()),
          error,
          offlineEnabled: OFFLINE_RUNTIME_ENABLED,
          preferredId: readPreferredOrganizationId(browserStorage()),
        });
        opened.current = true;
        fromCache.current = outcome.fromCache;
        setLoad(outcome.load);
      });
  }, []);

  useEffect(() => {
    // Opened from the device's copy: read the real list as soon as the connection is back.
    const onOnline = () => {
      if (fromCache.current) {
        loadOrganizations();
      }
    };
    window.addEventListener("online", onOnline);
    // the connection proven again (a wi-fi that had no internet gives no `online` event)
    const stopConnection = browserConnection.subscribe(() => {
      if (browserConnection.isOnline()) {
        onOnline();
      }
    });
    return () => {
      window.removeEventListener("online", onOnline);
      stopConnection();
    };
  }, [loadOrganizations]);

  useEffect(() => {
    clearLegacyOrganizationId(browserStorage());
    loadOrganizations();
    return () => {
      // A late answer from an unmounted provider must not set state.
      latestRequest.current += 1;
    };
  }, [loadOrganizations]);

  const reload = useCallback(() => {
    setLoad({ status: "loading" });
    loadOrganizations();
  }, [loadOrganizations]);
  const select = useCallback((organizationId: string) => {
    // the cart of the store left behind is not kept: it would come back after the person forgot it. The attempt sent
    // with no answer is, since that sale may be on the server and retyping the cart must reach it
    clearSaleDrafts(sessionStorageOrNull(), organizationId);
    clearSaleAttempts(sessionStorageOrNull(), organizationId, true);
    writePreferredOrganizationId(browserStorage(), organizationId);
    setLoad((current) => selectOrganization(current, organizationId));
  }, []);

  const value = useMemo(
    () => ({ billingSelfService, load, reload, select }),
    [billingSelfService, load, reload, select]
  );
  return createElement(OrganizationContext.Provider, { value }, children);
}

/** The load state of the organization, for the shell that gates the pages. */
export function useOrganizationLoad(): OrganizationContextValue {
  const value = useContext(OrganizationContext);
  if (value === null) {
    throw new Error("useOrganizationLoad needs an OrganizationProvider.");
  }
  return value;
}

export interface CurrentOrganization {
  /** The billing self-service is on (ADR 0104): with `billing:manage`, the "Assinatura" may show. */
  billingSelfService: boolean;
  organization: Organization;
  /** The requested context for every call. The server still authorizes it. */
  organizationId: string;
  organizations: readonly Organization[];
  select: (organizationId: string) => void;
}

/**
 * The organization a page works in. Pages render only once the shell has
 * resolved one, so this never returns "no organization".
 */
export function useCurrentOrganization(): CurrentOrganization {
  const { billingSelfService, load, select } = useOrganizationLoad();
  if (load.status !== "ready") {
    throw new Error(
      "useCurrentOrganization was used before an organization was resolved."
    );
  }
  return {
    billingSelfService,
    organization: load.current,
    organizationId: load.current.id,
    organizations: load.organizations,
    select,
  };
}

/**
 * A fixed organization for the browser labs that mount a real screen without a
 * server (they are only built in the offline-poc mode).
 */
export function StaticOrganizationProvider({
  billingSelfService = false,
  children,
  organization,
}: {
  billingSelfService?: boolean;
  children: ReactNode;
  organization: Organization;
}) {
  const value = useMemo<OrganizationContextValue>(
    () => ({
      billingSelfService,
      load: {
        current: organization,
        organizations: [organization],
        status: "ready",
      },
      reload: () => undefined,
      select: () => undefined,
    }),
    [billingSelfService, organization]
  );
  return createElement(OrganizationContext.Provider, { value }, children);
}
