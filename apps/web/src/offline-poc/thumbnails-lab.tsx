import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import {
  ProductThumbnail,
  ThumbnailProvider,
} from "../catalog/product-thumbnail";
import { THUMBNAIL_CACHE_BUDGET_BYTES } from "../catalog/thumbnail-cache";
import type { ThumbnailTransport } from "../catalog/thumbnail-transport";
import {
  purgeNamespace,
  wipeNamespaceCollections,
} from "../offline/logout-purge";
import { localNamespace } from "../offline/namespace";
import { wipeOutboxStore } from "../offline/outbox/outbox-store";
import { openThumbnailDisk } from "../offline/thumbnail-store";
import "./lab-page.css";

/**
 * Browser lab of the thumbnails on the disk: the real IndexedDB store of a namespace, the real wipes (logout,
 * revocation, emptying the queue) and the real provider switching stores, with a simulated server that answers a
 * synthetic image for the ids of the store it is asked about. Only built in the offline-poc mode. Synthetic data.
 */
const KB = 1024;
const STORE_ASSETS: Record<string, string> = {
  "org-1": "0199c2d0-0000-7000-8000-000000000a01",
  "org-2": "0199c2d0-0000-7000-8000-000000000a02",
};

/** A square in one chart token, drawn here: the lab never ships an image file. */
function photo(token: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.resolve(null);
  }
  context.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  context.fillRect(0, 0, 320, 320);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp"));
}

/** The simulated server: an image only for the ids of the store asked about, like the real route (AC-10). */
/** Bytes the server sent that are no image: the box keeps the marker. */
const BROKEN_ASSET = "0199c2d0-0000-7000-8000-000000000a0f";

const labTransport: ThumbnailTransport = async ({ ids, organizationId }) => {
  const own = STORE_ASSETS[organizationId];
  const image = own
    ? await photo(organizationId === "org-1" ? "--chart-1" : "--chart-2")
    : null;
  const broken = new Blob(["not an image"], { type: "image/webp" });
  return {
    items: new Map(
      ids.map((id) => {
        if (id === BROKEN_ASSET) {
          return [id, broken];
        }
        return [id, id === own ? image : null];
      })
    ),
    kind: "ok",
  };
};

export function ThumbnailsLab() {
  const [userId, setUserId] = useState("user-a");
  const [organizationId, setOrganizationId] = useState("org-1");
  const [showing, setShowing] = useState<{
    namespaceKey: string | null;
    organizationId: string;
  } | null>(null);
  const [message, setMessage] = useState("Laboratório fechado.");

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

  const namespace = useCallback(
    () => localNamespace(userId, organizationId),
    [organizationId, userId]
  );

  const handleWrite = useCallback(
    () =>
      run("Gravar", async () => {
        const count = Number(
          (document.getElementById("lab-count") as HTMLInputElement).value
        );
        const size = Number(
          (document.getElementById("lab-size") as HTMLInputElement).value
        );
        const disk = await openThumbnailDisk((await namespace()).key);
        try {
          for (let index = 0; index < count; index += 1) {
            // biome-ignore lint/performance/noAwaitInLoops: one use after the other, in order
            await disk.write(
              `lab-${index}`,
              new ArrayBuffer(size * KB),
              index + 1,
              THUMBNAIL_CACHE_BUDGET_BYTES
            );
          }
        } finally {
          disk.close();
        }
        return `${count}`;
      }),
    [namespace, run]
  );

  const handleKey = useCallback(
    () => run("Chave", async () => (await namespace()).key),
    [namespace, run]
  );
  const handleLogout = useCallback(
    () =>
      run("Sair", async () => {
        await purgeNamespace(await namespace(), { discardPending: true });
      }),
    [namespace, run]
  );
  const handleRevoke = useCallback(
    () =>
      run("Revogar", async () => {
        await wipeNamespaceCollections(await namespace());
      }),
    [namespace, run]
  );
  const handleClearOutbox = useCallback(
    () =>
      run("Esvaziar fila", async () => {
        await wipeOutboxStore(await namespace(), { discardPending: true });
      }),
    [namespace, run]
  );
  const handleShow = useCallback(
    () =>
      run("Mostrar", async () => {
        const { key } = await namespace();
        setShowing({ namespaceKey: key, organizationId });
        return key;
      }),
    [namespace, organizationId, run]
  );
  const handleShowMemory = useCallback(() => {
    setShowing({ namespaceKey: null, organizationId });
    setMessage("Mostrar sem cópia: ok");
  }, [organizationId]);

  const onUser = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setUserId(event.target.value),
    []
  );
  const onOrganization = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setOrganizationId(event.target.value),
    []
  );

  const assetIds = useMemo(
    () => [...Object.values(STORE_ASSETS), BROKEN_ASSET],
    []
  );

  return (
    <main className="lab-page">
      <h1>Miniaturas no aparelho</h1>
      <label>
        Usuário <input onChange={onUser} value={userId} />
      </label>
      <label>
        Organização <input onChange={onOrganization} value={organizationId} />
      </label>
      <label>
        Quantidade <input defaultValue="1" id="lab-count" />
      </label>
      <label>
        Tamanho em KB <input defaultValue="25" id="lab-size" />
      </label>
      <div>
        <button onClick={handleKey} type="button">
          Chave
        </button>
        <button onClick={handleWrite} type="button">
          Gravar
        </button>
        <button onClick={handleLogout} type="button">
          Sair
        </button>
        <button onClick={handleRevoke} type="button">
          Revogar
        </button>
        <button onClick={handleClearOutbox} type="button">
          Esvaziar fila
        </button>
        <button onClick={handleShow} type="button">
          Mostrar
        </button>
        <button onClick={handleShowMemory} type="button">
          Mostrar sem cópia
        </button>
      </div>
      <p data-testid="message">{message}</p>
      {showing ? (
        <ThumbnailProvider
          namespaceKey={showing.namespaceKey}
          organizationId={showing.organizationId}
          transport={labTransport}
        >
          <ul data-testid="thumbnails">
            {assetIds.map((id) => (
              <li data-asset-id={id} key={id}>
                <ProductThumbnail assetId={id} name="Camiseta" size={40} />
              </li>
            ))}
          </ul>
        </ThumbnailProvider>
      ) : null}
    </main>
  );
}
