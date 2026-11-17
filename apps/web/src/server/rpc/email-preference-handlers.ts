import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  type ActivationPreference,
  type ActivationPreferenceClient,
  createActivationPreferenceClient,
} from "@polaris/db/activation-preference";
import type { WorkerBindings } from "../environment";
import type { withTenantRequestContext } from "../tenant-request-context";

interface EmailPreferenceRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface EmailPreferenceRpcDependencies {
  createPreferenceClient:
    | ((connectionString: string) => ActivationPreferenceClient)
    | undefined;
  toRpcError: (error: unknown) => never;
  withTenantRequestContext: typeof withTenantRequestContext;
}

const CAPABILITY = "organization:export";

/**
 * The preference of the tips e-mails in Seus dados (ADR 0106, D8). It asks what the tab asks, `organization:export`,
 * in the tenant context, and only then calls the two functions of migration 0134 on the tenant connection, the one
 * role that may execute them. The person is always `identity.userId`, the session's, taken by the server: the input
 * has no user field, and the organization of the input only names the store whose permission the owner shows.
 */
export function createEmailPreferenceRpcHandlers(
  dependencies: EmailPreferenceRpcDependencies
) {
  const implementContract =
    implement(polarisContract).$context<EmailPreferenceRpcContext>();
  const createClient =
    dependencies.createPreferenceClient ?? createActivationPreferenceClient;

  const withClient = async (
    bindings: WorkerBindings,
    use: (client: ActivationPreferenceClient) => Promise<ActivationPreference>
  ): Promise<ActivationPreference> => {
    const client = createClient(bindings.HYPERDRIVE.connectionString);
    try {
      return await use(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  const emailPreference = implementContract.account.emailPreference.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: (_transaction, identity) =>
            withClient(context.bindings, (client) =>
              client.read(identity.userId)
            ),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  const setTips = implementContract.account.setTips.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: CAPABILITY,
          operation: (_transaction, identity) =>
            withClient(context.bindings, (client) =>
              client.setTips(identity.userId, input.on)
            ),
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return { emailPreference, setTips };
}
