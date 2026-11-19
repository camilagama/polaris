import type { BillingPlanView } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createPlanRead,
  PLAN_READ_TTL_MS,
  planRead as shared,
} from "./plan-read";
import { notifyPlanUsageChanged } from "./plan-usage-changes";

const readPlan = vi.fn();

vi.mock("./orpc", () => ({
  orpcClient: {
    billing: { readPlan: (input: unknown) => readPlan(input) },
  },
}));

const planWith = (variants: number) =>
  ({
    limits: { goals: 1, images: 50, variants: 50 },
    state: "free",
    usage: { goals: 0, images: 0, variants },
  }) as unknown as BillingPlanView;

const now = { value: 1_000_000 };

function setup() {
  const answers: Array<{
    organizationId: string;
    reject: (error: Error) => void;
    resolve: (plan: BillingPlanView) => void;
  }> = [];
  const read = vi.fn(
    (organizationId: string) =>
      new Promise<BillingPlanView>((resolve, reject) => {
        answers.push({ organizationId, reject, resolve });
      })
  );
  now.value = 1_000_000;
  const planRead = createPlanRead({ now: () => now.value, read });
  return { answers, planRead, read };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("planRead: a memória de 10 s do plano", () => {
  it("a TTL é de 10 s", () => {
    expect(PLAN_READ_TTL_MS).toBe(10_000);
  });

  it("dois pedidos juntos viram uma leitura, e os dois recebem a mesma resposta", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    const second = planRead.get("org-a");
    answers[0]?.resolve(planWith(7));
    expect(await first).toEqual(planWith(7));
    expect(await second).toEqual(planWith(7));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("até 10 s a resposta vem da memória; aos 10 s + 1 ms a pergunta vai ao servidor", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    answers[0]?.resolve(planWith(7));
    await first;

    now.value += 10_000;
    expect(await planRead.get("org-a")).toEqual(planWith(7));
    expect(read).toHaveBeenCalledTimes(1);

    now.value += 1;
    const late = planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]?.resolve(planWith(8));
    expect(await late).toEqual(planWith(8));
  });

  it("cada loja tem a sua memória", async () => {
    const { answers, planRead, read } = setup();
    const a = planRead.get("org-a");
    const b = planRead.get("org-b");
    answers[0]?.resolve(planWith(1));
    answers[1]?.resolve(planWith(2));
    expect(await a).toEqual(planWith(1));
    expect(await b).toEqual(planWith(2));
    expect(await planRead.get("org-a")).toEqual(planWith(1));
    expect(await planRead.get("org-b")).toEqual(planWith(2));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("pedido fresco ignora a memória e a leitura em voo, e a resposta dele vale para todos", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    answers[0]?.resolve(planWith(7));
    await first;

    const fresh = planRead.get("org-a", { fresh: true });
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]?.resolve(planWith(8));
    expect(await fresh).toEqual(planWith(8));
    expect(await planRead.get("org-a")).toEqual(planWith(8));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a resposta velha em voo que chega depois da fresca não a sobrescreve", async () => {
    const { answers, planRead } = setup();
    const old = planRead.get("org-a");
    const fresh = planRead.get("org-a", { fresh: true });

    answers[1]?.resolve(planWith(8));
    await fresh;
    answers[0]?.resolve(planWith(7));
    expect(await old).toEqual(planWith(7));

    expect(await planRead.get("org-a")).toEqual(planWith(8));
  });

  it("depois de limpar, a leitura que já estava em voo não é guardada nem juntada", async () => {
    const { answers, planRead, read } = setup();
    const before = planRead.get("org-a");
    planRead.clear();
    const after = planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);

    answers[0]?.resolve(planWith(7));
    await before;
    answers[1]?.resolve(planWith(8));
    await after;
    expect(await planRead.get("org-a")).toEqual(planWith(8));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("limpar apaga o que estava guardado: a próxima pergunta vai ao servidor", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    answers[0]?.resolve(planWith(7));
    await first;

    planRead.clear();
    const next = planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]?.resolve(planWith(9));
    expect(await next).toEqual(planWith(9));
  });

  it("limpar com a leitura em voo e sem resposta guardada: a resposta que chega depois não fica", async () => {
    const { answers, planRead, read } = setup();
    const inFlight = planRead.get("org-a");
    planRead.clear();
    answers[0]?.resolve(planWith(7));
    await inFlight;
    planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("leitura que falha chega a quem juntou, não é guardada e a próxima pergunta tenta de novo", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    const second = planRead.get("org-a");
    answers[0]?.reject(new Error("rede"));
    await expect(first).rejects.toThrow("rede");
    await expect(second).rejects.toThrow("rede");
    await settle();

    const retry = planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
    answers[1]?.resolve(planWith(7));
    expect(await retry).toEqual(planWith(7));
  });

  it("a leitura nova de quem a fez (a Assinatura) vira a mais nova para todos e vence a que estava em voo", async () => {
    const { answers, planRead, read } = setup();
    const old = planRead.get("org-a");
    planRead.remember("org-a", planWith(9), planRead.begin());
    expect(await planRead.get("org-a")).toEqual(planWith(9));

    answers[0]?.resolve(planWith(7));
    await old;
    expect(await planRead.get("org-a")).toEqual(planWith(9));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("planRead: borda do tempo e da Assinatura", () => {
  it("a leitura da Assinatura que começou antes de uma gravação e respondeu depois não é guardada", () => {
    const { planRead, read } = setup();
    const token = planRead.begin();
    planRead.clear();
    planRead.remember("org-a", planWith(9), token);
    planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("os 10 s contam do começo da leitura, não da resposta", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    now.value += 6000;
    answers[0]?.resolve(planWith(7));
    await first;
    now.value += 4001;
    planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("um relógio que voltou não faz a memória valer: pergunta ao servidor", async () => {
    const { answers, planRead, read } = setup();
    const first = planRead.get("org-a");
    answers[0]?.resolve(planWith(7));
    await first;
    now.value -= 5000;
    planRead.get("org-a");
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("planRead compartilhada", () => {
  it("lê pelo cliente da loja pedida e é apagada quando o uso ou a sessão mudam", async () => {
    readPlan.mockResolvedValue(planWith(5));
    shared.clear();
    await shared.get("org-a");
    await shared.get("org-a");
    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(readPlan).toHaveBeenCalledWith({ organizationId: "org-a" });

    notifyPlanUsageChanged();
    await shared.get("org-a");
    expect(readPlan).toHaveBeenCalledTimes(2);
  });
});
