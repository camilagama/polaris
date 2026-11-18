import { readFileSync } from "node:fs";
import type { ActivationSweepReport } from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  namesAndValuesOf,
  parseWranglerConfig,
  varsOf,
} from "../wrangler-config.testing";
import {
  ACTIVATION_SWEEP_BATCH,
  activationEmailsEnabled,
  runActivationSweep,
} from "./activation-sweep";

const bindingsOf = (value: string | undefined) =>
  value === undefined ? {} : { ACTIVATION_EMAILS_ENABLED: value };
const wranglerPath = new URL("../../../wrangler.jsonc", import.meta.url);
const now = new Date("2026-11-12T13:17:00.000Z");
const ownerId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const organizationId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function storeAnswering(report: ActivationSweepReport | Error) {
  const sweepActivationSeries = vi.fn(() =>
    report instanceof Error ? Promise.reject(report) : Promise.resolve(report)
  );
  return { sweepActivationSeries };
}

/** Every line the logger wrote, whatever the console method, as the Worker's log would show it. */
function captureLog() {
  const lines: string[] = [];
  for (const method of ["debug", "error", "info", "log", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" ")
      );
    });
  }
  return lines;
}

describe("the switch of the activation series", () => {
  it("is on only for the exact text true", () => {
    expect(activationEmailsEnabled({ ACTIVATION_EMAILS_ENABLED: "true" })).toBe(
      true
    );
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "on"]) {
      expect(activationEmailsEnabled(bindingsOf(value))).toBe(false);
    }
  });

  const FLAG = "ACTIVATION_EMAILS_ENABLED";
  const SENDER = "ACTIVATION_EMAIL_FROM";
  const SECRET_NAMES = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"];

  const stagingSender = "Polaris (staging) <dicas@araute.app>";
  const configText = (
    order: ("staging" | "production")[],
    staging = "true"
  ) => {
    const blocks = {
      production: `"production": { "vars": { "${FLAG}": "false", "${SENDER}": "" } }`,
      staging: `"staging": { "vars": { "${FLAG}": "${staging}", "${SENDER}": "${stagingSender}" } }`,
    };
    return `{
      // top level, the local one
      "vars": { "${FLAG}": "false" },
      "env": { ${order.map((name) => blocks[name]).join(",\n")}, },
    }`;
  };
  const seriesOf = (text: string) => {
    const config = parseWranglerConfig(text);
    const of = (environment?: string) => {
      const vars = varsOf(config, environment);
      return { enabled: vars[FLAG], sender: vars[SENDER] };
    };
    return {
      production: of("production"),
      staging: of("staging"),
      top: of(),
    };
  };
  const secretsIn = (text: string) => [
    ...namesAndValuesOf(parseWranglerConfig(text)).filter((item) =>
      SECRET_NAMES.some((name) => item.includes(name))
    ),
    ...(text.includes("whsec_") ? ["whsec_"] : []),
  ];

  const expected = {
    production: { enabled: "false", sender: "" },
    staging: { enabled: "true", sender: stagingSender },
    top: { enabled: "false", sender: undefined },
  };

  it("is on only in staging, with a public sender there (AC-7b.7, AC-9b.1); the local top level and production stay off, production with an empty sender", () => {
    expect(seriesOf(readFileSync(wranglerPath, "utf8"))).toEqual(expected);
  });

  it("gives the same answer whichever of the staging and production blocks comes first", () => {
    expect(seriesOf(configText(["staging", "production"]))).toEqual(expected);
    expect(seriesOf(configText(["production", "staging"]))).toEqual(expected);
  });

  it("tells staging off from staging on, whichever block comes first", () => {
    for (const order of [
      ["staging", "production"],
      ["production", "staging"],
    ] as const) {
      expect(seriesOf(configText([...order], "false")).staging.enabled).toBe(
        "false"
      );
    }
  });

  it("refuses the name of a Resend secret as key or value and whsec_ anywhere in wrangler.jsonc, comments included, and lets a comment that only names a Resend secret pass", () => {
    expect(secretsIn(readFileSync(wranglerPath, "utf8"))).toEqual([]);
    const placements = {
      "env.production": (entry: string) =>
        `{ "vars": {}, "env": { "production": { "vars": { ${entry} } } } }`,
      "env.staging": (entry: string) =>
        `{ "vars": {}, "env": { "staging": { "vars": { ${entry} } } } }`,
      top: (entry: string) => `{ "vars": { ${entry} } }`,
    };
    for (const entry of [
      '"RESEND_API_KEY": "x"',
      '"RESEND_WEBHOOK_SECRET": "x"',
      '"SOME_VAR": "RESEND_API_KEY"',
      '"SOME_VAR": "RESEND_WEBHOOK_SECRET"',
      '"SOME_VAR": "whsec_x"',
    ]) {
      for (const [position, place] of Object.entries(placements)) {
        expect(secretsIn(place(entry)), `${entry} in ${position}`).not.toEqual(
          []
        );
      }
    }
    expect(secretsIn('{ "vars": {} } // whsec_x')).not.toEqual([]);
    expect(
      secretsIn('{ "vars": {} } // RESEND_API_KEY is a Worker secret')
    ).toEqual([]);
  });
});

describe("the hourly sweep of the activation series", () => {
  let lines: string[];

  beforeEach(() => {
    lines = captureLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const empty = { due: 0, expired: 0, seriesOff: 0, truncated: false };

  it.each([undefined, "false", "TRUE"])(
    "with the switch %s asks the store for the sweep that only clears the instant (AC-7b.1)",
    async (value) => {
      const store = storeAnswering(empty);

      const info = vi.spyOn(logger, "info");

      await runActivationSweep(bindingsOf(value), store, now);

      expect(store.sweepActivationSeries).toHaveBeenCalledExactlyOnceWith({
        enabled: false,
        limit: ACTIVATION_SWEEP_BATCH,
        now,
      });
      expect(info).toHaveBeenCalledExactlyOnceWith(
        "activation_sweep_complete",
        { outcome: "skipped", reason: "series_switched_off", seriesOn: false }
      );
    }
  );

  it("with the switch on sweeps one fixed batch of 50 at the clock it is given (AC-7b.6)", async () => {
    const store = storeAnswering({ ...empty, due: 50, truncated: true });

    const report = await runActivationSweep(
      { ACTIVATION_EMAILS_ENABLED: "true" },
      store,
      now
    );

    expect(ACTIVATION_SWEEP_BATCH).toBe(50);
    expect(store.sweepActivationSeries).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      limit: 50,
      now,
    });
    expect(report).toEqual({ ...empty, due: 50, truncated: true });
  });

  it("logs only the outcome, the counts and the reasons: no address, no store and no person (AC-7b.8)", async () => {
    const info = vi.spyOn(logger, "info");
    const store = storeAnswering({
      due: 2,
      expired: 1,
      seriesOff: 3,
      truncated: true,
    });

    await runActivationSweep({ ACTIVATION_EMAILS_ENABLED: "true" }, store, now);

    expect(info).toHaveBeenCalledExactlyOnceWith("activation_sweep_complete", {
      due: 2,
      outcome: "success",
      seriesOn: true,
      skipped: { expired: 1, series_off: 3 },
      truncated: true,
    });
    const written = lines.join("\n");
    expect(written).toContain("activation_sweep_complete");
    expect(written).not.toContain("@");
    expect(written).not.toMatch(UUID);
  });

  it("logs a failure with its class and code alone, never the message that may name a person, and throws (AC-7b.8)", async () => {
    const error = Object.assign(
      new Error(
        `duplicate key value (user_id, step)=(${ownerId}, a1) of dona@example.com in ${organizationId}`
      ),
      { code: "23505", detail: `Key (user_id)=(${ownerId})` }
    );
    const store = storeAnswering(error);

    await expect(
      runActivationSweep({ ACTIVATION_EMAILS_ENABLED: "true" }, store, now)
    ).rejects.toBe(error);

    const written = lines.join("\n");
    expect(written).toContain("activation_sweep_failed");
    expect(written).toContain("23505");
    expect(written).not.toContain("@");
    expect(written).not.toMatch(UUID);
  });
});
