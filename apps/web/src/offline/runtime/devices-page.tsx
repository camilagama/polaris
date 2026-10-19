import type { DeviceReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../../lib/orpc";
import { LogoutDialog } from "../logout-dialog";
import { DeviceItem } from "./device-item";
import {
  type DeviceRow,
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
import "./devices-page.css";
import { forgetSessionCaches, leaveTo, signInPath } from "./leave-browser";
import { useLogout } from "./logout-control";
import type { OfflineRuntime, RuntimeSnapshot } from "./offline-runtime";
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

type Recognition = "failed" | "waiting";

/**
 * Whether the screen is still waiting to know which row is this browser (null when it
 * does not need to). It gives up when the runtime says it is unavailable, or after a while.
 */
function useRecognition(
  online: boolean,
  knowsThisDevice: boolean,
  sessionOver: boolean,
  snapshot: RuntimeSnapshot | null
): Recognition | null {
  const [slow, setSlow] = useState(false);
  const waiting = online && !knowsThisDevice && !sessionOver;
  useEffect(() => {
    setSlow(false);
    if (!waiting) {
      return;
    }
    const timer = setTimeout(() => setSlow(true), RECOGNIZING_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  if (!waiting) {
    return null;
  }
  return slow || snapshot === null || snapshot.phase === "unavailable"
    ? "failed"
    : "waiting";
}

function RecognitionLine({ state }: { state: Recognition }) {
  return state === "failed" ? (
    <p className="categories-message is-error" role="status">
      {RECOGNIZING_FAILED_TEXT}
    </p>
  ) : (
    <p className="device-recognizing" role="status">
      {RECOGNIZING_TEXT}
    </p>
  );
}

interface ListSectionProps {
  actionError: string | null;
  busy: boolean;
  /** The id of the row whose confirmation is open. */
  confirming: string | null;
  devices: DeviceReadModel[] | null;
  endOtherSessions: boolean;
  loadFailed: string | null;
  loading: boolean;
  notice: string | null;
  /** The buttons are off: no connection, or this browser's device is not known yet. */
  offline: boolean;
  onAsk: (id: string) => void;
  onCancel: () => void;
  onChoose: (endOtherSessions: boolean) => void;
  onDismiss: () => void;
  online: boolean;
  onRetry: () => void;
  onRevoke: (id: string) => void;
  panel: SignInAgainPanel | null;
  recognition: Recognition | null;
  rows: DeviceRow[];
}

/** Everything under the heading while this browser's session is alive: messages, then the list. */
function ListSection({
  actionError,
  confirming,
  devices,
  loadFailed,
  loading,
  notice,
  offline,
  onDismiss,
  onRetry,
  online,
  panel,
  recognition,
  rows,
  ...shared
}: ListSectionProps) {
  const sessionGone = panel?.kind === "session_gone";
  // an unsure answer is said inside the open confirmation; if the row left the list meanwhile, it is said here
  const errorInsideRow =
    confirming !== null && rows.some((row) => row.id === confirming);
  return (
    <>
      {panel ? <SignInAgain onDismiss={onDismiss} panel={panel} /> : null}
      {loading ? (
        <p aria-busy="true" className="device-loading" role="status">
          {LOADING_TEXT}
        </p>
      ) : null}
      {loadFailed && online && !panel ? (
        <p className="categories-message is-error" role="alert">
          {loadFailed}{" "}
          <button className="quiet-button" onClick={onRetry} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {actionError && !errorInsideRow ? (
        <p className="categories-message is-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="categories-message is-success" role="status">
          {notice}
        </p>
      ) : null}
      {devices && rows.length === 0 && !loadFailed ? (
        <p className="category-empty-state">{EMPTY_TEXT}</p>
      ) : null}
      {devices && recognition && !sessionGone ? (
        <RecognitionLine state={recognition} />
      ) : null}
      {devices && sessionGone ? (
        <p className="categories-message is-error" role="status">
          {SESSION_GONE_LIST_TEXT}
        </p>
      ) : null}
      {devices ? (
        <ul aria-label="Aparelhos" className="device-list">
          {rows.map((row) => (
            <DeviceItem
              actionError={confirming === row.id ? actionError : null}
              confirming={confirming === row.id}
              key={row.id}
              offline={offline || sessionGone}
              row={row}
              {...shared}
            />
          ))}
        </ul>
      ) : null}
    </>
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
  const recognition = useRecognition(
    online,
    knowsThisDevice,
    sessionOver,
    snapshot
  );
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
    setActionError(null);
    setEndOtherSessions(false);
    setConfirming(null);
  }, []);
  const handleRetry = useCallback(() => {
    setLoadFailed(null);
    setReloadVersion((version) => version + 1);
  }, []);
  const handleDismiss = useCallback(() => setPanel(null), []);

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
      {endedHere ? (
        <BrowserLeft keptWork={endedHere.keptWork} />
      ) : (
        <ListSection
          actionError={actionError}
          busy={busy}
          confirming={confirming}
          devices={devices}
          endOtherSessions={endOtherSessions}
          loadFailed={loadFailed}
          loading={loading}
          notice={notice}
          offline={!(online && knowsThisDevice)}
          onAsk={handleAsk}
          onCancel={handleCancel}
          onChoose={setEndOtherSessions}
          onDismiss={handleDismiss}
          online={online}
          onRetry={handleRetry}
          onRevoke={handleRevokeEvent}
          panel={panel}
          recognition={recognition}
          rows={rows}
        />
      )}
    </div>
  );
}
