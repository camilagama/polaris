import type { DeviceReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../../lib/orpc";
import { LogoutDialog } from "../logout-dialog";
import {
  deviceRows,
  devicesLoadError,
  EMPTY_TEXT,
  LOADING_TEXT,
  OFFLINE_TEXT,
  RECOGNIZING_FAILED_TEXT,
  RECOGNIZING_PATIENCE_MS,
  RECOGNIZING_TEXT,
  revokedMessage,
  revokeFailure,
  SESSION_ENDED_PANEL,
  SESSION_GONE_LIST_TEXT,
  SESSION_GONE_LOAD_PANEL,
  type SignInAgainPanel,
  signInAgainPanel,
} from "./devices-model";
import { DeviceItem } from "./device-item";
import "./devices-page.css";
import { forgetSessionCaches, leaveTo, signInPath } from "./leave-browser";
import { useLogout } from "./logout-control";
import type { OfflineRuntime } from "./offline-runtime";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";
import {
  markSessionEndedHere,
  markSessionOver,
  useSessionEndedHere,
} from "./session-ended";

const SESSION_COPY_GRACE_MS = 5000;

/** The session is already gone: drop the local copy that needs it (never the queue), then go to sign in. Never through "Sair". */
function leaveSessionOver(runtime: OfflineRuntime | null): void {
  // a send that never answers must not trap the person on this panel: the caches are
  // already gone and the runtime drops the copy at the next start anyway
  const grace = new Promise<void>((resolve) => {
    setTimeout(resolve, SESSION_COPY_GRACE_MS);
  });
  Promise.race([runtime?.dropSessionCopy() ?? Promise.resolve(), grace])
    .catch(() => undefined)
    .then(() => leaveTo(signInPath("sessao")));
}

interface SignInAgainProps {
  onDismiss: () => void;
  panel: SignInAgainPanel;
}

/** The revocation did not happen because the login is old or gone: the way back is to sign in. */
function SignInAgain({ onDismiss, panel }: SignInAgainProps) {
  const runtime = useOfflineRuntime();
  const logout = useLogout(signInPath("recente"));
  // a live but old session goes through "Sair" (the queue is protected first);
  // a dead one cannot sign out, and the queue stays where it is
  const handleSignIn = useCallback(() => {
    if (panel.kind === "session_gone") {
      leaveSessionOver(runtime);
    } else {
      logout.start();
    }
  }, [logout, panel.kind, runtime]);
  return (
    <>
      <section
        aria-labelledby="devices-sign-in-title"
        className="device-panel"
        role="alert"
      >
        <h2 id="devices-sign-in-title">{panel.title}</h2>
        <p>{panel.body}</p>
        {logout.message ? <p>{logout.message}</p> : null}
        <div className="device-actions">
          <button
            className="primary-button"
            disabled={logout.busy}
            onClick={handleSignIn}
            type="button"
          >
            Entrar de novo
          </button>
          {panel.kind === "session_old" ? (
            <button
              className="quiet-button"
              disabled={logout.busy}
              onClick={onDismiss}
              type="button"
            >
              Agora não
            </button>
          ) : null}
        </div>
      </section>
      {logout.blocked ? (
        <LogoutDialog
          blocked={logout.blocked}
          busy={logout.busy}
          errorMessage={null}
          onCancel={logout.cancel}
          onDiscard={logout.discard}
          onRetry={logout.start}
          onShowAttention={logout.showAttention}
        />
      ) : null}
    </>
  );
}

/** This browser's session ended with the revoked device: stays until the person acts. */
function BrowserLeft({ keptWork }: { keptWork: boolean }) {
  const runtime = useOfflineRuntime();
  const handleSignIn = useCallback(() => leaveSessionOver(runtime), [runtime]);
  return (
    <section
      aria-labelledby="devices-left-title"
      className="device-panel"
      role="alert"
    >
      <h2 id="devices-left-title">{SESSION_ENDED_PANEL.title}</h2>
      <p>{SESSION_ENDED_PANEL.body}</p>
      {keptWork ? <p>{SESSION_ENDED_PANEL.keptWork}</p> : null}
      <div className="device-actions">
        <button className="primary-button" onClick={handleSignIn} type="button">
          Entrar de novo
        </button>
      </div>
    </section>
  );
}

/** Lists the user's devices and lets them revoke one (lost phone). Needs a connection. */
export function DevicesPage() {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const endedHere = useSessionEndedHere();
  const [devices, setDevices] = useState<DeviceReadModel[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [panel, setPanel] = useState<SignInAgainPanel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [endOtherSessions, setEndOtherSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  const currentDeviceId = runtime?.context()?.deviceId ?? null;
  const online = snapshot?.online ?? true;
  // without the runtime we cannot tell which row is this browser: offer no action at all
  const knowsThisDevice = currentDeviceId !== null;
  const sessionOver = endedHere !== null;
  // the runtime gave up on this browser's device, or it is taking too long: say so instead of leaving the buttons dead
  const [recognitionSlow, setRecognitionSlow] = useState(false);
  const waitingForDevice = online && !knowsThisDevice && !sessionOver;
  useEffect(() => {
    setRecognitionSlow(false);
    if (!waitingForDevice) {
      return;
    }
    const timer = setTimeout(
      () => setRecognitionSlow(true),
      RECOGNIZING_PATIENCE_MS
    );
    return () => clearTimeout(timer);
  }, [waitingForDevice]);
  const recognitionFailed =
    waitingForDevice &&
    (recognitionSlow || snapshot === null || snapshot.phase === "unavailable");

  // the server says the session is over: forget the caches it left here now (the runtime
  // drops the lease and the collections when it sees the refusal, or when the person leaves)
  const handleSessionOver = useCallback(() => {
    markSessionOver();
    forgetSessionCaches();
  }, []);

  useEffect(() => {
    if (sessionOver) {
      return; // the session is gone: the list would only come back as a refusal
    }
    let current = true;
    // reloadVersion re-reads the list after a revocation or a retry
    orpcClient.device
      .list()
      .then(({ devices: found }) => {
        if (current && reloadVersion >= 0) {
          setDevices(found);
          setLoadFailed(null);
        }
      })
      .catch((cause: unknown) => {
        if (!current) {
          return;
        }
        const refusal = signInAgainPanel(cause);
        if (refusal) {
          setPanel(
            refusal.kind === "session_gone" ? SESSION_GONE_LOAD_PANEL : refusal
          );
          if (refusal.kind === "session_gone") {
            handleSessionOver();
          }
        }
        setLoadFailed(devicesLoadError(cause));
      });
    return () => {
      current = false;
    };
  }, [handleSessionOver, reloadVersion, sessionOver]);

  // the connection is back after a failed read: read again without asking
  const wasOnline = useRef(online);
  const hadLoadError = useRef(false);
  hadLoadError.current = loadFailed !== null;
  useEffect(() => {
    if (online && !wasOnline.current && hadLoadError.current) {
      setReloadVersion((version) => version + 1);
    }
    wasOnline.current = online;
  }, [online]);

  // after the render that removed the confirmation, so the focus is not lost to the body
  useEffect(() => {
    if (focusTick > 0) {
      headingRef.current?.focus();
    }
  }, [focusTick]);

  const handleRevoke = useCallback(
    async (id: string) => {
      setBusy(true);
      setActionError(null);
      setNotice(null);
      setPanel(null);
      let reload = true;
      let closed = true;
      try {
        const result = await orpcClient.device.revoke({
          deviceId: id,
          endOtherSessions,
        });
        if (result.endedCurrentSession) {
          const counts = runtime?.getSnapshot().counts;
          markSessionEndedHere({
            keptWork:
              counts !== undefined &&
              counts.pending + counts.rejected + counts.sending > 0,
          });
          reload = false;
          handleSessionOver();
        } else {
          setNotice(
            revokedMessage({
              grants: result.revokedGrantIds.length,
              sessions: result.endedSessionCount,
            })
          );
        }
        setConfirming(null);
      } catch (cause) {
        const failure = revokeFailure(cause);
        if (failure.kind === "sign_in_again") {
          setPanel(failure.panel);
          setConfirming(null);
          reload = false;
          if (failure.panel.kind === "session_gone") {
            handleSessionOver();
          }
        } else {
          setActionError(failure.text);
          if (failure.uncertain) {
            closed = false;
          } else {
            setConfirming(null);
          }
        }
      } finally {
        setBusy(false);
        // the confirmation that held the focus is gone: keep the place for keyboard and screen reader
        if (closed) {
          setFocusTick((tick) => tick + 1);
        }
        if (reload) {
          setReloadVersion((version) => version + 1);
        }
      }
    },
    [endOtherSessions, handleSessionOver, runtime]
  );
  const handleRevokeEvent = useCallback(
    (id: string) => {
      handleRevoke(id).catch(() => undefined);
    },
    [handleRevoke]
  );
  const handleAsk = useCallback((id: string) => {
    setEndOtherSessions(false);
    setActionError(null);
    setConfirming(id);
  }, []);
  const handleCancel = useCallback(() => {
    setEndOtherSessions(false);
    setConfirming(null);
  }, []);
  const handleRetry = useCallback(() => {
    setLoadFailed(null);
    setReloadVersion((version) => version + 1);
  }, []);
  const handleDismiss = useCallback(() => setPanel(null), []);

  const sessionGone = panel?.kind === "session_gone";
  const rows = devices ? deviceRows(devices, currentDeviceId) : [];
  const loading = devices === null && loadFailed === null && !sessionOver;
  return (
    <div className="devices-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Segurança</p>
          <h1 ref={headingRef} tabIndex={-1}>
            Aparelhos
          </h1>
          <p className="categories-intro-copy">
            Os aparelhos em que você usa o Polaris offline. Se perdeu um celular
            ou computador, revogue o aparelho: o servidor deixa de aceitar o que
            ele enviar.
          </p>
        </div>
      </section>
      {online ? null : (
        <p className="categories-message is-error" role="status">
          {OFFLINE_TEXT}
        </p>
      )}
      {endedHere ? <BrowserLeft keptWork={endedHere.keptWork} /> : null}
      {panel && !endedHere ? (
        <SignInAgain onDismiss={handleDismiss} panel={panel} />
      ) : null}
      {loading ? (
        <p aria-busy="true" className="device-loading" role="status">
          {LOADING_TEXT}
        </p>
      ) : null}
      {loadFailed && online && !panel && !endedHere ? (
        <p className="categories-message is-error" role="alert">
          {loadFailed}{" "}
          <button className="quiet-button" onClick={handleRetry} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {actionError && confirming === null && !endedHere ? (
        <p className="categories-message is-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {notice && !endedHere ? (
        <p className="categories-message is-success" role="status">
          {notice}
        </p>
      ) : null}
      {devices && rows.length === 0 && !loadFailed && !endedHere ? (
        <p className="category-empty-state">{EMPTY_TEXT}</p>
      ) : null}
      {devices && waitingForDevice ? (
        <p
          className={
            recognitionFailed
              ? "categories-message is-error"
              : "device-recognizing"
          }
          role="status"
        >
          {recognitionFailed ? RECOGNIZING_FAILED_TEXT : RECOGNIZING_TEXT}
        </p>
      ) : null}
      {devices && sessionGone && !endedHere ? (
        <p className="categories-message is-error" role="status">
          {SESSION_GONE_LIST_TEXT}
        </p>
      ) : null}
      {devices && !endedHere ? (
        <ul aria-label="Aparelhos" className="device-list">
          {rows.map((row) => (
            <DeviceItem
              actionError={confirming === row.id ? actionError : null}
              busy={busy}
              confirming={confirming === row.id}
              endOtherSessions={endOtherSessions}
              key={row.id}
              offline={!(online && knowsThisDevice) || sessionGone}
              onAsk={handleAsk}
              onCancel={handleCancel}
              onChoose={setEndOtherSessions}
              onRevoke={handleRevokeEvent}
              row={row}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
