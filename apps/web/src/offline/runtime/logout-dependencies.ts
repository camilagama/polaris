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

/**
 * The logout of a device with no offline runtime (the build flag is off): no queue, copy or registered device
 * exists here, so there is nothing to protect and nothing to revoke; the session just ends.
 */
export function plainLogoutDependencies(
  effects: LogoutEffects
): LogoutFlowDependencies {
  return {
    device: {
      forget: () => undefined,
      id: null,
      isOnline: () => navigator.onLine,
      revoke: effects.revoke,
    },
    leave: effects.leave,
    signOut: effects.signOut,
    workspaces: [],
  };
}

/** The logout that ends only the session: no runtime to read and the screen asked to always offer a way out. */
export function endsOnlySession(
  runtime: LogoutRuntime | null,
  endsWithoutRuntime: boolean
): boolean {
  return !runtime && endsWithoutRuntime;
}

/** What a sign-out that failed says: only a logout that went through the runtime has purged the device before it. */
export function signOutFailedMessage(endedOnlySession: boolean): string {
  return endedOnlySession
    ? "Não foi possível sair. Confira a internet e tente de novo."
    : "Os dados deste aparelho foram apagados, mas não foi possível encerrar a sessão. Recarregue a página.";
}
