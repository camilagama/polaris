import type { Page } from "@playwright/test";

/** The ids of the commands waiting in every outbox database of the page, in the order they were kept. */
export async function outboxCommands(page: Page) {
  return await page.evaluate(async () => {
    const found: string[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of tiny databases
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (database.objectStoreNames.contains("commands")) {
        const rows = await new Promise<{ commandId: string; seq: number }[]>(
          (resolve, reject) => {
            const request = database
              .transaction("commands", "readonly")
              .objectStore("commands")
              .getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          }
        );
        rows.sort((a, b) => a.seq - b.seq);
        found.push(...rows.map(({ commandId }) => commandId));
      }
      database.close();
    }
    return found;
  });
}
