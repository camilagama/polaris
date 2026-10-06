import { spawnSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const biome = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.exe" : "biome"
);

const cases = [
  {
    expected:
      "packages/domain must stay framework- and infrastructure-independent.",
    source:
      'import type { ReactNode } from "react";\nexport type ForbiddenImport = ReactNode;\n',
    workspace: ["packages", "domain", "src"],
  },
  {
    expected:
      "packages/contracts must not import database or driver implementation.",
    source:
      'import type { DatabaseClient } from "@polaris/db";\nexport type ForbiddenImport = DatabaseClient;\n',
    workspace: ["packages", "contracts", "src"],
  },
];

const fixtureFileName = "__boundary_fixture.ts";

await Promise.all(
  cases.map(async (testCase) => {
    const fixture = path.join(root, ...testCase.workspace, fixtureFileName);

    try {
      await writeFile(fixture, testCase.source, { flag: "wx" });

      const result = spawnSync(biome, ["lint", path.relative(root, fixture)], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      });
      const output = (result.stdout ?? "") + (result.stderr ?? "");

      if (result.error) {
        throw result.error;
      }

      if (result.status === 0 || !output.includes(testCase.expected)) {
        throw new Error(
          "Biome did not reject the forbidden import in " +
            path.relative(root, fixture) +
            ": " +
            output
        );
      }
    } finally {
      await unlink(fixture).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  })
);
console.log("Import boundary rules reject the prohibited fixtures.");
