import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getFooterHref } from "../server/site";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  component: () => <Outlet />,
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Catálogo Polaris" },
    ],
  }),
  // The footer's link is the same on every page and for every visitor: read once, not on each navigation.
  loader: () => getFooterHref(),
  shellComponent: Shell,
  staleTime: Number.POSITIVE_INFINITY,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
