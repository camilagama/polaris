import type {
  BootstrapPageReadModel,
  SaleListEntryReadModel,
  SyncChangeReadModel,
} from "@polaris/contracts";
import type {
  BootstrapCollectionName,
  BootstrapPageRequest,
  BootstrapSource,
  LocalRows,
} from "./bootstrap";

/** How many of the latest sales a device keeps locally. */
export const RECENT_SALES_WINDOW = 100;

/** The slice of the oRPC client the bootstrap source needs. */
export interface OfflineSyncClient {
  sale: {
    list: (input: {
      limit: number;
      offset: number;
      organizationId: string;
    }) => Promise<{ hasMore: boolean; sales: SaleListEntryReadModel[] }>;
  };
  sync: {
    bootstrapPage: (input: {
      afterId?: string | null;
      collection: BootstrapCollectionName;
      ids?: string[] | null;
      limit?: number;
      organizationId: string;
    }) => Promise<BootstrapPageReadModel>;
    getCursor: (input: {
      organizationId: string;
    }) => Promise<{ cursor: string }>;
    pull: (input: {
      cursor?: string | null;
      limit?: number;
      organizationId: string;
    }) => Promise<{
      changes: SyncChangeReadModel[];
      hasMore: boolean;
      nextCursor: string;
    }>;
  };
}

/** The server answered a different collection than the one asked for. */
export class BootstrapResponseMismatchError extends Error {
  constructor() {
    super("bootstrap_response_mismatch");
    this.name = "BootstrapResponseMismatchError";
  }
}

/** The real source: the server's sync procedures for one organization. */
export function createOrpcBootstrapSource(
  client: OfflineSyncClient,
  organizationId: string
): BootstrapSource {
  return {
    async getCursor() {
      return (await client.sync.getCursor({ organizationId })).cursor;
    },
    async page<K extends BootstrapCollectionName>(
      collection: K,
      request: BootstrapPageRequest
    ) {
      const page = await client.sync.bootstrapPage({
        afterId: request.afterId ?? null,
        collection,
        ids: request.ids ?? null,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        organizationId,
      });
      if (page.collection !== collection) {
        throw new BootstrapResponseMismatchError();
      }
      return {
        nextAfterId: page.nextAfterId,
        rows: page.rows as unknown as LocalRows[K][],
      };
    },
    pull(cursor, limit) {
      return client.sync.pull({ cursor, limit, organizationId });
    },
    async recentSales() {
      const result = await client.sale.list({
        limit: RECENT_SALES_WINDOW,
        offset: 0,
        organizationId,
      });
      return result.sales;
    },
  };
}
