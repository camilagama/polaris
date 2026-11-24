import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.resolve(
  fileURLToPath(new URL("playwright-install.sh", import.meta.url))
);

let sandbox;

const STUBS = {
  "apt-get": "#!/usr/bin/env bash\nexit 0",
  bunx: [
    "#!/usr/bin/env bash",
    'echo "$*" >> "$STUB_LOG"',
    'count_file="$STUB_STATE/$(echo "$*" | tr -c "a-z0-9\\n" _)"',
    'n=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))',
    'echo "$n" > "$count_file"',
    'case "$2" in',
    "  install)",
    '    if [[ "$3" == "--dry-run" ]]; then',
    '      if [[ "$STUB_DRY_RUN_FAILS" == "1" ]]; then exit 1; fi',
    '      echo "  Install location:    $STUB_BROWSERS/chromium-1"',
    "      exit 0",
    "    fi",
    "    if ((n <= $STUB_DOWNLOAD_FAILURES)); then exit 1; fi",
    "    exit 0 ;;",
    "  install-deps)",
    "    if ((n <= $STUB_APT_STALLS)); then exec sleep 30; fi",
    "    if ((n <= $STUB_APT_FAILURES)); then exit 1; fi",
    "    exit 0 ;;",
    "esac",
  ].join("\n"),
  ldd: [
    "#!/usr/bin/env bash",
    'echo "ldd $1" >> "$STUB_LOG"',
    'if [[ -n "$STUB_MISSING_LIBRARY" && "$1" == *"$STUB_MISSING_IN" ]]; then',
    "  printf '\\t%s => not found\\n' \"$STUB_MISSING_LIBRARY\"",
    "fi",
    "printf '\\tlibc.so.6 => /lib/libc.so.6 (0x1)\\n'",
  ].join("\n"),
  pgrep: [
    "#!/usr/bin/env bash",
    'count_file="$STUB_STATE/pgrep"',
    'n=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))',
    'echo "$n" > "$count_file"',
    'echo "pgrep" >> "$STUB_LOG"',
    "((n <= STUB_PGREP_RUNNING))",
  ].join("\n"),
  sudo: [
    "#!/usr/bin/env bash",
    'echo "sudo $1" >> "$STUB_LOG"',
    'if [[ "$1" == "tee" ]]; then cat > /dev/null; fi',
    "exit 0",
  ].join("\n"),
};

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "playwright-install-"));
  const bin = path.join(sandbox, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    const file = path.join(bin, name);
    writeFileSync(file, `${body}\n`);
    chmodSync(file, 0o755);
  }
  mkdirSync(path.join(sandbox, "state"));
  mkdirSync(path.join(sandbox, "app"));
  const chromium = path.join(sandbox, "browsers", "chromium-1");
  mkdirSync(chromium, { recursive: true });
  for (const name of ["chrome", "chrome-headless-shell"]) {
    writeFileSync(path.join(chromium, name), "");
  }
});

afterEach(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

function run(env = {}) {
  const result = spawnSync("bash", [script, path.join(sandbox, "app")], {
    encoding: "utf8",
    env: {
      PATH: `${path.join(sandbox, "bin")}:/usr/bin:/bin`,
      PLAYWRIGHT_INSTALL_RETRY_PAUSE: "0",
      STUB_APT_FAILURES: "0",
      STUB_APT_STALLS: "0",
      STUB_BROWSERS: path.join(sandbox, "browsers"),
      STUB_DOWNLOAD_FAILURES: "0",
      STUB_DRY_RUN_FAILS: "0",
      STUB_LOG: path.join(sandbox, "calls.log"),
      STUB_MISSING_IN: "",
      STUB_MISSING_LIBRARY: "",
      STUB_PGREP_RUNNING: "0",
      STUB_STATE: path.join(sandbox, "state"),
      ...env,
    },
    timeout: 60_000,
  });
  let calls = [];
  try {
    calls = readFileSync(path.join(sandbox, "calls.log"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    calls = [];
  }
  return {
    calls,
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

const aptCalls = (calls) =>
  calls.filter((call) => call.startsWith("playwright install-deps"));
const downloads = (calls) =>
  calls.filter((call) => call === "playwright install chromium");

describe("scripts/playwright-install.sh", () => {
  it("downloads the browser and does not call apt when the libraries are on the system", () => {
    const { calls, output, status } = run();

    expect(status).toBe(0);
    expect(downloads(calls)).toHaveLength(1);
    const checked = calls
      .filter((call) => call.startsWith("ldd "))
      .map((call) => path.basename(call));
    expect(checked.sort()).toEqual(["chrome", "chrome-headless-shell"]);
    expect(aptCalls(calls)).toEqual([]);
    expect(calls.some((call) => call.startsWith("sudo"))).toBe(false);
    expect(output).toContain("o apt não foi chamado");
  });

  it("retries a download that failed, still without apt", () => {
    const { calls, status } = run({ STUB_DOWNLOAD_FAILURES: "1" });

    expect(status).toBe(0);
    expect(downloads(calls)).toHaveLength(2);
    expect(aptCalls(calls)).toEqual([]);
  });

  it("fails without calling apt when every download attempt fails", () => {
    const { calls, output, status } = run({ STUB_DOWNLOAD_FAILURES: "9" });

    expect(status).toBe(1);
    expect(downloads(calls)).toHaveLength(2);
    expect(aptCalls(calls)).toEqual([]);
    expect(output).toContain("tentativas de download falharam");
  });

  it("calls apt when a library is missing", () => {
    const { calls, output, status } = run({
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toEqual(["playwright install-deps chromium"]);
    expect(calls).toContain("sudo tee");
    expect(output).toContain("libnss3.so => not found");
  });

  it("times out a stalled apt and retries it", () => {
    const { calls, output, status } = run({
      PLAYWRIGHT_INSTALL_FIRST_ATTEMPT_TIMEOUT: "1",
      STUB_APT_STALLS: "1",
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(2);
    expect(output).toContain("apt falhou ou estourou 1s");
    expect(output).toContain("apt, tentativa 2 de 2");
  });

  it("fails when every apt attempt fails", () => {
    const { calls, output, status } = run({
      STUB_APT_FAILURES: "9",
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(1);
    expect(aptCalls(calls)).toHaveLength(2);
    expect(output).toContain("tentativas do apt falharam");
  });

  it("makes a single apt attempt when PLAYWRIGHT_INSTALL_APT_ATTEMPTS is 1", () => {
    const { calls, status } = run({
      PLAYWRIGHT_INSTALL_APT_ATTEMPTS: "1",
      STUB_APT_FAILURES: "9",
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(1);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(downloads(calls)).toHaveLength(1);
  });

  it("calls apt when no browser binary was found to check", () => {
    rmSync(path.join(sandbox, "browsers"), { force: true, recursive: true });
    const { calls, output, status } = run();

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(output).toContain("nenhum encontrado");
  });

  it("calls apt without a missing library when PLAYWRIGHT_INSTALL_FORCE_DEPS is 1", () => {
    const { calls, status } = run({ PLAYWRIGHT_INSTALL_FORCE_DEPS: "1" });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(1);
  });

  it("calls apt when only the headless shell misses a library", () => {
    const { calls, output, status } = run({
      STUB_MISSING_IN: "chrome-headless-shell",
      STUB_MISSING_LIBRARY: "libgbm.so.1",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(output).toContain("chrome-headless-shell:");
    expect(output).toContain("libgbm.so.1 => not found");
  });

  it("calls apt when the install location cannot be listed", () => {
    const { calls, output, status } = run({ STUB_DRY_RUN_FAILS: "1" });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(output).toContain("não consegui listar o local de instalação");
  });

  it("waits for a leftover apt-get and ends it before the second apt attempt", () => {
    const { calls, output, status } = run({
      PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE: "0",
      STUB_APT_FAILURES: "1",
      STUB_MISSING_LIBRARY: "libnss3.so",
      STUB_PGREP_RUNNING: "2",
    });

    expect(status).toBe(0);
    expect(calls).toContain("sudo pkill");
    expect(output).toContain("enviando SIGTERM");
    expect(aptCalls(calls)).toHaveLength(2);
    expect(calls.indexOf("sudo pkill")).toBeLessThan(
      calls.lastIndexOf("playwright install-deps chromium")
    );
  });
});
