import { implement } from "@orpc/server";
import { polarisContract } from "@polaris/contracts";
import {
  DeviceNotOwnedError,
  type DeviceRecord,
  type listDevices,
  type registerDevice,
  type revokeDevice,
  type revokeOwnDevice,
  type touchDevice,
} from "@polaris/db/device-repository";
import type { issueOfflineLeaseGrant } from "@polaris/db/offline-lease-repository";
import { logger } from "@polaris/observability/logger";
import {
  type AccessLogQueryable,
  type AccessLogWriter,
  requestIp,
} from "../auth/access-log";
import type { withAuthenticatedRequestContext } from "../authenticated-request-context";
import { isSessionFresh } from "../auth/session-policy";
import { deviceFamilyLabel } from "../device-family-label";
import type { WorkerBindings } from "../environment";
import { offlineLeaseKeys, signLeaseClaims } from "../offline-lease-service";
import type { withTenantRequestContext } from "../tenant-request-context";

interface OfflineRpcContext {
  bindings: WorkerBindings;
  request: Request;
  requestId: string;
}

interface OfflineRpcDependencies {
  /**
   * The writer of the record of access (ADR 0092) over the authentication connection of the request context, the
   * pool of the authentication role (`AUTH_HYPERDRIVE`): the same writer the server of authentication uses, so the
   * tenant runtime never executes `record_auth_access` and the handler opens no connection of its own.
   */
  accessLogWriter: (connection: AccessLogQueryable) => AccessLogWriter;
  defaultIssueOfflineLeaseGrant: typeof issueOfflineLeaseGrant;
  defaultListDevices: typeof listDevices;
  defaultRegisterDevice: typeof registerDevice;
  defaultRevokeDevice: typeof revokeDevice;
  defaultRevokeOwnDevice: typeof revokeOwnDevice;
  defaultTouchDevice: typeof touchDevice;
  issueOfflineLeaseGrant: typeof issueOfflineLeaseGrant | undefined;
  listDevices: typeof listDevices | undefined;
  registerDevice: typeof registerDevice | undefined;
  requestAuditId: (requestId: string) => string | null;
  revokeDevice: typeof revokeDevice | undefined;
  revokeOwnDevice: typeof revokeOwnDevice | undefined;
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
  const revokeOwnRepository =
    dependencies.revokeOwnDevice ?? dependencies.defaultRevokeOwnDevice;
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
                // a device the person did not name is named by its browser and system, from a closed table (U-51)
                label: input.label?.trim()
                  ? input.label
                  : deviceFamilyLabel(context.request.headers),
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
              // a recent session owns the first device it confirms, so its "Sair" can revoke it
              freshSession: isSessionFresh(session.session.createdAt),
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

  const revokeCurrent = implementContract.device.revokeCurrent.handler(
    ({ context, input }) => {
      // one id for the audit of the revocation and the record of the logout
      const requestId =
        dependencies.requestAuditId(context.requestId) ?? crypto.randomUUID();
      return dependencies
        .withAuthenticatedRequestContext({
          bindings: context.bindings,
          operation: async (database, session, authConnection) => {
            let result: Awaited<ReturnType<typeof revokeOwnDevice>>;
            try {
              result = await revokeOwnRepository(
                database,
                session.user.id,
                input.deviceId,
                { actingSessionId: session.session.id, requestId }
              );
            } catch (error) {
              if (error instanceof DeviceNotOwnedError) {
                // the "Sair" goes on without revoking; counted, without the device or the user
                logger.warn("device_revoke_current_refused", {
                  reason: error.code,
                });
              }
              throw error;
            }
            if (result.endedCurrentSession) {
              // the session is gone: the sign-out that follows finds no one to record, so the logout is recorded
              // here, after the commit, and its failure never fails the command
              await dependencies.accessLogWriter(
                authConnection as unknown as AccessLogQueryable
              )({
                event: "logout",
                ip: requestIp(context.request.headers),
                requestId,
                userId: session.user.id,
              });
            }
            return result;
          },
          request: context.request,
        })
        .catch(dependencies.toRpcError);
    }
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
    device: { check, list, register, revoke, revokeCurrent },
    offline: { issueLease },
  };
}
