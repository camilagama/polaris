import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { closedEnvironment } from "./closed-environment.ts";
import { workerLogPath } from "./worker-log.ts";

/**
 * The web server of one Playwright project: `vite build` into its own directory, then `vite preview` of it (the
 * bundle that would be deployed, in local workerd). The environment is closed to the names of the config
 * (`previewEnvironment`, closed-environment.ts). The plugin points `vite preview` at the LAST build through `.wrangler/deploy/config.json`,
 * one file for both builds; Playwright starts the web servers one after another and waits for each to answer, so
 * each preview has read its own build before the next build rewrites the file. The `chave-do-runtime` test of
 * each project fails if a preview serves the other build.
 */
const [project, port] = process.argv.slice(2);
if (!(project && /^[a-z-]+$/.test(project) && port && /^\d+$/.test(port))) {
  throw new Error("usage: node e2e-real/serve.ts <project> <port>");
}
const appRoot = fileURLToPath(new URL("..", import.meta.url));
// under Node, never Bun: miniflare cannot reach workerd from Bun (the CI job has Node from .node-version)
if (process.versions.bun) {
  throw new Error(
    "serve.ts runs under Node (node e2e-real/serve.ts), not Bun."
  );
}
const vite = fileURLToPath(
  new URL("../node_modules/vite/bin/vite.js", import.meta.url)
);
const outDir = `dist-e2e/${project}`;

// the build gets no secret and no connection string (the plugin copies the environment of the build into a
// `.dev.vars` next to the Worker bundle); the preview gets the closed list of the config and nothing else
const build = spawnSync(process.execPath, [vite, "build", "--outDir", outDir], {
  cwd: appRoot,
  env: closedEnvironment(process.env, "build"),
  stdio: ["ignore", "ignore", "inherit"],
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
const preview = spawn(
  process.execPath,
  [
    vite,
    "preview",
    "--outDir",
    outDir,
    "--host",
    "127.0.0.1",
    "--port",
    port,
    "--strictPort",
  ],
  {
    cwd: appRoot,
    env: closedEnvironment(process.env, "preview"),
    stdio: ["ignore", "pipe", "pipe"],
  }
);
// the Worker logs to the preview's output (`info` to stdout, `warn` and `error` to stderr), which Playwright drops: a
// copy of both in a file of the run, for a journey that checks a log line (worker-log.ts)
const workerLog = createWriteStream(workerLogPath(project), { flags: "w" });
preview.stdout.pipe(process.stdout);
preview.stderr.pipe(process.stderr);
// two sources into one file: neither ends it (the other may still write), and a failure of the copy never stops the preview
workerLog.on("error", () => undefined);
preview.stdout.pipe(workerLog, { end: false });
preview.stderr.pipe(workerLog, { end: false });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => preview.kill(signal));
}
preview.on("exit", (code) => process.exit(code ?? 0));
