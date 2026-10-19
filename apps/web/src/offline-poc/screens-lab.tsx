import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import {
  type ChangeEvent,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ProductsPage } from "../catalog/products-page";
import { CustomersPage } from "../customers/customers-page";
import { DashboardPage } from "../dashboard/dashboard-page";
import { ExpensesPage } from "../expenses/expenses-page";
import { InventoryPage } from "../inventory/inventory-page";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { signOfflineLease } from "../lib/offline-lease-token";
import { wipeLocalStore } from "../offline/local-store";
import { purgeNamespace } from "../offline/logout-purge";
import { localNamespace } from "../offline/namespace";
import { openBrowserDataChannel } from "../offline/runtime/data-channel";
import { OfflineRuntime } from "../offline/runtime/offline-runtime";
import { RuntimeContext } from "../offline/runtime/runtime-context";
import { openRuntimeStores } from "../offline/runtime/runtime-stores";
import { SyncStatus } from "../offline/runtime/sync-status";
import { FakeCatalogServer, FakeCustomerServer } from "../offline/test-support";
import { SaleHistoryPage } from "../sales/sale-history-page";
import { SalePage } from "../sales/sale-page";
import { SaleLabServer } from "./sale-lab-server";

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
  | "customers"
  | "dashboard"
  | "expenses"
  | "history"
  | "products"
  | "sale"
  | "stock";

function labScreen(): LabScreen {
  const screen = new URLSearchParams(window.location.search).get("screen");
  return screen === "products" ||
    screen === "dashboard" ||
    screen === "expenses" ||
    screen === "sale" ||
    screen === "stock" ||
    screen === "history"
    ? screen
    : "customers";
}

function newServer(screen: LabScreen) {
  if (screen === "products") {
    return new FakeCatalogServer();
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

export function ScreensLab() {
  const screen = useMemo(labScreen, []);
  const [userId, setUserId] = useState("user-a");
  const [online, setOnline] = useState(true);
  const [started, setStarted] = useState(false);
  const [message, setMessage] = useState("Laboratório fechado.");
  const network = useMemo<{ online: boolean }>(() => ({ online: true }), []);
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
          push: () => (input) => server.push(input),
          registerDevice: () => {
            const deviceId = uuid(7001);
            window.localStorage.setItem(deviceOwnerKey(deviceId), labUser());
            return Promise.resolve(deviceId);
          },
          sessionUserId: () => Promise.resolve(labUser()),
          source: () => server,
        },
        isOnline: () => network.online,
        keyValues: {
          read: (key) => window.localStorage.getItem(key),
          remove: (key) => window.localStorage.removeItem(key),
          write: (key, value) => window.localStorage.setItem(key, value),
        },
        namespaceFor: localNamespace,
        openDataChannel: openBrowserDataChannel,
        openStores: openRuntimeStores,
        purge: purgeNamespace,
        wipeCollections: async (namespace) => {
          await wipeLocalStore(namespace);
        },
      }),
    [network, server]
  );

  // the screen syncs by itself: read the simulated server whenever the runtime says so
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const serverRecords = recordsOn(server, screen);

  const handleStart = useCallback(async () => {
    window.localStorage.setItem("screens-lab-user", userId);
    try {
      await runtime.start(ORGANIZATION.id);
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

  const handleUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setUserId(event.currentTarget.value),
    []
  );

  return (
    <RuntimeContext.Provider value={runtime}>
      <StaticOrganizationProvider organization={ORGANIZATION}>
        <main className="app-shell" style={{ padding: "1rem" }}>
          <h1>Laboratório das telas offline</h1>
          <p data-testid="message">{message}</p>
          <SyncStatus />
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
          {started && screen === "customers" ? <CustomersPage /> : null}
          {started && screen === "products" ? <ProductsPage /> : null}
          {started && screen === "sale" ? <SalePage /> : null}
          {started && screen === "stock" ? <InventoryPage /> : null}
          {started && screen === "history" ? <SaleHistoryPage /> : null}
          {started && screen === "expenses" ? <ExpensesPage /> : null}
          {started && screen === "dashboard" ? <DashboardPage /> : null}
        </main>
      </StaticOrganizationProvider>
    </RuntimeContext.Provider>
  );
}
