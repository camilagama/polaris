import { readFileSync } from "node:fs";
import type { ActivationSweepReport } from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_SWEEP_BATCH,
  activationEmailsEnabled,
  runActivationSweep,
} from "./activation-sweep";

const bindingsOf = (value: string | undefined) =>
  value === undefined ? {} : { ACTIVATION_EMAILS_ENABLED: value };
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

  it("is off in every environment of the repository, staging included (AC-7b.7)", () => {
    const config = readFileSync(
      new URL("../../../wrangler.jsonc", import.meta.url),
      "utf8"
    );
    const values = [
      ...config.matchAll(/"ACTIVATION_EMAILS_ENABLED":\s*"([^"]*)"/g),
    ].map((match) => match[1]);
    // the local top level, staging and production each declare it, and each one off
    expect(values).toEqual(["false", "false", "false"]);
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
