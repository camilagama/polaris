/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { WORKER_MARK } from "./worker-mark";

/**
 * The goals panel of the result screen in a real browser, over a small
 * in-memory stand-in for the server's `goal.*` procedures (and a fixed
 * `report.periodSummary`), answered on the RPC wire format. Like the real
 * server, listing settles the goals: one whose progress reached the target
 * becomes completed and stays so, one whose period ended unmet is missed. What
 * the real server computes is proved on PostgreSQL by the goals gate.
 */
const NOW = "2026-10-14T12:00:00.000Z";
const TODAY = "2026-10-14";
const rpcPrefix = /^\/rpc\//;
const goalActionName = /^(Editar|Cancelar) meta/;
const fortyFivePercent = /45,0%/;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** The month's figures: net sales R$ 450,00 over 3 sales and a result of R$ 120,00. */
const FIXTURE = {
  netSalesCents: 45_000,
  operatingResultCents: 12_000,
  sales: 3,
};

type GoalKind = "net_sales" | "operating_result" | "sale_count";
type GoalStatus = "active" | "cancelled" | "completed" | "missed";

interface TargetChange {
  changedAt: string;
  newTarget: string;
  previousTarget: string;
}

interface StoredGoal {
  achievedValue: string | null;
  changes: TargetChange[];
  createdAt: string;
  endsOn: string;
  id: string;
  kind: GoalKind;
  name: string | null;
  settledAt: string | null;
  startsOn: string;
  status: GoalStatus;
  target: string;
  updatedAt: string;
  version: number;
}

type GoalSeed = Partial<StoredGoal> & Pick<StoredGoal, "kind" | "target">;

/** "1000.00" as 100000, "50" as 50 for a count: integer units, never floats. */
function unitsOf(kind: GoalKind, text: string): number {
  if (kind === "sale_count") {
    return Number(text);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

function moneyText(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function valueText(kind: GoalKind, units: number): string {
  return kind === "sale_count" ? String(units) : moneyText(units);
}

function targetText(kind: GoalKind, text: string): string {
  return kind === "sale_count"
    ? String(Number(text))
    : moneyText(unitsOf(kind, text));
}

/** The figures exist in October 2026 only: a period outside it measures nothing. */
function measureOf(goal: StoredGoal, figures: typeof FIXTURE): number {
  if (goal.startsOn > "2026-10-31" || goal.endsOn < "2026-10-01") {
    return 0;
  }
  if (goal.kind === "sale_count") {
    return figures.sales;
  }
  return goal.kind === "net_sales"
    ? figures.netSalesCents
    : figures.operatingResultCents;
}

function percentOf(value: number, target: number): string | null {
  if (value <= 0) {
    return null;
  }
  const tenths = Math.floor((value * 1000) / target);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function summary(from: string, to: string) {
  return {
    generatedAt: NOW,
    cards: {
      items: 5,
      marginPercent: "53.33",
      netSales: moneyText(FIXTURE.netSalesCents),
      operatingResult: moneyText(FIXTURE.operatingResultCents),
      salesCount: FIXTURE.sales,
      ticket: "150.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "200.00",
      commercialSurcharges: "0.00",
      contributionMargin: "240.00",
      discounts: "30.00",
      estimatedOperatingResult: moneyText(FIXTURE.operatingResultCents),
      grossProfit: "250.00",
      grossSales: "500.00",
      linkedExpenses: "0.00",
      netSales: moneyText(FIXTURE.netSalesCents),
      operatingExpenses: "120.00",
      processingFees: "10.00",
      returns: "20.00",
    },
    period: { from, to },
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: 3,
      itemLinesWithUnknownCost: 0,
      level: "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 1,
      processingFeesUnknown: 0,
      salesCount: FIXTURE.sales,
    },
  };
}

class FakeGoalServer {
  readonly goals: StoredGoal[] = [];
  /** Calls to `goal.create` that were answered, in order. */
  readonly created: Record<string, unknown>[] = [];
  /** When set, `goal.list` answers this ORPC error instead of the goals. */
  listFailure: { code: string; status: number } | null = null;
  /** The figures of the month; a test can change them. */
  readonly figures = { ...FIXTURE };
  private lastId = 0;

  /** A goal that already exists when the screen opens. */
  seed(input: GoalSeed): StoredGoal {
    this.lastId += 1;
    const goal: StoredGoal = {
      achievedValue: null,
      changes: [],
      createdAt: "2026-10-01T12:00:00.000Z",
      endsOn: "2026-10-31",
      id: uuid(this.lastId),
      name: null,
      settledAt: null,
      startsOn: "2026-10-01",
      status: "active",
      updatedAt: "2026-10-01T12:00:00.000Z",
      version: 1,
      ...input,
    };
    this.goals.push(goal);
    return goal;
  }

  /** Another device changed the goal: its version moves on. */
  touch(id: string) {
    const goal = this.find(id);
    if (goal) {
      goal.version += 1;
    }
  }

  handle(procedure: string, input: Record<string, unknown>) {
    switch (procedure) {
      case "report/periodSummary":
        return this.ok(summary(String(input.from), String(input.to)));
      case "goal/list":
        return this.list(input);
      case "goal/create":
        return this.create(input);
      case "goal/update":
        return this.update(input);
      case "goal/cancel":
        return this.cancel(input);
      case "goal/targetChanges":
        return this.targetChanges(input);
      default:
        return this.fail("NOT_FOUND", 404);
    }
  }

  private find(id: unknown) {
    return this.goals.find((goal) => goal.id === id);
  }

  /** What listing does on the server: settle by the figures, then read. */
  private settle() {
    for (const goal of this.goals.filter((item) => item.status === "active")) {
      const value = measureOf(goal, this.figures);
      const reached = value >= unitsOf(goal.kind, goal.target);
      if (reached || goal.endsOn < TODAY) {
        goal.status = reached ? "completed" : "missed";
        goal.achievedValue = valueText(goal.kind, value);
        goal.settledAt = NOW;
        goal.updatedAt = NOW;
        goal.version += 1;
      }
    }
  }

  private wire(
    goal: StoredGoal,
    organizationId: unknown,
    withProgress: boolean
  ) {
    const { changes: _changes, ...rest } = goal;
    let progress: {
      percent: string | null;
      periodEnded: boolean;
      reached: boolean;
      value: string;
    } | null = null;
    if (withProgress && goal.status === "active") {
      const value = measureOf(goal, this.figures);
      progress = {
        percent: percentOf(value, unitsOf(goal.kind, goal.target)),
        periodEnded: goal.endsOn < TODAY,
        reached: false,
        value: valueText(goal.kind, value),
      };
    }
    return {
      ...rest,
      organizationId: String(organizationId),
      paused: false,
      progress,
    };
  }

  private list(input: Record<string, unknown>) {
    if (this.listFailure) {
      return this.fail(this.listFailure.code, this.listFailure.status);
    }
    this.settle();
    return this.ok({
      goals: this.goals.map((goal) =>
        this.wire(goal, input.organizationId, true)
      ),
    });
  }

  private create(input: Record<string, unknown>) {
    const kind = input.kind as GoalKind;
    const target = unitsOf(kind, String(input.target));
    const startsOn = String(input.startsOn);
    const endsOn = String(input.endsOn);
    const days =
      (Date.parse(`${endsOn}T00:00:00Z`) -
        Date.parse(`${startsOn}T00:00:00Z`)) /
        86_400_000 +
      1;
    if (!(target > 0) || endsOn < startsOn || days > 366) {
      return this.fail("BAD_REQUEST", 400);
    }
    this.created.push(input);
    const goal = this.seed({
      endsOn,
      kind,
      name: typeof input.name === "string" ? input.name : null,
      startsOn,
      target: targetText(kind, String(input.target)),
    });
    return this.ok(this.wire(goal, input.organizationId, false));
  }

  private editable(input: Record<string, unknown>) {
    const goal = this.find(input.id);
    if (!goal) {
      return { failure: this.fail("NOT_FOUND", 404) };
    }
    if (goal.status !== "active" || goal.version !== input.expectedVersion) {
      return { failure: this.fail("CONFLICT", 409) };
    }
    return { goal };
  }

  private update(input: Record<string, unknown>) {
    const { failure, goal } = this.editable(input);
    if (!goal) {
      return failure;
    }
    if (typeof input.name === "string" || input.name === null) {
      goal.name = input.name?.trim() || null;
    }
    if (typeof input.target === "string") {
      const target = targetText(goal.kind, input.target);
      if (target !== goal.target) {
        goal.changes.push({
          changedAt: NOW,
          newTarget: target,
          previousTarget: goal.target,
        });
        goal.target = target;
      }
    }
    goal.version += 1;
    goal.updatedAt = NOW;
    return this.ok({
      changed: true,
      goal: this.wire(goal, input.organizationId, false),
    });
  }

  private cancel(input: Record<string, unknown>) {
    const { failure, goal } = this.editable(input);
    if (!goal) {
      return failure;
    }
    goal.status = "cancelled";
    goal.version += 1;
    goal.updatedAt = NOW;
    return this.ok({
      changed: true,
      goal: this.wire(goal, input.organizationId, false),
    });
  }

  private targetChanges(input: Record<string, unknown>) {
    const goal = this.find(input.id);
    return goal
      ? this.ok({ changes: goal.changes })
      : this.fail("NOT_FOUND", 404);
  }

  private ok(json: unknown) {
    return { body: { json, meta: [] }, status: 200 };
  }

  private fail(code: string, status: number) {
    return {
      body: {
        json: { code, data: {}, defined: false, message: code, status },
        meta: [],
      },
      status,
    };
  }
}

async function installServer(page: Page, server: FakeGoalServer) {
  await page.route("**/rpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.replace(rpcPrefix, "");
    const body = route.request().postDataJSON() as {
      json?: Record<string, unknown>;
    } | null;
    const answer = server.handle(procedure, body?.json ?? {});
    await route.fulfill({
      body: JSON.stringify(answer.body),
      headers: { ...WORKER_MARK },
      contentType: "application/json",
      status: answer.status,
    });
  });
}

async function openDashboard(page: Page, server: FakeGoalServer) {
  // the screen reads today's date from the browser: October 2026
  await page.clock.setFixedTime(new Date(NOW));
  await installServer(page, server);
  await page.goto("/offline-screens-lab?screen=dashboard");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Resultado" })
  ).toBeVisible({ timeout: 20_000 });
}

/** Opens the screen and the collapsible "Metas" panel. */
async function openGoals(page: Page, server: FakeGoalServer) {
  await openDashboard(page, server);
  await page.locator(".goal-panel > summary").click();
  await expect(page.locator(".goal-panel")).toHaveAttribute("open", "");
}

const card = (page: Page, title: string): Locator =>
  page
    .locator(".goal-card")
    .filter({ has: page.getByRole("heading", { exact: true, name: title }) });

const goalActions = (page: Page) =>
  page.getByRole("button", { name: goalActionName });

test("cria uma meta e mostra o progresso com a barra", async ({ page }) => {
  const server = new FakeGoalServer();
  await openGoals(page, server);

  await expect(page.getByText("Nenhuma meta ainda.")).toBeVisible();
  await page.getByRole("button", { name: "Nova meta" }).click();

  // the period starts as the month on screen
  await expect(page.locator("#goal-create-startsOn")).toHaveValue("2026-10-01");
  await expect(page.locator("#goal-create-endsOn")).toHaveValue("2026-10-31");
  await page.locator("#goal-create-name").fill("Meta de outubro");
  await page.locator("#goal-create-target").fill("1.000,00");
  await page.getByRole("button", { name: "Criar meta" }).click();

  await expect(page.getByText("Meta criada.")).toBeVisible();
  expect(server.created[0]).toMatchObject({
    endsOn: "2026-10-31",
    kind: "net_sales",
    name: "Meta de outubro",
    startsOn: "2026-10-01",
    target: "1000.00",
  });

  const created = card(page, "Meta de outubro");
  await expect(created).toContainText("Em andamento");
  await expect(created).toContainText("Vendas líquidas");
  await expect(created).toContainText("01/10/2026 a 31/10/2026");
  await expect(created.locator(".goal-progress-text")).toContainText(
    "R$ 450,00"
  );
  await expect(created.locator(".goal-progress-text")).toContainText(
    "R$ 1.000,00"
  );
  await expect(created.locator(".goal-progress-text")).toContainText("45,0%");
  const bar = created.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "45");
  await expect(bar).toHaveAttribute("aria-valuemax", "100");
  await expect(bar).toHaveAttribute("aria-valuetext", fortyFivePercent);
  // the form closed
  await expect(page.locator("#goal-create-target")).toHaveCount(0);
});

test("uma meta que chegou ao alvo vira Concluída e continua concluída", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  await openGoals(page, server);

  await page.getByRole("button", { name: "Nova meta" }).click();
  await page.locator("#goal-create-kind").selectOption("sale_count");
  await page.locator("#goal-create-target").fill("3");
  await page.getByRole("button", { name: "Criar meta" }).click();

  await expect(page.getByText("Meta criada.")).toBeVisible();
  const done = card(page, "Número de vendas");
  await expect(done).toContainText("Concluída");
  await expect(done).toContainText("atingido com 3 (conferido em 14/10/2026)");
  await expect(done).toContainText(
    "Uma meta concluída continua concluída, mesmo que devoluções posteriores reduzam os números."
  );
  await expect(page.getByRole("heading", { name: "Encerradas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Em andamento" })).toHaveCount(
    0
  );
  await expect(goalActions(page)).toHaveCount(0);

  // reading again changes nothing: it stays completed
  await page.getByRole("button", { name: "Atualizar metas" }).click();
  await expect(card(page, "Número de vendas")).toContainText("Concluída");
  expect(server.goals[0]?.status).toBe("completed");
});

test("edita o alvo e mostra o histórico de mudanças", async ({ page }) => {
  const server = new FakeGoalServer();
  const seeded = server.seed({ kind: "sale_count", target: "10" });
  await openGoals(page, server);

  const goal = card(page, "Número de vendas");
  await expect(goal).toContainText("Em andamento");
  await expect(goal).toContainText("3 de 10 vendas");
  await expect(goal.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "30"
  );

  await goal
    .getByRole("button", { name: "Editar meta Número de vendas" })
    .click();
  await page.locator(`#goal-edit-${seeded.id}-target`).fill("5");
  await goal.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page.getByText("Meta atualizada.")).toBeVisible();
  await expect(goal).toContainText("3 de 5 vendas");
  await expect(goal.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "60"
  );
  // the form closed
  await expect(page.locator(`#goal-edit-${seeded.id}-target`)).toHaveCount(0);

  await goal.getByRole("button", { name: "Histórico do alvo" }).click();
  await expect(goal.getByRole("listitem")).toHaveText(
    "de 10 para 5 em 14/10/2026"
  );
});

test("o histórico de uma meta sem mudanças diz que o alvo nunca mudou", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  server.seed({ kind: "net_sales", name: "Intacta", target: "2000.00" });
  await openGoals(page, server);

  await card(page, "Intacta")
    .getByRole("button", { name: "Histórico do alvo" })
    .click();
  await expect(page.getByText("O alvo nunca foi alterado.")).toBeVisible();
});

test("cancela a meta só depois da confirmação", async ({ page }) => {
  const server = new FakeGoalServer();
  server.seed({ kind: "net_sales", name: "Meta de vendas", target: "1000.00" });
  await openGoals(page, server);

  const goal = card(page, "Meta de vendas");
  await goal
    .getByRole("button", { name: "Cancelar meta Meta de vendas" })
    .click();
  await expect(goal).toContainText("isso não poderá ser desfeito");
  expect(server.goals[0]?.status).toBe("active");

  // back out: nothing was cancelled
  await goal.getByRole("button", { name: "Voltar" }).click();
  await expect(goal).not.toContainText("isso não poderá ser desfeito");
  expect(server.goals[0]?.status).toBe("active");

  await goal
    .getByRole("button", { name: "Cancelar meta Meta de vendas" })
    .click();
  await goal.getByRole("button", { name: "Confirmar cancelamento" }).click();

  await expect(page.getByText("Meta cancelada.")).toBeVisible();
  expect(server.goals[0]?.status).toBe("cancelled");
  await expect(card(page, "Meta de vendas")).toContainText("Cancelada");
  await expect(card(page, "Meta de vendas")).toContainText(
    "Cancelada em 14/10/2026"
  );
  await expect(goalActions(page)).toHaveCount(0);
});

test("as metas finais não têm editar nem cancelar", async ({ page }) => {
  const server = new FakeGoalServer();
  // active, but already at its target: reading settles it as completed
  server.seed({ kind: "net_sales", name: "Alcançada", target: "450.00" });
  // active, the period is over and the target was not reached: missed
  server.seed({
    endsOn: "2026-09-30",
    kind: "net_sales",
    name: "Setembro",
    startsOn: "2026-09-01",
    target: "1000.00",
  });
  server.seed({
    achievedValue: "10.00",
    kind: "net_sales",
    name: "Já cancelada",
    status: "cancelled",
    target: "900.00",
  });
  await openGoals(page, server);

  await expect(card(page, "Alcançada")).toContainText("Concluída");
  await expect(card(page, "Alcançada")).toContainText(
    "atingido com R$ 450,00 (conferido em 14/10/2026)"
  );
  await expect(card(page, "Setembro")).toContainText("Não atingida");
  await expect(card(page, "Setembro")).toContainText(
    "O período terminou sem atingir o alvo de R$ 1.000,00: o resultado foi R$ 0,00."
  );
  await expect(card(page, "Já cancelada")).toContainText("Cancelada");
  await expect(page.getByRole("heading", { name: "Encerradas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Em andamento" })).toHaveCount(
    0
  );
  await expect(page.locator(".goal-card")).toHaveCount(3);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(goalActions(page)).toHaveCount(0);
});

test("a meta que ainda não começou diz quando começa", async ({ page }) => {
  const server = new FakeGoalServer();
  server.seed({
    endsOn: "2026-11-30",
    kind: "sale_count",
    name: "Novembro",
    startsOn: "2026-11-01",
    target: "20",
  });
  await openGoals(page, server);

  const goal = card(page, "Novembro");
  await expect(goal).toContainText("Em andamento");
  await expect(goal).toContainText("Começa em 01/11/2026");
  await expect(goal.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "0"
  );
});

test("o operacional estimado negativo mostra a barra vazia", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  server.seed({
    kind: "operating_result",
    name: "Resultado",
    target: "5000.00",
  });
  // the month closes with a loss: the server answers no percent
  server.figures.operatingResultCents = -8000;
  await openGoals(page, server);

  const shown = card(page, "Resultado");
  await expect(shown.locator(".goal-progress-text")).toContainText("-R$ 80,00");
  await expect(shown.locator(".goal-progress-text")).toContainText("0%");
  await expect(shown.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "0"
  );
});

test("uma versão antiga mostra o conflito e atualiza a lista", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  const seeded = server.seed({
    kind: "net_sales",
    name: "Disputada",
    target: "1000.00",
  });
  await openGoals(page, server);

  const goal = card(page, "Disputada");
  await goal.getByRole("button", { name: "Editar meta Disputada" }).click();
  await page.locator(`#goal-edit-${seeded.id}-target`).fill("2000");

  // another device changes the goal first
  server.touch(seeded.id);
  await goal.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Esta meta mudou em outra solicitação"
  );
  expect(seeded.target).toBe("1000.00");
  // the form closed and the list was read again
  await expect(page.locator(`#goal-edit-${seeded.id}-target`)).toHaveCount(0);
  await expect(card(page, "Disputada")).toContainText("R$ 1.000,00");
});

test("a validação mostra o erro junto do campo e não envia nada", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  await openGoals(page, server);

  await page.getByRole("button", { name: "Nova meta" }).click();
  await page.getByRole("button", { name: "Criar meta" }).click();

  await expect(page.getByText("Informe o alvo da meta.")).toBeVisible();
  await expect(page.locator("#goal-create-target")).toHaveAttribute(
    "aria-invalid",
    "true"
  );
  expect(server.created).toHaveLength(0);

  // a period over 366 days is refused before it is sent
  await page.locator("#goal-create-target").fill("100");
  await page.locator("#goal-create-endsOn").fill("2027-12-31");
  await page.getByRole("button", { name: "Criar meta" }).click();
  await expect(page.locator("#goal-create-endsOn-error")).toContainText("366");
  expect(server.created).toHaveLength(0);
});

test("uma falha ao carregar mostra o erro e deixa tentar de novo", async ({
  page,
}) => {
  const server = new FakeGoalServer();
  server.seed({
    kind: "net_sales",
    name: "Depois da falha",
    target: "1000.00",
  });
  server.listFailure = { code: "INTERNAL_SERVER_ERROR", status: 500 };
  await openGoals(page, server);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Não foi possível carregar as metas. Tente novamente."
  );
  await expect(page.locator(".goal-card")).toHaveCount(0);

  server.listFailure = null;
  await alert.getByRole("button", { name: "Tentar de novo" }).click();

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card(page, "Depois da falha")).toContainText("Em andamento");
});
