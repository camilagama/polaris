/**
 * Gate 5 em aparelhos reais (iPhone e Android) pelo BrowserStack: sobe o app local em HTTPS,
 * abre o BrowserStack Local, roda a suíte em um aparelho por vez, grava o relatório e
 * encerra o túnel. Sem IA. Uso: scripts/gate5-real-devices.sh (carrega as credenciais).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Local } from "browserstack-local";
import { remote } from "webdriverio";
import {
  credentials,
  markSession,
  redact,
  restoreNetwork,
  sessionLinks,
} from "./browserstack-api";
import {
  DEVICES,
  HUB,
  IS_PARTIAL,
  LAB_PORT,
  SELECTED_FLOWS,
  SHELL_PORT,
} from "./config";
import {
  type DeviceReport,
  deviceStatus,
  type RunReport,
  writeReport,
} from "./report";
import { selfSignedCertificate, serveBuild } from "./static-server";
import { runGate5Suite } from "./suite";

const webRoot = new URL("..", import.meta.url).pathname;
const startedAt = new Date().toISOString();
/** Sessão do aparelho em andamento: encerrada também por sinal ou erro (a rede volta ao normal). */
let activeSession: { browser: WebdriverIO.Browser; id: string } | null = null;
const reportDirectory =
  process.env.GATE5_REPORT_DIR ??
  join(webRoot, "test-results", "real-devices", startedAt.replaceAll(":", "-"));

/** A build executa plugins do projeto: ela não recebe as credenciais do BrowserStack. */
function buildEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("BROWSERSTACK_")) {
      delete environment[name];
    }
  }
  return environment;
}

function build() {
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, {
      cwd: webRoot,
      env: buildEnvironment(),
      stdio: "ignore",
    });
  run("bun", ["run", "build:offline-poc"]);
  run("bunx", [
    "vite",
    "build",
    "--config",
    "vite.pwa.config.ts",
    "--mode",
    "pwa-e2e",
  ]);
}

/**
 * O túnel só alcança as duas portas da suíte (`only`), não o resto do `localhost`. O binário do
 * BrowserStack exige `--key` na linha de comando (sem ela ele recusa iniciar, mesmo com
 * `BROWSERSTACK_ACCESS_KEY` no ambiente): a chave fica visível em `ps` enquanto o túnel está de
 * pé, então rode a suíte numa máquina sem outros usuários.
 */
function startTunnel(
  binary: Local,
  accessKey: string,
  localIdentifier: string,
  logFile: string
) {
  return new Promise<void>((resolve, reject) => {
    binary.start(
      {
        key: accessKey,
        localIdentifier,
        logFile,
        only: `bs-local.com,${LAB_PORT},1,bs-local.com,${SHELL_PORT},1`,
        onlyAutomate: true,
      },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function runDevice(
  target: (typeof DEVICES)[number],
  localIdentifier: string,
  buildName: string
): Promise<DeviceReport> {
  const { key: accessKey, user: userName } = credentials();
  const report: DeviceReport = {
    device: `${target.deviceName} (${target.platformName === "ios" ? "iOS" : "Android"} ${target.osVersion})`,
    error: null,
    platform: target.platformName,
    sessionId: null,
    sessionUrl: null,
    steps: [],
  };
  // `acceptInsecureCerts` dentro de `bstack:options` é o que o BrowserStack honra no Safari do iPhone
  const bstackOptions: Record<string, unknown> = {
    acceptInsecureCerts: true,
    buildName,
    deviceName: target.deviceName,
    local: true,
    localIdentifier,
    osVersion: target.osVersion,
    projectName: "Polaris",
    realMobile: true,
    sessionName: `Gate 5 · ${target.deviceName}`,
  };
  const browser = await remote({
    ...HUB,
    capabilities: {
      browserName: target.browserName,
      "bstack:options": bstackOptions,
      platformName: target.platformName,
    } as WebdriverIO.Capabilities,
    connectionRetryCount: 1,
    key: accessKey,
    logLevel: "silent",
    user: userName,
  }).catch((error: unknown) => {
    report.error = redact(
      error instanceof Error ? error.message : String(error)
    );
    return null;
  });
  if (!browser) {
    return report;
  }
  activeSession = { browser, id: browser.sessionId };
  report.sessionId = browser.sessionId;
  try {
    await browser.setTimeout({ script: 30_000 });
    report.sessionUrl = (await sessionLinks(browser.sessionId)).dashboard;
    report.steps = await runGate5Suite(browser, browser.sessionId);
  } catch (error: unknown) {
    report.error = redact(
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    const passed = deviceStatus(report) === "passed";
    const marked = await markSession(
      browser.sessionId,
      passed ? "passed" : "failed",
      passed ? "Gate 5: todos os passos passaram" : "Gate 5: há passo falho"
    );
    if (!marked) {
      console.warn("  aviso: o BrowserStack não aceitou a marcação da sessão");
    }
    activeSession = null;
    await browser.deleteSession().catch(() => undefined);
  }
  report.steps = report.steps.map((step) => ({
    ...step,
    detail: redact(step.detail),
  }));
  return report;
}

const { key } = credentials();
const identifier = `polaris-gate5-${crypto.randomUUID()}`;
const certificate = selfSignedCertificate();
const logDirectory = mkdtempSync(join(tmpdir(), "polaris-gate5-local-"));
const servers: { close: () => unknown }[] = [];
let tunnel: Local | null = null;

const STOP_TIMEOUT_MS = 15_000;
let shuttingDown: Promise<void> | null = null;

async function stopEverything() {
  if (activeSession) {
    const { browser, id } = activeSession;
    activeSession = null;
    await restoreNetwork(id).catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
  }
  for (const server of servers) {
    server.close();
  }
  if (tunnel) {
    const open = tunnel;
    tunnel = null;
    await Promise.race([
      new Promise<void>((resolve) => open.stop(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
  }
  certificate.dispose();
  rmSync(logDirectory, { force: true, recursive: true });
}

/** Idempotente: sinais e o fim normal podem chamar mais de uma vez. */
function shutdown() {
  shuttingDown ??= stopEverything();
  return shuttingDown;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(130));
  });
}
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => {
    console.error(redact(String(error)));
    shutdown().finally(() => process.exit(1));
  });
}

const devices: DeviceReport[] = [];
try {
  console.log("Gate 5 em aparelhos reais: construindo o app…");
  build();
  servers.push(
    await serveBuild(join(webRoot, "dist/offline-poc"), LAB_PORT, certificate)
  );
  servers.push(
    await serveBuild(join(webRoot, "dist/pwa-e2e"), SHELL_PORT, certificate)
  );
  console.log("Abrindo o BrowserStack Local…");
  tunnel = new Local();
  await startTunnel(tunnel, key, identifier, join(logDirectory, "local.log"));
  for (const target of DEVICES) {
    console.log(`Rodando em ${target.deviceName}…`);
    // biome-ignore lint/performance/noAwaitInLoops: o plano tem 1 sessão paralela: um aparelho por vez
    const report = await runDevice(target, identifier, `Gate 5 ${startedAt}`);
    devices.push(report);
    const failed = report.steps.filter(
      (step) => step.status === "failed"
    ).length;
    console.log(
      `  ${deviceStatus(report) === "passed" ? "passou" : `falhou (${failed} passo(s) com falha${report.error ? `; ${report.error}` : ""})`} — sessão: ${report.sessionUrl ?? "n/d"}`
    );
  }
} catch (error: unknown) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await shutdown();
}
if (process.exitCode === 1) {
  process.exit(1);
}

const report: RunReport = {
  devices,
  finishedAt: new Date().toISOString(),
  partial: IS_PARTIAL,
  selection: {
    flows: SELECTED_FLOWS,
    platforms: DEVICES.map((device) => device.platformName),
  },
  startedAt,
  status:
    devices.length === DEVICES.length &&
    devices.length > 0 &&
    devices.every((device) => deviceStatus(device) === "passed")
      ? "passed"
      : "failed",
};
writeReport(reportDirectory, report);
console.log(`Relatório: ${reportDirectory}/report.md`);
process.exit(report.status === "passed" ? 0 : 1);
