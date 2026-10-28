import { fileURLToPath } from "node:url";

/**
 * Where serve.ts copies the output of the preview of a project (the Worker's log lines), for the journeys that check
 * what the Worker logged. No import outside Node: serve.ts runs this file under Node directly.
 */
export function workerLogPath(project: string): string {
  return fileURLToPath(
    new URL(`../dist-e2e/${project}-worker.log`, import.meta.url)
  );
}
