import { existsSync, readdirSync, rmSync } from "node:fs";
import { dropRunDatabase } from "./run-database";
import { ensureRunEnvironment, ownerDatabaseUrl } from "./run-environment";

/**
 * Drops the run database and its logins, and the `polaris_pr11_runtime` role if this run created it (and fails if
 * any is left). Then removes what the builds leave behind:
 * the `.dev.vars` the Vite plugin writes next to each Worker bundle (the build gets no secret, so it should be
 * empty; removed anyway) and `.wrangler/deploy`, which points at the last e2e build: a later `wrangler deploy`
 * without a build must not follow it.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    if (process.env.E2E_KEEP_DATABASE === "1") {
      console.warn(
        "E2E_KEEP_DATABASE=1: the run database and its logins were kept."
      );
    } else if (process.env.POLARIS_E2E_DATABASE_URL) {
      await dropRunDatabase(
        ownerDatabaseUrl(),
        ensureRunEnvironment(),
        process.env.E2E_CREATED_RUNTIME_ROLE === "1"
      );
    }
  } finally {
    const builds = new URL("../dist-e2e/", import.meta.url);
    const projects = existsSync(builds)
      ? readdirSync(builds, { withFileTypes: true })
      : [];
    for (const project of projects) {
      if (project.isDirectory()) {
        rmSync(new URL(`${project.name}/polaris_web_local/.dev.vars`, builds), {
          force: true,
        });
      }
    }
    rmSync(new URL("../.wrangler/deploy", import.meta.url), {
      force: true,
      recursive: true,
    });
  }
}
