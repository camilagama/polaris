import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { signOfflineLease } from "../lib/offline-lease-token";
import { wipeLocalStore } from "../offline/local-store";
import { purgeNamespace } from "../offline/logout-purge";
import { localNamespace } from "../offline/namespace";
import { createOfflineProduct } from "../offline/product-create";
import { OfflineRuntime } from "../offline/runtime/offline-runtime";
import { RuntimeContext } from "../offline/runtime/runtime-context";
import { openRuntimeStores } from "../offline/runtime/runtime-stores";
import { SyncStatus } from "../offline/runtime/sync-status";
import { FakeCatalogServer } from "../offline/test-support";

/**
 * Browser lab for the offline runtime (Phase 5 wiring): the real runtime over the
 * real IndexedDB outbox and OPFS database, with a simulated server and network.
 * It shows what the app does on a second visit with no connection. Only built in
 * the offline-poc mode. Synthetic keys and data only.
 */
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const DEVICE_STORAGE_PREFIX = "polaris.offline.";

export function RuntimeLab() {
  const [userId, setUserId] = useState("user-a");
  const [online, setOnline] = useState(true);
  const [message, setMessage] = useState("Laboratório fechado.");
  const [serverProducts, setServerProducts] = useState(0);
  const [localProducts, setLocalProducts] = useState(0);
  const network = useMemo<{ online: boolean }>(() => ({ online: true }), []);
  const server = useMemo(() => new FakeCatalogServer(), []);
  const counterKey = "runtime-lab-counter";

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
                capabilities: ["product:create", "inventory:adjust"],
                deviceId,
                epoch: 0,
                expiresAt,
                grantId: uuid(9000),
                issuedAt,
                organizationId,
                userId: window.localStorage.getItem("runtime-lab-user") ?? "u",
              }),
              LAB_KEY
            );
            return { expiresAt: expiresAt.toISOString(), lease };
          },
          push: () => (input) => server.push(input),
          registerDevice: () => Promise.resolve(uuid(7001)),
          sessionUserId: () =>
            Promise.resolve(
              window.localStorage.getItem("runtime-lab-user") ?? "u"
            ),
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
        wipeCollections: async (namespace) => {
          await wipeLocalStore(namespace);
        },
      }),
    [network, server]
  );

  const run = useCallback(
    async (label: string, action: () => Promise<string | undefined>) => {
      try {
        const detail = await action();
        setMessage(`${label}: ok${detail ? ` (${detail})` : ""}`);
      } catch (error: unknown) {
        setMessage(
          `${label}: erro ${error instanceof Error ? error.message : "desconhecido"}`
        );
      }
      setServerProducts(server.products.size);
      const context = runtime.context();
      setLocalProducts(
        context ? (await context.writer.keys("products")).length : 0
      );
    },
    [runtime, server]
  );

  const handleStart = useCallback(
    () =>
      run("Iniciar", async () => {
        window.localStorage.setItem("runtime-lab-user", userId);
        await runtime.start("org-1");
        const { phase, reason } = runtime.getSnapshot();
        return reason ? `${phase}:${reason}` : phase;
      }),
    [run, runtime, userId]
  );
  const handleCreate = useCallback(
    () =>
      run("Criar produto", async () => {
        const context = runtime.context();
        if (!context) {
          throw new Error("runtime não está pronto");
        }
        const n = Number(window.localStorage.getItem(counterKey) ?? "0") + 1;
        window.localStorage.setItem(counterKey, String(n));
        await createOfflineProduct({
          ...context,
          input: { name: `Produto offline ${n}` },
        });
        await runtime.refreshCounts();
      }),
    [run, runtime]
  );
  const handleSync = useCallback(
    () =>
      run("Sincronizar", async () => {
        await runtime.syncNow();
        return runtime.getSnapshot().reason ?? undefined;
      }),
    [run, runtime]
  );
  const handleNetwork = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      network.online = event.currentTarget.checked;
      setOnline(event.currentTarget.checked);
      // what the page does on the browser's online and offline events
      run("Rede", async () => {
        await runtime.syncNow();
        return network.online ? "online" : "offline";
      }).catch(() => undefined);
    },
    [network, run, runtime]
  );
  const handleUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setUserId(event.currentTarget.value),
    []
  );
  const handleForget = useCallback(
    () =>
      run("Esquecer aparelho", () => {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith(DEVICE_STORAGE_PREFIX)) {
            window.localStorage.removeItem(key);
          }
        }
        return Promise.resolve(undefined);
      }),
    [run]
  );

  return (
    <RuntimeContext.Provider value={runtime}>
      <main className="app-shell" style={{ padding: "1rem" }}>
        <h1>Laboratório do runtime offline</h1>
        <p data-testid="message">{message}</p>
        <SyncStatus />
        <div style={{ display: "grid", gap: "0.5rem", maxWidth: "28rem" }}>
          <label>
            Usuário
            <input onChange={handleUser} value={userId} />
          </label>
          <label>
            <input checked={online} onChange={handleNetwork} type="checkbox" />
            Rede disponível
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <button onClick={handleStart} type="button">
            Iniciar
          </button>
          <button onClick={handleCreate} type="button">
            Criar produto offline
          </button>
          <button onClick={handleSync} type="button">
            Sincronizar
          </button>
          <button onClick={handleForget} type="button">
            Esquecer aparelho
          </button>
        </div>
        <dl>
          <dt>Produtos no servidor simulado</dt>
          <dd data-testid="server-products">{serverProducts}</dd>
          <dt>Produtos neste aparelho</dt>
          <dd data-testid="local-products">{localProducts}</dd>
        </dl>
      </main>
    </RuntimeContext.Provider>
  );
}
