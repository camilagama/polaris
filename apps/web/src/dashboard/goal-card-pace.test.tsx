import type { GoalReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveGoalCard } from "./goal-card";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

function progress(
  percent: string,
  over: Partial<NonNullable<GoalReadModel["progress"]>> = {}
): NonNullable<GoalReadModel["progress"]> {
  return {
    percent,
    periodEnded: false,
    reached: false,
    value: "1500.00",
    ...over,
  };
}

const base: GoalReadModel = {
  achievedValue: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  endsOn: "2026-11-30",
  id: "0199c2d0-0000-7000-8000-000000000001",
  kind: "net_sales",
  name: null,
  organizationId: "org",
  paused: false,
  progress: progress("30.0"),
  settledAt: null,
  startsOn: "2026-11-01",
  status: "active",
  target: "5000.00",
  updatedAt: "2026-11-01T12:00:00.000Z",
  version: 1,
};

const onDone = () => Promise.resolve("ok" as const);

function card(goal: GoalReadModel, today: string) {
  return renderToStaticMarkup(
    <ActiveGoalCard
      busyKey={null}
      goal={goal}
      onCancel={onDone}
      onSave={onDone}
      organizationId="org"
      timezone="America/Sao_Paulo"
      today={today}
    />
  );
}

const MARKER = /data-slot="progress-marker"[^>]*style="left:([\d.]+)%"/;
const MARKER_HIDDEN =
  /<span[^>]*aria-hidden="true"[^>]*data-slot="progress-marker"/;
const VALUETEXT = /aria-valuetext="([^"]*)"/;
const SLOT = /data-pace="([^"]*)"/;
const PACE_WORD = /Adiantada|No ritmo|Atrasada/;

describe("o ritmo na barra da aba Metas", () => {
  it("põe o traço em dias passados ÷ dias do período e diz o estado em palavras", () => {
    const html = card(base, "2026-11-19");
    expect(Number(MARKER.exec(html)?.[1])).toBeCloseTo(60, 5);
    expect(html).toMatch(MARKER_HIDDEN);
    expect(VALUETEXT.exec(html)?.[1]).toBe(
      "R$ 1.500,00 de R$ 5.000,00, 30,0%. Atrasada: o esperado até hoje era 60%."
    );
    expect(SLOT.exec(html)?.[1]).toBe("behind");
    expect(html).toContain("Atrasada</p>");
  });

  it("escreve Adiantada e No ritmo", () => {
    const ahead = { ...base, progress: progress("80.0") };
    const near = { ...base, progress: progress("58.0") };
    expect(SLOT.exec(card(ahead, "2026-11-19"))?.[1]).toBe("ahead");
    expect(SLOT.exec(card(near, "2026-11-19"))?.[1]).toBe("on_pace");
  });

  it.each([
    ["primeiro dia", base, "2026-11-01"],
    ["antes do início", base, "2026-10-31"],
    [
      "período acabado",
      { ...base, progress: progress("30.0", { periodEnded: true }) },
      "2026-12-01",
    ],
  ])(
    "sem traço nem palavra no %s, e a linha continua reservada",
    (_name, goal, today) => {
      const html = card(goal, today);
      expect(html).not.toContain("progress-marker");
      expect(html).not.toMatch(PACE_WORD);
      expect(VALUETEXT.exec(html)?.[1]).toBe(
        "R$ 1.500,00 de R$ 5.000,00, 30,0%"
      );
      expect(SLOT.exec(html)?.[1]).toBe("");
    }
  );

  it("meta pausada e sem progresso lido não têm barra, traço nem linha", () => {
    for (const goal of [
      { ...base, paused: true },
      { ...base, progress: null },
    ]) {
      const html = card(goal, "2026-11-19");
      expect(html).not.toContain("progress-marker");
      expect(html).not.toContain("data-pace");
    }
  });
});
