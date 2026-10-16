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
  report: (event, fields) =>
    console.warn({ event: `admin.${event}`, ...fields }),
  resolvePrincipal: (identity, bindings) => {
    const connectionString = bindings.ADMIN_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      return Promise.reject(new Error("admin_not_configured"));
    }
    return withAdminDatabase(connectionString, (client) =>
      resolvePlatformPrincipal(client, identity)
    );
  },
};

const app = createAdminApp(dependencies);

export default {
  fetch: (request: Request, env: AdminBindings, context: ExecutionContext) =>
    app.fetch(request, env, context),
} satisfies ExportedHandler<AdminBindings>;
