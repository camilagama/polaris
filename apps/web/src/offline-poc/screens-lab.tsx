import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import {
  type ChangeEvent,
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ConnectionRequiredSlot } from "../app-shell/connection-required-notice";
import { CategoriesPage } from "../catalog/categories-page";
import { ProductsPage } from "../catalog/products-page";
import { PublicCatalogPage } from "../catalog/public-catalog-page";
import { CustomersPage } from "../customers/customers-page";
import { DashboardPage } from "../dashboard/dashboard-page";
import { HomePage } from "../home/home-page";
import { ExpensesPage } from "../expenses/expenses-page";
import { InventoryPage } from "../inventory/inventory-page";
import { addConnectionTry, browserConnection } from "../lib/browser-connection";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { signOfflineLease } from "../lib/offline-lease-token";
import { wipeLocalStore } from "../offline/local-store";
import { purgeNamespace } from "../offline/logout-purge";
import { anyOutboxOnDisk } from "../offline/outbox/outbox-on-disk";
import { localNamespace } from "../offline/namespace";
import { openBrowserDataChannel } from "../offline/runtime/data-channel";
import { DevicesPage } from "../offline/runtime/devices-page";
import { OfflineRuntime } from "../offline/runtime/offline-runtime";
import { RuntimeContext } from "../offline/runtime/runtime-context";
import { openRuntimeStores } from "../offline/runtime/runtime-stores";
import {
  type SyncScheduler,
  startSyncScheduler,
} from "../offline/runtime/sync-scheduler";
import { SyncStatus } from "../offline/runtime/sync-status";
import { FakeCatalogServer, FakeCustomerServer } from "../offline/test-support";
import { PaymentProfilesPage } from "../payment-profiles/payment-profiles-page";
import { SaleDetailPage } from "../sales/sale-detail-page";
import { SaleHistoryPage } from "../sales/sale-history-page";
import { SalePage } from "../sales/sale-page";
import { ChangePasswordPage } from "../sign-in/change-password-page";
import { AttentionLabPage } from "./notice-lab-pages";
import { ProductsLabServer } from "./products-lab-server";
import { SaleLabServer } from "./sale-lab-server";
import "./lab-page.css";

/**
 * Browser lab for the screens that work from this device (plan PR64): the real
 * customers screen over the real runtime (IndexedDB outbox, OPFS collections),
 * with a simulated server and network. Only built in the offline-poc mode.
 * Synthetic keys and data only.
 */
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do laboratório",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const labUser = () => window.localStorage.getItem("screens-lab-user") ?? "u";
const deviceOwnerKey = (deviceId: string) =>
  `screens-lab-device-owner.${deviceId}`;

type LabScreen =
  | "attention"
  | "categories"
  | "change-password"
  | "customers"
  | "dashboard"
  | "devices"
  | "expenses"
  | "history"
  | "home"
  | "payment-profiles"
  | "products"
  | "public-catalog"
  | "sale"
  | "sale-detail"
  | "stock";

function labScreen(): LabScreen {
  const screen = new URLSearchParams(window.location.search).get("screen");
  return screen === "attention" ||
    screen === "devices" ||
    screen === "change-password" ||
    screen === "categories" ||
    screen === "products" ||
    screen === "dashboard" ||
    screen === "expenses" ||
    screen === "home" ||
    screen === "payment-profiles" ||
    screen === "public-catalog" ||
    screen === "sale" ||
    screen === "sale-detail" ||
    screen === "stock" ||
    screen === "history"
    ? screen
    : "customers";
}

/** `&catalog=seeded`: the products screen with a small catalog already on the simulated server. */
const seededCatalog = () =>
  new URLSearchParams(window.location.search).get("catalog") === "seeded";

function newServer(screen: LabScreen) {
  if (screen === "products") {
    return seededCatalog() ? new ProductsLabServer() : new FakeCatalogServer();
  }
  return screen === "sale" || screen === "stock" || screen === "history"
    ? new SaleLabServer()
    : new FakeCustomerServer();
}

function recordsOn(
  server: ReturnType<typeof newServer>,
  screen: LabScreen
): number {
  if (server instanceof FakeCatalogServer) {
    return server.products.size;
  }
  if (server instanceof SaleLabServer) {
    // sales confirmed, or movements executed when the screen is the stock one
    return screen === "stock" ? server.executions : server.sales.size;
  }
  return server.customers.size;
}

/**
 * The simulated server is in this page, but the network to it is the real one: before each push and pull
 * the lab calls the Worker (a GET of an unknown RPC path, answered 404 with the Worker's mark), through the tab's
 * connection. With `/rpc` cut or answered by a "portal", the sync gets no answer, as in the field.
 */
async function reachWorker(): Promise<void> {
  const response = await browserConnection.fetch("/rpc/__screens-lab", {
    cache: "no-store",
  });
  await response.body?.cancel();
}

/** The refusal the real server sends without the legal acceptance: a FORBIDDEN with its own reason. */
function legalAcceptanceRefusal(): Error {
  return Object.assign(new Error("Forbidden"), {
    code: "FORBIDDEN",
    data: {
      pending: [{ document: "terms", version: 1 }],
      reason: "legal_acceptance_required",
    },
    status: 403,
  });
}

const LAB_PAGES: Readonly<Record<LabScreen, ComponentType>> = {
  attention: AttentionLabPage,
  categories: CategoriesPage,
  "change-password": ChangePasswordPage,
  customers: CustomersPage,
  dashboard: DashboardPage,
  devices: DevicesPage,
  expenses: ExpensesPage,
  history: SaleHistoryPage,
  home: HomePage,
  "payment-profiles": PaymentProfilesPage,
  products: ProductsPage,
  "public-catalog": PublicCatalogPage,
  sale: SalePage,
  "sale-detail": SaleDetailPage,
  stock: InventoryPage,
};

function LabScreenPage({ screen }: { screen: LabScreen }) {
  const Page = LAB_PAGES[screen];
  return <Page />;
}

export function ScreensLab() {
  const screen = useMemo(labScreen, []);
  const onlineOnly =
    screen === "categories" ||
    screen === "expenses" ||
    screen === "payment-profiles" ||
    screen === "public-catalog" ||
    screen === "sale-detail";
  const [userId, setUserId] = useState("user-a");
  const [online, setOnline] = useState(true);
  const [started, setStarted] = useState(false);
  const [message, setMessage] = useState("Laboratório fechado.");
  const network = useMemo<{ online: boolean }>(() => ({ online: true }), []);
  // the simulated server refuses the sync for lack of the legal acceptance (ADR 0100), like the real one
  const legal = useMemo<{ missing: boolean }>(() => ({ missing: false }), []);
  const [legalMissing, setLegalMissing] = useState(false);
  const server = useMemo(() => newServer(screen), [screen]);

  const runtime = useMemo(
    () =>
      new OfflineRuntime({
        api: {
          // like the real server: a device belongs to the user who registered it
          deviceIsMine: (deviceId) =>
            Promise.resolve(
              window.localStorage.getItem(deviceOwnerKey(deviceId)) ===
                labUser()
            ),
          issueLease: async (deviceId, organizationId) => {
            const issuedAt = new Date();
            const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
            const lease = await signOfflineLease(
              buildOfflineLeaseClaims({
                capabilities: [
                  "customer:create",
                  "customer:update",
                  "product:create",
                  "sale:create",
                  "inventory:adjust",
                ],
                deviceId,
                epoch: 0,
                expiresAt,
                grantId: uuid(9000),
                issuedAt,
                organizationId,
                userId: labUser(),
              }),
              LAB_KEY
            );
            return { expiresAt: expiresAt.toISOString(), lease };
          },
          push: () => async (input) => {
            await reachWorker();
            return legal.missing
              ? Promise.reject(legalAcceptanceRefusal())
              : server.push(input);
          },
          registerDevice: () => {
            const deviceId = uuid(7001);
            window.localStorage.setItem(deviceOwnerKey(deviceId), labUser());
            return Promise.resolve(deviceId);
          },
          sessionUserId: () => Promise.resolve(labUser()),
          source: () => ({
            getCursor: () => server.getCursor(),
            page: (collection, request) => server.page(collection, request),
            pull: async (cursor, limit) => {
              await reachWorker();
              return server.pull(cursor, limit);
            },
            recentSales: () => server.recentSales(),
          }),
        },
        // the lab's switch, and the tab's connection state as in the app
        isOnline: () => network.online && browserConnection.isOnline(),
        keyValues: {
          read: (key) => window.localStorage.getItem(key),
          remove: (key) => window.localStorage.removeItem(key),
          write: (key, value) => window.localStorage.setItem(key, value),
        },
        mayTry: () => network.online && navigator.onLine,
        namespaceFor: localNamespace,
        openDataChannel: openBrowserDataChannel,
        openStores: openRuntimeStores,
        outboxOnDisk: anyOutboxOnDisk,
        purge: purgeNamespace,
        wipeCollections: async (namespace) => {
          await wipeLocalStore(namespace);
        },
      }),
    [legal, network, server]
  );

  // the screen syncs by itself: read the simulated server whenever the runtime says so
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const serverRecords = recordsOn(server, screen);
  const scheduler = useRef<SyncScheduler | null>(null);
  // the same signals and scheduler as the app's runtime provider
  useEffect(() => browserConnection.attach(window, document), []);
  useEffect(
    () => () => {
      scheduler.current?.stop();
    },
    []
  );
  useEffect(
    () =>
      addConnectionTry(() => scheduler.current?.syncNow() ?? Promise.resolve()),
    []
  );

  const handleStart = useCallback(async () => {
    window.localStorage.setItem("screens-lab-user", userId);
    try {
      await runtime.start(ORGANIZATION.id);
      scheduler.current?.stop();
      scheduler.current = startSyncScheduler({
        connection: browserConnection,
        isVisible: () => document.visibilityState === "visible",
        onVisible: (listener) => {
          const onVisibility = () => {
            if (document.visibilityState === "visible") {
              listener();
            }
          };
          document.addEventListener("visibilitychange", onVisibility);
          return () =>
            document.removeEventListener("visibilitychange", onVisibility);
        },
        random: Math.random,
        runtime,
        schedule: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      });
      const { phase, reason } = runtime.getSnapshot();
      setMessage(`Iniciar: ok (${reason ? `${phase}:${reason}` : phase})`);
      setStarted(true);
    } catch (error: unknown) {
      setMessage(
        `Iniciar: erro ${error instanceof Error ? error.message : "desconhecido"}`
      );
    }
  }, [runtime, userId]);

  const handleSync = useCallback(async () => {
    await runtime.syncNow();
    setMessage(`Sincronizar: ok ${runtime.getSnapshot().reason ?? ""}`.trim());
  }, [runtime]);

  const handleNetwork = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      network.online = event.currentTarget.checked;
      setOnline(event.currentTarget.checked);
      // what the page does on the browser's online and offline events
      await runtime.syncNow();
    },
    [network, runtime]
  );

  // another device edits every customer on the simulated server (the device is not told)
  const handleOtherDevice = useCallback(() => {
    if (!(server instanceof FakeCustomerServer)) {
      return;
    }
    for (const [id, row] of [...server.customers]) {
      server.customers.set(id, {
        ...row,
        name: `${row.name} (outro aparelho)`,
        version: row.version + 1,
      });
      server.changes.push({
        entityId: id,
        entityType: "customer",
        seq: server.changes.length + 1,
      });
    }
  }, [server]);

  const handleLegal = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      legal.missing = event.currentTarget.checked;
      setLegalMissing(event.currentTarget.checked);
      await runtime.syncNow();
      const { legalAcceptanceRequired, reason } = runtime.getSnapshot();
      setMessage(
        `Aceite: ${legalAcceptanceRequired ? "pendente" : "ok"} ${reason ?? ""}`.trim()
      );
    },
    [legal, runtime]
  );

  const handleUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setUserId(event.currentTarget.value),
    []
  );

  return (
    <RuntimeContext.Provider value={runtime}>
      <StaticOrganizationProvider organization={ORGANIZATION}>
        <main className="app-shell" style={{ padding: "1rem" }}>
          {/* the lab's own controls: the guardrails hide them to measure the screen alone */}
          <div data-lab-chrome="">
            <h1>Laboratório das telas offline</h1>
            <p data-testid="message">{message}</p>
            <SyncStatus onlineOnly={onlineOnly} />
            <div style={{ display: "grid", gap: "0.5rem", maxWidth: "28rem" }}>
              <label>
                Usuário
                <input onChange={handleUser} value={userId} />
              </label>
              <label>
                <input
                  checked={online}
                  onChange={handleNetwork}
                  type="checkbox"
                />
                Rede disponível
              </label>
              <label>
                <input
                  checked={legalMissing}
                  onChange={handleLegal}
                  type="checkbox"
                />
                Falta aceitar os termos
              </label>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <button onClick={handleStart} type="button">
                Iniciar
              </button>
              <button onClick={handleSync} type="button">
                Sincronizar
              </button>
              {screen === "customers" ? (
                <button onClick={handleOtherDevice} type="button">
                  Outro aparelho altera os clientes
                </button>
              ) : null}
            </div>
            <p>
              Registros no servidor simulado:{" "}
              <span data-testid="server-records">{serverRecords}</span>
            </p>
          </div>
          {started && onlineOnly ? (
            // on the page's background, as in the shell: the lab's own page stays light in the dark theme
            <div style={{ background: "var(--background)" }}>
              <ConnectionRequiredSlot
                form={screen !== "public-catalog" && screen !== "sale-detail"}
              />
            </div>
          ) : null}
          {started ? <LabScreenPage screen={screen} /> : null}
        </main>
      </StaticOrganizationProvider>
    </RuntimeContext.Provider>
  );
}
