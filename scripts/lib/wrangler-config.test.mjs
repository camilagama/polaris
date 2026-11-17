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

  it("reads each kind of binding by name, without the consumer lanes", () => {
    const config = {
      account_id: "acc",
      hyperdrive: [{ binding: "HD", id: "hd-1" }],
      images: { binding: "IMAGES" },
      queues: {
        consumers: [{ dead_letter_queue: "dlq-1", queue: "q-1" }],
        producers: [{ binding: "PRODUCER", queue: "q-1" }],
      },
      r2_buckets: [{ binding: "MEDIA", bucket_name: "bucket-1" }],
      ratelimits: [{ name: "RL", namespace_id: 7 }],
    };
    const bindings = bindingsOf(config);
    expect(bindings.hyperdrive).toEqual(new Map([["HD", "hd-1"]]));
    expect(bindings.buckets).toEqual(new Map([["MEDIA", "bucket-1"]]));
    expect(bindings.producers).toEqual(new Map([["PRODUCER", "q-1"]]));
    expect(bindings.consumers).toEqual(["q-1", "dlq-1"]);
    expect(bindings.ratelimits).toEqual(new Map([["RL", "7"]]));
    expect(bindings.images).toEqual(["IMAGES"]);
    expect(bindings).not.toHaveProperty("consumerLanes");
    expect(bindingsSnapshot(config)).toEqual({
      account: "acc",
      buckets: [["MEDIA", "bucket-1"]],
      consumers: ["dlq-1", "q-1"],
      hyperdrive: [["HD", "hd-1"]],
      producers: [["PRODUCER", "q-1"]],
      ratelimits: [["RL", "7"]],
    });
  });

  it("refuses an unterminated block comment", () => {
    expect(() => parseJsonc('{ /* open "a": 1 }')).toThrow(
      "unterminated comment"
    );
  });
});
