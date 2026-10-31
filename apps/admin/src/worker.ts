import { configureLogging, logger } from "@polaris/observability/logger";
import { readAuthAccessLog } from "@polaris/db/admin-access-log-repository";
import {
  listOperationalIncidents,
  readOperationalIncident,
  retryDeadLetter,
} from "@polaris/db/admin-incident-repository";
import {
  auditBillingCommand,
  cancelOrganizationPurge,
  classifyOrganization,
  closeSupportCase,
  dismissClosureNotice,
  grantTenantAccess,
  listOrganizationLegalHolds,
  listPrivacyCases,
  listSupportCases,
  listTenantCustomers,
  openPrivacyCase,
  openSupportCase,
  placeOrganizationLegalHold,
  reactivateOrganization,
  readPrivacyCase,
  readSupportCase,
  recordPrivacyAction,
  recordPrivacyDecision,
  recordPrivacyIdentity,
  recordPrivacyRole,
  recordPrivacyScope,
  reissueClosureNotice,
  releaseOrganizationLegalHold,
  resolvePrivacyCase,
  revealCustomerField,
  revokeTenantAccess,
  scheduleOrganizationPurge,
  suspendOrganization,
} from "@polaris/db/admin-support-repository";
import { readRefundWindow } from "@polaris/db/admin-refund-window-repository";
import { createBillingStore } from "@polaris/db/billing-store";
import { renewalBlocksPurge } from "@polaris/domain/billing/renewal-cancellation";
import {
  listOrganizations,
  readActivationFunnel,
  readOrganizationDiagnostics,
} from "@polaris/db/admin-diagnostics-repository";
import {
  resolvePlatformPrincipal,
  withAdminDatabase,
} from "@polaris/db/platform-principal-repository";
import { InvalidSupportRequestError } from "@polaris/domain/admin/support-access";
import adminCss from "./ui/generated/admin.css.txt";
import adminJs from "./ui/generated/admin.js.txt";
import {
  type BillingCommandPorts,
  grantEntitlementCommand,
  revokeEntitlementCommand,
} from "./billing-commands";
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

function billingConnectionOf(bindings: AdminBindings): string {
  const connectionString = bindings.ADMIN_BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error("admin_not_configured");
  }
  return connectionString;
}

/** The ports of a billing command: the audit through the Admin role, the command through the billing role (one connection per request, closed after). */
async function withBillingPorts<T>(
  bindings: AdminBindings,
  operation: (ports: BillingCommandPorts) => Promise<T>
): Promise<T> {
  const store = createBillingStore(billingConnectionOf(bindings));
  try {
    return await operation({
      audit: (principalId, caseId, event, entityId, detail) =>
        withAdminDatabase(connectionOf(bindings), (client) =>
          auditBillingCommand(
            client,
            principalId,
            caseId,
            event,
            entityId,
            detail
          )
        ),
      find: (id) => store.findEntitlementGrant(id),
      grant: (input) => store.grantEntitlement(input),
      newId: () => crypto.randomUUID(),
      revoke: (input) => store.revokeEntitlementGrant(input),
    });
  } finally {
    await store.close();
  }
}

const dependencies: AdminDependencies = {
  accessLog: {
    read: (principalId, request, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readAuthAccessLog(client, principalId, request)
      ),
  },
  activationFunnel: {
    read: (principalId, weeks, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readActivationFunnel(client, principalId, weeks)
      ),
  },
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
  incidents: {
    detail: (incidentId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readOperationalIncident(client, incidentId, input)
      ),
    list: (input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listOperationalIncidents(client, input)
      ),
    retry: (principalId, incidentId, eventId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        retryDeadLetter(client, principalId, incidentId, eventId)
      ),
  },
  privacy: {
    action: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        recordPrivacyAction(client, principalId, caseId, input)
      ),
    decision: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        recordPrivacyDecision(client, principalId, caseId, input)
      ),
    detail: (caseId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readPrivacyCase(client, caseId)
      ),
    identity: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        recordPrivacyIdentity(client, principalId, caseId, input)
      ),
    list: (input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listPrivacyCases(client, input)
      ),
    open: (principalId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        openPrivacyCase(client, principalId, input)
      ),
    resolve: (principalId, caseId, resolution, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        resolvePrivacyCase(client, principalId, caseId, resolution)
      ),
    role: (principalId, caseId, role, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        recordPrivacyRole(client, principalId, caseId, role)
      ),
    scope: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        recordPrivacyScope(client, principalId, caseId, input)
      ),
  },
  refundWindow: {
    read: (principalId, caseId, organizationId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        readRefundWindow(client, principalId, caseId, organizationId)
      ),
  },
  report: (event, fields) => logger.warn(`admin.${event}`, fields),
  support: {
    closureNotice: (principalId, caseId, organizationId, action, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        action.kind === "dismiss"
          ? dismissClosureNotice(
              client,
              principalId,
              caseId,
              organizationId,
              action.reason
            )
          : reissueClosureNotice(client, principalId, caseId, organizationId)
      ),
    cancelPurge: (principalId, caseId, organizationId, reason, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        cancelOrganizationPurge(
          client,
          principalId,
          caseId,
          organizationId,
          reason
        )
      ),
    close: (principalId, caseId, resolution, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        closeSupportCase(client, principalId, caseId, resolution)
      ),
    customers: (principalId, caseId, input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listTenantCustomers(client, principalId, caseId, input)
      ),
    grantEntitlement: (principalId, caseId, command, bindings) =>
      withBillingPorts(bindings, (ports) =>
        grantEntitlementCommand(ports, principalId, caseId, command, new Date())
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
    legalHold: (
      principalId,
      caseId,
      organizationId,
      action,
      reviewAt,
      bindings
    ) =>
      withAdminDatabase(connectionOf(bindings), (client) => {
        if (action === "release") {
          return releaseOrganizationLegalHold(
            client,
            principalId,
            caseId,
            organizationId
          );
        }
        if (reviewAt === null) {
          // the route always sends one; a hold is never placed without its review date
          throw new InvalidSupportRequestError("invalid_review_at");
        }
        return placeOrganizationLegalHold(
          client,
          principalId,
          caseId,
          organizationId,
          reviewAt
        );
      }),
    listLegalHolds: (input, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        listOrganizationLegalHolds(client, input)
      ),
    purge: (principalId, caseId, organizationId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        scheduleOrganizationPurge(client, principalId, caseId, organizationId)
      ),
    reactivate: (principalId, caseId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        reactivateOrganization(client, principalId, caseId)
      ),
    renewalBlocksPurge: async (organizationId, bindings) => {
      // through the billing role, as the billing commands (ADR 0073): no new grant to the Admin role
      const store = createBillingStore(billingConnectionOf(bindings));
      try {
        const [record, link] = await Promise.all([
          store.readRecord(organizationId),
          store.readProviderLink(organizationId),
        ]);
        return renewalBlocksPurge(record, link);
      } finally {
        await store.close();
      }
    },
    revokeEntitlement: (principalId, caseId, grantId, bindings) =>
      withBillingPorts(bindings, (ports) =>
        revokeEntitlementCommand(ports, principalId, caseId, grantId)
      ),
    suspend: (principalId, caseId, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        suspendOrganization(client, principalId, caseId)
      ),
    classify: (principalId, organizationId, internal, bindings) =>
      withAdminDatabase(connectionOf(bindings), (client) =>
        classifyOrganization(client, principalId, organizationId, internal)
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

configureLogging({ service: "polaris-admin" });

const app = createAdminApp(dependencies, { css: adminCss, js: adminJs });

export default {
  fetch: (request: Request, env: AdminBindings, context: ExecutionContext) =>
    app.fetch(request, env, context),
} satisfies ExportedHandler<AdminBindings>;
