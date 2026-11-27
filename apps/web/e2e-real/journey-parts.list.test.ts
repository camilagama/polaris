import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ONLINE_B_JOURNEYS,
  partitionProblems,
  RUNTIME_ONLY_JOURNEYS,
} from "./journey-parts.list";

const here = dirname(fileURLToPath(import.meta.url));
const folder = readdirSync(join(here, "jornadas"))
  .filter((name) => name.endsWith(".e2e.ts"))
  .map((name) => `jornadas/${name}`);

describe("the journeys shared among the parts of the e2e job", () => {
  it("are true to the folder: every listed file exists, none is in two lists, none twice", () => {
    expect(partitionProblems(folder)).toEqual([]);
  });

  it("leave a journey in exactly one of online, online-b and runtime-ligado", () => {
    const online = folder.filter(
      (file) =>
        !(
          (RUNTIME_ONLY_JOURNEYS as readonly string[]).includes(file) ||
          (ONLINE_B_JOURNEYS as readonly string[]).includes(file)
        )
    );
    expect(online.length + ONLINE_B_JOURNEYS.length).toBe(
      folder.length - RUNTIME_ONLY_JOURNEYS.length
    );
    expect(online.length).toBeGreaterThan(0);
  });

  it("catch a file that is gone, one listed twice, one in both lists and a list out of order", () => {
    expect(
      partitionProblems(folder, RUNTIME_ONLY_JOURNEYS, [
        ...ONLINE_B_JOURNEYS,
        "jornadas/some.e2e.ts",
      ])
    ).toContain(
      "ONLINE_B_JOURNEYS names jornadas/some.e2e.ts, which is not in jornadas/"
    );
    const [first] = ONLINE_B_JOURNEYS;
    expect(
      partitionProblems(folder, RUNTIME_ONLY_JOURNEYS, [
        first,
        ...ONLINE_B_JOURNEYS,
      ])
    ).toContain("ONLINE_B_JOURNEYS names a file twice");
    const [runtimeFirst] = RUNTIME_ONLY_JOURNEYS;
    expect(
      partitionProblems(folder, RUNTIME_ONLY_JOURNEYS, [
        ...ONLINE_B_JOURNEYS,
        runtimeFirst,
      ]).join("\n")
    ).toContain("is in both lists");
    expect(
      partitionProblems(
        folder,
        RUNTIME_ONLY_JOURNEYS,
        [...ONLINE_B_JOURNEYS].reverse()
      )
    ).toContain("ONLINE_B_JOURNEYS is not in alphabetical order");
  });
});
