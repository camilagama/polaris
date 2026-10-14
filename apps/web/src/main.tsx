import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { orpcClient } from "./lib/orpc";
import "./styles.css";

function App() {
  const [result, setResult] = useState("Não chamado");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handlePing = useCallback(async () => {
    setIsPending(true);
    setError(null);

    try {
      const response = await orpcClient.system.ping();
      setResult(response.message);
    } catch {
      setError("Falha ao chamar system.ping.");
    } finally {
      setIsPending(false);
    }
  }, []);

  return (
    <main className="app-shell">
      <h1>Polaris</h1>
      <p>POC oRPC</p>
      <button disabled={isPending} onClick={handlePing} type="button">
        {isPending ? "Chamando…" : "Testar system.ping"}
      </button>
      {import.meta.env.DEV ? (
        <a className="offline-lab-entry-link" href="/offline-poc?release=1">
          Abrir laboratório de persistência offline
        </a>
      ) : null}
      <output aria-live="polite">{error ?? result}</output>
    </main>
  );
}

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

if (isOfflinePocRoute) {
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
