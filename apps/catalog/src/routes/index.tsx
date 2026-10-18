import { createFileRoute } from "@tanstack/react-router";
import { keepOutOfSearch } from "../seo";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({ meta: [keepOutOfSearch] }),
});

function Home() {
  return (
    <main className="page">
      <h1>Catálogo Polaris</h1>
      <p>Abra o endereço de uma loja para ver o catálogo dela.</p>
    </main>
  );
}
