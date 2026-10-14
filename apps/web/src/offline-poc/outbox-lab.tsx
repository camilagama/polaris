import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { signOfflineLease } from "../lib/offline-lease-token";
import { localNamespace } from "../offline/namespace";
import type { OutboxCommand } from "../offline/outbox/command";
import {
  type OutboxStore,
  openOutboxStore,
  wipeOutboxStore,
} from "../offline/outbox/outbox-store";
import { requestPersistentStorage } from "../offline/persistence";

/** Browser lab for the durable outbox (PR52). Synthetic keys and data only. */
const DEVICE_ID = "0199c2d0-0000-7000-8000-0000000000d1";
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function leaseFor(
  userId: string,
  organizationId: string,
  expired: boolean
) {
  const now = Date.now();
  const issuedAt = new Date(expired ? now - 80 * HOUR : now - HOUR);
  const expiresAt = new Date(expired ? now - 10 * HOUR : now + 24 * HOUR);
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId: DEVICE_ID,
      epoch: 0,
      expiresAt,
      grantId: uuid(9000),
      issuedAt,
      organizationId,
      userId,
    }),
    LAB_KEY
  );
}

function describeCommand(command: OutboxCommand): string {
  const reason = command.rejection ? `:${command.rejection.code}` : "";
  return `${command.seq}:${command.status}${reason}:${command.commandId.slice(-4)}:a${command.attempts}`;
}

export function OutboxLab() {
  const [userId, setUserId] = useState("user-a");
  const [organizationId, setOrganizationId] = useState("org-1");
  const [expiredLease, setExpiredLease] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [counts, setCounts] = useState({ pending: 0, rejected: 0, sending: 0 });
  const [message, setMessage] = useState("Outbox fechado.");
  const [persistent, setPersistent] = useState("não solicitado");
  const storeRef = useRef<OutboxStore | null>(null);
  const counterRef = useRef(1);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) {
      setItems([]);
      setCounts({ pending: 0, rejected: 0, sending: 0 });
      return;
    }
    const snapshot = await store.outbox.snapshot();
    setItems(snapshot.commands.map(describeCommand));
    setCounts({
      pending: snapshot.pending,
      rejected: snapshot.rejected,
      sending: snapshot.sending,
    });
  }, []);

  const run = useCallback(
    async (label: string, action: () => Promise<string | undefined>) => {
      try {
        const detail = await action();
        await refresh();
        setMessage(`${label}: ok${detail ? ` (${detail})` : ""}`);
      } catch (error: unknown) {
        await refresh();
        setMessage(
          `${label}: erro ${error instanceof Error ? error.name : "desconhecido"} ${error instanceof Error ? error.message : ""}`
        );
      }
    },
    [refresh]
  );

  const open = useCallback(async () => {
    storeRef.current?.close();
    const namespace = await localNamespace(userId, organizationId);
    storeRef.current = await openOutboxStore(namespace, DEVICE_ID);
    return storeRef.current;
  }, [organizationId, userId]);

  const ensure = useCallback(
    async () => storeRef.current ?? (await open()),
    [open]
  );

  const enqueue = useCallback(
    (repeat: boolean) =>
      run(repeat ? "Repetir comando" : "Enfileirar", async () => {
        const store = await ensure();
        const n = repeat ? counterRef.current - 1 : counterRef.current;
        if (!repeat) {
          counterRef.current = n + 1;
        }
        const command = await store.outbox.enqueue({
          baseVersion: n,
          commandId: uuid(100 + n),
          deviceId: DEVICE_ID,
          lease: await leaseFor(userId, organizationId, expiredLease),
          organizationId,
          payload: { n, note: "venda sintética" },
          type: "sale.confirm",
        });
        return `seq ${command.seq}`;
      }),
    [ensure, expiredLease, organizationId, run, userId]
  );

  const head = useCallback(async () => {
    const store = await ensure();
    const first = (await store.outbox.snapshot()).commands.at(0);
    if (!first) {
      throw new Error("outbox vazio");
    }
    return { first, store };
  }, [ensure]);

  const handleOpen = useCallback(
    () =>
      run("Abrir", async () => {
        await open();
      }),
    [open, run]
  );
  const handleEnqueue = useCallback(() => enqueue(false), [enqueue]);
  const handleRepeat = useCallback(() => enqueue(true), [enqueue]);
  const handleSend = useCallback(
    () =>
      run("Enviar", async () => {
        const store = await ensure();
        const next = await store.outbox.next();
        if (!next) {
          throw new Error("nada para enviar");
        }
        await store.outbox.markSending(next.commandId);
      }),
    [ensure, run]
  );
  const handleAck = useCallback(
    () =>
      run("Confirmar", async () => {
        const { first, store } = await head();
        await store.outbox.acknowledge(first.commandId);
      }),
    [head, run]
  );
  const handleReject = useCallback(
    () =>
      run("Rejeitar", async () => {
        const { first, store } = await head();
        await store.outbox.reject(first.commandId, "stock_insufficient");
      }),
    [head, run]
  );
  const handleRetry = useCallback(
    () =>
      run("Tentar de novo", async () => {
        const { first, store } = await head();
        await store.outbox.retry(first.commandId);
      }),
    [head, run]
  );
  const handleRecover = useCallback(
    () =>
      run("Recuperar", async () => {
        const store = await ensure();
        return `${await store.outbox.recoverInterrupted()} recuperados`;
      }),
    [ensure, run]
  );
  const handleWipe = useCallback(
    (discardPending: boolean) =>
      run(discardPending ? "Apagar descartando" : "Apagar", async () => {
        storeRef.current?.close();
        storeRef.current = null;
        const namespace = await localNamespace(userId, organizationId);
        const result = await wipeOutboxStore(namespace, { discardPending });
        return `${result.discarded} descartados`;
      }),
    [organizationId, run, userId]
  );
  const handleWipeSafely = useCallback(() => handleWipe(false), [handleWipe]);
  const handleWipeDiscarding = useCallback(
    () => handleWipe(true),
    [handleWipe]
  );
  const handlePersist = useCallback(async () => {
    setPersistent(await requestPersistentStorage());
  }, []);
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
  const handleExpired = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setExpiredLease(event.currentTarget.checked),
    []
  );

  return (
    <main className="app-shell" style={{ padding: "1rem" }}>
      <h1>Outbox de comandos</h1>
      <p data-testid="message">{message}</p>
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
          <input
            checked={expiredLease}
            onChange={handleExpired}
            type="checkbox"
          />
          Lease vencido
        </label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button onClick={handleOpen} type="button">
          Abrir
        </button>
        <button onClick={handleEnqueue} type="button">
          Enfileirar
        </button>
        <button onClick={handleRepeat} type="button">
          Repetir comando
        </button>
        <button onClick={handleSend} type="button">
          Enviar
        </button>
        <button onClick={handleAck} type="button">
          Confirmar
        </button>
        <button onClick={handleReject} type="button">
          Rejeitar
        </button>
        <button onClick={handleRetry} type="button">
          Tentar de novo
        </button>
        <button onClick={handleRecover} type="button">
          Recuperar
        </button>
        <button onClick={handleWipeSafely} type="button">
          Apagar
        </button>
        <button onClick={handleWipeDiscarding} type="button">
          Apagar descartando
        </button>
        <button onClick={handlePersist} type="button">
          Pedir armazenamento persistente
        </button>
      </div>
      <dl>
        <dt>Persistente</dt>
        <dd data-testid="persistent">{persistent}</dd>
        <dt>Pendentes</dt>
        <dd data-testid="count-pending">{counts.pending}</dd>
        <dt>Enviando</dt>
        <dd data-testid="count-sending">{counts.sending}</dd>
        <dt>Rejeitados</dt>
        <dd data-testid="count-rejected">{counts.rejected}</dd>
      </dl>
      <ol data-testid="outbox-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    </main>
  );
}
