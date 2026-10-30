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
import type { OfflineRuntime } from "./offline-runtime";
import { logoutDependencies } from "./logout-dependencies";
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

/** Revokes this installation on the server (ADR 0048, emenda); the flow decides what a failure means. */
async function revokeCurrentDevice(
  deviceId: string
): Promise<{ endedCurrentSession: boolean }> {
  const { endedCurrentSession } = await orpcClient.device.revokeCurrent({
    deviceId,
  });
  return { endedCurrentSession };
}

function dependenciesFor(
  runtime: OfflineRuntime | null,
  destination: LeavePath
) {
  return logoutDependencies(runtime, {
    leave: () => leaveAfterSignOut(destination),
    revoke: revokeCurrentDevice,
    signOut: signOutOnServer,
  });
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

  const dependencies = useCallback(
    () => dependenciesFor(runtime, destination),
    [destination, runtime]
  );

  const run = useCallback(
    async (
      action: (deps: LogoutFlowDependencies) => Promise<LogoutFlowResult>
    ) => {
      // cleared first so that the same message again is a new one, and is brought to view again
      setMessage(null);
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

/** The state of a protected logout and what it does: what `useLogout` returns. */
export type Logout = ReturnType<typeof useLogout>;

interface LogoutNoticesProps {
  logout: Logout;
  /**
   * Called when the warning of the pending queue or a message appears, so a closed "Mais" sheet of the phone opens
   * again: the answer may arrive after the person closed it.
   */
  onAttention?: (() => void) | undefined;
}

/**
 * What a logout has to say after "Sair": the message of a failure and the dialog of the work this device would lose.
 * It lives with the hook, never inside a menu that closes on the click: the answer
 * may come after the menu has closed, and a logout that failed must never be silent.
 */
export function LogoutNotices({ logout, onAttention }: LogoutNoticesProps) {
  const { blocked, busy, message } = logout;
  const blockedRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const needsAttention = blocked !== null || message !== null;
  useEffect(() => {
    if (needsAttention) {
      onAttention?.();
    }
  }, [needsAttention, onAttention]);
  // in the sidebar the warning opens below "Sair", in a narrow column that may scroll: bring it to view, with focus
  useEffect(() => {
    const shown = blocked ? blockedRef.current : messageRef.current;
    if (shown && needsAttention) {
      shown.scrollIntoView({ block: "nearest" });
      shown.focus();
    }
  }, [blocked, message, needsAttention]);
  return (
    <>
      {/* the menu that held "Sair" is closed by now: the state is said here, not only by a disabled item */}
      {busy ? (
        <p className="m-0 text-muted-foreground text-support" role="status">
          Saindo…
        </p>
      ) : null}
      {message ? (
        <p
          className="focus-ring m-0 text-destructive text-support"
          ref={messageRef}
          role="alert"
          tabIndex={-1}
        >
          {message}
        </p>
      ) : null}
      {blocked ? (
        <div className="focus-ring" ref={blockedRef} tabIndex={-1}>
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
    </>
  );
}

interface LogoutControlProps {
  /**
   * The logout of the one that holds the state, when the control may be unmounted and mounted again with it kept (the
   * sidebar, when the width crosses 760 px in the middle of the flow). Without it the control has its own.
   */
  logout?: Logout | undefined;
  /** See `LogoutNotices`. */
  onAttention?: (() => void) | undefined;
  /** Why the person is signing out, when the next stop is the sign-in screen (AC-43). */
  reason?: SignInReason | undefined;
  /** Where to come back to after signing in again. Not valid, or no reason: "Sair" goes to the start. */
  returnTo?: string | undefined;
}

/** "Sair" as a button with its notices under it: the "Mais" sheet of the phone, the acceptance and Aparelhos. */
export function LogoutControl({
  logout,
  onAttention,
  reason,
  returnTo,
}: LogoutControlProps = {}) {
  return logout ? (
    <LogoutButton logout={logout} onAttention={onAttention} />
  ) : (
    <OwnLogoutControl
      onAttention={onAttention}
      reason={reason}
      returnTo={returnTo}
    />
  );
}

function OwnLogoutControl({
  onAttention,
  reason,
  returnTo,
}: Omit<LogoutControlProps, "logout">) {
  const logout = useLogout(
    reason ? logoutDestination({ reason, returnTo }) : "/"
  );
  return <LogoutButton logout={logout} onAttention={onAttention} />;
}

function LogoutButton({
  logout,
  onAttention,
}: {
  logout: Logout;
  onAttention?: (() => void) | undefined;
}) {
  const runtime = useOfflineRuntime();
  if (!runtime) {
    return null;
  }
  return (
    <div className="grid gap-2">
      <button
        className="touch-hit focus-ring inline-flex h-ctl-md w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 font-medium text-foreground text-sm shadow-xs motion-full:transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 dark:bg-secondary/60 dark:hover:bg-accent [&_svg]:size-4"
        disabled={logout.busy}
        onClick={logout.start}
        type="button"
      >
        <LogOutIcon aria-hidden="true" />
        Sair
      </button>
      <LogoutNotices logout={logout} onAttention={onAttention} />
    </div>
  );
}
