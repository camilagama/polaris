import { implement, ORPCError } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import {
  legalAcceptanceStatus,
  readAcceptedLegalVersions,
  recordLegalAcceptance,
} from "../legal-acceptance";

interface AccountRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface AccountRpcDependencies {
  readAcceptedLegalVersions: typeof readAcceptedLegalVersions | undefined;
  recordLegalAcceptance: typeof recordLegalAcceptance | undefined;
  toRpcError: (error: unknown) => never;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
}

/**
 * The acceptance of the legal documents (ADR 0100), per user: what is still to accept and the
 * acceptance itself. Both are exempt from the acceptance control (`LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES`)
 * and go through the authentication connection, the only one that may execute the database functions.
 */
export function createAccountRpcHandlers(dependencies: AccountRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<AccountRpcContext>();
  const readAccepted =
    dependencies.readAcceptedLegalVersions ?? readAcceptedLegalVersions;
  const record = dependencies.recordLegalAcceptance ?? recordLegalAcceptance;

  const legalStatus = implementContract.account.legalStatus.handler(
    ({ context }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (_database, session, authConnection) =>
            legalAcceptanceStatus(
              await readAccepted(authConnection, session.user.id)
            ),
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const acceptLegal = implementContract.account.acceptLegal.handler(
    ({ context, input }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (_database, session, authConnection) => {
            // only the version in force can be accepted: an older screen reads the status again
            if (
              input.documents.some(
                (item) =>
                  item.version !== LEGAL_DOCUMENTS[item.document].version
              )
            ) {
              throw new ORPCError("CONFLICT", {
                data: { reason: "legal_version_mismatch" },
              });
            }
            for (const item of input.documents) {
              // biome-ignore lint/performance/noAwaitInLoops: one document at a time, at most two
              await record(authConnection, {
                document: item.document,
                origin: "reaceite",
                requestId: context.requestId,
                userId: session.user.id,
              });
            }
            return legalAcceptanceStatus(
              await readAccepted(authConnection, session.user.id)
            );
          },
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  return { acceptLegal, legalStatus };
}
