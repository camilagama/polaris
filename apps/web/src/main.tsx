import { createRoot } from "react-dom/client";
import { App } from "./app-shell/app";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/ui.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("O elemento raiz da aplicação não foi encontrado.");
}

const root = createRoot(rootElement);
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
const isAttentionLabRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-attention-lab";

if (isAttentionLabRoute) {
  const loadAttentionLab = async () => {
    try {
      const { AttentionLab } = await import("./offline-poc/attention-lab");
      root.render(<AttentionLab />);
    } catch (error: unknown) {
      root.render(
        <main className="app-shell" role="alert">
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
        <main className="app-shell" role="alert">
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
        <main className="app-shell" role="alert">
          <h1>Falha ao abrir o laboratório das coleções locais</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadLocalLab().catch(() => undefined);
} else if (isOfflinePocRoute) {
  root.render(
    <main className="app-shell">Carregando laboratório offline…</main>
  );
  const loadOfflineLab = async () => {
    try {
      const { OfflinePersistenceLab } = await import(
        "./offline-poc/offline-persistence-lab"
      );
      root.render(<OfflinePersistenceLab />);
    } catch (error: unknown) {
      root.render(
        <main className="app-shell" role="alert">
          <h1>Falha ao abrir o laboratório offline</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadOfflineLab().catch(() => undefined);
} else {
  root.render(<App />);
}
