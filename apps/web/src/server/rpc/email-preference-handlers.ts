import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  readActivationPreference,
  setActivationTips,
} from "@polaris/db/activation-preference";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface EmailPreferenceRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface EmailPreferenceRpcDependencies {
  readPreference: typeof readActivationPreference | undefined;
  setTips: typeof setActivationTips | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "organization:export";

/**
 * The preference of the tips e-mails in Seus dados (ADR 0106, D8). It asks what the tab asks, `organization:export`,
 * in the tenant context, and only then calls the two functions of migration 0134 inside that same transaction, with
 * the tenant role, the one that may execute them: one connection per call, none of its own. The person is always
 * `identity.userId`, the session's, taken by the server: the input has no user field, and the organization of the
 * input only names the store whose permission the owner shows.
 */
export function createEmailPreferenceRpcHandlers(
  dependencies: EmailPreferenceRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<EmailPreferenceRpcContext>();
  const readPreference =
    dependencies.readPreference ?? readActivationPreference;
  const setTips = dependencies.setTips ?? setActivationTips;

  const emailPreference = implementContract.account.emailPreference.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: (transaction, identity) =>
            readPreference(transaction, identity.userId),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  const setTipsHandler = implementContract.account.setTips.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: (transaction, identity) =>
            setTips(transaction, identity.userId, input.on),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { emailPreference, setTips: setTipsHandler };
}
