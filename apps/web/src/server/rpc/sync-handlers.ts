import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type { readBootstrapPage } from "@polaris/db/bootstrap-repository";
import type { runSyncCommand } from "@polaris/db/sync-command-repository";
import type {
  getSyncCursor,
  pullSyncChanges,
} from "@polaris/db/sync-repository";
import { logger } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import { offlineLeaseKeys } from "../offline-lease-service";
import { syncPayloadHashKeys } from "../sync/payload-hash";
import { pushCommands, type SyncCommandHandler } from "../sync/push";
import type { withTenantRequestContext } from "../tenant-request-context";

interface SyncRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface SyncRpcDependencies {
  commandHandlers: readonly SyncCommandHandler[];
  defaultGetSyncCursor: typeof getSyncCursor;
  defaultPullSyncChanges: typeof pullSyncChanges;
  defaultReadBootstrapPage: typeof readBootstrapPage;
  defaultRunSyncCommand: typeof runSyncCommand;
  getSyncCursor: typeof getSyncCursor | undefined;
  now: () => Date;
  pullSyncChanges: typeof pullSyncChanges | undefined;
  readBootstrapPage: typeof readBootstrapPage | undefined;
  runSyncCommand: typeof runSyncCommand | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

/**
 * The signal of the sync rejection alert (PR119, ADR 0095): one event per rejected command, with the stable
 * rejection code in `reason` and nothing of the command (no payload, no type, no ids of the device or the
 * organization). A batch stops at its first rejection, so at most one line per push; a replay of a rejection already
 * stored is not counted again (a code that is not stored counts every retry).
 */
function logRejections(
  results: readonly {
    code: string | null;
    replayed: boolean;
    status: string;
  }[],
  requestId: string
): void {
  for (const result of results) {
    // a replay of a stored rejection is the same rejection, not a new one (a code that is never stored, such as `session_changed`, counts every retry)
    if (result.status === "rejected" && !result.replayed) {
      logger.warn("sync_push_command_rejected", {
        outcome: "rejected",
        reason: result.code ?? "unknown",
        requestId,
      });
    }
  }
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

  const bootstrapRepository =
    dependencies.readBootstrapPage ?? dependencies.defaultReadBootstrapPage;
  const bootstrapPage = implementContract.sync.bootstrapPage.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "sync:read",
          operation: (transaction, identity) =>
            bootstrapRepository(transaction, identity, {
              afterId: input.afterId ?? null,
              collection: input.collection,
              ids: input.ids ?? null,
              limit: input.limit,
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

  const runCommand =
    dependencies.runSyncCommand ?? dependencies.defaultRunSyncCommand;
  const push = implementContract.sync.push.handler(
    async ({ context, input }) => {
      try {
        // Fails closed (503) before touching anything when no lease secret or
        // no content-hash secret exists.
        const keys = offlineLeaseKeys(context.bindings);
        const hashKeys = syncPayloadHashKeys(context.bindings);
        const results = await pushCommands(input.commands, {
          handlers: dependencies.commandHandlers,
          hashKeys,
          keys,
          now: dependencies.now,
          runSyncCommand: runCommand,
          withTenant: (operation) =>
            dependencies.withTenantRequestContext({
              bindings: context.bindings,
              capability: "sync:push",
              operation,
              request: context.request,
              requestedOrganizationId: input.organizationId,
            }),
        });
        logRejections(results, context.requestId);
        return { results };
      } catch (error) {
        return dependencies.toRpcError(error);
      }
    }
  );

  return { bootstrapPage, getCursor, pull, push };
}
