import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { queueLaneOf } from "./consumer";
import { isDeadLetterQueue } from "./dead-letter";

interface QueuesConfig {
  queues?: {
    consumers?: Array<{ dead_letter_queue?: string; queue: string }>;
    producers?: Array<{ binding: string; queue: string }>;
  };
}

interface WranglerConfig extends QueuesConfig {
  env?: Record<string, QueuesConfig>;
}

// wrangler.jsonc is JSON with comments and trailing commas, which is also a valid JavaScript expression
const config = new Function(
  `return (${readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8")});`
)() as WranglerConfig;

const LANE_BY_BINDING: Record<string, string> = {
  QUEUE_CRITICAL: "critical",
  QUEUE_DEFAULT: "default",
  QUEUE_MEDIA: "media",
};

const environments: [string, QueuesConfig][] = [
  ["top level", config],
  ...Object.entries(config.env ?? {}),
];

// the consumer routes by queue name (`polaris-<lane>-<environment>`): a name it does not recognize refuses every message
describe.each(environments)(
  "the queue names of %s in wrangler.jsonc",
  (_name, block) => {
    it("are recognized by the consumer as the lane of their producer", () => {
      for (const producer of block.queues?.producers ?? []) {
        if (producer.binding === "QUEUE_DLQ") {
          expect(isDeadLetterQueue(producer.queue)).toBe(true);
        } else {
          expect(queueLaneOf(producer.queue)).toBe(
            LANE_BY_BINDING[producer.binding]
          );
          expect(isDeadLetterQueue(producer.queue)).toBe(false);
        }
      }
    });

    it("send refused messages to a queue the dead-letter handler recognizes", () => {
      const consumers = block.queues?.consumers ?? [];
      expect(consumers.length).toBe(4);
      for (const consumer of consumers) {
        if (consumer.dead_letter_queue !== undefined) {
          expect(isDeadLetterQueue(consumer.dead_letter_queue)).toBe(true);
        }
      }
    });
  }
);
