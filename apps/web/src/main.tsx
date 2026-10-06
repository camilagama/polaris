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
      <output aria-live="polite">{error ?? result}</output>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("O elemento raiz da aplicação não foi encontrado.");
}

createRoot(rootElement).render(<App />);
