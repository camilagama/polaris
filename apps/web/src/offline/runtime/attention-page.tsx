import { useCallback, useEffect, useRef, useState } from "react";
import { PageLoading } from "../../app-shell/page-loading";
import { signInPath } from "../../lib/sign-in-path";
import {
  type AttentionItem,
  type AttentionSummary,
  buildAttention,
  discardAttentionItem,
  resubmitAttentionItem,
} from "../attention";
import {
  type AttentionError,
  AttentionFrame,
  AttentionPanel,
  AttentionStateCard,
  signInAgainButtonId,
} from "../attention-panel";
import { LogoutNotices, useLogout } from "./logout-control";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

/**
 * The page of operations that need attention (ADR 0038), over the runtime's real
 * outbox. It re-reads the queue whenever the runtime's figures change, so a sync
 * that clears or refuses something is reflected at once.
 */
const EMPTY: AttentionSummary = { items: [], waitingBehind: 0 };

/** "Sair e entrar de novo": the queue is protected first, then the sign-in screen brings the person back here. */
const SIGN_IN_AGAIN = signInPath({ reason: "saiu", returnTo: "/attention" });

export function AttentionPage() {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const [summary, setSummary] = useState<AttentionSummary>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AttentionError | null>(null);
  const logout = useLogout(SIGN_IN_AGAIN);

  const counts = snapshot?.counts;
  useEffect(() => {
    const context = runtime?.context();
    if (!context) {
      setSummary(EMPTY);
      return;
    }
    let current = true;
    context.outbox
      .snapshot()
      .then((queue) => {
        if (current) {
          setSummary(buildAttention(queue));
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // the figures change whenever the queue does
  }, [runtime, counts]);

  const resolve = useCallback(
    async (item: AttentionItem, work: () => Promise<void>, message: string) => {
      setBusy(item.commandId);
      setError(null);
      try {
        await work();
        await runtime?.refreshCounts();
        runtime?.syncNow().catch(() => undefined);
      } catch {
        setError({ commandId: item.commandId, message });
      } finally {
        setBusy(null);
      }
    },
    [runtime]
  );

  const handleDiscard = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => discardAttentionItem(item, context),
          "Não foi possível descartar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const handleResubmit = useCallback(
    (item: AttentionItem) => {
      const context = runtime?.context();
      if (context) {
        resolve(
          item,
          () => resubmitAttentionItem(item, context),
          "Não foi possível reenviar. Tente de novo."
        ).catch(() => undefined);
      }
    },
    [resolve, runtime]
  );
  const { blocked, start: startLogout } = logout;
  const signInFrom = useRef<string | null>(null);
  const wasBlocked = useRef<boolean>(false);
  const handleSignInAgain = useCallback(
    (item: AttentionItem) => {
      signInFrom.current = item.commandId;
      setError(null);
      startLogout();
    },
    [startLogout]
  );
  // the panel that said what the sign-out would lose is gone once the person keeps the session: the focus goes back to
  // the button that asked
  useEffect(() => {
    if (blocked) {
      wasBlocked.current = true;
    } else if (wasBlocked.current && signInFrom.current) {
      wasBlocked.current = false;
      document.getElementById(signInAgainButtonId(signInFrom.current))?.focus();
    }
  }, [blocked]);

  if (!(runtime && snapshot)) {
    return (
      <AttentionFrame>
        <AttentionStateCard>
          O modo offline não está ativo neste aparelho.
        </AttentionStateCard>
      </AttentionFrame>
    );
  }
  if (snapshot.phase !== "ready") {
    return (
      <PageLoading
        label={
          snapshot.phase === "unavailable"
            ? "O modo offline não está disponível neste aparelho agora."
            : "Preparando o modo offline…"
        }
        skeleton={snapshot.phase !== "unavailable"}
      />
    );
  }
  return (
    <AttentionPanel
      busyCommandId={busy}
      error={error}
      notices={<LogoutNotices inAttentionPage logout={logout} />}
      onDiscard={handleDiscard}
      onResubmit={handleResubmit}
      onSignInAgain={handleSignInAgain}
      signingOut={logout.busy}
      summary={summary}
    />
  );
}
