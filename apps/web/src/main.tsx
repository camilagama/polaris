// The CSS entry before any other import: it declares the order of the cascade layers before any other
// sheet (ADR 0103), and the CSS of a module imported earlier (a lab's own sheet) would come first.
import "./styles/index.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app-shell/app";
import { followMotionLevel } from "./lib/motion-level";
import { followSystemTheme } from "./lib/theme";
import { initSentry } from "./observability/sentry";
import {
  browserRegisterEnvironment,
  registerServiceWorker,
} from "./pwa/register";
import { restoreScrollAfterSwap } from "./pwa/auto-swap";
import {
  checkForUpdatesRegularly,
  getUpdateStore,
  startUpdates,
} from "./pwa/runtime";
import { watchTypedFields } from "./pwa/swap-guard";

// Error reporting is off unless the build has a Sentry DSN (ADR 0098); never blocks the first paint.
// The guard is on the build constant, so a build without a DSN drops the SDK chunk altogether.
if (import.meta.env.VITE_SENTRY_DSN) {
  initSentry({
    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,
    VITE_SENTRY_ENVIRONMENT: import.meta.env.VITE_SENTRY_ENVIRONMENT,
    VITE_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE,
  }).catch(() => undefined);
}

// The system can go from dark to light with the page open: the `dark` class follows it (U-40).
followSystemTheme();
// How much the interface moves (ADR 0103, "Níveis de movimento"): `data-motion` on <html> before the first render, and
// again when the window crosses the line of the phone or the system asks for no motion.
followMotionLevel();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("O elemento raiz da aplicação não foi encontrado.");
}

const reactRoot = createRoot(rootElement);
// Base UI never renders its <style> elements under the shell's CSP (`style-src 'self'`, ADR 0103):
// the one rule they carried, hiding the native scrollbar, is in styles/index.css.
const root = {
  render: (node: ReactNode) =>
    reactRoot.render(<CSPProvider disableStyleElements>{node}</CSPProvider>),
};
const isOfflinePocEnabled =
  import.meta.env.DEV ||
  import.meta.env.MODE === "offline-poc" ||
  import.meta.env.VITE_OFFLINE_POC_ENABLED === "true";
const isOfflinePocRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-poc";
const isOutboxLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-outbox-lab";
const isLocalLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-local-lab";
const isRuntimeLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-runtime-lab";
const isLogoutLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-logout-lab";
const isAttentionLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-attention-lab";
// The lab of the screens is also in the browser-check build: the interface guardrails measure the sale screen there.
const isScreensLabRoute =
  (isOfflinePocEnabled || import.meta.env.MODE === "pwa-e2e") &&
  window.location.pathname === "/offline-screens-lab";
// The gallery of the interface primitives (ADR 0103): never in the production build, where no screen uses
// them yet; the browser checks open it under the shell's CSP.
const isUiGalleryRoute =
  (isOfflinePocEnabled || import.meta.env.MODE === "pwa-e2e") &&
  window.location.pathname === "/ui-galeria";

// The pieces around the screens (404, failure, loading, notices, "Sair", expired access) in the states the
// browser checks measure: a lab like the one of the screens, only in the builds of the browser checks.
const isShellPiecesRoute =
  (isOfflinePocEnabled || import.meta.env.MODE === "pwa-e2e") &&
  window.location.pathname === "/ui-pecas-do-shell";

if (isShellPiecesRoute) {
  const loadShellPieces = async () => {
    try {
      const { ShellPiecesGallery } = await import(
        "./offline-poc/screens-lab-shell-pieces"
      );
      root.render(<ShellPiecesGallery />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir as peças do shell</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadShellPieces().catch(() => undefined);
} else if (isUiGalleryRoute) {
  const loadUiGallery = async () => {
    try {
      const { UiGallery } = await import("./ui-gallery/ui-gallery");
      root.render(<UiGallery />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir a galeria da interface</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadUiGallery().catch(() => undefined);
} else if (isRuntimeLabRoute) {
  const loadRuntimeLab = async () => {
    try {
      const { RuntimeLab } = await import("./offline-poc/runtime-lab");
      root.render(<RuntimeLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório do runtime</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadRuntimeLab().catch(() => undefined);
} else if (isLogoutLabRoute) {
  const loadLogoutLab = async () => {
    try {
      const { LogoutLab } = await import("./offline-poc/logout-lab");
      root.render(<LogoutLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório da saída</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadLogoutLab().catch(() => undefined);
} else if (isScreensLabRoute) {
  const loadScreensLab = async () => {
    try {
      const { ScreensLab } = await import("./offline-poc/screens-lab");
      root.render(<ScreensLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório das telas</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadScreensLab().catch(() => undefined);
} else if (isAttentionLabRoute) {
  const loadAttentionLab = async () => {
    try {
      const { AttentionLab } = await import("./offline-poc/attention-lab");
      root.render(<AttentionLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório da atenção</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadAttentionLab().catch(() => undefined);
} else if (isOutboxLabRoute) {
  const loadOutboxLab = async () => {
    try {
      const { OutboxLab } = await import("./offline-poc/outbox-lab");
      root.render(<OutboxLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório do outbox</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadOutboxLab().catch(() => undefined);
} else if (isLocalLabRoute) {
  const loadLocalLab = async () => {
    try {
      const { LocalCollectionsLab } = await import(
        "./offline-poc/local-collections-lab"
      );
      root.render(<LocalCollectionsLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório das coleções locais</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadLocalLab().catch(() => undefined);
} else if (isOfflinePocRoute) {
  root.render(<main>Carregando laboratório offline…</main>);
  const loadOfflineLab = async () => {
    try {
      const { OfflinePersistenceLab } = await import(
        "./offline-poc/offline-persistence-lab"
      );
      root.render(<OfflinePersistenceLab />);
    } catch (error: unknown) {
      root.render(
        <main role="alert">
          <h1>Falha ao abrir o laboratório offline</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadOfflineLab().catch(() => undefined);
} else {
  // what is typed counts from the first key, and an idle swap comes back to the scroll it left (pwa/auto-swap.ts)
  watchTypedFields();
  root.render(<App />);
  restoreScrollAfterSwap();
  if (import.meta.env.MODE === "pwa-e2e") {
    // Only in the browser-check build: lets the test play the part of the outbox.
    (window as unknown as { polarisUpdateStore: unknown }).polarisUpdateStore =
      getUpdateStore();
  }
  const pwaEnvironment = browserRegisterEnvironment();
  if (pwaEnvironment) {
    // After the first paint: the shell cache never competes with the app for the network.
    window.addEventListener("load", () => {
      registerServiceWorker(pwaEnvironment)
        .then((registration) => {
          const updates = getUpdateStore();
          if (registration && updates) {
            startUpdates(updates, registration);
            checkForUpdatesRegularly(registration);
          }
        })
        .catch(() => undefined);
    });
  }
}
