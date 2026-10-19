import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { signOfflineLease } from "../lib/offline-lease-token";
import {
  type AttentionItem,
  type AttentionSummary,
  buildAttention,
  discardAttentionItem,
  resubmitAttentionItem,
} from "../offline/attention";
import { AttentionPanel } from "../offline/attention-panel";
import type { LocalWriter } from "../offline/bootstrap";
import { localNamespace } from "../offline/namespace";
import {
  type OutboxStore,
  openOutboxStore,
} from "../offline/outbox/outbox-store";

/**
 * Browser lab for the attention panel (PR58): the real panel over the real
 * IndexedDB outbox, with synthetic refused commands. Only built in the
 * offline-poc mode. Synthetic keys and data only.
 */
const DEVICE_ID = "0199c2d0-0000-7000-8000-0000000000d1";
const LAB_KEY = {
  id: "lab",
  secret: "lab-secret-lab-secret-lab-secret-0123456789",
};
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const EMPTY: AttentionSummary = { items: [], waitingBehind: 0 };

/** The lab holds no local collections; discarding only has to reach the outbox. */
const noCollections: LocalWriter = {
  keys: () => Promise.resolve([]),
  readMeta: () => Promise.resolve(null),
  recentSalesRows: () => Promise.resolve([]),
  remove: () => Promise.resolve(),
  replaceRecentSales: () => Promise.resolve(),
  rows: () => Promise.resolve([]),
  upsert: () => Promise.resolve(),
  variantKeysOfProducts: () => Promise.resolve([]),
  writeMeta: () => Promise.resolve(),
};

async function leaseFor(userId: string, organizationId: string) {
  const now = Date.now();
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create", "product:create"],
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

const salePayload = (n: number) => ({
  adjustments: [],
  items: [
    {
      chargedUnitPrice: "10.00",
      listedUnitPrice: "10.00",
      quantity: 1,
      variantId: uuid(7000 + n),
    },
  ],
  occurredAt: new Date().toISOString(),
  payment: {
    anticipationRequested: false,
    installmentPlan: null,
    installments: null,
    method: "pix",
  },
  recordedAt: new Date().toISOString(),
});

const productPayload = (n: number) => ({
  categoryId: null,
  description: null,
  initialStock: null,
  listPrice: null,
  name: "Camiseta do laboratório",
  productId: uuid(8000 + n),
  sku: "CAM-LAB",
  variantId: uuid(9100 + n),
});

export function AttentionLab() {
  const [userId, setUserId] = useState("user-a");
  const [organizationId, setOrganizationId] = useState("org-1");
  const [summary, setSummary] = useState<AttentionSummary>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Laboratório fechado.");
  const storeRef = useRef<OutboxStore | null>(null);
  const counterRef = useRef(1);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    setSummary(store ? buildAttention(await store.outbox.snapshot()) : EMPTY);
  }, []);

  const ensure = useCallback(async () => {
    if (storeRef.current) {
      return storeRef.current;
    }
    const namespace = await localNamespace(userId, organizationId);
    storeRef.current = await openOutboxStore(namespace, DEVICE_ID);
    return storeRef.current;
  }, [organizationId, userId]);

  const run = useCallback(
    async (label: string, action: () => Promise<string | undefined>) => {
      try {
        const detail = await action();
        await refresh();
        setMessage(`${label}: ok${detail ? ` (${detail})` : ""}`);
      } catch (error: unknown) {
        await refresh();
        setMessage(
          `${label}: erro ${error instanceof Error ? error.message : "desconhecido"}`
        );
      }
    },
    [refresh]
  );

  /** Queues a command and, when a code is given, has the server refuse it. */
  const seed = useCallback(
    async (type: string, payload: object, refusal: string | null) => {
      const store = await ensure();
      counterRef.current += 1;
      const n = counterRef.current;
      const command = await store.outbox.enqueue({
        baseVersion: null,
        commandId: uuid(100 + n),
        deviceId: DEVICE_ID,
        lease: await leaseFor(userId, organizationId),
        organizationId,
        payload: payload as never,
        type,
      });
      if (refusal) {
        await store.outbox.markSending(command.commandId);
        await store.outbox.reject(command.commandId, refusal);
      }
    },
    [ensure, organizationId, userId]
  );

  const handleOpen = useCallback(
    () =>
      run("Abrir", async () => {
        await ensure();
      }),
    [ensure, run]
  );
  const handleStockSale = useCallback(
    () =>
      run("Venda recusada", () =>
        seed(
          "sale.confirm",
          salePayload(counterRef.current + 1),
          "insufficient_stock"
        ).then(() => undefined)
      ),
    [run, seed]
  );
  const handleSkuProduct = useCallback(
    () =>
      run("Produto recusado", () =>
        seed(
          "product.create",
          productPayload(counterRef.current + 1),
          "sku_conflict"
        ).then(() => undefined)
      ),
    [run, seed]
  );
  const handleEntitlement = useCallback(
    () =>
      run("Direito alterado", () =>
        seed(
          "sale.confirm",
          salePayload(counterRef.current + 1),
          "entitlement_changed"
        ).then(() => undefined)
      ),
    [run, seed]
  );
  const handleWaiting = useCallback(
    () =>
      run("Venda na fila", () =>
        seed("sale.confirm", salePayload(counterRef.current + 1), null).then(
          () => undefined
        )
      ),
    [run, seed]
  );

  const resolve = useCallback(
    (label: string, item: AttentionItem, action: () => Promise<void>) => {
      setBusy(item.commandId);
      run(label, async () => {
        await action();
      })
        .catch(() => undefined)
        .finally(() => setBusy(null));
    },
    [run]
  );
  const handleDiscard = useCallback(
    (item: AttentionItem) =>
      resolve("Descartar", item, async () => {
        const store = await ensure();
        await discardAttentionItem(item, {
          outbox: store.outbox,
          writer: noCollections,
        });
      }),
    [ensure, resolve]
  );
  const handleResubmit = useCallback(
    (item: AttentionItem) =>
      resolve("Reenviar", item, async () => {
        const store = await ensure();
        await resubmitAttentionItem(item, {
          lease: await leaseFor(userId, organizationId),
          outbox: store.outbox,
        });
      }),
    [ensure, organizationId, resolve, userId]
  );
  const handleReviewAccount = useCallback(
    () => setMessage("Revisar acesso: abriria a tela de conta e plano."),
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

  return (
    <main className="app-shell" style={{ padding: "1rem" }}>
      <h1>Laboratório da atenção</h1>
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
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button onClick={handleOpen} type="button">
          Abrir
        </button>
        <button onClick={handleStockSale} type="button">
          Criar venda recusada por estoque
        </button>
        <button onClick={handleSkuProduct} type="button">
          Criar produto recusado por SKU
        </button>
        <button onClick={handleEntitlement} type="button">
          Criar venda recusada por direito
        </button>
        <button onClick={handleWaiting} type="button">
          Criar venda na fila
        </button>
      </div>
      <AttentionPanel
        busyCommandId={busy}
        onDiscard={handleDiscard}
        onResubmit={handleResubmit}
        onReviewAccount={handleReviewAccount}
        summary={summary}
      />
    </main>
  );
}
