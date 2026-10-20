import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RuntimeSnapshot } from "./offline-runtime";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

/**
 * The offline access of this device expired (the own lease passed its `exp`
 * with no connection to renew it; emenda do ADR 0047). The screen says so in
 * place of the page: no screen reads the local copy and nothing new can be
 * queued, the queue stays, and the app does not go to the sign-in screen (the
 * session was not refused). When the network returns the runtime renews the
 * access by itself and the page comes back without a reload.
 */
export const ACCESS_EXPIRED_TITLE = "O acesso sem internet venceu";
// Not "72 horas": the lease is renewed only in its last 12 hours, so the device may have been offline for less.
export const ACCESS_EXPIRED_BODY_ONLINE =
  "Este aparelho ficou muito tempo sem se conectar à internet.";
/** Offline the body also says what to do; with internet the person is already connected, so "Conecte-se" would mislead. */
export const ACCESS_EXPIRED_BODY = `${ACCESS_EXPIRED_BODY_ONLINE} Conecte-se para continuar.`;
export const ACCESS_RENEWING = "Conexão de volta. Renovando o acesso…";
/** Only when the access ended with the app open: the page that was on the screen is gone, and so is what was typed in it. */
export const ACCESS_SALE_NOT_KEPT =
  "A venda que você estava montando não foi guardada. Quando o acesso voltar, monte de novo.";
export const ACCESS_RETURNS_BY_ITSELF =
  "Quando a internet voltar, o acesso volta sozinho.";
export const ACCESS_RENEW_FAILED =
  "Há internet, mas não conseguimos renovar o acesso agora. Vamos tentar de novo em instantes.";
export const ACCESS_RENEW_REFUSED =
  "Não conseguimos renovar o acesso deste aparelho. Feche e abra o app com internet.";
export const ACCESS_RETRY = "Tentar agora";
export const ACCESS_RENEWED = "Acesso renovado.";
/** How long "Acesso renovado." stays on the page. */
const RENEWED_NOTICE_MS = 5000;

/** Every operation still on the device: waiting, being sent or refused; none of them is lost. */
function storedOperations(snapshot: RuntimeSnapshot): number {
  const { pending, rejected, sending } = snapshot.counts;
  return pending + rejected + sending;
}

export function storedOperationsText(count: number): string {
  if (count === 0) {
    return "Não há operações guardadas neste aparelho.";
  }
  return count === 1
    ? "Há 1 operação guardada neste aparelho. Ela não se perde."
    : `Há ${count} operações guardadas neste aparelho. Elas não se perdem.`;
}

/** What the status line says: renewing, refused for good, or (online, not renewing) that it will try again. */
function renewalText(snapshot: RuntimeSnapshot): string {
  if (snapshot.online && snapshot.syncing) {
    return ACCESS_RENEWING;
  }
  if (snapshot.renewalRefused) {
    return ACCESS_RENEW_REFUSED;
  }
  return snapshot.online ? ACCESS_RENEW_FAILED : "";
}

export function OfflineAccessExpiredView({
  onRetry,
  snapshot,
}: {
  /** Tries to renew the access now; without it no button is drawn. */
  onRetry?: (() => void) | undefined;
  snapshot: RuntimeSnapshot;
}) {
  const canRetry =
    onRetry !== undefined &&
    snapshot.online &&
    !(snapshot.syncing || snapshot.renewalRefused);
  const noticeRef = useRef<HTMLElement>(null);
  // it takes the place of the page, maybe under the person's finger: the focus moves to it and it is announced
  useEffect(() => {
    noticeRef.current?.focus({ preventScroll: true });
  }, []);
  // the button leaves while it renews: the focus stays in the notice
  const retry = useCallback(() => {
    noticeRef.current?.focus({ preventScroll: true });
    onRetry?.();
  }, [onRetry]);
  return (
    <section
      aria-labelledby="offline-access-expired-title"
      className="app-gate offline-access-expired"
      ref={noticeRef}
      role="alert"
      tabIndex={-1}
    >
      <h1 id="offline-access-expired-title">{ACCESS_EXPIRED_TITLE}</h1>
      <p>
        {snapshot.online ? ACCESS_EXPIRED_BODY_ONLINE : ACCESS_EXPIRED_BODY}
      </p>
      {snapshot.expiredWhileOpen ? <p>{ACCESS_SALE_NOT_KEPT}</p> : null}
      <p data-testid="offline-access-expired-queue">
        {storedOperationsText(storedOperations(snapshot))}
      </p>
      {snapshot.online || snapshot.renewalRefused ? null : (
        <p>{ACCESS_RETURNS_BY_ITSELF}</p>
      )}
      <p aria-live="polite" role="status">
        {renewalText(snapshot)}
      </p>
      {canRetry ? (
        <button className="secondary-button" onClick={retry} type="button">
          {ACCESS_RETRY}
        </button>
      ) : null}
    </section>
  );
}

/** Whether the offline access of the open organization expired. */
export function useOfflineAccessExpired(): boolean {
  return useRuntimeSnapshot()?.phase === "expired";
}

/** The page, or the notice in its place while the offline access is expired (null: no runtime). */
export function OfflineAccessGateView({
  children,
  onRetry,
  renewed = false,
  snapshot,
}: {
  children: ReactNode;
  onRetry?: (() => void) | undefined;
  /** The access came back a moment ago: a line says so above the page. */
  renewed?: boolean;
  snapshot: RuntimeSnapshot | null;
}) {
  if (snapshot?.phase === "expired") {
    return <OfflineAccessExpiredView onRetry={onRetry} snapshot={snapshot} />;
  }
  // the status region stays mounted (empty) so a screen reader announces the text when it fills in
  return (
    <>
      {snapshot ? (
        <p className="offline-access-renewed" role="status">
          {renewed ? ACCESS_RENEWED : ""}
        </p>
      ) : null}
      {children}
    </>
  );
}

/** True for a few seconds after the access went from expired back to ready. */
function useAccessRenewedNotice(snapshot: RuntimeSnapshot | null): boolean {
  const phase = snapshot?.phase;
  const wasExpired = useRef(false);
  const [renewed, setRenewed] = useState(false);
  useEffect(() => {
    if (phase === "expired") {
      wasExpired.current = true;
      setRenewed(false);
      return;
    }
    if (phase === "ready" && wasExpired.current) {
      wasExpired.current = false;
      setRenewed(true);
      const timer = setTimeout(() => setRenewed(false), RENEWED_NOTICE_MS);
      return () => clearTimeout(timer);
    }
    wasExpired.current = false;
    setRenewed(false);
  }, [phase]);
  return renewed;
}

export function OfflineAccessGate({ children }: { children: ReactNode }) {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const renewed = useAccessRenewedNotice(snapshot);
  const retry = useCallback(() => {
    runtime?.syncNow().catch(() => undefined);
  }, [runtime]);
  return (
    <OfflineAccessGateView
      onRetry={runtime ? retry : undefined}
      renewed={renewed}
      snapshot={snapshot}
    >
      {children}
    </OfflineAccessGateView>
  );
}
