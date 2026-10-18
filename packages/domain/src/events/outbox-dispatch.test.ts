import { describe, expect, it } from "vitest";
import {
  OUTBOX_DISPATCH_BATCH,
  OUTBOX_DISPATCH_LEASE_SECONDS,
  OUTBOX_MAX_DISPATCH_ATTEMPTS,
  outboxRetryDelaySeconds,
} from "./outbox-dispatch";
import { QUEUE_ENVELOPE_MAX_ATTEMPT } from "./queue-envelope";

describe("the outbox dispatch rules", () => {
  it("doubles the delay of a failed send from thirty seconds and stops at an hour", () => {
    expect(outboxRetryDelaySeconds(1)).toBe(30);
    expect(outboxRetryDelaySeconds(2)).toBe(60);
    expect(outboxRetryDelaySeconds(3)).toBe(120);
    expect(outboxRetryDelaySeconds(8)).toBe(3600);
    expect(outboxRetryDelaySeconds(999)).toBe(3600);
    expect(outboxRetryDelaySeconds(0)).toBe(30);
  });

  it("holds a claim longer than a cron invocation can live", () => {
    expect(OUTBOX_DISPATCH_LEASE_SECONDS).toBeGreaterThan(15 * 60);
  });

  it("never counts an attempt the queue envelope would refuse", () => {
    expect(OUTBOX_MAX_DISPATCH_ATTEMPTS).toBe(QUEUE_ENVELOPE_MAX_ATTEMPT);
  });

  it("takes fewer events than one sendBatch holds", () => {
    expect(OUTBOX_DISPATCH_BATCH).toBeLessThanOrEqual(100);
  });
});
