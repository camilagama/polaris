import { type ReactNode, useEffect, useRef } from "react";
import type { RuntimeSnapshot } from "./offline-runtime";
import { useRuntimeSnapshot } from "./runtime-context";

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
export const ACCESS_EXPIRED_BODY =
  "Este aparelho ficou muito tempo sem se conectar à internet. Conecte-se para continuar.";
export const ACCESS_RENEWING = "Conexão de volta. Renovando o acesso…";

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

export function OfflineAccessExpiredView({
  snapshot,
}: {
  snapshot: RuntimeSnapshot;
}) {
  const renewing = snapshot.online && snapshot.syncing;
  const noticeRef = useRef<HTMLElement>(null);
  // it takes the place of the page, maybe under the person's finger: the focus moves to it and it is announced
  useEffect(() => {
    noticeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      aria-labelledby="offline-access-expired-title"
      className="app-gate offline-access-expired"
      ref={noticeRef}
      role="alert"
      tabIndex={-1}
    >
      <h1 id="offline-access-expired-title">{ACCESS_EXPIRED_TITLE}</h1>
      <p>{ACCESS_EXPIRED_BODY}</p>
      <p data-testid="offline-access-expired-queue">
        {storedOperationsText(storedOperations(snapshot))}
      </p>
      <p aria-live="polite" role="status">
        {renewing ? ACCESS_RENEWING : ""}
      </p>
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
  snapshot,
}: {
  children: ReactNode;
  snapshot: RuntimeSnapshot | null;
}) {
  if (snapshot?.phase === "expired") {
    return <OfflineAccessExpiredView snapshot={snapshot} />;
  }
  return <>{children}</>;
}

export function OfflineAccessGate({ children }: { children: ReactNode }) {
  return (
    <OfflineAccessGateView snapshot={useRuntimeSnapshot()}>
      {children}
    </OfflineAccessGateView>
  );
}
