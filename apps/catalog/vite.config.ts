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
import { defineConfig, loadEnv, type Plugin } from "vite";
import { serverRelease, serverReleasePlugin } from "../web/pwa/server-release";

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

// "fixture-data" is the other test-only build: the real server entry (nonce, headers, router) over a
// database module of fixtures (e2e/fixtures/public-catalog-reader.ts), so the browser tests see the pages
// of a store with products without a PostgreSQL. Like bare-entry, it has no identity in common with the
// deployed Worker: another name, no public URLs, a fictitious bucket.
const fixtureData = (config: { [key: string]: unknown }) => {
  // the address pages are canonical at, and a valid address for the footer's link (the real ones are per environment)
  config.vars = {
    ...(config.vars as object),
    CATALOG_ORIGIN: "http://127.0.0.1:5176",
    // a build for the screenshots of the footer without an address sets this variable to an empty string
    POLARIS_SITE_URL:
      process.env.POLARIS_FIXTURE_SITE_URL ?? "https://polaris.example/",
  };
  config.name = "polaris-catalog-fixture-test";
  config.preview_urls = false;
  config.r2_buckets = [
    { binding: "MEDIA_BUCKET", bucket_name: "polaris-fixture-test-unused" },
  ];
  config.workers_dev = false;
};

// The Cloudflare plugin points .wrangler/deploy/config.json (what `wrangler deploy` follows) at the
// output of every build, and `vite preview` reads it to find the Worker it serves. A test-only build
// therefore leaves it on its own directory (dist-bare, dist-fixture) only until its preview is
// configured, then puts back what it found (a redirect already on a test directory counts as nothing),
// so that a manual deploy after the e2e run does not publish a test-only Worker. The e2e suite fails if
// it ends on one of them.
function restoreDeployRedirectAfterPreview(directory: string): Plugin {
  let redirectFile = "";
  let sidecarFile = "";
  let previous: string | undefined;
  return {
    buildStart() {
      previous = existsSync(redirectFile)
        ? readFileSync(redirectFile, "utf8")
        : undefined;
      if (
        previous?.includes("dist-bare") ||
        previous?.includes("dist-fixture")
      ) {
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
        `${directory}/deploy-redirect.before.json`
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
  const fixtures = mode === "fixture-data";
  if ((bare || fixtures) && process.env.POLARIS_CATALOG_E2E !== "1") {
    throw new Error(
      `${mode} is a test-only build: it runs through \`bun run test:e2e\``
    );
  }
  return {
    plugins: [
      cloudflare({
        ...(bare ? { config: bareEntry } : {}),
        ...(fixtures ? { config: fixtureData } : {}),
        viteEnvironment: { name: "ssr" },
      }),
      tanstackStart(),
      react(),
      // the Worker declares the commit it was built from on /robots.txt (ADR 0098, amended), never the browser
      serverReleasePlugin(
        serverRelease(loadEnv(mode, import.meta.dirname, "VITE_"))
      ),
      ...(bare ? [restoreDeployRedirectAfterPreview("dist-bare")] : []),
      ...(fixtures ? [restoreDeployRedirectAfterPreview("dist-fixture")] : []),
    ],
    resolve: {
      alias: fixtures
        ? [
            {
              find: "@polaris/db/public-catalog-reader",
              replacement: resolve(
                import.meta.dirname,
                "e2e/fixtures/public-catalog-reader.ts"
              ),
            },
          ]
        : [],
    },
  };
});
