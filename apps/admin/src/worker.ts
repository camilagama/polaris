import {
  closeSupportCase,
  grantTenantAccess,
  listSupportCases,
  listTenantCustomers,
  openSupportCase,
  readSupportCase,
  revealCustomerField,
  revokeTenantAccess,
} from "@polaris/db/admin-support-repository";
import {
  listOrganizations,
  readOrganizationDiagnostics,
} from "@polaris/db/admin-diagnostics-repository";
import {
  resolvePlatformPrincipal,
  withAdminDatabase,
} from "@polaris/db/platform-principal-repository";
import {
  type AccessKeyStore,
  accessIssuer,
  createAccessKeyStore,
  unverifiedKeyId,
  verifyAccessJwt,
} from "./access-jwt";
import {
  type AdminBindings,
  type AdminDependencies,
  createAdminApp,
} from "./app";

/** The key stores live as long as the isolate; one per Access team. */
const keyStores = new Map<string, AccessKeyStore>();

function keyStoreFor(teamDomain: string): AccessKeyStore {
  let store = keyStores.get(teamDomain);
  if (!store) {
    store = createAccessKeyStore({
      fetchKeys: async (url) => {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          throw new Error("access_keys_unavailable");
        }
        return await response.json();
      },
      teamDomain,
    });
    keyStores.set(teamDomain, store);
  }
  return store;
}

function connectionOf(bindings: AdminBindings): string {
  const connectionString = bindings.ADMIN_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error("admin_not_configured");
  }
  return connectionString;
}

const dependencies: AdminDependencies = {
  authenticate: async (token, bindings) => {
    const teamDomain = bindings.ACCESS_TEAM_DOMAIN ?? "";
    const issuer = accessIssuer(teamDomain);
    if (!(issuer && bindings.ACCESS_AUDIENCE)) {
      throw new Error("admin_not_configured");
    }
    const keys = await keyStoreFor(teamDomain).keys(unverifiedKeyId(token));
    return await verifyAccessJwt(
      token,
      { audience: bindings.ACCESS_AUDIENCE, issuer },
      keys,
      new Date()
    );
  },
  organizations: {
    diagnostics: (organizationId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readOrganizationDiagnostics(client, organizationId)
      ),
    list: (input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listOrganizations(client, input)
      ),
  },
  report: (event, fields) =>
    console.warn({ event: `admin.${event}`, ...fields }),
  support: {
    close: (principalId, caseId, resolution, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        closeSupportCase(client, principalId, caseId, resolution)
      ),
    customers: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listTenantCustomers(client, principalId, caseId, input)
      ),
    detail: (caseId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readSupportCase(client, caseId)
      ),
    grant: (principalId, caseId, minutes, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        grantTenantAccess(client, principalId, caseId, minutes)
      ),
    list: (input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listSupportCases(client, input)
      ),
    open: (principalId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        openSupportCase(client, principalId, input)
      ),
    reveal: (principalId, caseId, customerId, field, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        revealCustomerField(client, principalId, caseId, customerId, field)
      ),
    revoke: (principalId, grantId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        revokeTenantAccess(client, principalId, grantId)
      ),
  },
  resolvePrincipal: (identity, bindings) =>
    withAdminDatabase(connectionOf(bindings), (client) =>
      resolvePlatformPrincipal(client, identity)
    ),
};

const app = createAdminApp(dependencies);

export default {
  fetch: (request: Request, env: AdminBindings, context: ExecutionContext) =>
    app.fetch(request, env, context),
} satisfies ExportedHandler<AdminBindings>;
