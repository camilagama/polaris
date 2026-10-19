import type { PolarisRpcClient } from "@polaris/contracts";
import type { BootstrapSource } from "../bootstrap";
import { type RuntimeApi, SessionUnreachableError } from "./offline-runtime";

/** A lie-fi connection must not hold the start of the app: after this, the remembered user stands in. */
const SESSION_LOOKUP_TIMEOUT_MS = 4000;

/**
 * The runtime's window to the server, over the same RPC client the screens use:
 * the session cookie authorizes every call, the organization is only the
 * requested context, and the server revalidates all of it (ADR 0033).
 */
export function createRpcRuntimeApi(client: PolarisRpcClient): RuntimeApi {
  return {
    deviceIsMine: async (deviceId) =>
      (await client.device.list()).devices.some(
        (device) => device.id === deviceId && device.revokedAt === null
      ),
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
    sessionUserId: async () => {
      let response: Response;
      try {
        response = await fetch("/api/auth/get-session", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new SessionUnreachableError("session_unreachable", { cause });
      }
      if (!response.ok) {
        throw new Error("session_unavailable");
      }
      const session = (await response.json().catch((cause: unknown) => {
        throw new Error("session_unavailable", { cause });
      })) as { user?: { id?: unknown } } | null;
      const id = session?.user?.id;
      return typeof id === "string" && id !== "" ? id : null;
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
