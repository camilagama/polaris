import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { moneyDelta, percentDelta } from "../home/home-kpis";

const hiddenValues = vi.hoisted(() => ({ hidden: false }));

// the server snapshot of the hook says "shown": the choice of the device is set here
vi.mock("../lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hidden-values")>()),
  useHiddenValues: () => [hiddenValues.hidden, () => undefined],
}));

const { DeltaChip } = await import("./kpi-card");

const BASIS = "em relação a setembro (1 a 14/09)";
const NAME = /aria-label="([^"]*)"/;
const SR_ONLY = /class="sr-only"/g;
const VISIBLE = /data-kpi-delta-text="">(.*?)<\/span>(?:<\/span>)?/;

type Delta = NonNullable<ReturnType<typeof percentDelta>>;

function chip(delta: Delta) {
  return renderToStaticMarkup(<DeltaChip delta={delta} />);
}
const nameOf = (markup: string) => NAME.exec(markup)?.[1];
const visibleOf = (markup: string) =>
  (VISIBLE.exec(markup)?.[1] ?? "").replace(/<[^>]*>/g, "");

beforeEach(() => {
  hiddenValues.hidden = false;
});

describe("the name of the chip says the direction in words", () => {
  const cases: [string, Delta | null, string, string][] = [
    [
      "percent up",
      percentDelta(13_000n, 10_000n, BASIS),
      "subiu 30,0 por cento",
      "+30,0%",
    ],
    [
      "percent down",
      percentDelta(8800n, 10_000n, BASIS),
      "caiu 12,0 por cento",
      "-12,0%",
    ],
    ["percent flat", percentDelta(500n, 500n, BASIS), "ficou igual", "0,0%"],
    [
      "percent multiple",
      percentDelta(160_000n, 10_000n, BASIS),
      "subiu para 16,0 vezes o valor anterior",
      "16,0×",
    ],
    [
      "money up",
      moneyDelta(50_000n, 6314n, BASIS),
      "subiu R$ 436,86",
      "+R$ 436,86",
    ],
    ["money down", moneyDelta(0n, 1200n, BASIS), "caiu R$ 12,00", "-R$ 12,00"],
    ["money flat", moneyDelta(700n, 700n, BASIS), "ficou igual", "R$ 0,00"],
  ];

  it.each(cases)("%s", (_case, delta, phrase, seen) => {
    if (!delta) {
      throw new Error("no delta");
    }
    const markup = chip(delta);
    expect(nameOf(markup)).toBe(`${phrase} ${BASIS}`);
    expect(markup).toContain('role="img"');
    expect(visibleOf(markup)).toBe(seen);
  });
});

describe("one spoken path a chip", () => {
  it("with a name, the words are the name alone: no screen-reader-only text beside it", () => {
    for (const delta of [
      percentDelta(13_000n, 10_000n, BASIS),
      percentDelta(160_000n, 10_000n, BASIS),
      moneyDelta(50_000n, 6314n, BASIS),
    ]) {
      const markup = chip(delta as Delta);
      expect(markup.match(SR_ONLY)).toBeNull();
      expect(markup.match(/aria-label=/g)).toHaveLength(1);
      expect(markup).toContain('aria-hidden="true" data-kpi-delta-text=""');
    }
  });

  it("with no name, the sign is hidden and the words are one text for the screen reader", () => {
    const markup = chip(percentDelta(13_000n, 10_000n) as Delta);
    expect(markup).not.toContain("aria-label=");
    expect(markup.match(SR_ONLY)).toHaveLength(1);
    expect(markup).toContain('class="sr-only">subiu 30,0 por cento</span>');
    expect(markup).toContain('aria-hidden="true" data-kpi-delta-text=""');
  });
});

describe("with the values hidden", () => {
  beforeEach(() => {
    hiddenValues.hidden = true;
  });

  it("the name of a chip in reais does not carry the amount", () => {
    const markup = chip(moneyDelta(50_000n, 6314n, BASIS));
    expect(nameOf(markup)).toBe(`subiu valor escondido ${BASIS}`);
    expect(markup).not.toContain("436");
    expect(nameOf(chip(moneyDelta(0n, 1200n, BASIS)))).toBe(
      `caiu valor escondido ${BASIS}`
    );
  });

  it("the text for a screen reader of a chip with no name does not carry it either", () => {
    const markup = chip(moneyDelta(50_000n, 6314n));
    expect(markup).toContain('class="sr-only">subiu valor escondido</span>');
    expect(markup).not.toContain("436,86");
  });

  it("a percent keeps its words", () => {
    expect(nameOf(chip(percentDelta(13_000n, 10_000n, BASIS) as Delta))).toBe(
      `subiu 30,0 por cento ${BASIS}`
    );
  });
});
