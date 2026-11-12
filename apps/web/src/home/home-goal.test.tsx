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

const SENTENCE_CLASS = /<p class="([^"]*)">Defina quanto/;

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

describe("a faixa fina da Meta (sem meta para o mês)", () => {
  const STRIP = 'data-goal-strip=""';
  const SENTENCE = "Defina quanto quer vender no mês e acompanhe aqui.";
  const active: GoalReadModel = {
    ...october,
    achievedValue: null,
    endsOn: "2026-11-30",
    progress: {
      percent: "10.00",
      periodEnded: false,
      reached: false,
      value: "500.00",
    },
    settledAt: null,
    startsOn: "2026-11-01",
    status: "active",
    target: "5000.00",
  };
  const view = (value: Parameters<typeof GoalBlock>[0]["view"]) =>
    renderToStaticMarkup(
      <GoalBlock
        block={{ data: [], status: "ready" }}
        onRetry={noRetry}
        projection={null}
        today="2026-11-11"
        view={value}
      />
    );

  it("sem meta é faixa: o título, a frase e Definir meta, com a marca que a grade lê", () => {
    const html = view({ kind: "none" });
    expect(html).toContain(STRIP);
    expect(text(html)).toBe(`Meta ${SENTENCE} Definir meta`);
    expect(html).toContain('href="/dashboard?meta=nova"');
  });

  it("a frase só aparece onde a faixa tem lugar (a partir de 960 px de conteúdo)", () => {
    const sentence = view({ kind: "none" }).match(SENTENCE_CLASS);
    expect(sentence?.[1]?.split(" ")).toEqual(
      expect.arrayContaining(["hidden", "@min-[60rem]/home:block"])
    );
  });

  it("o mês sem meta, lido logo depois da meta do anterior, também é faixa", () => {
    expect(render("2026-11-02")).toContain(STRIP);
  });

  it("meta em andamento e meta liquidada neste mês são cartão, não faixa", () => {
    expect(view({ goal: active, kind: "active", others: 0 })).not.toContain(
      STRIP
    );
    expect(render("2026-10-31")).not.toContain(STRIP);
  });

  it("sem conexão: sem cópia ou com a meta do mês passado é faixa; a meta em andamento é cartão", () => {
    const offline = (goal: Parameters<typeof OfflineGoalBlock>[0]["goal"]) =>
      renderToStaticMarkup(<OfflineGoalBlock goal={goal} />);
    expect(offline({ kind: "online-only" })).toContain(STRIP);
    expect(
      offline({ currentMonth: "Novembro", goal: october, kind: "settled" })
    ).toContain(STRIP);
    expect(
      offline({ ended: false, goal: active, kind: "active" })
    ).not.toContain(STRIP);
  });

  it("a meta em andamento fica em pé quando está num par (o anel e os números no meio)", () => {
    const html = view({ goal: active, kind: "active", others: 0 });
    expect(html).toContain("group-data-[pair]/row:@min-[60rem]/home:flex-col");
  });
});
