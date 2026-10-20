import { readdirSync, rmSync } from "node:fs";
import { dropRunDatabase } from "./run-database";
import { ensureRunEnvironment, ownerDatabaseUrl } from "./run-environment";

/**
 * Drops the run database and its logins (and fails if any is left), and removes the `.dev.vars` the Vite plugin
 * writes into each build with the environment of the build (the run secret and the login passwords).
 */
export default async function globalTeardown(): Promise<void> {
  const builds = new URL("../dist-e2e/", import.meta.url);
  for (const project of readdirSync(builds, { withFileTypes: true })) {
    if (project.isDirectory()) {
      rmSync(new URL(`${project.name}/polaris_web_local/.dev.vars`, builds), { force: true });
    }
  }
  if (process.env.E2E_KEEP_DATABASE === "1") {
    console.warn("E2E_KEEP_DATABASE=1: the run database and its logins were kept.");
    return;
  }
  await dropRunDatabase(ownerDatabaseUrl(), ensureRunEnvironment());
}
