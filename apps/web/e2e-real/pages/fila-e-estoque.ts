import type { Page } from "@playwright/test";
import type { test } from "../fixtures";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

/** The commands the device keeps to send (IndexedDB stores named `commands`), whatever their status. */
export function queuedCommands(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let total = 0;
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
        total += await new Promise<number>((resolve, reject) => {
          const request = database
            .transaction("commands", "readonly")
            .objectStore("commands")
            .count();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }
      database.close();
    }
    return total;
  });
}

export async function movements(sql: Sql, variantId: string): Promise<number> {
  const [row] = (
    await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1",
      [variantId]
    )
  ).rows;
  return row?.n ?? 0;
}
