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
import { StaticOrganizationProvider } from "../lib/current-organization";
import { signOfflineLease } from "../lib/offline-lease-token";
import { purgeNamespace } from "../offline/logout-purge";
import { localNamespace } from "../offline/namespace";
import { OfflineRuntime } from "../offline/runtime/offline-runtime";
import { RuntimeContext } from "../offline/runtime/runtime-context";
import { openRuntimeStores } from "../offline/runtime/runtime-stores";
import { SyncStatus } from "../offline/runtime/sync-status";
import { FakeCatalogServer, FakeCustomerServer } from "../offline/test-support";

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

type LabScreen = "customers" | "products";

function labScreen(): LabScreen {
  return new URLSearchParams(window.location.search).get("screen") ===
    "products"
    ? "products"
    : "customers";
}

export function ScreensLab() {
  const screen = useMemo(labScreen, []);
  const [userId, setUserId] = useState("user-a");
  const [online, setOnline] = useState(true);
  const [started, setStarted] = useState(false);
  const [message, setMessage] = useState("Laboratório fechado.");
  const network = useMemo<{ online: boolean }>(() => ({ online: true }), []);
  const server = useMemo(
    () =>
      screen === "products"
        ? new FakeCatalogServer()
        : new FakeCustomerServer(),
    [screen]
  );

  const runtime = useMemo(
    () =>
      new OfflineRuntime({
        api: {
          deviceIsMine: () => Promise.resolve(true),
          issueLease: async (deviceId, organizationId) => {
            const issuedAt = new Date();
            const expiresAt = new Date(issuedAt.getTime() + 72 * HOUR);
            const lease = await signOfflineLease(
              buildOfflineLeaseClaims({
                capabilities: ["customer:create", "product:create"],
                deviceId,
                epoch: 0,
                expiresAt,
                grantId: uuid(9000),
                issuedAt,
                organizationId,
                userId: window.localStorage.getItem("screens-lab-user") ?? "u",
              }),
              LAB_KEY
            );
            return { expiresAt: expiresAt.toISOString(), lease };
          },
          push: () => (input) => server.push(input),
          registerDevice: () => Promise.resolve(uuid(7001)),
          source: () => server,
        },
        isOnline: () => network.online,
        keyValues: {
          read: (key) => window.localStorage.getItem(key),
          remove: (key) => window.localStorage.removeItem(key),
          write: (key, value) => window.localStorage.setItem(key, value),
        },
        namespaceFor: localNamespace,
        openStores: openRuntimeStores,
        purge: purgeNamespace,
      }),
    [network, server]
  );

  // the screen syncs by itself: read the simulated server whenever the runtime says so
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const serverRecords =
    server instanceof FakeCatalogServer
      ? server.products.size
      : server.customers.size;

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
          </div>
          <p>
            Registros no servidor simulado:{" "}
            <span data-testid="server-records">{serverRecords}</span>
          </p>
          {started && screen === "customers" ? <CustomersPage /> : null}
          {started && screen === "products" ? <ProductsPage /> : null}
        </main>
      </StaticOrganizationProvider>
    </RuntimeContext.Provider>
  );
}
