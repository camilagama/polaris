import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// "bare-entry" exists only for the browser tests: a Worker whose main skips src/server.ts, the
// misconfiguration the router must refuse (catalog_nonce_missing). It is never deployed, so it
// has no identity in common with the real Worker: another name, no public URLs, and a fictitious
// bucket instead of the production one.
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
// build therefore leaves it on dist-bare only until its preview is configured, then puts back what it
// found (a redirect already on dist-bare counts as nothing), so that a manual deploy after the e2e
// run does not publish the test-only Worker. The e2e suite fails if it ends on dist-bare.
function restoreDeployRedirectAfterPreview(): Plugin {
  let redirectFile = "";
  let sidecarFile = "";
  let previous: string | undefined;
  return {
    buildStart() {
      previous = existsSync(redirectFile)
        ? readFileSync(redirectFile, "utf8")
        : undefined;
      if (previous?.includes("dist-bare")) {
        previous = undefined;
      }
    },
    closeBundle: {
      handler() {
        mkdirSync(dirname(sidecarFile), { recursive: true });
        writeFileSync(sidecarFile, JSON.stringify({ previous }));
      },
      order: "post",
    },
    configResolved(config) {
      redirectFile = resolve(config.root, ".wrangler/deploy/config.json");
      sidecarFile = resolve(
        config.root,
        "dist-bare/deploy-redirect.before.json"
      );
    },
    configurePreviewServer() {
      if (!existsSync(sidecarFile)) {
        return;
      }
      const saved = JSON.parse(readFileSync(sidecarFile, "utf8")) as {
        previous?: string;
      };
      if (saved.previous === undefined) {
        if (existsSync(redirectFile)) {
          unlinkSync(redirectFile);
        }
      } else {
        writeFileSync(redirectFile, saved.previous);
      }
      unlinkSync(sidecarFile);
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
