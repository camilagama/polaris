import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { routeTree } from "./routeTree.gen";
import { NONCE_HEADER } from "./server/security";

// The nonce the server entry made for this request (ADR 0090); the router puts it on the inline scripts it
// renders. The browser reads it back from the page's meta tag, so the client has nothing to pass. A build
// that reaches here without one is not running through src/server.ts: it would render a page with no
// policy, so it fails instead (the dev server has no policy by design).
const requestNonce = createIsomorphicFn()
  .server(() => {
    const nonce = getRequest().headers.get(NONCE_HEADER) ?? undefined;
    if (nonce === undefined && !import.meta.env.DEV) {
      throw new Error("catalog_nonce_missing");
    }
    return nonce;
  })
  .client(() => undefined);

// Start asks for a new router for every request.
export function getRouter() {
  const nonce = requestNonce();
  return createRouter({
    defaultErrorComponent: Unavailable,
    defaultNotFoundComponent: NotFound,
    routeTree,
    scrollRestoration: true,
    ...(nonce === undefined ? {} : { ssr: { nonce } }),
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
