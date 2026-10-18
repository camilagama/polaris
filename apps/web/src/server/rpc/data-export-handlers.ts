import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  listDataExports,
  requestDataExport,
} from "@polaris/db/data-export-repository";
import type { ExportFormat } from "@polaris/domain/privacy/data-export";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface DataExportRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

const defaultDataExportRepository = { listDataExports, requestDataExport };

/** The repository functions the handlers call; tests replace any of them. */
export type DataExportRepository = typeof defaultDataExportRepository;

interface DataExportRpcDependencies {
  dataExportRepository: Partial<DataExportRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "organization:export";

/**
 * Asking for a copy of the organization's data and following it (ADR 0078). Both need
 * `organization:export`. Building the files is the background job's work, not the request's.
 */
export function createDataExportRpcHandlers(
  dependencies: DataExportRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<DataExportRpcContext>();
  const repository = {
    ...defaultDataExportRepository,
    ...dependencies.dataExportRepository,
  };

  const list = implementContract.dataExport.list.handler(({ context, input }) =>
    dependencies
      .withTenantRequestContext({
        bindings: context.bindings,
        capability: CAPABILITY,
        operation: async (transaction, identity) => ({
          exports: (
            await repository.listDataExports(transaction, identity)
          ).map((item) => ({
            errorCode: item.errorCode,
            expiresAt: item.expiresAt?.toISOString() ?? null,
            files: item.files,
            formats: item.formats as ExportFormat[],
            id: item.id,
            readyAt: item.readyAt?.toISOString() ?? null,
            requestedAt: item.requestedAt.toISOString(),
            status: item.status as
              | "requested"
              | "running"
              | "ready"
              | "failed"
              | "expired",
            totalBytes: item.totalBytes,
          })),
        }),
        request: context.request,
        requestedOrganizationId: input.organizationId,
      })
      .catch(dependencies.toRpcError)
  );

  const request = implementContract.dataExport.request.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: (transaction, identity) =>
            repository.requestDataExport(transaction, identity, {
              formats: input.formats,
              requestId: dependencies.requestAuditId(context.requestId),
            }),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { list, request };
}
