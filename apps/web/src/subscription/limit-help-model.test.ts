import { describe, expect, it } from "vitest";
import {
  isLimitReached,
  LIMIT_ASK_OWNER,
  type LimitSubject,
  limitHelpFor,
  limitUsageText,
  type NearLimitSubject,
  nearLimitFor,
  nearLimitText,
} from "./limit-help-model";

const STATES = [
  "free",
  "free_over_limit",
  "trial_setup",
  "trialing",
  "active",
  "grace",
] as const;
const SUBJECTS: LimitSubject[] = [
  "variants",
  "images",
  "productImages",
  "goals",
  "catalog",
];

const planOf = (state: (typeof STATES)[number]) => ({
  limits: { goals: 1, images: 50, variants: 50 },
  state,
  usage: { goals: 1, images: 50, variants: 50 },
});

const help = (
  billingSelfService: boolean,
  canManageBilling: boolean,
  state: (typeof STATES)[number] | null,
  subject: LimitSubject = "variants"
) =>
  limitHelpFor({
    billingSelfService,
    canManageBilling,
    plan: state === null ? null : planOf(state),
    subject,
  });

describe("a regra única do que acompanha um limite (corte 1.6, AC-5)", () => {
  it("o dono numa loja Free, ou Free acima do limite, ganha 'Conhecer o Pro' em todo lugar", () => {
    for (const subject of SUBJECTS) {
      for (const state of ["free", "free_over_limit"] as const) {
        expect(help(true, true, state, subject)?.action).toBe("upgrade");
      }
    }
  });

  it("o dono no Pro, em teste, na carência ou sem a leitura do plano não vê nada", () => {
    for (const subject of SUBJECTS) {
      for (const state of [
        "trial_setup",
        "trialing",
        "active",
        "grace",
        null,
      ] as const) {
        expect(help(true, true, state, subject)).toBeNull();
      }
    }
  });

  it("quem não é dono lê o caminho até o dono, sem números, em qualquer plano", () => {
    for (const subject of SUBJECTS) {
      for (const state of [...STATES, null]) {
        expect(help(true, false, state, subject)).toEqual({
          action: "ask_owner",
          usage: null,
        });
      }
    }
    expect(LIMIT_ASK_OWNER).toBe("Fale com o dono da loja para mudar o plano.");
  });

  it("com a assinatura desligada, nada para ninguém", () => {
    for (const manage of [true, false]) {
      for (const state of [...STATES, null]) {
        expect(help(false, manage, state)).toBeNull();
      }
    }
  });

  it("os números vêm só da leitura do plano, e só onde ela os tem", () => {
    expect(help(true, true, "free", "variants")?.usage).toEqual({
      max: 50,
      subject: "variants",
      used: 50,
    });
    expect(help(true, true, "free", "goals")?.usage).toEqual({
      max: 1,
      subject: "goals",
      used: 1,
    });
    // the read of the plan has no limit per product, and the catalog has no count
    expect(help(true, true, "free", "productImages")?.usage).toBeNull();
    expect(help(true, true, "free", "catalog")?.usage).toBeNull();
    // a limit the plan does not have (null) gives no line
    expect(
      limitHelpFor({
        billingSelfService: true,
        canManageBilling: true,
        plan: {
          limits: { goals: null, images: null, variants: null },
          state: "free",
          usage: { goals: 0, images: 0, variants: 0 },
        },
        subject: "variants",
      })
    ).toEqual({ action: "upgrade", usage: null });
  });
});

describe("a linha de uso", () => {
  it("diz N de M do limite atingido, sem o número do Pro", () => {
    expect(limitUsageText({ max: 50, subject: "variants", used: 50 })).toBe(
      "Você usa 50 de 50 variantes no plano Free."
    );
    expect(limitUsageText({ max: 50, subject: "images", used: 50 })).toBe(
      "Você usa 50 de 50 imagens no plano Free."
    );
    expect(limitUsageText({ max: 1, subject: "goals", used: 1 })).toBe(
      "Você usa 1 de 1 meta em andamento no plano Free."
    );
    expect(limitUsageText({ max: 1, subject: "goals", used: 3 })).toBe(
      "Você usa 3 de 1 metas em andamento no plano Free."
    );
  });
});

describe("a recusa por limite", () => {
  it("é um CONFLICT com o motivo do limite, e só ele", () => {
    const refusal = (code: string, reason?: string) => ({
      code,
      ...(reason ? { data: { reason } } : {}),
    });
    expect(
      isLimitReached(refusal("CONFLICT", "entitlement_limit_reached"))
    ).toBe(true);
    expect(
      isLimitReached(refusal("BAD_REQUEST", "entitlement_limit_reached"))
    ).toBe(false);
    expect(isLimitReached(refusal("CONFLICT", "goal_limit_reached"))).toBe(
      false
    );
    expect(isLimitReached(refusal("CONFLICT"))).toBe(false);
  });
});

describe("o aviso de que o limite está perto", () => {
  const planWith = (
    state: (typeof STATES)[number],
    used: number,
    max: number | null = 50
  ) => ({
    limits: { goals: 1, images: max, variants: max },
    state,
    usage: { goals: 0, images: used, variants: used },
  });
  const near = (
    subject: NearLimitSubject,
    used: number,
    state: (typeof STATES)[number] = "free"
  ) =>
    nearLimitFor({
      billingSelfService: true,
      canManageBilling: true,
      plan: planWith(state, used),
      subject,
    });

  it.each([
    ["variants", "variantes"],
    ["images", "imagens"],
  ] as const)("nas bordas 44, 45, 49, 50 e 51 de %s", (subject, word) => {
    expect(near(subject, 44)).toBeNull();
    const at45 = near(subject, 45);
    expect(at45?.kind).toBe("near");
    expect(at45 && nearLimitText(at45)).toBe(
      `Você usa 45 de 50 ${word} no plano Free.`
    );
    expect(near(subject, 49)?.kind).toBe("near");
    const at50 = near(subject, 50);
    expect(at50?.kind).toBe("reached");
    expect(at50 && nearLimitText(at50)).toBe(
      `Você chegou ao limite de 50 ${word} do plano Free.`
    );
    const over = near(subject, 51, "free_over_limit");
    expect(over?.kind).toBe("reached");
    expect(over && nearLimitText(over)).toBe(
      `Você chegou ao limite de 50 ${word} do plano Free.`
    );
  });

  it("arredonda os 90% para cima, com o número do servidor", () => {
    const at = (used: number, max: number) =>
      nearLimitFor({
        billingSelfService: true,
        canManageBilling: true,
        plan: planWith("free", used, max),
        subject: "variants",
      });
    expect(at(8, 10)).toBeNull();
    expect(at(9, 10)?.kind).toBe("near");
    expect(at(9, 11)).toBeNull();
    expect(at(10, 11)?.kind).toBe("near");
    expect(at(2, 3)).toBeNull();
    expect(at(3, 3)?.kind).toBe("reached");
  });

  it("só o dono, em Free ou Free acima do limite, com a assinatura ligada e o plano lido", () => {
    for (const state of STATES) {
      const shown = state === "free" || state === "free_over_limit";
      expect(near("variants", 50, state) !== null).toBe(shown);
    }
    const base = {
      billingSelfService: true,
      canManageBilling: true,
      plan: planWith("free", 50),
      subject: "variants" as const,
    };
    expect(nearLimitFor({ ...base, billingSelfService: false })).toBeNull();
    expect(nearLimitFor({ ...base, canManageBilling: false })).toBeNull();
    expect(nearLimitFor({ ...base, plan: null })).toBeNull();
  });

  it("sem limite no plano, ou limite zero, não avisa", () => {
    for (const max of [null, 0]) {
      expect(
        nearLimitFor({
          billingSelfService: true,
          canManageBilling: true,
          plan: planWith("free", 5, max),
          subject: "images",
        })
      ).toBeNull();
    }
  });
});
