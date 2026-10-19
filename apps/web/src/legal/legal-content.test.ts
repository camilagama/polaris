import { CLOSURE_RECOVERY_WINDOW_DAYS } from "@polaris/domain/organization/closure";
import {
  EXPORT_VALIDITY_HOURS,
  MAX_EXPORTS_PER_DAY,
} from "@polaris/domain/privacy/data-export";
import {
  RETENTION_POLICIES,
  type RetentionClass,
} from "@polaris/domain/privacy/retention";
import { LEGAL_DOCUMENT_IDS } from "@polaris/domain/legal/legal-documents";
import { describe, expect, it } from "vitest";
import { currentLegalText } from "./legal-content";
import { type Block, type Inline, parseMarkdown } from "./markdown";

const privacy = currentLegalText("privacy");
const terms = currentLegalText("terms");
const DAY_MS = 86_400_000;
const periodInBold = /\*\*(\d+ (?:dia|dias|meses|anos))\*\*/g;
const outsideHttp = /https?:\/\//;
const sentenceEnd = /[.!?]$/;
const podemosApagar = /podemos apag|pode apag/;

/** The words of a text with the bold and the line breaks flattened, for the sentences below. */
const flat = (text: string) => text.replaceAll("**", "").replaceAll("\n", " ");

function periodLabel(retentionClass: RetentionClass): string {
  const policy = RETENTION_POLICIES.find(
    (item) => item.class === retentionClass
  );
  if (policy?.status !== "aprovada") {
    throw new Error(`${retentionClass} não tem prazo aprovado.`);
  }
  const { period } = policy;
  if (period.kind === "duration") {
    const days = period.ms / DAY_MS;
    return days === 1 ? "1 dia" : `${days} dias`;
  }
  if (period.kind === "calendar_months") {
    return `${period.months} meses`;
  }
  throw new Error(`${retentionClass} não tem prazo em dias ou meses.`);
}

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) =>
      node.kind === "bold" ? inlineText(node.children) : node.text
    )
    .join("");
}

function retentionRows(): Map<string, string> {
  const table = parseMarkdown(privacy).find(
    (block): block is Extract<Block, { kind: "table" }> =>
      block.kind === "table" && block.header[0] === "O que"
  );
  if (!table) {
    throw new Error("A tabela de prazos não está na política.");
  }
  return new Map(
    table.rows.map((row) => [
      inlineText(row[0] ?? []),
      inlineText(row[1] ?? []),
    ])
  );
}

describe("the periods the privacy policy cites (AC-7)", () => {
  const rows = retentionRows();
  const row = (start: string) => {
    const found = [...rows].find(([name]) => name.startsWith(start));
    if (!found) {
      throw new Error(`Sem linha "${start}" na tabela de prazos.`);
    }
    return found[1];
  };

  it.each([
    [
      "Código de verificação de entrada e arquivo de exportação",
      ["auth_verification", "data_exports"],
    ],
    ["Sessões", ["auth_sessions"]],
    [
      "Aparelhos revogados e registro de comandos offline",
      ["devices", "sync_commands"],
    ],
    ["Registro de acesso", ["auth_access_log"]],
    ["Auditoria de segurança", ["auth_security_audit"]],
  ] as const)("%s keeps the period of its retention class", (name, classes) => {
    for (const retentionClass of classes) {
      expect(row(name)).toContain(periodLabel(retentionClass));
    }
  });

  it("adds the 30 days of margin to the access log, as the registry does", () => {
    expect(row("Registro de acesso")).toContain("mais 30 dias de folga");
  });

  it("uses the closure windows and the export rules of the domain", () => {
    expect(row("Loja encerrada")).toContain("90 dias");
    expect(row("Loja encerrada")).toContain(
      `${CLOSURE_RECOVERY_WINDOW_DAYS} dias`
    );
    expect(row("Código de verificação")).toContain(
      `${EXPORT_VALIDITY_HOURS} horas`
    );
    expect(flat(privacy)).toContain(`vale ${EXPORT_VALIDITY_HOURS} horas`);
    expect(flat(privacy)).toContain("no máximo três pedidos em 24 horas");
    expect(MAX_EXPORTS_PER_DAY).toBe(3);
  });

  it("cites no other period than the approved ones", () => {
    const approved = new Set([
      "1 dia",
      "30 dias",
      "90 dias",
      "6 meses",
      "12 meses",
      "5 anos",
      "10 anos",
      // the provider's rotation of backups (ADR 0099), not a retention class of the registry
      "35 dias",
    ]);
    const cited = [...privacy.matchAll(periodInBold)].map((match) => match[1]);
    expect(cited.length).toBeGreaterThan(0);
    for (const period of cited) {
      expect(approved).toContain(period);
    }
  });

  it("says that legal hold suspends any deletion, in both texts", () => {
    expect(flat(privacy)).toContain("legal hold");
    expect(flat(privacy)).toContain("o apagamento fica suspenso");
    expect(flat(terms)).toContain("o apagamento fica suspenso");
  });
});

describe("the terms of use", () => {
  it("say, in their own sentences, that the tax record is the shop's duty (AC-8)", () => {
    const text = flat(terms);
    expect(text).toContain("A guarda fiscal é sua responsabilidade.");
    expect(text).toContain("Essa guarda é obrigação sua, não do Polaris.");
    expect(text).toContain("5 anos contados do primeiro dia do ano seguinte");
  });

  it("promise the deletion 90 days after closing only in the conditional form (AC-20)", () => {
    const text = flat(terms);
    expect(text).toContain(
      "A partir de 90 dias depois do encerramento, o Polaris pode apagar os dados do seu negócio."
    );
    expect(text).not.toContain("apaga automaticamente");
  });

  it("keep the promises the system does not keep yet in the conditional form (AC-20)", () => {
    const text = flat(terms);
    expect(text).toContain(
      "O pagamento por cartão (Asaas) ainda não está disponível."
    );
    expect(text).toContain(
      "A renovação do plano é cancelada no provedor de pagamento"
    );
    expect(text).toContain(
      "a tela avisa que a cobrança precisa ser cancelada lá"
    );
    expect(text).toContain("A tela avisa as datas ao encerrar.");
    expect(text).toContain(
      "O Polaris ainda não confere a fila antes de encerrar"
    );
  });

  it("count the 7 days of regret from the first charge (decision of 19/10/2026)", () => {
    expect(flat(terms)).toContain("7 dias depois da primeira cobrança");
  });

  it("name the supplier and the forum decided by the user", () => {
    const text = flat(terms);
    expect(text).toContain("Agência Summit");
    expect(text).toContain("CNPJ 35.584.467/0001-00");
    expect(text).toContain("Santarém, Pará");
    expect(text).toContain("foro de Santarém, Pará");
  });
});

describe("the privacy policy", () => {
  it("does not promise the card never reaches Polaris before that is proved (AC-23)", () => {
    const text = flat(privacy);
    expect(text).not.toContain("não passam pelo Polaris");
    expect(text).toContain("O pagamento por cartão ainda não está disponível");
  });

  it("marks the providers that are not on yet (AC-11)", () => {
    const text = flat(privacy);
    expect(text).toContain(
      "Resend (Estados Unidos, a confirmar no contrato), ainda não ligado"
    );
    expect(text).toContain("ainda não ligados: processam os pagamentos");
    expect(text).toContain(
      "Sentry (Estados Unidos, a confirmar), quando estiver ligado"
    );
  });

  it("says offline data is not encrypted and to revoke a lost device (AC-13)", () => {
    expect(flat(privacy)).toContain(
      "os dados guardados no aparelho não são cifrados"
    );
    expect(flat(privacy)).toContain("revogue um aparelho perdido");
    expect(flat(terms)).toContain("Essa cópia não é cifrada.");
    expect(flat(terms)).toContain("revogue um aparelho perdido");
  });
});

describe("both texts", () => {
  it.each(LEGAL_DOCUMENT_IDS)(
    "%s cites no outside address and no internal term",
    (document) => {
      const text = currentLegalText(document);
      expect(text).not.toMatch(outsideHttp);
      // V9 (UX review): the shopkeeper's text never names the Google identity document
      expect(text).not.toContain("idToken");
    }
  );

  it.each(LEGAL_DOCUMENT_IDS)(
    "%s parses with the restricted Markdown, a single h1 and h2 sections",
    (document) => {
      const headings = parseMarkdown(currentLegalText(document)).filter(
        (block) => block.kind === "heading"
      );
      expect(headings.filter((heading) => heading.level === 1)).toHaveLength(1);
      expect(headings[0]?.level).toBe(1);
      expect(new Set(headings.map((heading) => heading.id)).size).toBe(
        headings.length
      );
    }
  );

  it("keeps the numbered sections in order", () => {
    for (const document of LEGAL_DOCUMENT_IDS) {
      const numbers = parseMarkdown(currentLegalText(document))
        .filter(
          (block) =>
            block.kind === "heading" &&
            block.level === 2 &&
            block.id !== "o-essencial"
        )
        .map((block) =>
          block.kind === "heading" ? Number.parseInt(block.text, 10) : 0
        );
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    }
  });
});

describe("the essentials box (V5)", () => {
  const essentialItems = (document: (typeof LEGAL_DOCUMENT_IDS)[number]) => {
    const blocks = parseMarkdown(currentLegalText(document));
    const at = blocks.findIndex(
      (block) => block.kind === "heading" && block.id === "o-essencial"
    );
    const next = blocks.slice(at + 1);
    const end = next.findIndex((block) => block.kind === "heading");
    const list = next
      .slice(0, end === -1 ? undefined : end)
      .find((block) => block.kind === "list");
    if (at === -1 || list?.kind !== "list") {
      throw new Error(`${document}: o quadro "O essencial" não tem lista.`);
    }
    return list.items.map(inlineText);
  };

  it.each(LEGAL_DOCUMENT_IDS)(
    "%s opens with 4 to 6 one-sentence items",
    (document) => {
      const items = essentialItems(document);
      expect(items.length).toBeGreaterThanOrEqual(4);
      expect(items.length).toBeLessThanOrEqual(6);
      for (const item of items) {
        expect(item).toMatch(sentenceEnd);
      }
    }
  );

  it("says the same as the text about the periods and the shop's tax record, and no more", () => {
    for (const document of LEGAL_DOCUMENT_IDS) {
      const box = essentialItems(document).join(" ");
      expect(box).toContain("90 dias");
      expect(box).toContain("5 anos");
      expect(box).toContain("ainda não confere");
      // the conditional form of the text (AC-20): nothing is promised that the text does not promise
      expect(box).not.toContain("e-mail");
      // any deletion in the box is in the conditional form of the text ("podemos apagar")
      for (const item of essentialItems(document)) {
        if (item.includes("apag")) {
          expect(item).toMatch(podemosApagar);
        }
      }
    }
    expect(essentialItems("terms").join(" ")).toContain(
      "30 dias para desfazer"
    );
  });
});

describe("plain language (V4)", () => {
  it("writes the legal term in parentheses after the plain words, once", () => {
    const text = flat(privacy);
    expect(text).toContain("(identificador da requisição)");
    expect(text).toContain("(legítimo interesse, art. 7º, IX)");
    expect(text).toContain("(cláusulas-padrão contratuais,");
    expect(text).toContain("(anonimização)");
    for (const term of [
      "identificador da requisição",
      "legítimo interesse",
      "cláusulas-padrão",
      "anonimização",
    ]) {
      expect(text.split(term)).toHaveLength(2);
    }
  });

  it.each([
    ["LGPD", "Lei Geral de Proteção de Dados"],
    ["ANPD", "Autoridade Nacional de Proteção de Dados"],
  ])("spells %s out where it first appears (AC-15)", (acronym, name) => {
    const text = flat(privacy);
    const at = text.indexOf(acronym);
    expect(at).toBeGreaterThan(0);
    expect(text.slice(at - name.length - 2, at + acronym.length + 1)).toBe(
      `${name} (${acronym})`
    );
  });

  it("turns the long enumerations into lists", () => {
    const rights = parseMarkdown(privacy).filter(
      (block) => block.kind === "list"
    );
    expect(rights.some((block) => block.items.length === 7)).toBe(true);
    expect(
      parseMarkdown(terms).some(
        (block) => block.kind === "list" && block.items.length === 5
      )
    ).toBe(true);
  });
});
