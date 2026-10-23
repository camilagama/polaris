import type { ReactNode } from "react";
import { ErrorBoundary } from "../app-shell/error-boundary";
import { LegalAcceptanceNotice } from "../app-shell/legal-acceptance-notice";
import { NotFoundPage } from "../app-shell/not-found-page";
import { PageLoading } from "../app-shell/page-loading";
import { SessionEndedNotice } from "../app-shell/session-ended-notice";
import { useReportUnsentWork } from "../lib/unsent-work";
import { LogoutDialog } from "../offline/logout-dialog";
import type { BlockedWorkspace } from "../offline/logout-guard";
import { OfflineAccessExpiredView } from "../offline/runtime/offline-access-expired";
import type { RuntimeSnapshot } from "../offline/runtime/offline-runtime";
import { UpdateBannerView } from "../pwa/update-banner";
import { NO_PENDING_WORK, offerFor } from "../pwa/update-model";
import type { UpdateSnapshot } from "../pwa/update-store";

/**
 * The pieces around the screens (v5.1), each in the states the browser checks measure (`?estado=`): the 404, the
 * failure of a screen, the loading, the notices of the session, the acceptance and the new version, "Sair" with
 * work to lose and the offline access that expired. Real components with synthetic data, in a frame like the
 * shell's `main`; only in the builds of the browser checks (see main.tsx; the chunk is named `screens-lab-*`, which
 * the precache check keeps out of the production build). The same pieces run in the real shell in the browser tests
 * of the sessions, of the acceptance, of "Sair" and of the update.
 */
const none = () => undefined;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background" data-ui="">
      <main
        className="mx-auto w-[min(100%-2rem,76rem)] py-8 font-sans text-foreground text-sm antialiased"
        id="conteudo"
      >
        <h1 className="sr-only">Peças do shell</h1>
        {children}
      </main>
    </div>
  );
}

function Boom(): never {
  throw new Error("Falha de teste");
}

const updateSnapshot = (
  work: Partial<UpdateSnapshot["work"]>,
  message: string | null = null
): UpdateSnapshot => {
  const merged = { ...NO_PENDING_WORK, ...work };
  return {
    applying: false,
    message,
    offer: offerFor(true, merged),
    waiting: true,
    work: merged,
  };
};

/** The notices of the top of a screen, one under the other: the session, the acceptance and the update. */
function Notices() {
  // the screen says by itself that it holds something typed: the warning of the session notice and the hint of the link
  useReportUnsentWork(true);
  return (
    <>
      <SessionEndedNotice alone />
      <LegalAcceptanceNotice />
      <UpdateBannerView onApply={none} snapshot={updateSnapshot({})} />
      <UpdateBannerView
        onApply={none}
        snapshot={updateSnapshot(
          { pending: 2, sending: 1 },
          "Ainda não foi possível enviar a fila. Tente de novo com conexão."
        )}
      />
      <UpdateBannerView
        onApply={none}
        snapshot={updateSnapshot({ rejected: 2 })}
      />
    </>
  );
}

const BLOCKED: BlockedWorkspace[] = [
  {
    attention: { items: [], waitingBehind: 0 },
    label: "Loja do laboratório",
    pending: 2,
    reason: "offline",
    sending: 1,
    total: 3,
  },
];

const EXPIRED: RuntimeSnapshot = {
  bootstrapped: false,
  counts: { pending: 2, rejected: 0, sending: 0 },
  dataVersion: 0,
  expiredWhileOpen: true,
  lastSyncAt: null,
  leaseExpiresAt: "2026-10-17T12:00:00.000Z",
  legalAcceptanceRequired: false,
  online: true,
  phase: "expired",
  reason: "offline_access_expired",
  renewalRefused: false,
  sessionRefused: false,
  syncing: false,
};

const SHELL_PIECES = [
  "carregando",
  "erro",
  "nao-encontrada",
  "avisos",
  "sair",
  "acesso-vencido",
] as const;

type ShellPiece = (typeof SHELL_PIECES)[number];

function pieceOf(search: string): ShellPiece {
  const requested = new URLSearchParams(search).get("estado");
  return SHELL_PIECES.find((piece) => piece === requested) ?? "nao-encontrada";
}

/** "Sair" with work to lose: the panel under the button, in the width of the sidebar's footer (a narrow column). */
function LogoutPiece() {
  return (
    <div className="max-w-sm">
      <LogoutDialog
        blocked={BLOCKED}
        errorMessage={null}
        onCancel={none}
        onDiscard={none}
        onRetry={none}
        onShowAttention={none}
      />
    </div>
  );
}

export function ShellPiecesGallery() {
  const piece = pieceOf(window.location.search);
  return (
    <Frame>
      {piece === "carregando" ? <PageLoading /> : null}
      {piece === "erro" ? (
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      ) : null}
      {piece === "nao-encontrada" ? (
        <NotFoundPage pathname="/produtos-antigos/categoria-com-um-nome-bem-comprido" />
      ) : null}
      {piece === "avisos" ? <Notices /> : null}
      {piece === "sair" ? <LogoutPiece /> : null}
      {piece === "acesso-vencido" ? (
        <OfflineAccessExpiredView onRetry={none} snapshot={EXPIRED} />
      ) : null}
    </Frame>
  );
}
