import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import type {
  DeviceRecord,
  listDevices,
  registerDevice,
  revokeDevice,
  touchDevice,
} from "@polaris/db/device-repository";
import type { issueOfflineLeaseGrant } from "@polaris/db/offline-lease-repository";
import { isSessionFresh } from "../auth/session-policy";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import type { WorkerBindings } from "../environment";
import { offlineLeaseKeys, signLeaseClaims } from "../offline-lease-service";
import type { withTenantRequestContext } from "../tenant-request-context";

interface OfflineRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface OfflineRpcDependencies {
  defaultIssueOfflineLeaseGrant: typeof issueOfflineLeaseGrant;
  defaultListDevices: typeof listDevices;
  defaultRegisterDevice: typeof registerDevice;
  defaultRevokeDevice: typeof revokeDevice;
  defaultTouchDevice: typeof touchDevice;
  issueOfflineLeaseGrant: typeof issueOfflineLeaseGrant | undefined;
  listDevices: typeof listDevices | undefined;
  registerDevice: typeof registerDevice | undefined;
  requestAuditId: (requestId: string) => string | null;
  revokeDevice: typeof revokeDevice | undefined;
  toRpcError: (error: unknown) => never;
  touchDevice: typeof touchDevice | undefined;
  withAuthenticatedRequestContext: typeof withAuthenticatedRequestContext;
  withTenantRequestContext: typeof withTenantRequestContext;
}

function deviceReadModel(device: DeviceRecord) {
  return {
    createdAt: device.createdAt.toISOString(),
    id: device.id,
    label: device.label,
    lastSeenAt: device.lastSeenAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Devices and offline leases (plan PR48/PR49). Devices belong to the signed-in
 * user and use no tenant context; a lease is issued inside a tenant transaction
 * that has already checked the membership, the organization and the
 * `offline:manage` capability. The user always comes from the verified session,
 * and every operation on a device links that session to it, so revoking the
 * device ends the session.
 */
export function createOfflineRpcHandlers(dependencies: OfflineRpcDependencies) {
  const implementContract =
    implement(polarisContract).$context<OfflineRpcContext>();
  const registerRepository =
    dependencies.registerDevice ?? dependencies.defaultRegisterDevice;
  const listRepository =
    dependencies.listDevices ?? dependencies.defaultListDevices;
  const revokeRepository =
    dependencies.revokeDevice ?? dependencies.defaultRevokeDevice;
  const touchRepository =
    dependencies.touchDevice ?? dependencies.defaultTouchDevice;
  const issueRepository =
    dependencies.issueOfflineLeaseGrant ??
    dependencies.defaultIssueOfflineLeaseGrant;

  const register = implementContract.device.register.handler(
    ({ context, input }) =>
      dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (database, session) => ({
            device: deviceReadModel(
              await registerRepository(database, session.user.id, {
                label: input.label ?? null,
                sessionId: session.session.id,
              })
            ),
          }),
          request: context.request,
        })
        .catch(dependencies.toRpcError)
  );

  const check = implementContract.device.check.handler(({ context, input }) =>
    dependencies
      .withAuthenticatedRequestContext({
        bindings: context.bindings,
        operation: async (database, session) => ({
          device: deviceReadModel(
            await touchRepository(database, session.user.id, input.deviceId, {
              sessionId: session.session.id,
            })
          ),
        }),
        request: context.request,
      })
      .catch(dependencies.toRpcError)
  );

  const list = implementContract.device.list.handler(({ context }) =>
    dependencies
      .withAuthenticatedRequestContext({
        bindings: context.bindings,
        operation: async (database, session) => ({
          devices: (await listRepository(database, session.user.id)).map(
            deviceReadModel
          ),
        }),
        request: context.request,
      })
      .catch(dependencies.toRpcError)
  );

  const revoke = implementContract.device.revoke.handler(({ context, input }) =>
    dependencies
      .withAuthenticatedRequestContext({
        bindings: context.bindings,
        operation: async (database, session) => {
          const result = await revokeRepository(
            database,
            session.user.id,
            input.deviceId,
            {
              actingSession: {
                fresh: isSessionFresh(session.session.createdAt),
                id: session.session.id,
              },
              endOtherSessions: input.endOtherSessions,
              requestId: dependencies.requestAuditId(context.requestId),
            }
          );
          return {
            device: deviceReadModel(result.device),
            endedCurrentSession: result.endedCurrentSession,
            endedSessionCount: result.endedSessionCount,
            revokedGrantIds: result.revokedGrantIds,
          };
        },
        request: context.request,
      })
      .catch(dependencies.toRpcError)
  );

  const issueLease = implementContract.offline.issueLease.handler(
    ({ context, input }) =>
      dependencies
        .withTenantRequestContext({
          bindings: context.bindings,
          capability: "offline:manage",
          operation: async (transaction, identity) => {
            // Fail closed before writing anything when no secret is configured.
            const keys = offlineLeaseKeys(context.bindings);
            const { claims, grant } = await issueRepository(
              transaction,
              identity,
              {
                deviceId: input.deviceId,
                requestId: dependencies.requestAuditId(context.requestId),
              }
            );
            // Signed inside the transaction: a signing failure rolls the grant back.
            const lease = await signLeaseClaims(claims, keys);
            return {
              expiresAt: grant.expiresAt.toISOString(),
              grantId: grant.id,
              issuedAt: grant.issuedAt.toISOString(),
              lease,
            };
          },
          request: context.request,
          requestedOrganizationId: input.organizationId,
        })
        .catch(dependencies.toRpcError)
  );

  return {
    device: { check, list, register, revoke },
    offline: { issueLease },
  };
}
