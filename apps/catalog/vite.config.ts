import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// "bare-entry" exists only for the browser tests: a Worker whose main skips src/server.ts, the
// misconfiguration the router must refuse (catalog_nonce_missing). It is never deployed, so it
// shares nothing with the real Worker: another name, no public URLs, and a fictitious bucket
// instead of the production one.
const bareEntry = (config: { [key: string]: unknown }) => {
  config.main = "@tanstack/react-start/server-entry";
  config.name = "polaris-catalog-bare-entry-test";
  config.preview_urls = false;
  // replaced, not merged: the plugin concatenates arrays with the ones of wrangler.jsonc
  config.r2_buckets = [
    { binding: "MEDIA_BUCKET", bucket_name: "polaris-bare-entry-test-unused" },
  ];
  config.workers_dev = false;
};

// The Cloudflare plugin points .wrangler/deploy/config.json (what `wrangler deploy` follows) at the
// output of every build, and `vite preview` reads it to find the Worker it serves. The bare-entry
// build therefore leaves it on dist-bare only until its preview has started, then puts back what it
// found, so that a manual deploy after the e2e run can never publish the test-only Worker.
const DEPLOY_REDIRECT = resolve(".wrangler/deploy/config.json");
const REDIRECT_BEFORE = resolve("dist-bare/deploy-redirect.before.json");

function restoreDeployRedirectAfterPreview(): Plugin {
  let before: string | undefined;
  return {
    buildStart() {
      before = existsSync(DEPLOY_REDIRECT)
        ? readFileSync(DEPLOY_REDIRECT, "utf8")
        : undefined;
    },
    closeBundle: {
      handler() {
        writeFileSync(REDIRECT_BEFORE, JSON.stringify({ before }));
      },
      order: "post",
    },
    configurePreviewServer() {
      if (!existsSync(REDIRECT_BEFORE)) {
        return;
      }
      const saved = JSON.parse(readFileSync(REDIRECT_BEFORE, "utf8")) as {
        before?: string;
      };
      if (saved.before === undefined) {
        unlinkSync(DEPLOY_REDIRECT);
      } else {
        writeFileSync(DEPLOY_REDIRECT, saved.before);
      }
      unlinkSync(REDIRECT_BEFORE);
    },
    enforce: "post",
    name: "polaris:restore-deploy-redirect",
  };
}

export default defineConfig(({ mode }) => {
  const bare = mode === "bare-entry";
  if (bare && process.env.POLARIS_CATALOG_E2E !== "1") {
    throw new Error(
      "bare-entry is a test-only build: it runs through `bun run test:e2e`"
    );
  }
  return {
    plugins: [
      cloudflare({
        ...(bare ? { config: bareEntry } : {}),
        viteEnvironment: { name: "ssr" },
      }),
      tanstackStart(),
      react(),
      ...(bare ? [restoreDeployRedirectAfterPreview()] : []),
    ],
  };
});
