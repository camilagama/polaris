import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { polarisSiteHref } from "../polaris-site";

/** The footer's link to the Polaris site: the configured address when it is valid, otherwise null (only text). */
export const getFooterHref = createServerFn().handler(
  (): { footerHref: string | null } => ({
    footerHref: polarisSiteHref(env.POLARIS_SITE_URL),
  })
);
