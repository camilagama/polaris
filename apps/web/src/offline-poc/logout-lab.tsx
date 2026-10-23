import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { signOfflineLease } from "../lib/offline-lease-token";
import { LogoutDialog } from "../offline/logout-dialog";
import {
  attemptLogout,
  type BlockedWorkspace,
  discardAndLogout,
  type LogoutWorkspace,
} from "../offline/logout-guard";
import { purgeNamespace } from "../offline/logout-purge";
import { localNamespace } from "../offline/namespace";
import {
  type OutboxStore,
  openOutboxStore,
} from "../offline/outbox/outbox-store";
import "./lab-page.css";

/**
 * Browser lab for logging out with queued work (PR59): the real guard, dialog and
 * purge over the real IndexedDB outbox and OPFS database, with a simulated
 * network and server. Only built in the offline-poc mode. Synthetic data only.
 */
const DEVICE_ID = "0199c2d0-0000-7000-8000-0000000000d1";
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function leaseFor(userId: string, organizationId: string) {
  const now = Date.now();
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId: DEVICE_ID,
      epoch: 0,
      expiresAt: new Date(now + 24 * HOUR),
      grantId: uuid(9000),
      issuedAt: new Date(now - HOUR),
      organizationId,
      userId,
    }),
    LAB_KEY
  );
}

export function LogoutLab() {
  const [userId, setUserId] = useState("user-a");
  const [organizationId, setOrganizationId] = useState("org-1");
  const [online, setOnline] = useState(true);
  const [serverRefuses, setServerRefuses] = useState(false);
  const [message, setMessage] = useState("Laboratório fechado.");
  const [blocked, setBlocked] = useState<BlockedWorkspace[] | null>(null);
  const [loggedOut, setLoggedOut] = useState(false);
  const storeRef = useRef<OutboxStore | null>(null);
  const counterRef = useRef(1);
  const networkRef = useRef<{ online: boolean; refuses: boolean }>({
    online: true,
    refuses: false,
  });

  const ensure = useCallback(async () => {
    if (storeRef.current) {
      return storeRef.current;
    }
    const namespace = await localNamespace(userId, organizationId);
    storeRef.current = await openOutboxStore(namespace, DEVICE_ID);
    return storeRef.current;
  }, [organizationId, userId]);

  const workspace = useCallback(async (): Promise<LogoutWorkspace> => {
    const store = await ensure();
    const namespace = await localNamespace(userId, organizationId);
    return {
      label: organizationId,
      outbox: store.outbox,
      purge: async (options) => {
        storeRef.current?.close();
        storeRef.current = null;
        await purgeNamespace(namespace, options);
      },
      trySync: async () => {
        if (!networkRef.current.online) {
          throw new Error("sem conexão");
        }
        for (;;) {
          // biome-ignore lint/performance/noAwaitInLoops: the queue is sent in order
          const next = await store.outbox.next();
          if (!next) {
            return;
          }
          await store.outbox.markSending(next.commandId);
          if (networkRef.current.refuses) {
            await store.outbox.reject(next.commandId, "insufficient_stock");
            return;
          }
          await store.outbox.acknowledge(next.commandId);
        }
      },
    };
  }, [ensure, organizationId, userId]);

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
    },
    []
  );

  const handleOpen = useCallback(
    () =>
      run("Abrir", async () => {
        await ensure();
      }),
    [ensure, run]
  );
  const handleEnqueue = useCallback(
    () =>
      run("Enfileirar", async () => {
        const store = await ensure();
        counterRef.current += 1;
        const n = counterRef.current;
        await store.outbox.enqueue({
          baseVersion: null,
          commandId: uuid(100 + n),
          deviceId: DEVICE_ID,
          lease: await leaseFor(userId, organizationId),
          organizationId,
          payload: {
            adjustments: [],
            items: [{ quantity: 1, variantId: uuid(7000 + n) }],
            occurredAt: new Date().toISOString(),
          },
          type: "sale.confirm",
        });
        return `${(await store.outbox.snapshot()).commands.length} na fila`;
      }),
    [ensure, organizationId, run, userId]
  );
  const handleCount = useCallback(
    () =>
      run("Conferir", async () => {
        const store = await ensure();
        return `${(await store.outbox.snapshot()).commands.length} operações guardadas`;
      }),
    [ensure, run]
  );
  const logout = useCallback(
    () =>
      run("Sair", async () => {
        const outcome = await attemptLogout([await workspace()]);
        if (outcome.status === "ready") {
          setBlocked(null);
          setLoggedOut(true);
          return "sessão encerrada, dados locais apagados";
        }
        setBlocked(outcome.blocked);
        return "bloqueado";
      }),
    [run, workspace]
  );
  const handleDiscard = useCallback(
    () =>
      run("Descartar e sair", async () => {
        const result = await discardAndLogout([await workspace()], {
          confirmed: true,
        });
        setBlocked(null);
        setLoggedOut(true);
        return `${result.discarded} descartadas, dados locais apagados`;
      }),
    [run, workspace]
  );
  const handleCancel = useCallback(() => {
    setBlocked(null);
    setMessage("Sair: cancelado, a sessão continua.");
  }, []);
  const handleAttention = useCallback(
    () => setMessage("Atenção: abriria o painel de operações recusadas."),
    []
  );
  const handleUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setUserId(event.currentTarget.value),
    []
  );
  const handleOrganization = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setOrganizationId(event.currentTarget.value),
    []
  );
  const handleOnline = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    networkRef.current.online = event.currentTarget.checked;
    setOnline(event.currentTarget.checked);
  }, []);
  const handleRefuses = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    networkRef.current.refuses = event.currentTarget.checked;
    setServerRefuses(event.currentTarget.checked);
  }, []);

  return (
    <main className="app-shell" style={{ padding: "1rem" }}>
      <h1>Laboratório da saída</h1>
      <p data-testid="message">{message}</p>
      {loggedOut ? <p data-testid="logged-out">Sessão encerrada.</p> : null}
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: "28rem" }}>
        <label>
          Usuário
          <input onChange={handleUser} value={userId} />
        </label>
        <label>
          Organização
          <input onChange={handleOrganization} value={organizationId} />
        </label>
        <label>
          <input checked={online} onChange={handleOnline} type="checkbox" />
          Rede disponível
        </label>
        <label>
          <input
            checked={serverRefuses}
            onChange={handleRefuses}
            type="checkbox"
          />
          Servidor recusa
        </label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button onClick={handleOpen} type="button">
          Abrir
        </button>
        <button onClick={handleEnqueue} type="button">
          Enfileirar operação
        </button>
        <button onClick={handleCount} type="button">
          Conferir dados
        </button>
        <button onClick={logout} type="button">
          Sair
        </button>
      </div>
      {blocked ? (
        <LogoutDialog
          blocked={blocked}
          onCancel={handleCancel}
          onDiscard={handleDiscard}
          onRetry={logout}
          onShowAttention={handleAttention}
        />
      ) : null}
    </main>
  );
}
