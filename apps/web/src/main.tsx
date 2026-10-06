import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="app-shell">
      <h1>Polaris</h1>
      <p>Fundação Web inicial</p>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("O elemento raiz da aplicação não foi encontrado.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
