import { useCallback, useState } from "react";
import { LogoutDialog } from "../logout-dialog";
import type { BlockedWorkspace } from "../logout-guard";
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

export function LogoutControl() {
  const runtime = useOfflineRuntime();
  const [blocked, setBlocked] = useState<BlockedWorkspace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dependencies =
    useCallback(async (): Promise<LogoutFlowDependencies | null> => {
      const workspaces = (await runtime?.logoutWorkspaces()) ?? [];
      return workspaces.length > 0
        ? {
            leave: () => window.location.assign("/"),
            signOut: signOutOnServer,
            workspaces,
          }
        : null;
    }, [runtime]);

  const run = useCallback(
    async (
      action: (deps: LogoutFlowDependencies) => Promise<LogoutFlowResult>
    ) => {
      const deps = await dependencies();
      if (!deps) {
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

  if (!runtime) {
    return null;
  }
  return (
    <div className="app-logout">
      <button
        className="secondary-button"
        disabled={busy}
        onClick={handleLogout}
        type="button"
      >
        Sair
      </button>
      {message ? (
        <p className="app-logout-message" role="alert">
          {message}
        </p>
      ) : null}
      {blocked ? (
        <LogoutDialog
          blocked={blocked}
          busy={busy}
          errorMessage={null}
          onCancel={handleCancel}
          onDiscard={handleDiscard}
          onRetry={handleLogout}
          onShowAttention={handleAttention}
        />
      ) : null}
    </div>
  );
}
