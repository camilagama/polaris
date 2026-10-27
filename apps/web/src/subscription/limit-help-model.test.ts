import { describe, expect, it } from "vitest";
import {
  isLimitReached,
  LIMIT_ASK_OWNER,
  type LimitSubject,
  limitHelpFor,
  limitUsageText,
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
