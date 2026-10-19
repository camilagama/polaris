import type { PolarisRpcClient } from "@polaris/contracts";
import type { BootstrapSource } from "../bootstrap";
import type { RuntimeApi } from "./offline-runtime";

function isDeviceRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "CONFLICT" || error.code === "NOT_FOUND")
  );
}

/**
 * The runtime's window to the server, over the same RPC client the screens use:
 * the session cookie authorizes every call, the organization is only the
 * requested context, and the server revalidates all of it (ADR 0033).
 */
export function createRpcRuntimeApi(client: PolarisRpcClient): RuntimeApi {
  return {
    // `device.check` also links this session to the device, so revoking the
    // device ends this session even if it never syncs (called at every online
    // start). Revoked or unknown is "not mine"; any other failure is thrown.
    deviceIsMine: async (deviceId) => {
      try {
        await client.device.check({ deviceId });
        return true;
      } catch (error) {
        if (isDeviceRefusal(error)) {
          return false;
        }
        throw error;
      }
    },
    issueLease: async (deviceId, organizationId) => {
      const issued = await client.offline.issueLease({
        deviceId,
        organizationId,
      });
      return { expiresAt: issued.expiresAt, lease: issued.lease };
    },
    push: (organizationId) => (input) =>
      client.sync.push({ commands: input.commands, organizationId }),
    registerDevice: async (label) => {
      const { device } = await client.device.register({ label });
      return device.id;
    },
    source: (organizationId): BootstrapSource => ({
      getCursor: async () =>
        (await client.sync.getCursor({ organizationId })).cursor,
      page: async (collection, request) => {
        const page = await client.sync.bootstrapPage({
          afterId: request.afterId ?? null,
          collection,
          ids: request.ids ?? null,
          limit: request.limit ?? 200,
          organizationId,
        });
        return { nextAfterId: page.nextAfterId, rows: page.rows } as never;
      },
      pull: (cursor, limit) =>
        client.sync.pull({ cursor, limit, organizationId }),
      recentSales: async () =>
        (await client.sale.list({ limit: 100, organizationId })).sales,
    }),
  };
}
