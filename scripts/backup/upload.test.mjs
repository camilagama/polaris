import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stampInstant } from "./retention.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const UPLOAD = join(here, "upload.sh");
const STAMP = "20261104T062200Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const ENDPOINT = `https://${"a1b2c3d4".repeat(4)}.r2.cloudflarestorage.com`;
const SEPARATORS = /[-:]/g;
const MILLISECONDS_SUFFIX = /\.\d+Z$/;

const stampAgo = (days) =>
  new Date(stampInstant(STAMP) - days * DAY_MS)
    .toISOString()
    .replace(SEPARATORS, "")
    .replace(MILLISECONDS_SUFFIX, "Z");

const FAKE_AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
shift
sub=$1
shift
key=""
body=""
meta=""
query=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift ;;
    --body) body=$2; shift ;;
    --metadata) meta=$2; shift ;;
    --query) query=$2; shift ;;
  esac
  shift
done
file="$FAKE_BUCKET/$(printf '%s' "$key" | tr '/' '%')"
case "$sub" in
  put-object)
    cp "$body" "$file"
    printf '%s' "\${meta#sha256=}" > "$file.sha"
    ;;
  head-object)
    [ -e "$file" ] || exit 255
    if [ -n "$query" ]; then
      sha=$(cat "$file.sha")
      [ -z "\${FAKE_CORRUPT:-}" ] || sha=deadbeef
      printf '%s\\t%s\\n' "$(stat -c %s "$file")" "$sha"
    fi
    ;;
  list-objects-v2)
    keys=$(ls "$FAKE_BUCKET" | grep -v '\\.sha$' | tr '%' '/' | sort)
    if [ -z "$keys" ]; then echo '{"RequestCharged": null}'; exit 0; fi
    printf '%s\\n' "$keys" | node -e 'const k=require("fs").readFileSync(0,"utf8").trim().split("\\n");console.log(JSON.stringify({Contents:k.map((Key)=>({Key}))}))'
    ;;
  delete-object)
    rm -f "$file" "$file.sha"
    ;;
esac
`;

describe("upload.sh", () => {
  let base;
  let bucket;
  let sealed;
  let log;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "upload-test-"));
    bucket = join(base, "bucket");
    sealed = join(base, "sealed.tar.age");
    log = join(base, "calls.log");
    const bin = join(base, "bin");
    await Promise.all([mkdir(bin), mkdir(bucket)]);
    await writeFile(join(bin, "aws"), FAKE_AWS);
    await chmod(join(bin, "aws"), 0o755);
    await writeFile(sealed, "sealed bytes of the backup");
    await writeFile(log, "");
  });

  afterEach(async () => {
    await rm(base, { force: true, recursive: true });
  });

  const seed = async (stamps) => {
    await Promise.all(
      stamps.map(async (stamp) => {
        const file = join(bucket, `daily%${stamp}.tar.age`);
        await writeFile(file, `old ${stamp}`);
        await writeFile(`${file}.sha`, "old");
      })
    );
  };
  const objects = async () =>
    (await readdir(bucket)).filter((name) => !name.endsWith(".sha")).sort();
  const run = (extraEnv = {}, stamp = STAMP) =>
    new Promise((resolve) => {
      execFile(
        "bash",
        [UPLOAD, sealed, stamp],
        {
          env: {
            AWS_ACCESS_KEY_ID: "test-id",
            AWS_SECRET_ACCESS_KEY: "test-secret",
            FAKE_BUCKET: bucket,
            FAKE_LOG: log,
            HOME: base,
            PATH: [
              join(base, "bin"),
              dirname(process.execPath),
              process.env.PATH,
            ].join(delimiter),
            R2_BACKUP_BUCKET: "polaris-backup-staging",
            R2_BACKUP_ENDPOINT: ENDPOINT,
            ...extraEnv,
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stderr, stdout })
      );
    });
  const calls = async () => (await readFile(log, "utf8")).split("\n");

  it("uploads, confirms and removes the expired backups of 41 dailies", async () => {
    const old = Array.from({ length: 40 }, (_, index) => stampAgo(index + 1));
    await seed(old);

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ok: uploaded daily/${STAMP}.tar.age`);
    expect(result.stdout).toContain("removed 5 object(s)");
    const left = await objects();
    expect(left).toHaveLength(36);
    expect(left).toContain(`daily%${STAMP}.tar.age`);
    const digest = createHash("sha256")
      .update("sealed bytes of the backup")
      .digest("base64");
    expect(
      (await calls()).some(
        (line) =>
          line.includes("put-object") &&
          line.includes(`--checksum-sha256 ${digest}`)
      )
    ).toBe(true);
    expect(left).not.toContain(`daily%${stampAgo(40)}.tar.age`);
    expect(left).not.toContain(`daily%${stampAgo(36)}.tar.age`);
    expect(left).toContain(`daily%${stampAgo(35)}.tar.age`);
    const sha = createHash("sha256")
      .update("sealed bytes of the backup")
      .digest("hex");
    expect(
      await readFile(join(bucket, `daily%${STAMP}.tar.age.sha`), "utf8")
    ).toBe(sha);
  });

  it("removes nothing when there is nothing old", async () => {
    await seed([stampAgo(1), stampAgo(2)]);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed 0 object(s)");
    expect(await objects()).toHaveLength(3);
  });

  it("fails without deleting anything when the stored object does not match", async () => {
    await seed(Array.from({ length: 40 }, (_, index) => stampAgo(index + 1)));
    const result = await run({ FAKE_CORRUPT: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match the sealed file");
    expect(await objects()).toHaveLength(41);
    expect((await calls()).some((line) => line.includes("delete-object"))).toBe(
      false
    );
    expect(
      (await calls()).some((line) => line.includes("list-objects-v2"))
    ).toBe(false);
  });

  it("refuses a stamp that already exists without a put", async () => {
    await seed([STAMP]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect((await calls()).some((line) => line.includes("put-object"))).toBe(
      false
    );
    expect(await readFile(join(bucket, `daily%${STAMP}.tar.age`), "utf8")).toBe(
      `old ${STAMP}`
    );
  });

  it.each([
    [
      "http scheme",
      "http://a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4.r2.cloudflarestorage.com",
    ],
    ["a short account id", "https://abc.r2.cloudflarestorage.com"],
    ["another host", `https://${"a1b2c3d4".repeat(4)}.example.com`],
    ["a path", `${ENDPOINT}/bucket`],
    [
      "an uppercase id",
      `https://${"A1B2C3D4".repeat(4)}.r2.cloudflarestorage.com`,
    ],
  ])("refuses an endpoint with %s", async (_name, endpoint) => {
    const result = await run({ R2_BACKUP_ENDPOINT: endpoint });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not an R2 account endpoint");
    expect(existsSync(log) && (await calls()).join("")).toBe("");
  });

  it("refuses a stamp that is not AAAAMMDDTHHMMSSZ", async () => {
    const result = await run({}, "2026-11-04");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stamp must be");
  });
});
