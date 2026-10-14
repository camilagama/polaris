import { openLocalStore } from "../local-store";
import type { LocalNamespace } from "../namespace";
import { openOutboxStore } from "../outbox/outbox-store";
import type { OpenedStores } from "./offline-runtime";

/** Opens the two durable stores of a namespace: the outbox (IndexedDB) and the local collections (OPFS). */
export async function openRuntimeStores(
  namespace: LocalNamespace,
  deviceId: string
): Promise<OpenedStores> {
  const outbox = await openOutboxStore(namespace, deviceId);
  try {
    const local = await openLocalStore(namespace);
    return {
      close: async () => {
        outbox.close();
        await local.close();
      },
      outbox: outbox.outbox,
      writer: local.writer,
    };
  } catch (error) {
    outbox.close();
    throw error;
  }
}
