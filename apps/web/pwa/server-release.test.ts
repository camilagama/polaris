import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import {
  SERVER_RELEASE_KEY,
  serverRelease,
  serverReleasePlugin,
} from "./server-release";

const SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const SCRIPT = /\.m?js$/;

describe("the release of the Worker's build", () => {
  it("is the first 12 characters of VITE_RELEASE, in lowercase", () => {
    expect(serverRelease({ VITE_RELEASE: SHA })).toBe("9b3d37ed5c22");
    expect(serverRelease({ VITE_RELEASE: ` ${SHA.toUpperCase()} ` })).toBe(
      "9b3d37ed5c22"
    );
  });

  it("is empty without VITE_RELEASE, never the SHA of the CI run", () => {
    expect(serverRelease({})).toBe("");
    expect(serverRelease({ GITHUB_SHA: SHA, VITE_RELEASE: "  " })).toBe("");
  });

  it("is empty for a value that is not 12 hex characters after the cut", () => {
    for (const value of [
      "9b3d37ed5c2",
      "9b3d37ed5c2g34",
      "release-1.2.3",
      "<script>alert",
      "9b3d37ed5c2\n2",
    ]) {
      expect(serverRelease({ VITE_RELEASE: value }), value).toBe("");
    }
  });

  it("is defined for every environment but the client", () => {
    const plugin = serverReleasePlugin("9b3d37ed5c22");
    const configEnvironment = plugin.configEnvironment as (
      name: string
    ) => { define?: Record<string, string> } | undefined;
    expect(configEnvironment("client")).toBeUndefined();
    for (const name of ["ssr", "polaris_web_staging"]) {
      expect(configEnvironment(name)?.define).toEqual({
        [SERVER_RELEASE_KEY]: JSON.stringify("9b3d37ed5c22"),
      });
    }
  });
});

describe("a build with the plugin", () => {
  let root = "";

  afterAll(async () => {
    if (root) {
      await rm(root, { force: true, recursive: true });
    }
  });

  async function filesUnder(directory: string): Promise<string> {
    const names = await readdir(directory, { recursive: true });
    const texts = await Promise.all(
      names
        .filter((name) => SCRIPT.test(name))
        .map((name) => readFile(join(directory, name), "utf8"))
    );
    return texts.join("\n");
  }

  it("puts the release in the Worker's bundle and not in the client's, even if the client reads it", async () => {
    root = await mkdtemp(join(tmpdir(), "server-release-"));
    const reader =
      "export const release = import.meta.env.POLARIS_SERVER_RELEASE ?? 'none';\n";
    await writeFile(join(root, "worker.js"), reader);
    await writeFile(join(root, "client.js"), reader);
    const builder = await createBuilder({
      builder: {},
      configFile: false,
      environments: {
        client: {
          build: {
            outDir: join(root, "dist/client"),
            rolldownOptions: {
              input: join(root, "client.js"),
              preserveEntrySignatures: "strict",
            },
          },
        },
        worker: {
          build: {
            outDir: join(root, "dist/worker"),
            rolldownOptions: {
              input: join(root, "worker.js"),
              preserveEntrySignatures: "strict",
            },
          },
          consumer: "server",
        },
      },
      logLevel: "silent",
      plugins: [serverReleasePlugin("9b3d37ed5c22")],
      root,
    });
    await builder.buildApp();

    expect(await filesUnder(join(root, "dist/worker"))).toContain(
      '"9b3d37ed5c22"'
    );
    const client = await filesUnder(join(root, "dist/client"));
    expect(client).not.toBe("");
    expect(client).not.toContain("9b3d37ed5c22");
  }, 60_000);
});
