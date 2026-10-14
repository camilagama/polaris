import { type ChangeEvent, useCallback, useRef, useState } from "react";
import {
  type BootstrapCollectionName,
  bootstrapLocalStore,
  isLocalStoreReady,
  type LocalSyncMeta,
  pullLocalChanges,
} from "../offline/bootstrap";
import {
  type LocalStore,
  openLocalStore,
  wipeLocalStore,
} from "../offline/local-store";
import { localNamespace } from "../offline/namespace";
import { LabServer } from "./local-lab-server";

const COLLECTIONS = [
  "categories",
  "products",
  "variants",
  "inventory",
  "customers",
  "recentSales",
] as const;

interface Summary {
  counts: Record<(typeof COLLECTIONS)[number], number>;
  meta: LocalSyncMeta | null;
  sampleProduct: string;
}

const emptySummary: Summary = {
  counts: {
    categories: 0,
    customers: 0,
    inventory: 0,
    products: 0,
    recentSales: 0,
    variants: 0,
  },
  meta: null,
  sampleProduct: "",
};

async function summarize(store: LocalStore): Promise<Summary> {
  const counts = { ...emptySummary.counts };
  for (const name of COLLECTIONS) {
    // biome-ignore lint/performance/noAwaitInLoops: six small collections, read in turn
    counts[name] = (await store.collections[name].toArrayWhenReady()).length;
  }
  const products = await store.collections.products.toArrayWhenReady();
  const [first] = [...products].sort((a, b) => a.id.localeCompare(b.id));
  return {
    counts,
    meta: await store.writer.readMeta(),
    sampleProduct: first?.name ?? "",
  };
}

/**
 * Browser lab for the local collections (PR50): opens the OPFS store of a
 * namespace, bootstraps it from a synthetic server and shows what is on disk.
 * Only built in the offline-poc mode, like the persistence lab.
 */
export function LocalCollectionsLab() {
  const [userId, setUserId] = useState("user-a");
  const [organizationId, setOrganizationId] = useState("org-1");
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [message, setMessage] = useState("Nenhum armazenamento aberto.");
  const [removedFiles, setRemovedFiles] = useState("-");
  const [failOn, setFailOn] = useState<"" | BootstrapCollectionName>("");
  const storeRef = useRef<LocalStore | null>(null);
  const serverRef = useRef(
    new LabServer({ categories: 25, customers: 8, products: 12 })
  );

  const open = useCallback(async () => {
    if (storeRef.current) {
      await storeRef.current.close();
      storeRef.current = null;
    }
    const namespace = await localNamespace(userId, organizationId);
    storeRef.current = await openLocalStore(namespace);
    return storeRef.current;
  }, [organizationId, userId]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setMessage(`${label}…`);
      try {
        await action();
        const store = storeRef.current;
        if (store) {
          setSummary(await summarize(store));
        } else {
          setSummary(emptySummary);
        }
        setMessage(`${label}: concluído.`);
      } catch (error: unknown) {
        const store = storeRef.current;
        if (store) {
          setSummary(await summarize(store));
        }
        setMessage(
          `${label}: falhou (${error instanceof Error ? error.message : "erro"}).`
        );
      }
    },
    []
  );

  const handleUserChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setUserId(event.currentTarget.value),
    []
  );
  const handleOrganizationChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setOrganizationId(event.currentTarget.value),
    []
  );
  const handleFailChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setFailOn(event.currentTarget.value as "" | BootstrapCollectionName),
    []
  );
  const handleOpen = useCallback(
    () =>
      run("Abrir sem servidor", async () => {
        await open();
      }),
    [open, run]
  );
  const handleBootstrap = useCallback(
    () =>
      run("Sincronizar", async () => {
        const store = await open();
        serverRef.current.failOn = failOn === "" ? null : failOn;
        await bootstrapLocalStore(serverRef.current, store.writer, {
          pageSize: 5,
        });
      }),
    [failOn, open, run]
  );
  const handleChangeServer = useCallback(() => {
    serverRef.current.renameFirstProduct("Produto renomeado no servidor");
    serverRef.current.addCategory("Categoria nova do servidor");
    serverRef.current.removeFirstCustomer();
    setMessage("Servidor alterado: 1 produto, 1 categoria e 1 cliente.");
  }, []);
  const handleCatchUp = useCallback(
    () =>
      run("Aplicar mudanças", async () => {
        const store = storeRef.current ?? (await open());
        const meta = await store.writer.readMeta();
        const cursor = meta?.cursor ?? null;
        if (!isLocalStoreReady(meta) || cursor === null) {
          throw new Error("o armazenamento ainda não foi sincronizado");
        }
        await pullLocalChanges(serverRef.current, store.writer, cursor);
      }),
    [open, run]
  );
  const handleWipe = useCallback(
    () =>
      run("Apagar dados locais", async () => {
        const namespace = await localNamespace(userId, organizationId);
        if (storeRef.current) {
          await storeRef.current.close();
          storeRef.current = null;
        }
        const result = await wipeLocalStore(namespace);
        setRemovedFiles(String(result.removedFiles));
      }),
    [organizationId, run, userId]
  );
  const handleClose = useCallback(
    () =>
      run("Fechar", async () => {
        if (storeRef.current) {
          await storeRef.current.close();
          storeRef.current = null;
        }
      }),
    [run]
  );

  return (
    <main className="app-shell" style={{ padding: "1rem" }}>
      <h1>Coleções locais</h1>
      <p data-testid="message">{message}</p>
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: "28rem" }}>
        <label>
          Usuário
          <input onChange={handleUserChange} value={userId} />
        </label>
        <label>
          Organização
          <input onChange={handleOrganizationChange} value={organizationId} />
        </label>
        <label>
          Falhar na coleção
          <select onChange={handleFailChange} value={failOn}>
            <option value="">Nenhuma</option>
            <option value="inventory">inventory</option>
            <option value="customers">customers</option>
          </select>
        </label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button onClick={handleBootstrap} type="button">
          Sincronizar
        </button>
        <button onClick={handleOpen} type="button">
          Abrir sem servidor
        </button>
        <button onClick={handleChangeServer} type="button">
          Alterar servidor
        </button>
        <button onClick={handleCatchUp} type="button">
          Aplicar mudanças
        </button>
        <button onClick={handleClose} type="button">
          Fechar
        </button>
        <button onClick={handleWipe} type="button">
          Apagar dados locais
        </button>
      </div>
      <dl>
        <dt>Estado</dt>
        <dd data-testid="meta-status">{summary.meta?.status ?? "vazio"}</dd>
        <dt>Cursor</dt>
        <dd data-testid="meta-cursor">{summary.meta?.cursor ?? "-"}</dd>
        {COLLECTIONS.map((name) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd data-testid={`count-${name}`}>{summary.counts[name]}</dd>
          </div>
        ))}
        <dt>Arquivos removidos</dt>
        <dd data-testid="removed-files">{removedFiles}</dd>
        <dt>Produto de amostra</dt>
        <dd data-testid="sample-product">{summary.sampleProduct}</dd>
      </dl>
    </main>
  );
}
