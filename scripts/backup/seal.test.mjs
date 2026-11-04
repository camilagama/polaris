import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SEAL = join(here, "seal.sh");
const SEALED_LINE = /^ok: sealed for 1 key\(s\), 1 MB, sha256 [0-9a-f]{64}\n$/;
const KEY = `age1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 58)}`;

const FAKE_AGE = `#!/usr/bin/env bash
echo "age $*" >> "$FAKE_LOG"
for a in "$@"; do case "$a" in --output=*) out="\${a#--output=}" ;; esac; done
cat > "$out"
`;

describe("seal.sh", () => {
  let base;
  let work;
  let sealed;
  let recipients;
  let log;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "seal-test-"));
    work = join(base, "work");
    sealed = join(base, "sealed.tar.age");
    recipients = join(base, "recipients.txt");
    log = join(base, "calls.log");
    const bin = join(base, "bin");
    await Promise.all([mkdir(bin), mkdir(work)]);
    await Promise.all(
      ["dump", "manifest.json", "roles.sql"].map((name) =>
        writeFile(join(work, name), `content of ${name}`)
      )
    );
    await writeFile(join(bin, "age"), FAKE_AGE);
    await chmod(join(bin, "age"), 0o755);
    await writeFile(recipients, `# reviewed keys\n${KEY}\n`);
    await writeFile(log, "");
  });

  afterEach(async () => {
    await rm(base, { force: true, recursive: true });
  });

  const run = () =>
    new Promise((resolve) => {
      execFile(
        "bash",
        [SEAL, work, recipients, sealed],
        {
          env: {
            FAKE_LOG: log,
            HOME: base,
            PATH: `${join(base, "bin")}${delimiter}${process.env.PATH}`,
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stderr, stdout })
      );
    });

  it("seals with a valid key, removes the plaintext and prints the sha256", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(SEALED_LINE);
    expect(existsSync(work)).toBe(false);
    expect((await readFile(sealed)).length).toBeGreaterThan(0);
    const call = await readFile(log, "utf8");
    expect(call).toContain(`--recipients-file=${recipients}`);
    expect(call).toContain(`--output=${sealed}`);
  });

  it.each([
    ["a recipients file with no key", "", "no age public key"],
    ["a recipients file with only comments", "# a\n# b\n", "no age public key"],
    ["an invalid line", `${KEY}\nnot-a-key\n`, "not an age public key"],
    [
      "a key with a letter outside the alphabet",
      `age1${"b".repeat(58)}\n`,
      "not an age public key",
    ],
    [
      "a key that is too short",
      `${KEY.slice(0, -1)}\n`,
      "not an age public key",
    ],
  ])("refuses %s", async (_name, content, text) => {
    await writeFile(recipients, content);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(text);
    expect(existsSync(work)).toBe(true);
    expect(existsSync(sealed)).toBe(false);
    expect(await readFile(log, "utf8")).toBe("");
  });

  it("refuses a directory with one more file", async () => {
    await writeFile(join(work, "extra.txt"), "x");
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "exactly dump, manifest.json and roles.sql"
    );
    expect(existsSync(work)).toBe(true);
    expect(existsSync(sealed)).toBe(false);
  });

  it("refuses when the sealed file already exists", async () => {
    await writeFile(sealed, "previous");
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(await readFile(sealed, "utf8")).toBe("previous");
    expect(existsSync(work)).toBe(true);
  });
});
