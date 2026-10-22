import LogOutIcon from "lucide-react/dist/esm/icons/log-out";
import { useCallback, useState } from "react";
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
  const response = await fetch("/api/auth/sign-out", {
    body: "{}",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("sign_out_failed");
  }
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
      const workspaces = (await runtime?.logoutWorkspaces()) ?? [];
      return workspaces.length > 0
        ? {
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
  /** Why the person is signing out, when the next stop is the sign-in screen (AC-43). */
  reason?: SignInReason;
  /** Where to come back to after signing in again. Not valid, or no reason: "Sair" goes to the start. */
  returnTo?: string;
  /** In the sidebar of the shell (v5.1): the look of the outline button of the interface, as wide as the column. */
  shell?: boolean;
}

export function LogoutControl({
  reason,
  returnTo,
  shell = false,
}: LogoutControlProps = {}) {
  const runtime = useOfflineRuntime();
  const logout = useLogout(
    reason ? logoutDestination({ reason, returnTo }) : "/"
  );
  const { blocked, busy, message } = logout;
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
        <LogoutDialog
          blocked={blocked}
          busy={busy}
          errorMessage={null}
          onCancel={logout.cancel}
          onDiscard={logout.discard}
          onRetry={logout.start}
          onShowAttention={logout.showAttention}
        />
      ) : null}
    </div>
  );
}
