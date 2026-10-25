import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BILLING_NOTICE_KINDS } from "@polaris/domain/billing/notices";
import type { PlanMethod } from "@polaris/domain/billing/plan-view";
import { describe, expect, it } from "vitest";
import { emailColors } from "../../email-colors.generated";
import {
  BILLING_NOTICE_EMAIL_KINDS,
  type BillingNoticeEmail,
  billingEmailFooter,
  billingNoticeContent,
  renderBillingNoticeEmail,
} from "./billing-notice-email";
import type { BillingEmailStore } from "./content";
import { subjectStore } from "./format";

const ORIGIN = "https://dash.exemplo.app";
const SUPPORT = "suporte@exemplo.app";
const SUBSCRIPTION_URL = `${ORIGIN}/subscription`;
const RE_PRO_BEGAN = /^O plano Pro começou na loja Loja Aurora\. /;
const RE_TRIAL_BEGAN =
  /^Seu teste grátis do plano Pro começou na loja Loja Aurora\. /;
const RE_D3 = /O pagamento ainda não foi confirmado\. Seu Pro continua até \d/;
const RE_IN_7_DAYS = /^Em 7 dias, \d/;
const RE_ENTITY = /&(amp|lt|gt|quot|#x27);/g;
const RE_DAY = /^\d{1,2}º? de [a-zç]+ de \d{4}$/;
const RE_1 = /oklch\(/i;
const RE_2 = /rgba?\(/i;
const RE_3 = /#[0-9a-fA-F]{3,8}\b/;
const RE_4 = /\.tsx?$/;
const RE_5 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RE_6 =
  /você cancelou|o banco|cancelamos|cancelado por|pelo banco|revogou/i;
const RE_7 = /desistir|valor de volta|arrependimento/i;
const RE_8 = /teste termina|o teste acaba|fim do teste/i;
const RE_9 = /\d+\s*(dias|dia|úteis)/i;
const RE_10 = /nenhuma nova cobrança/i;
const RE_11 = /\bPro\b/;
const RE_12 = /sem internet|offline/i;
const RE_13 = /carência|inadimplência|dunning|nota fiscal/i;
const RE_14 = /\b\d{4}[ -]\d{4}[ -]\d{4}\b/;
const RE_15 = /\d{13,19}/;
const RE_16 = /\d{3}\.\d{3}\.\d{3}-\d{2}/;
const RE_17 = /Polaris, um produto de .+, CNPJ /;
const RE_18 =
  /Polaris, um produto de .+, CNPJ \d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\./;
const RE_19 = /<!DOCTYPE[^>]*>/i;
const RE_20 = /[?#]|utm/i;
const RE_21 = /asaas|woovi/i;
const RE_22 = /cartão/;
const RE_23 = /\bpor \d+ dias?\b/;
const RE_24 = /-\d|\b0 dias?\b/;
const RE_25 = /^Falta 1 dia de Pro/;
const INVISIBLE = /[\u200B-\u200F\u00AD\u2060\uFEFF\u00A0]/g;
const LINE_BREAK = /[\r\n]/;

const STORE: BillingEmailStore = {
  appOrigin: ORIGIN,
  name: "Loja Aurora",
  timeZone: "America/Sao_Paulo",
};

const CARD_PHRASE = "no cartão que você cadastrou";
const PIX_PHRASE = "pelo Pix Automático que você autorizou no seu banco";

interface Case {
  email: BillingNoticeEmail;
  label: string;
  method: PlanMethod | null;
}

function cases(store: BillingEmailStore = STORE): Case[] {
  const list: Case[] = [];
  const add = (
    label: string,
    method: PlanMethod | null,
    email: BillingNoticeEmail
  ) => list.push({ email, label, method });
  for (const method of ["card", "pix_automatic"] as const) {
    add(`trial_started (${method})`, method, {
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: "2026-10-29",
      kind: "trial_started",
      method,
      store,
      today: "2026-10-22",
    });
    add(`trial_charge_eve (${method})`, method, {
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: "2026-10-29",
      kind: "trial_charge_eve",
      method,
      store,
    });
    add(`renewal_failed d0 (${method})`, method, {
      accessEndsAt: new Date("2026-11-05T15:00:00.000Z"),
      amount: "24.90",
      kind: "renewal_failed",
      method,
      milestone: "d0",
      store,
    });
    add(`charge_receipt first (${method})`, method, {
      amount: "24.90",
      kind: "charge_receipt",
      method,
      paidAt: new Date("2026-10-29T15:00:00.000Z"),
      periodEndsAt: new Date("2026-11-29T15:00:00.000Z"),
      refundUntil: new Date("2026-11-05T15:00:00.000Z"),
      store,
    });
    add(`charge_receipt renewal (${method})`, method, {
      amount: "24.90",
      kind: "charge_receipt",
      method,
      paidAt: new Date("2026-11-29T15:00:00.000Z"),
      periodEndsAt: new Date("2026-12-29T15:00:00.000Z"),
      refundUntil: null,
      store,
    });
    add(`annual_renewal_reminder (${method})`, method, {
      amount: "249.00",
      chargeOn: "2027-10-29",
      kind: "annual_renewal_reminder",
      method,
      store,
    });
  }
  add("first_charge_failed", null, {
    amount: "24.90",
    cycleMonths: 1,
    kind: "first_charge_failed",
    store,
  });
  for (const milestone of ["d3", "dlast"] as const) {
    add(`renewal_failed ${milestone}`, null, {
      accessEndsAt: new Date("2026-11-01T15:00:00.000Z"),
      kind: "renewal_failed",
      milestone,
      store,
      today: "2026-10-29",
    });
  }
  add("access_ended", null, {
    endedAt: new Date("2026-10-29T15:00:00.000Z"),
    kind: "access_ended",
    overLimit: null,
    store,
  });
  add("access_ended over limit", null, {
    endedAt: new Date("2026-10-29T15:00:00.000Z"),
    kind: "access_ended",
    overLimit: {
      chooseUntil: new Date("2026-11-05T14:00:00.000Z"),
      limit: 50,
      variants: 73,
    },
    store,
  });
  for (const phase of ["trial", "pro"] as const) {
    add(`renewal_cancelled ${phase}`, null, {
      accessEndsAt: new Date("2026-10-30T15:00:00.000Z"),
      kind: "renewal_cancelled",
      phase,
      store,
    });
  }
  add("refund_confirmed", null, {
    amount: "24.90",
    kind: "refund_confirmed",
    store,
  });
  add("welcome", null, { kind: "welcome", store });
  return list;
}

const ALL = cases();

interface Rendered {
  html: string;
  subject: string;
  text: string;
}

async function renderAll(
  list: Case[] = ALL
): Promise<Array<Case & { out: Rendered }>> {
  return await Promise.all(
    list.map(async (item) => ({
      ...item,
      out: await renderBillingNoticeEmail(item.email, SUPPORT),
    }))
  );
}

function kindCase(label: string, store?: BillingEmailStore): Case {
  const found = cases(store).find((item) => item.label === label);
  if (!found) {
    throw new Error(`no fixture ${label}`);
  }
  return found;
}

function bodyOf(email: BillingNoticeEmail): string {
  const content = billingNoticeContent(email);
  return [content.heading, ...content.paragraphs].join("\n");
}

function flat(value: string): string {
  return value.replaceAll(/\s+/g, " ");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "#x27": "'",
  amp: "&",
  gt: ">",
  lt: "<",
  quot: '"',
};

// the visible text of the HTML: no comments, no tags, entities decoded once, the preview's invisible padding gone
function htmlText(html: string): string {
  let text = "";
  let at = 0;
  while (at < html.length) {
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      at = end < 0 ? html.length : end + 3;
    } else if (html[at] === "<") {
      const end = html.indexOf(">", at + 1);
      at = end < 0 ? html.length : end + 1;
      text += " ";
    } else {
      text += html[at];
      at += 1;
    }
  }
  return flat(
    text
      .replaceAll(RE_ENTITY, (entity, name: string) => ENTITIES[name] ?? entity)
      .replaceAll(INVISIBLE, " ")
  );
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

function withStore(name: string, timeZone = STORE.timeZone) {
  return { ...STORE, name, timeZone };
}

describe("the kinds of billing e-mail", () => {
  it("are the kinds of the domain, each with content", () => {
    expect([...BILLING_NOTICE_EMAIL_KINDS].sort()).toEqual(
      [...BILLING_NOTICE_KINDS].sort()
    );
    for (const kind of BILLING_NOTICE_KINDS) {
      const item = ALL.find((candidate) => candidate.email.kind === kind);
      expect(item, `fixture for ${kind}`).toBeDefined();
      const content = billingNoticeContent((item as Case).email);
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.heading.length).toBeGreaterThan(0);
      expect(content.preview.length).toBeGreaterThan(0);
      expect(content.paragraphs.length).toBeGreaterThan(0);
    }
  });

  it("refuses a kind it does not know", () => {
    expect(() =>
      billingNoticeContent({ kind: "nope" } as unknown as BillingNoticeEmail)
    ).toThrow("billing_notice_kind_unknown");
  });
});

describe("the amounts and the cycle", () => {
  it("writes 24.90 as R$ 24,90 where the text of the corte puts the amount", () => {
    const wanted = [
      "trial_started (card)",
      "trial_charge_eve (card)",
      "renewal_failed d0 (pix_automatic)",
      "charge_receipt first (card)",
      "charge_receipt renewal (pix_automatic)",
      "first_charge_failed",
      "refund_confirmed",
    ];
    for (const label of wanted) {
      expect(bodyOf(kindCase(label).email), label).toContain("R$ 24,90");
    }
    expect(
      billingNoticeContent(kindCase("trial_charge_eve (card)").email).subject
    ).toBe("Amanhã o Polaris Pro será cobrado: R$ 24,90");
    expect(
      billingNoticeContent(kindCase("refund_confirmed").email).subject
    ).toBe("Devolução do Polaris Pro: R$ 24,90");
  });

  it("says per month for the monthly cycle and per year for the yearly one", () => {
    const monthly = bodyOf(kindCase("trial_started (card)").email);
    expect(monthly).toContain("R$ 24,90 por mês");
    const yearly = bodyOf({
      ...(kindCase("trial_started (card)").email as BillingNoticeEmail & {
        kind: "trial_started";
      }),
      amount: "249.00",
      cycleMonths: 12,
    });
    expect(yearly).toContain("R$ 249,00 por ano");
    expect(yearly).not.toContain("por mês");
    expect(bodyOf(kindCase("annual_renewal_reminder (card)").email)).toContain(
      "R$ 249,00 por ano"
    );
    expect(bodyOf(kindCase("first_charge_failed").email)).toContain(
      "R$ 24,90 por mês"
    );
  });
});

describe("the dates", () => {
  // 04:30 UTC on the 29th: still the 28th in Rio Branco (UTC-5), already the 29th in Sao Paulo (UTC-3) and Manaus (UTC-4)
  // 03:30 UTC on the 29th: the 28th in Manaus and Rio Branco, the 29th in Sao Paulo
  const paidAt = (iso: string, timeZone: string) =>
    bodyOf({
      ...(kindCase("charge_receipt renewal (card)")
        .email as BillingNoticeEmail & {
        kind: "charge_receipt";
      }),
      paidAt: new Date(iso),
      store: withStore("Loja Aurora", timeZone),
    });

  it("are written in the store's time zone, never in UTC", () => {
    const early = "2026-10-29T03:30:00.000Z";
    expect(paidAt(early, "America/Sao_Paulo")).toContain(
      "em 29 de outubro de 2026"
    );
    expect(paidAt(early, "America/Manaus")).toContain(
      "em 28 de outubro de 2026"
    );
    expect(paidAt(early, "America/Rio_Branco")).toContain(
      "em 28 de outubro de 2026"
    );
    const later = "2026-10-29T04:30:00.000Z";
    expect(paidAt(later, "America/Sao_Paulo")).toContain(
      "em 29 de outubro de 2026"
    );
    expect(paidAt(later, "America/Manaus")).toContain(
      "em 29 de outubro de 2026"
    );
    expect(paidAt(later, "America/Rio_Branco")).toContain(
      "em 28 de outubro de 2026"
    );
    expect(paidAt(later, "America/Rio_Branco")).not.toContain(
      "em 29 de outubro de 2026"
    );
  });

  it("writes the last day of the access, not the day after, when it ends at midnight of the store", () => {
    const body = bodyOf({
      ...(kindCase("renewal_cancelled pro").email as BillingNoticeEmail & {
        kind: "renewal_cancelled";
      }),
      accessEndsAt: new Date("2026-10-30T03:00:00.000Z"),
    });
    expect(body).toContain("Seu Pro continua até 29 de outubro de 2026,");
  });

  it("uses the format 29 de outubro de 2026 for a calendar day", () => {
    expect(bodyOf(kindCase("trial_charge_eve (card)").email)).toContain(
      "Amanhã, 29 de outubro de 2026,"
    );
  });

  it("writes the first of the month as 1º, and no other day", () => {
    const first = bodyOf({
      ...(kindCase("annual_renewal_reminder (card)")
        .email as BillingNoticeEmail & {
        kind: "annual_renewal_reminder";
      }),
      chargeOn: "2027-12-01",
    });
    expect(first).toContain("Em 7 dias, 1º de dezembro de 2027,");
    const receipt = bodyOf({
      ...(kindCase("charge_receipt renewal (card)")
        .email as BillingNoticeEmail & {
        kind: "charge_receipt";
      }),
      paidAt: new Date("2026-11-01T15:00:00.000Z"),
    });
    expect(receipt).toContain("em 1º de novembro de 2026");
    expect(bodyOf(kindCase("trial_charge_eve (card)").email)).not.toContain(
      "1º"
    );
  });
});

describe("singular and plural", () => {
  const failed = (accessEndsAt: string, today: string) =>
    billingNoticeContent({
      ...(kindCase("renewal_failed d3").email as BillingNoticeEmail & {
        kind: "renewal_failed";
        milestone: "d3";
      }),
      accessEndsAt: new Date(accessEndsAt),
      today,
    });

  it("says Falta 1 dia with one day left and Faltam 4 dias with four (an access ends at midnight in São Paulo)", () => {
    const one = failed("2026-10-30T03:00:00.000Z", "2026-10-29");
    expect(one.subject).toBe("Falta 1 dia de Pro na loja Loja Aurora");
    expect(one.heading).toBe("Falta 1 dia de Pro na loja Loja Aurora");
    const four = failed("2026-11-02T03:00:00.000Z", "2026-10-29");
    expect(four.subject).toBe("Faltam 4 dias de Pro na loja Loja Aurora");
  });

  it("never says 0 days or a negative number, and the minimum is 1", () => {
    for (const [endsAt, today] of [
      ["2026-10-29T15:00:00.000Z", "2026-10-29"],
      ["2026-10-28T15:00:00.000Z", "2026-10-29"],
      ["2026-10-20T15:00:00.000Z", "2026-10-29"],
    ] as const) {
      const content = failed(endsAt, today);
      expect(content.subject).toMatch(RE_25);
      expect(content.subject).not.toMatch(RE_24);
    }
  });

  const started = (firstChargeOn: string) =>
    billingNoticeContent({
      ...(kindCase("trial_started (card)").email as BillingNoticeEmail & {
        kind: "trial_started";
      }),
      firstChargeOn,
      today: "2026-10-22",
    });

  it("says 7 dias and 1 dia in the start of the trial", () => {
    const seven = started("2026-10-29");
    expect(seven.preview).toBe("Você tem 7 dias de Pro na loja Loja Aurora.");
    expect(seven.paragraphs.join(" ")).toContain(
      "Você usa tudo o que o Pro tem por 7 dias."
    );
    const one = started("2026-10-23");
    expect(one.preview).toBe("Você tem 1 dia de Pro na loja Loja Aurora.");
    expect(one.paragraphs.join(" ")).toContain("tem por 1 dia.");
    expect(one.paragraphs.join(" ")).not.toContain("1 dias");
  });

  it("says hoje, and promises no days, when the first charge is today", () => {
    const today = started("2026-10-22");
    const text = [today.preview, ...today.paragraphs].join(" ");
    expect(today.preview).toBe(
      "A primeira cobrança da loja Loja Aurora é hoje."
    );
    expect(text).toContain("é hoje, 22 de outubro de 2026,");
    expect(text).not.toContain("Você usa tudo o que o Pro tem por");
    expect(text).not.toContain("Você tem");
    expect(text).not.toMatch(RE_23);
  });

  it("says the Pro began, with no trial, when the first charge is today (T329-1)", () => {
    const today = started("2026-10-22");
    expect(today.subject).toBe("Seu Polaris Pro começou");
    expect(today.heading).toBe("Seu Polaris Pro começou");
    expect(today.paragraphs[0]).toMatch(RE_PRO_BEGAN);
    expect(today.paragraphs.join(" ")).not.toContain("teste");
    const later = started("2026-10-29");
    expect(later.subject).toBe("Seu teste do Polaris Pro começou");
    expect(later.paragraphs[0]).toMatch(RE_TRIAL_BEGAN);
  });
});

describe("the method", () => {
  it("says the card phrase for card and the Pix phrase for Pix, never both", () => {
    for (const item of ALL) {
      const body = bodyOf(item.email);
      if (item.method === "card") {
        const isReceipt = item.email.kind === "charge_receipt";
        expect(body, item.label).toContain(
          isReceipt ? "pelo cartão" : CARD_PHRASE
        );
        expect(body, item.label).not.toContain("Pix");
      }
      if (item.method === "pix_automatic") {
        const isReceipt = item.email.kind === "charge_receipt";
        expect(body, item.label).toContain(
          isReceipt ? "pelo Pix Automático" : PIX_PHRASE
        );
        expect(body, item.label).not.toMatch(RE_22);
      }
    }
  });

  it("keeps the receipt short: pelo cartão and pelo Pix Automático, without the long phrases", () => {
    const card = bodyOf(kindCase("charge_receipt first (card)").email);
    expect(card).toContain(
      "R$ 24,90 do plano Pro da loja Loja Aurora, pelo cartão,"
    );
    expect(card).not.toContain(CARD_PHRASE);
    const pix = bodyOf(
      kindCase("charge_receipt renewal (pix_automatic)").email
    );
    expect(pix).toContain("pelo Pix Automático,");
    expect(pix).not.toContain("autorizou");
  });

  it("never names the provider", async () => {
    for (const item of await renderAll()) {
      for (const part of [item.out.html, item.out.text, item.out.subject]) {
        expect(part, item.label).not.toMatch(RE_21);
      }
    }
  });
});

describe("the links", () => {
  it("lead every billing e-mail to the subscription screen, with no query, hash or tracking", async () => {
    for (const item of await renderAll()) {
      const links = hrefs(item.out.html);
      const wanted =
        item.email.kind === "welcome" ? `${ORIGIN}/products` : SUBSCRIPTION_URL;
      expect(links, item.label).toContain(wanted);
      for (const link of links) {
        expect(link, item.label).not.toMatch(RE_20);
        expect(link.startsWith(`${ORIGIN}/`), item.label).toBe(true);
      }
    }
  });

  it("ignores the path and query of the origin it is given", async () => {
    const message = await renderBillingNoticeEmail(
      {
        ...(kindCase("refund_confirmed").email as BillingNoticeEmail & {
          kind: "refund_confirmed";
        }),
        store: { ...STORE, appOrigin: `${ORIGIN}/algum/caminho?x=1#y` },
      },
      SUPPORT
    );
    expect(hrefs(message.html)).toEqual([SUBSCRIPTION_URL]);
    expect(message.html).not.toContain("x=1");
    expect(message.text).not.toContain("x=1");
  });

  it("writes the address in full in the line below the button, in the HTML and in the plain text", async () => {
    for (const item of await renderAll()) {
      const url =
        item.email.kind === "welcome" ? `${ORIGIN}/products` : SUBSCRIPTION_URL;
      const line = `Se o botão não funcionar, abra este endereço: ${url}`;
      expect(htmlText(item.out.html), item.label).toContain(line);
      expect(flat(item.out.text), item.label).toContain(line);
    }
  });

  it("tells the variants over the limit only with the store over it, with one button to Assinatura", async () => {
    const [plain, over] = await renderAll([
      kindCase("access_ended"),
      kindCase("access_ended over limit"),
    ]);
    for (const part of [plain?.out.html, plain?.out.text]) {
      expect(part).not.toContain("variantes");
    }
    const html = htmlText(over?.out.html ?? "");
    const text = flat(over?.out.text ?? "");
    for (const part of [html, text]) {
      // the screen of the choice does not exist yet: no button to it (Petković, 24/10)
      expect(part).not.toContain("Escolher as variantes");
      expect(part).toContain(
        "A loja tem 73 variantes e o plano Free permite 50."
      );
      expect(part).toContain("até 5 de novembro de 2026");
      expect(part).toContain("Abra Assinatura para ver o prazo.");
    }
    expect(hrefs(over?.out.html ?? "")).toEqual([SUBSCRIPTION_URL]);
    expect(flat(over?.out.text ?? "")).toContain(
      `Se o botão não funcionar, abra este endereço: ${SUBSCRIPTION_URL}`
    );
  });
});

describe("the texts of the review of 24/10 (Petković, 20:31)", () => {
  it("opens the receipt with three lines: the amount, the day and the store (T329-3)", async () => {
    const content = billingNoticeContent(
      kindCase("charge_receipt first (card)").email
    );
    expect(content.summary).toEqual([
      { label: "Valor", value: "R$ 24,90" },
      { label: "Data", value: expect.stringMatching(RE_DAY) },
      { label: "Loja", value: "Loja Aurora" },
    ]);
    const [item] = await renderAll([kindCase("charge_receipt first (card)")]);
    const text = flat(item?.out.text ?? "");
    const html = htmlText(item?.out.html ?? "");
    for (const part of [text, html]) {
      const block = part.indexOf("Valor: R$ 24,90");
      expect(block, part).toBeGreaterThan(-1);
      expect(part.indexOf("Loja: Loja Aurora")).toBeGreaterThan(block);
      expect(part.indexOf("Recebemos R$ 24,90")).toBeGreaterThan(block);
    }
    for (const kind of cases()) {
      if (!kind.label.startsWith("charge_receipt")) {
        expect(billingNoticeContent(kind.email).summary, kind.label).toBeNull();
      }
    }
  });

  it("says the payment is still not confirmed on the 3rd day of the grace", () => {
    expect(bodyOf(kindCase("renewal_failed d3").email)).toMatch(RE_D3);
  });

  it("says the next subscription is charged the same day after a first charge that failed (T329-4)", () => {
    expect(bodyOf(kindCase("first_charge_failed").email)).toContain(
      "então a próxima assinatura é cobrada no mesmo dia."
    );
  });

  it("announces the yearly renewal 7 days ahead, in the body and in the preview", () => {
    const content = billingNoticeContent(
      kindCase("annual_renewal_reminder (card)").email
    );
    expect(content.paragraphs[0]).toMatch(RE_IN_7_DAYS);
    expect(content.preview).toBe(
      "A renovação anual da loja Loja Aurora é em 7 dias."
    );
  });

  it("keeps the right of withdrawal in the eve of the first charge", () => {
    expect(bodyOf(kindCase("trial_charge_eve (card)").email)).toContain(
      "Depois da cobrança você ainda pode desistir em até 7 dias e receber o valor de volta."
    );
  });
});

describe("the subject", () => {
  const longName = "Loja ".repeat(60).trim();

  it("has at most 60 characters for every kind with a store name of 300 characters", async () => {
    expect(longName.length).toBeGreaterThanOrEqual(299);
    for (const item of await renderAll(cases(withStore(longName)))) {
      expect(
        Array.from(item.out.subject).length,
        `${item.label}: ${item.out.subject}`
      ).toBeLessThanOrEqual(60);
    }
  });

  it("cuts the name at 24 characters and an ellipsis, and keeps the whole name in the body", async () => {
    const [item] = await renderAll([
      {
        ...kindCase("access_ended"),
        email: {
          ...(kindCase("access_ended").email as BillingNoticeEmail & {
            kind: "access_ended";
          }),
          store: withStore(longName),
        },
      },
    ]);
    expect(item?.out.subject).toBe(
      `A loja ${Array.from(longName).slice(0, 24).join("").trimEnd()}… voltou ao plano Free`
    );
    expect(item?.out.text).toContain(longName);
    expect(htmlText(item?.out.html ?? "")).toContain(longName);
  });

  it("keeps a name of 24 characters whole", () => {
    const name = "Abcdefghijklmnopqrstuvwx";
    expect(name).toHaveLength(24);
    expect(
      billingNoticeContent({
        endedAt: new Date("2026-10-29T15:00:00.000Z"),
        kind: "access_ended",
        overLimit: null,
        store: withStore(name),
      }).subject
    ).toBe(`A loja ${name} voltou ao plano Free`);
  });

  it("stays on one line and escapes a name with script, a line break and an emoji", async () => {
    const name = "<script>alert(1)</script>\n\u{1F600} Loja";
    const items = await renderAll(cases(withStore(name)));
    for (const item of items) {
      expect(item.out.subject, item.label).not.toMatch(LINE_BREAK);
      expect(item.out.html, item.label).not.toContain("<script>");
      expect(
        Array.from(item.out.subject).length,
        item.label
      ).toBeLessThanOrEqual(60);
    }
    const withName = items.filter((item) =>
      billingNoticeContent(item.email).paragraphs.join(" ").includes("Loja")
    );
    expect(withName.length).toBeGreaterThan(0);
    expect(items.some((item) => item.out.html.includes("&lt;script&gt;"))).toBe(
      true
    );
  });
});

describe("the form of the message", () => {
  it("has no image, no background, no url() and no address outside the app", async () => {
    for (const item of await renderAll()) {
      const { html } = item.out;
      expect(html, item.label).not.toContain("<img");
      expect(html, item.label).not.toContain("background-image");
      expect(html, item.label).not.toContain("url(");
      // the doctype's public identifier is not an address the message loads or links to
      const withoutDoctype = html.replace(RE_19, "");
      const addresses = withoutDoctype.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
      for (const address of addresses) {
        expect(new URL(address).origin, `${item.label}: ${address}`).toBe(
          new URL(ORIGIN).origin
        );
      }
    }
  });

  it("is in pt-BR, with the HTML and the plain text, and the paragraphs in the text", async () => {
    for (const item of await renderAll()) {
      expect(item.out.html, item.label).toContain('lang="pt-BR"');
      expect(item.out.html.length, item.label).toBeGreaterThan(0);
      expect(item.out.text.length, item.label).toBeGreaterThan(0);
      expect(item.out.text, item.label).not.toContain("<");
      const content = billingNoticeContent(item.email);
      const text = flat(item.out.text);
      for (const paragraph of content.paragraphs) {
        expect(text, item.label).toContain(flat(paragraph));
      }
    }
  });

  it("closes a billing e-mail with the automatic notice, the support line and the supplier", async () => {
    const lines = [
      "Este é um aviso automático sobre a sua assinatura. O Polaris nunca pede a sua senha por e-mail.",
      `Dúvidas: responda este e-mail ou escreva para ${SUPPORT}.`,
    ];
    for (const item of await renderAll()) {
      if (item.email.kind === "welcome") {
        continue;
      }
      const html = htmlText(item.out.html);
      const text = flat(item.out.text);
      for (const line of lines) {
        expect(html, item.label).toContain(line);
        expect(text, item.label).toContain(line);
      }
      expect(html, item.label).toMatch(RE_18);
      expect(text, item.label).toMatch(RE_18);
    }
  });

  it("gives the welcome its own footer, with no mention of a subscription", async () => {
    const [welcome] = await renderAll([kindCase("welcome")]);
    const text = flat(welcome?.out.text ?? "");
    expect(text).toContain(
      "Este é um e-mail automático do Polaris. O Polaris nunca pede a sua senha por e-mail."
    );
    expect(text).toContain(
      `Dúvidas: responda este e-mail ou escreva para ${SUPPORT}.`
    );
    expect(text).toMatch(RE_17);
    expect(text).not.toContain("assinatura");
    expect(htmlText(welcome?.out.html ?? "")).not.toContain("assinatura");
  });

  it("builds the footer lines from the kind of footer and the support address", () => {
    const subscription = billingEmailFooter("subscription", SUPPORT);
    expect(subscription).toHaveLength(3);
    expect(subscription[0]).toContain("sobre a sua assinatura");
    expect(subscription[1]).toBe(
      `Dúvidas: responda este e-mail ou escreva para ${SUPPORT}.`
    );
    expect(billingEmailFooter("welcome", SUPPORT)[0]).not.toContain(
      "assinatura"
    );
  });
});

describe("what the text must never say", () => {
  const PAYER_PATTERNS = [RE_16, RE_15, RE_14];

  it("has no forbidden word, no CPF and no card number, in any kind", async () => {
    for (const item of await renderAll()) {
      const everything = [
        item.out.subject,
        item.out.text,
        htmlText(item.out.html),
      ].join("\n");
      expect(everything, item.label).not.toMatch(RE_13);
      for (const pattern of PAYER_PATTERNS) {
        expect(everything, `${item.label} ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not promise selling without internet, nor sell the Pro, in the welcome", async () => {
    const [welcome] = await renderAll([kindCase("welcome")]);
    const everything = [welcome?.out.subject, welcome?.out.text].join("\n");
    expect(everything).not.toMatch(RE_12);
    expect(everything).not.toMatch(RE_11);
    expect(everything).toContain("O plano Free não pede forma de pagamento.");
  });

  it("does not say Nenhuma nova cobrança, nor a number of days for the refund to come back", () => {
    const body = bodyOf(kindCase("refund_confirmed").email);
    expect(body).not.toMatch(RE_10);
    expect(body).not.toMatch(RE_9);
    expect(body).toContain(
      "O valor volta para o mesmo meio de pagamento, no prazo do banco ou da operadora do cartão."
    );
    expect(body).toContain("O Pro terminou agora e a loja está no plano Free.");
  });

  it("talks of the first charge in the eve, never of the end of the trial", () => {
    const content = billingNoticeContent(
      kindCase("trial_charge_eve (card)").email
    );
    const everything = [
      content.subject,
      content.preview,
      content.heading,
      ...content.paragraphs,
    ].join("\n");
    expect(everything).not.toMatch(RE_8);
    expect(content.preview).toBe(
      "A primeira cobrança da loja Loja Aurora é amanhã."
    );
  });

  it("gives the right of withdrawal, with its last day, only in the receipt of the first charge", () => {
    const first = bodyOf(kindCase("charge_receipt first (card)").email);
    expect(first).toContain(
      "Você pode desistir em até 7 dias depois desta cobrança, até 5 de novembro de 2026, e receber o valor de volta: abra Assinatura."
    );
    expect(first).toContain("Este e-mail é o comprovante do pagamento.");
    const renewal = bodyOf(kindCase("charge_receipt renewal (card)").email);
    expect(renewal).not.toMatch(RE_7);
    expect(renewal).toContain("Recebemos R$ 24,90 da renovação do plano Pro");
    expect(renewal).toContain("Este e-mail é o comprovante do pagamento.");
  });

  it("never says who cancelled the renewal", () => {
    for (const label of ["renewal_cancelled trial", "renewal_cancelled pro"]) {
      const body = bodyOf(kindCase(label).email);
      expect(body, label).not.toMatch(RE_6);
      expect(body, label).toContain("A renovação do plano Pro da loja");
      expect(body, label).toContain(
        "Se você não reconhece este cancelamento, entre na conta e confira o acesso à loja."
      );
      expect(body, label).toContain("seus dados e seu histórico ficam");
    }
    const trial = bodyOf(kindCase("renewal_cancelled trial").email);
    expect(trial).toContain("nada será cobrado");
    expect(trial).toContain("O teste grátis vale uma vez por pessoa");
    const pro = bodyOf(kindCase("renewal_cancelled pro").email);
    expect(pro).toContain("o fim do que você já pagou");
    expect(pro).toContain(
      "Se mudar de ideia, dá para assinar de novo a partir de 30 de outubro de 2026."
    );
    expect(pro).not.toContain("espere essa data");
  });
});

describe("determinism", () => {
  it("renders the same e-mail twice with the same HTML, text and subject", async () => {
    const rendered = await Promise.all(
      ALL.map(async (item) => ({
        first: await renderBillingNoticeEmail(item.email, SUPPORT),
        item,
        second: await renderBillingNoticeEmail(item.email, SUPPORT),
      }))
    );
    for (const { first, item, second } of rendered) {
      expect(second, item.label).toEqual(first);
    }
  });
});

describe("the colors", () => {
  function channel(value: number): number {
    const unit = value / 255;
    return unit <= 0.039_28 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }
  function luminance(hex: string): number {
    const match = RE_5.exec(hex);
    if (!match) {
      throw new Error(`not a hex color: ${hex}`);
    }
    const [r, g, b] = [match[1], match[2], match[3]].map((part) =>
      channel(Number.parseInt(part as string, 16))
    ) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort(
      (x, y) => y - x
    ) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  }

  it("passes the contrast AA (4.5) for the text, the muted text and the button", () => {
    expect(
      contrast(emailColors.foreground, emailColors.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(emailColors.mutedForeground, emailColors.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(emailColors.primaryForeground, emailColors.primary)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("measures the contrast as WCAG does (black on white is 21)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("has no literal color in the models: they come from emailColors", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(directory).filter(
      (name) => RE_4.test(name) && !name.includes(".test.")
    );
    expect(files.length).toBeGreaterThanOrEqual(13);
    for (const name of files) {
      const source = readFileSync(`${directory}${name}`, "utf8");
      expect(source, name).not.toMatch(RE_3);
      expect(source, name).not.toMatch(RE_2);
      expect(source, name).not.toMatch(RE_1);
    }
  });
});

describe("the store's name in the subject, by grapheme", () => {
  it("never cuts an emoji made of several code points in half", () => {
    // 23 letters, then a family emoji (several code points joined) as the 24th character
    const name = `${"a".repeat(23)}👨‍👩‍👧 e mais`;
    const subject = subjectStore(name);
    expect(subject).toBe(`${"a".repeat(23)}👨‍👩‍👧…`);
  });
});
