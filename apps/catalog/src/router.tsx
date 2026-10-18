import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// Start asks for a new router for every request.
export function getRouter() {
  return createRouter({
    defaultErrorComponent: Unavailable,
    defaultNotFoundComponent: NotFound,
    routeTree,
    scrollRestoration: true,
  });
}

// The visitor never sees the error itself: it may name our infrastructure.
function Unavailable() {
  return (
    <main className="page">
      <h1>Catálogo indisponível</h1>
      <p>
        Não foi possível carregar esta página agora. Tente de novo em instantes.
      </p>
    </main>
  );
}

function NotFound() {
  return (
    <main className="page">
      <h1>Página não encontrada</h1>
      <p>Este catálogo ou produto não está disponível.</p>
    </main>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
