import { createFileRoute } from "@tanstack/react-router";
import { keepOutOfSearch } from "../seo";
import { HomeView, useFooterHref } from "../views";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({ meta: [keepOutOfSearch] }),
});

function Home() {
  return <HomeView footerHref={useFooterHref()} />;
}
