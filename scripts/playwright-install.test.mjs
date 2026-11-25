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
    "    if ((n <= $STUB_DOWNLOAD_STALLS)); then exec sleep 30; fi",
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
    'for binary in "$@"; do',
    '  echo "ldd $binary" >> "$STUB_LOG"',
    '  if [[ -n "$STUB_MISSING_LIBRARY" && "$binary" == *"$STUB_MISSING_IN" ]]; then',
    "    printf '\\t%s => not found\\n' \"$STUB_MISSING_LIBRARY\"",
    "  fi",
    "  printf '\\tlibc.so.6 => /lib/libc.so.6 (0x1)\\n'",
    "done",
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
    'if [[ "$1" == "pkill" ]]; then echo "sudo $*" >> "$STUB_LOG"; else echo "sudo $1" >> "$STUB_LOG"; fi',
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
    chmodSync(path.join(chromium, name), 0o755);
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
      PLAYWRIGHT_BROWSERS_PATH: path.join(sandbox, "browsers"),
      PLAYWRIGHT_INSTALL_RETRY_PAUSE: "0",
      STUB_APT_FAILURES: "0",
      STUB_APT_STALLS: "0",
      STUB_DOWNLOAD_FAILURES: "0",
      STUB_DOWNLOAD_STALLS: "0",
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
  it("downloads the browser from the CDN and does not use apt when no library is missing", () => {
    const { calls, output, status } = run();

    expect(status).toBe(0);
    expect(downloads(calls)).toHaveLength(1);
    const checked = calls
      .filter((call) => call.startsWith("ldd "))
      .map((call) => path.basename(call));
    expect(checked.sort()).toEqual(["chrome", "chrome-headless-shell"]);
    expect(aptCalls(calls)).toEqual([]);
    expect(calls.some((call) => call.startsWith("sudo"))).toBe(false);
    expect(output).toContain("apt não usado");
  });

  it("retries a download that failed, still without apt", () => {
    const { calls, output, status } = run({ STUB_DOWNLOAD_FAILURES: "1" });

    expect(status).toBe(0);
    expect(downloads(calls)).toHaveLength(2);
    expect(aptCalls(calls)).toEqual([]);
    expect(output).toContain("download do Chromium, tentativa 2 de 2");
    expect(output).toContain("apt não usado");
  });

  it("fails without calling apt or ldd when every download attempt fails", () => {
    const { calls, output, status } = run({ STUB_DOWNLOAD_FAILURES: "9" });

    expect(status).toBe(1);
    expect(downloads(calls)).toHaveLength(2);
    expect(aptCalls(calls)).toEqual([]);
    expect(calls.some((call) => call.startsWith("ldd "))).toBe(false);
    expect(output).toContain("2 tentativas de download do Chromium falharam");
  });

  it("splits the download ceiling between the attempts", () => {
    const { output } = run({
      PLAYWRIGHT_DOWNLOAD_TIMEOUT: "40",
      STUB_DOWNLOAD_FAILURES: "1",
    });

    expect(output).toContain("tentativa 1 de 2 (limite 20s)");
    expect(output).toContain("tentativa 2 de 2 (limite 20s)");
  });

  it("times out a stalled download and takes the second attempt", () => {
    const { calls, output, status } = run({
      PLAYWRIGHT_DOWNLOAD_TIMEOUT: "2",
      STUB_DOWNLOAD_STALLS: "1",
    });

    expect(status).toBe(0);
    expect(downloads(calls)).toHaveLength(2);
    expect(output).toContain("download do Chromium falhou ou estourou");
  });

  it("calls apt once, with the retry settings, when a library is missing", () => {
    const { calls, output, status } = run({
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toEqual(["playwright install-deps chromium"]);
    expect(calls).toContain("sudo tee");
    expect(output).toContain("faltam bibliotecas (libnss3.so)");
    expect(output).not.toContain("apt não usado");
  });

  it("calls apt when only the headless shell misses a library", () => {
    const { calls, output, status } = run({
      STUB_MISSING_IN: "chrome-headless-shell",
      STUB_MISSING_LIBRARY: "libgbm.so.1",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(output).toContain("faltam bibliotecas (libgbm.so.1)");
  });

  it("retries a stalled apt after waiting for the leftover apt-get", () => {
    const { calls, output, status } = run({
      PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE: "0",
      PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT: "2",
      STUB_APT_STALLS: "1",
      STUB_MISSING_LIBRARY: "libnss3.so",
      STUB_PGREP_RUNNING: "2",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(2);
    expect(output).toContain("apt falhou ou estourou");
    expect(output).toContain("apt, tentativa 2 de 2");
    expect(calls).toContain("sudo pkill -TERM -x apt-get|apt");
    expect(calls.indexOf("sudo pkill -TERM -x apt-get|apt")).toBeLessThan(
      calls.lastIndexOf("playwright install-deps chromium")
    );
  });

  it("does not end an apt-get that leaves within the grace period", () => {
    const { calls, status } = run({
      PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE: "4",
      STUB_APT_FAILURES: "1",
      STUB_MISSING_LIBRARY: "libnss3.so",
      STUB_PGREP_RUNNING: "1",
    });

    expect(status).toBe(0);
    expect(aptCalls(calls)).toHaveLength(2);
    expect(calls.some((call) => call.startsWith("sudo pkill"))).toBe(false);
  });

  it("never signals dpkg when ending the leftover apt", () => {
    const { calls } = run({
      PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE: "0",
      STUB_APT_FAILURES: "1",
      STUB_MISSING_LIBRARY: "libnss3.so",
      STUB_PGREP_RUNNING: "2",
    });

    const kills = calls.filter((call) => call.startsWith("sudo pkill"));
    expect(kills).toHaveLength(1);
    expect(kills[0]).not.toContain("dpkg");
  });

  it("fails when every apt attempt fails", () => {
    const { calls, output, status } = run({
      STUB_APT_FAILURES: "9",
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(1);
    expect(aptCalls(calls)).toHaveLength(2);
    expect(output).toContain("2 tentativas de apt falharam");
  });

  it("makes a single attempt of each step when PLAYWRIGHT_INSTALL_ATTEMPTS is 1", () => {
    const { calls, status } = run({
      PLAYWRIGHT_INSTALL_ATTEMPTS: "1",
      STUB_APT_FAILURES: "9",
      STUB_MISSING_LIBRARY: "libnss3.so",
    });

    expect(status).toBe(1);
    expect(aptCalls(calls)).toHaveLength(1);
    expect(downloads(calls)).toHaveLength(1);
  });
});
