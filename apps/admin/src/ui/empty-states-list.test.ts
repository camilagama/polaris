import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringLiteralsAt } from "./visible-text";

/**
 * Every empty state of the Admin says what to do or where to go, in the same sentence or the next line, with a link
 * when the destination is in the menu (AC-CL1). The list of the texts that start like an empty state lives here, and
 * `ui/empty-next-step.test.ts` proves the ones in `WITH_NEXT_STEP` in the DOM: a new one fails until it is put in the right group, and a text that says only what is missing cannot go in "next step".
 */

const EMPTY_START = /^(Nenhum|Nenhuma|Nada|Sem)(?![\p{L}])/u;
const TEST_HELPER = /(^|\/)test-[a-z-]+\.ts$/;
const SHOWN_LENGTH = 70;

/** The empty states the screens of this change complete; each one is proved in the DOM below. */
const WITH_NEXT_STEP = [
  "views/case.ts | Nada registrado ainda. Cada ação feita neste atendimento aparece aqui.",
  "views/case.ts | Nenhum acesso temporário neste atendimento. ",
  "views/cases.ts | Nenhum atendimento aberto.",
  "views/cases.ts | Nenhum atendimento fechado.",
  "views/cases.ts | Nenhuma loja começa com esse nome. Tente menos letras do início do nome ou deixe o campo vazio para ver os atendimentos de todas as lojas.",
  "views/home.ts | Nada esperando por você. ",
  "views/legal-holds.ts | Nenhuma loja com trava legal.",
  "views/organizations.ts | Nenhuma loja encontrada.",
  "views/privacy-case.ts | Nada registrado ainda. Cada etapa registrada neste atendimento aparece aqui.",
  "views/privacy-cases.ts | Nenhum atendimento de privacidade aberto.",
  "views/privacy-cases.ts | Nenhum atendimento de privacidade fechado.",
  "views/purge.ts | Nenhuma trava legal vigente. A loja já foi apagada: não há o que travar.",
  "views/purge.ts | Nenhuma trava legal vigente. Para pôr uma, use Pôr trava legal, abaixo.",
];

/** The good news: nothing to do is the answer, so nothing is added. */
const GOOD_NEWS = [
  "views/access-log.ts | Nenhum acesso encontrado nesse período. O registro pode ter lacunas: isto não prova que não houve acesso.",
  "views/incidents.ts | Nenhuma falha de envio. Tudo foi entregue.",
];

/** Empty states that already say what to do. */
const ALREADY_GUIDED = [
  "views/new-case.ts | Sem permissão para buscar loja: abra o atendimento pela tela da loja.",
  "views/privacy-new.ts | Sem permissão para buscar loja: abra o atendimento pela tela da loja.",
  "views/support-case.ts | Nenhum atendimento aberto desta loja. Abra um atendimento para ler a cobrança.",
];

/**
 * Empty states of screens left for the next pass (the task stops at eight files of production code): each one still
 * says only what is missing. A task that gives one its next step moves it to `WITH_NEXT_STEP` and proves it.
 */
const PENDING_NEXT_STEP = [
  "refund-words.ts | Nada a fazer aqui na cobrança desta loja.",
  "refund-words.ts | Nenhuma cobrança a reembolsar.",
  "views/diagnostics.ts | Nenhum aviso automático nesta loja.",
  "views/diagnostics.ts | Nenhum recurso está acima do plano por liberação temporária agora.",
  "views/diagnostics.ts | Nenhuma liberação temporária.",
  "views/entitlements.ts | Nenhuma liberação temporária em vigor.",
  "views/incident.ts | Nenhum evento sem entrega nesta falha de envio.",
  "views/new-case.ts | Nenhuma loja escolhida.",
  "views/privacy-new.ts | Nenhuma loja escolhida.",
  "views/refund-window.ts | Sem primeira cobrança: não há janela de arrependimento.",
  "views/store.ts | Nenhum atendimento aberto desta loja.",
];

/** Outcomes, refusals, values of a fact and labels: they start like an empty state but are not one. */
const NOT_AN_EMPTY_STATE = [
  "api.ts | Sem permissão para isto.",
  "privacy.ts | Nada a fazer",
  "views/access.ts | Nada foi encerrado: o acesso já tinha acabado.",
  "views/case.ts | Sem resolução escrita.",
  "views/case.ts | Sem resolução escrita.",
  "views/diagnostics.ts | Sem assinatura paga.",
  "views/diagnostics.ts | Sem cancelamento pedido",
  "views/entitlements.ts | Nada foi encerrado.",
  "views/entitlements.ts | Sem como encerrar por aqui",
  "views/funnel.ts | Sem venda",
  "views/incident.ts | Nenhum",
  "views/privacy-case.ts | Sem nota.",
  "views/purge.ts | Nada mudou: a trava já estava vigente com uma data de revisão igual ou mais tarde.",
  "views/refund-window.ts | Nenhum",
  "views/refund-window.ts | Sem permissão para ler a cobrança.",
  "views/store-actions.ts | Nada mudou: já era assim. ",
  "views/store-actions.ts | Nada mudou: a situação da loja é ",
];

const ui = fileURLToPath(new URL("../../ui", import.meta.url));

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourcesUnder(path);
    }
    return path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !TEST_HELPER.test(path)
      ? [path]
      : [];
  });
}

function emptyStartsFound(): string[] {
  return sourcesUnder(ui)
    .flatMap((path) =>
      stringLiteralsAt(readFileSync(path, "utf8"))
        .filter(({ text }) => EMPTY_START.test(text))
        .map(
          ({ text }) => `${relative(ui, path)} | ${text.slice(0, SHOWN_LENGTH)}`
        )
    )
    .sort();
}

const shown = (text: string) => text.slice(0, SHOWN_LENGTH);

describe("the texts that start like an empty state (AC-CL1)", () => {
  it("are all in one group, with the two good-news exceptions apart", () => {
    const listed = [
      ...WITH_NEXT_STEP,
      ...GOOD_NEWS,
      ...ALREADY_GUIDED,
      ...PENDING_NEXT_STEP,
      ...NOT_AN_EMPTY_STATE,
    ]
      .map((entry) => {
        const [file, ...text] = entry.split(" | ");
        return `${file} | ${shown(text.join(" | "))}`;
      })
      .sort();
    expect(emptyStartsFound()).toEqual(listed);
  });

  it("keeps the exceptions to the two the corte names", () => {
    expect(GOOD_NEWS).toHaveLength(2);
  });
});
