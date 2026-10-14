import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type {
  getSyncCursor,
  pullSyncChanges,
} from "@polaris/db/sync-repository";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface SyncRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface SyncRpcDependencies {
  defaultGetSyncCursor: typeof getSyncCursor;
  defaultPullSyncChanges: typeof pullSyncChanges;
  getSyncCursor: typeof getSyncCursor | undefined;
  pullSyncChanges: typeof pullSyncChanges | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

/**
 * The read side of sync (plan PR51): where the change log stands and what
 * changed after a cursor. Both need the `sync:read` capability in a tenant
 * transaction; the organization is authorized by the server, never trusted.
 */
export function createSyncRpcHandlers(dependencies: SyncRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<SyncRpcContext>();
  const cursorRepository =
    dependencies.getSyncCursor ?? dependencies.defaultGetSyncCursor;
  const pullRepository =
    dependencies.pullSyncChanges ?? dependencies.defaultPullSyncChanges;

  const getCursor = implementContract.sync.getCursor.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "sync:read",
          operation: async (transaction, identity) => ({
            cursor: String(await cursorRepository(transaction, identity)),
          }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  const pull = implementContract.sync.pull.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: "sync:read",
        operation: async (transaction, identity) => {
          const result = await pullRepository(transaction, identity, {
            cursor: input.cursor ?? null,
            limit: input.limit,
          });
          return {
            changes: result.changes,
            hasMore: result.hasMore,
            nextCursor: String(result.nextCursor),
          };
        },
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .catch(dependencies.toRpcError)
  );

  return { getCursor, pull };
}
