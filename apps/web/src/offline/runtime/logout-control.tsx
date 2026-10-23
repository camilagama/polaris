import LogOutIcon from "lucide-react/dist/esm/icons/log-out";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserConnection } from "../../lib/browser-connection";
import { orpcClient } from "../../lib/orpc";
import { logoutDestination, type SignInReason } from "../../lib/sign-in-path";
import { LogoutDialog } from "../logout-dialog";
import type { BlockedWorkspace } from "../logout-guard";
import { type LeavePath, leaveAfterSignOut } from "./leave-browser";
import {
  discardAndLeave,
  type LogoutFlowDependencies,
  type LogoutFlowResult,
  startLogout,
} from "./logout-flow";
import { useOfflineRuntime } from "./runtime-context";

/**
 * "Sair" (ADR 0039): protects the queue, then ends the session. It only exists
 * while the offline runtime is on, because that is when a device holds work no
 * one else has.
 */
async function signOutOnServer(): Promise<void> {
  // through the connection: a portal's 200 (no Worker mark) never passes for a cleared cookie
  const response = await browserConnection.fetch("/api/auth/sign-out", {
    body: "{}",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("sign_out_failed");
  }
}

/** Revokes this installation on the server (ADR 0048, emenda de 22/10); the flow decides what a failure means. */
async function revokeCurrentDevice(
  deviceId: string
): Promise<{ endedCurrentSession: boolean }> {
  const { endedCurrentSession } = await orpcClient.device.revokeCurrent({
    deviceId,
  });
  return { endedCurrentSession };
}

/**
 * The protected logout as a hook: "Sair" uses it to go home, the devices screen
 * to go to the sign-in screen (its "Entrar de novo" while the session is still
 * alive). Same guard, same dialog, only the destination changes.
 */
export function useLogout(destination: LeavePath) {
  const runtime = useOfflineRuntime();
  const [blocked, setBlocked] = useState<BlockedWorkspace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dependencies =
    useCallback(async (): Promise<LogoutFlowDependencies | null> => {
      // before anything else: protecting the queue purges the workspaces, and the device is revoked after that
      const deviceId = runtime?.currentDeviceId() ?? null;
      const workspaces = (await runtime?.logoutWorkspaces()) ?? [];
      return runtime && workspaces.length > 0
        ? {
            device: {
              forget: () => runtime.forgetDevice(),
              id: deviceId,
              isOnline: () => navigator.onLine,
              revoke: revokeCurrentDevice,
            },
            leave: () => leaveAfterSignOut(destination),
            signOut: signOutOnServer,
            workspaces,
          }
        : null;
    }, [destination, runtime]);

  const run = useCallback(
    async (
      action: (deps: LogoutFlowDependencies) => Promise<LogoutFlowResult>
    ) => {
      const deps = await dependencies();
      if (!deps) {
        setMessage(
          "Não foi possível verificar o trabalho guardado neste aparelho agora. Tente de novo com conexão, depois que o app terminar de abrir."
        );
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        const result = await action(deps);
        if (result.status === "blocked") {
          setBlocked(result.blocked);
        } else if (result.status === "sign_out_failed") {
          setBlocked(null);
          setMessage(
            "Os dados deste aparelho foram apagados, mas não foi possível encerrar a sessão. Recarregue a página."
          );
        }
      } catch {
        setMessage("Não foi possível sair agora. Tente de novo.");
      } finally {
        setBusy(false);
      }
    },
    [dependencies]
  );

  const handleLogout = useCallback(() => {
    run(startLogout).catch(() => undefined);
  }, [run]);
  const handleDiscard = useCallback(() => {
    run(discardAndLeave).catch(() => undefined);
  }, [run]);
  const handleCancel = useCallback(() => setBlocked(null), []);
  const handleAttention = useCallback(
    () => window.location.assign("/attention"),
    []
  );

  return {
    blocked,
    busy,
    cancel: handleCancel,
    discard: handleDiscard,
    message,
    showAttention: handleAttention,
    start: handleLogout,
  };
}

interface LogoutControlProps {
  /**
   * Called when the warning of the pending queue or a message appears, so a closed "Mais" sheet of the phone opens
   * again: the answer may arrive after the person closed it.
   */
  onAttention?: () => void;
  /** Why the person is signing out, when the next stop is the sign-in screen (AC-43). */
  reason?: SignInReason;
  /** Where to come back to after signing in again. Not valid, or no reason: "Sair" goes to the start. */
  returnTo?: string;
  /** In the sidebar of the shell (v5.1): the look of the outline button of the interface, as wide as the column. */
  shell?: boolean;
}

export function LogoutControl({
  onAttention,
  reason,
  returnTo,
  shell = false,
}: LogoutControlProps = {}) {
  const runtime = useOfflineRuntime();
  const logout = useLogout(
    reason ? logoutDestination({ reason, returnTo }) : "/"
  );
  const { blocked, busy, message } = logout;
  const blockedRef = useRef<HTMLDivElement>(null);
  const needsAttention = blocked !== null || message !== null;
  useEffect(() => {
    if (needsAttention) {
      onAttention?.();
    }
  }, [needsAttention, onAttention]);
  // in the sidebar the warning opens below "Sair", in a narrow column that may scroll: bring it to view, with focus
  useEffect(() => {
    if (shell && blocked) {
      blockedRef.current?.scrollIntoView({ block: "nearest" });
      blockedRef.current?.focus();
    }
  }, [blocked, shell]);
  if (!runtime) {
    return null;
  }
  return (
    <div className={shell ? "grid gap-2" : "app-logout"}>
      {shell ? (
        <button
          className="touch-hit focus-ring inline-flex h-ctl-md w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 font-medium text-foreground text-sm shadow-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 dark:bg-secondary/60 dark:hover:bg-accent [&_svg]:size-4"
          disabled={busy}
          onClick={logout.start}
          type="button"
        >
          <LogOutIcon aria-hidden="true" />
          Sair
        </button>
      ) : (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={logout.start}
          type="button"
        >
          Sair
        </button>
      )}
      {message ? (
        <p
          className={shell ? "m-0 text-destructive text-support" : undefined}
          role="alert"
        >
          {message}
        </p>
      ) : null}
      {blocked ? (
        <div className="outline-none" ref={blockedRef} tabIndex={-1}>
          <LogoutDialog
            blocked={blocked}
            busy={busy}
            errorMessage={null}
            onCancel={logout.cancel}
            onDiscard={logout.discard}
            onRetry={logout.start}
            onShowAttention={logout.showAttention}
          />
        </div>
      ) : null}
    </div>
  );
}
