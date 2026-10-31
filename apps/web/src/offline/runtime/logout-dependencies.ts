import type { LogoutFlowDependencies } from "./logout-flow";
import type { OfflineRuntime } from "./offline-runtime";

type LogoutRuntime = Pick<
  OfflineRuntime,
  "currentDeviceId" | "forgetDevice" | "inspectLogout"
>;

interface LogoutEffects {
  leave: () => void;
  revoke: LogoutFlowDependencies["device"]["revoke"];
  signOut: () => Promise<void>;
}

/**
 * What the flow needs to run, or null when the device's work could not be looked at. An empty list the runtime could
 * read means nothing is stored for this person here (a closed store's copy is gone once the device dropped it), so
 * there is nothing to protect and the session just ends; one it could not read may hide a queue, and no logout runs.
 */
export async function logoutDependencies(
  runtime: LogoutRuntime | null,
  effects: LogoutEffects
): Promise<LogoutFlowDependencies | null> {
  if (!runtime) {
    return null;
  }
  // before anything else: protecting the queue purges the workspaces, and the device is revoked after that
  const deviceId = runtime.currentDeviceId();
  const { readable, workspaces } = await runtime.inspectLogout();
  if (!readable) {
    return null;
  }
  return {
    device: {
      forget: () => runtime.forgetDevice(),
      id: deviceId,
      isOnline: () => navigator.onLine,
      revoke: effects.revoke,
    },
    leave: effects.leave,
    signOut: effects.signOut,
    workspaces,
  };
}
