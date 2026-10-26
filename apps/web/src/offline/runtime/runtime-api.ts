import type { PolarisRpcClient } from "@polaris/contracts";
import type { BootstrapSource } from "../bootstrap";
import { type RuntimeApi, SessionUnreachableError } from "./offline-runtime";

/** A lie-fi connection must not hold the start of the app: after this, the remembered user stands in. */
const SESSION_LOOKUP_TIMEOUT_MS = 4000;

/** 5xx and 429 say nothing about who is signed in: they are a server that could not answer, not a refusal. */
function isNoAnswer(status: number): boolean {
  return status === 429 || status >= 500;
}

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
export function createRpcRuntimeApi(
  client: PolarisRpcClient,
  // the connection's fetch in the browser: a 401 or 403 that is not the Worker's is no answer, not "no session"
  fetchSession: typeof fetch = (input, init) => fetch(input, init)
): RuntimeApi {
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
    sessionUserId: async () => {
      let response: Response;
      try {
        response = await fetchSession("/api/auth/get-session", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new SessionUnreachableError("session_unreachable", { cause });
      }
      if (response.status === 401 || response.status === 403) {
        return null; // the server said, in so many words, that there is no session for this cookie
      }
      if (isNoAnswer(response.status)) {
        // the server is down, overloaded or throttling: no answer, the same as having no connection
        throw new SessionUnreachableError(`session_http_${response.status}`);
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
    source: (organizationId, signal): BootstrapSource => {
      const options = signal ? { signal } : undefined;
      return {
        getCursor: async () =>
          (await client.sync.getCursor({ organizationId }, options)).cursor,
        page: async (collection, request) => {
          const page = await client.sync.bootstrapPage(
            {
              afterId: request.afterId ?? null,
              collection,
              ids: request.ids ?? null,
              limit: request.limit ?? 200,
              organizationId,
            },
            options
          );
          return { nextAfterId: page.nextAfterId, rows: page.rows } as never;
        },
        pull: (cursor, limit) =>
          client.sync.pull({ cursor, limit, organizationId }, options),
        recentSales: async () =>
          (await client.sale.list({ limit: 100, organizationId }, options))
            .sales,
      };
    },
  };
}
