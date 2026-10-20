import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  listClosedDataExports,
  requestClosedDataExport,
} from "@polaris/db/closed-organization-repository";
import {
  listDataExports,
  requestDataExport,
} from "@polaris/db/data-export-repository";
import { FreshSessionRequiredError } from "@polaris/db/device-repository";
import type { ExportFormat } from "@polaris/domain/privacy/data-export";
import { isSessionFresh } from "../auth/session-policy";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface DataExportRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

const defaultDataExportRepository = {
  listClosedDataExports,
  listDataExports,
  requestClosedDataExport,
  requestDataExport,
};

/** The repository functions the handlers call; tests replace any of them. */
export type DataExportRepository = typeof defaultDataExportRepository;

interface DataExportRpcDependencies {
  dataExportRepository: Partial<DataExportRepository> | undefined;
  requestAuditId: (requestId: string) => string | null;
  toRpcError: (error: unknown) => never;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "organization:export";

type ExportStatus = "requested" | "running" | "ready" | "failed" | "expired";

/**
 * Asking for a copy of the organization's data and following it (ADR 0078). Both need
 * `organization:export`. Building the files is the background job's work, not the request's.
 * A closed organization's copy (ADR 0081) is asked for and followed outside the tenant, which
 * no longer opens: the database checks the owner, and asking needs a session signed in within
 * 15 minutes (the copy holds the customers' personal data), following it does not.
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
            status: item.status as ExportStatus,
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

  const listClosed = implementContract.dataExport.listClosed.handler(
    ({ context, input }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (database, session) => ({
            exports: (
              await repository.listClosedDataExports(
                database,
                session.user.id,
                input.organizationId
              )
            ).map((item) => ({
              errorCode: item.errorCode,
              expiresAt: item.expiresAt?.toISOString() ?? null,
              files: item.files,
              formats: item.formats as ExportFormat[],
              id: item.id,
              mode: item.mode,
              readyAt: item.readyAt?.toISOString() ?? null,
              requestedAt: item.requestedAt.toISOString(),
              status: item.status as ExportStatus,
              totalBytes: item.totalBytes,
            })),
          }),
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const requestClosed = implementContract.dataExport.requestClosed.handler(
    ({ context, input }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: (database, session) => {
            if (!isSessionFresh(session.session.createdAt)) {
              throw new FreshSessionRequiredError();
            }
            return repository.requestClosedDataExport(
              database,
              session.user.id,
              {
                formats: input.formats,
                organizationId: input.organizationId,
                requestId: dependencies.requestAuditId(context.requestId),
              }
            );
          },
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  return { list, listClosed, request, requestClosed };
}
