import type { GoalReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoalBlock, OfflineGoalBlock } from "./home-goal";

const october: GoalReadModel = {
  achievedValue: "166619.00",
  createdAt: "2026-10-01T12:00:00.000Z",
  endsOn: "2026-10-31",
  id: "0199c2d0-0000-7000-8000-000000000001",
  kind: "net_sales",
  name: null,
  organizationId: "org",
  paused: false,
  progress: null,
  settledAt: "2026-11-01T03:05:00.000Z",
  startsOn: "2026-10-01",
  status: "missed",
  target: "200000.00",
  updatedAt: "2026-11-01T03:05:00.000Z",
  version: 1,
};

const noRetry = () => undefined;

const NO_BREAK_AMOUNT = /<span class="whitespace-nowrap">([^<]*)<\/span>/g;

const text = (html: string) =>
  html
    .replace(NO_BREAK_AMOUNT, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function render(today: string | null, goal: GoalReadModel = october) {
  return renderToStaticMarkup(
    <GoalBlock
      block={{ data: [goal], status: "ready" }}
      onRetry={noRetry}
      projection={null}
      today={today}
      view={{ goal, kind: "settled" }}
    />
  );
}

describe("the goal block on the 2nd of the month after the goal's", () => {
  it("titles the month now, invites to set its goal, and keeps the past one in a line", () => {
    const html = render("2026-11-02");
    expect(text(html)).toBe(
      "Meta de novembro Sem meta ainda Definir meta Outubro: R$ 166.619,00 de R$ 200.000,00 (não atingida)"
    );
    expect(html).toContain('href="/dashboard?meta=nova"');
    expect(html).not.toContain("Não atingida");
    expect(html).not.toContain("Chegou a");
  });

  it("a goal that ended in the current month keeps the settled card", () => {
    const html = render("2026-10-31");
    expect(text(html)).toContain("Não atingida");
    expect(text(html)).toContain("Chegou a R$ 166.619,00 de R$ 200.000,00.");
    expect(text(html)).not.toContain("Sem meta ainda");
  });

  it("without the store's today it keeps the settled card (nothing to say the month by)", () => {
    expect(text(render(null))).toContain("Não atingida");
  });

  it("offline, the same card with no link to set a goal", () => {
    const html = renderToStaticMarkup(
      <OfflineGoalBlock
        goal={{ currentMonth: "Novembro", goal: october, kind: "settled" }}
      />
    );
    expect(text(html)).toBe(
      "Meta de novembro Sem meta ainda Outubro: R$ 166.619,00 de R$ 200.000,00 (não atingida)"
    );
    expect(html).not.toContain("<a");
  });
});
