import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stagingMarkers } from "../verify-production-workflow.mjs";
import {
  bindingsOf,
  bindingsSnapshot,
  parseJsonc,
  stringsOf,
  WORKERS,
} from "./wrangler-config.mjs";

const STAGING_WORD = /staging/i;

const MODULE_TEXT = readFileSync(
  new URL("./wrangler-config.mjs", import.meta.url),
  "utf8"
);

const readConfig = (app) =>
  parseJsonc(
    readFileSync(
      new URL(`../../apps/${app}/wrangler.jsonc`, import.meta.url),
      "utf8"
    )
  );

describe("the neutral wrangler config module", () => {
  it("never names staging", () => {
    expect(MODULE_TEXT).not.toMatch(STAGING_WORD);
  });

  it("carries no host or resource id of staging", () => {
    const markers = stagingMarkers(WORKERS.map(readConfig));
    expect(markers.length).toBeGreaterThan(3);
    for (const marker of markers) {
      expect(MODULE_TEXT).not.toContain(marker);
    }
  });

  it("reads the comments and trailing commas of a wrangler.jsonc", () => {
    expect(
      parseJsonc('{ "a": "x // not a comment", /* c */ "b": [1,], // t\n}')
    ).toEqual({ a: "x // not a comment", b: [1] });
  });

  it("lists every string of a config with its path", () => {
    expect(stringsOf({ a: ["x"], b: { c: "y" } })).toEqual([
      ["a[0]", "x"],
      ["b.c", "y"],
    ]);
  });

  it("reads the bindings of every Worker, sorted in the snapshot", () => {
    for (const app of WORKERS) {
      const config = readConfig(app);
      expect(bindingsOf(config).hyperdrive).toBeInstanceOf(Map);
      expect(bindingsSnapshot(config).hyperdrive).toEqual(
        [...bindingsOf(config).hyperdrive].sort()
      );
    }
  });
});
