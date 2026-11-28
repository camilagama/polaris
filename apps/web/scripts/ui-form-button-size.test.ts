import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DESIGN.md manda o botão principal de formulário de página ou de diálogo de formulário em `Button size="xl"`, e o
 * "Cancelar" da mesma linha na mesma altura. A lista abaixo é a dos formulários em que isso foi aplicado: por arquivo,
 * quantos `<Button size="xl" type="submit">` (o principal) e quantos `<Button size="xl">` de outro tipo (o Cancelar e a
 * ação irmã da linha) o fonte tem. A conta é exata: voltar um botão a outro tamanho derruba a contagem, e um botão
 * `xl` novo num desses arquivos pede a linha atualizada aqui. Confirmação destrutiva, formulário dentro de linha de
 * lista e botão fora de formulário não entram: ficam no tamanho padrão de propósito.
 */
const web = fileURLToPath(new URL("..", import.meta.url));

const TAG_BOUNDARY = /[\s/>]/;
const SIZE_XL = /\bsize="xl"/;
const TYPE_SUBMIT = /\btype="submit"/;

interface Expected {
  readonly file: string;
  readonly other: number;
  readonly submit: number;
}

const FORM_BUTTONS: readonly Expected[] = [
  { file: "src/catalog/category-form.tsx", other: 0, submit: 1 },
  { file: "src/catalog/product-dialog.tsx", other: 1, submit: 1 },
  { file: "src/catalog/product-media-panel.tsx", other: 0, submit: 1 },
  { file: "src/catalog/product-variants-form.tsx", other: 1, submit: 1 },
  { file: "src/catalog/public-catalog-panels.tsx", other: 0, submit: 1 },
  { file: "src/customers/customer-form.tsx", other: 1, submit: 1 },
  { file: "src/dashboard/goal-form.tsx", other: 2, submit: 2 },
  { file: "src/expenses/expense-category-form.tsx", other: 1, submit: 1 },
  { file: "src/expenses/expense-form.tsx", other: 1, submit: 1 },
  { file: "src/expenses/expense-rule-form.tsx", other: 1, submit: 1 },
  {
    file: "src/payment-profiles/payment-profile-form.tsx",
    other: 1,
    submit: 1,
  },
  { file: "src/sales/sale-customer-panel.tsx", other: 1, submit: 1 },
  { file: "src/ui/filter-bar.tsx", other: 1, submit: 1 },
];

interface Counts {
  other: number;
  submit: number;
}

const COMMENT_OR_STRING =
  /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;

const withoutComments = (text: string) =>
  text.replace(COMMENT_OR_STRING, (_match, quoted?: string) => quoted ?? "");

/** The opening tags of every `<Button`: the end is the first `>` outside braces and strings, so `=>` in a handler does not cut it. */
function buttonTags(rawSource: string): string[] {
  const source = withoutComments(rawSource);
  const tags: string[] = [];
  let from = source.indexOf("<Button");
  while (from !== -1) {
    const after = source[from + "<Button".length] ?? "";
    let end = from + "<Button".length;
    if (TAG_BOUNDARY.test(after)) {
      let depth = 0;
      let quote: string | null = null;
      for (; end < source.length; end += 1) {
        const ch = source[end] ?? "";
        if (quote !== null) {
          if (ch === "\\") {
            end += 1;
          } else if (ch === quote) {
            quote = null;
          }
        } else if (ch === '"' || ch === "'" || (ch === "`" && depth > 0)) {
          quote = ch;
        } else if (ch === "{") {
          depth += 1;
        } else if (ch === "}") {
          depth -= 1;
        } else if (ch === ">" && depth === 0) {
          break;
        }
      }
      tags.push(source.slice(from, end + 1));
    }
    from = source.indexOf("<Button", end);
  }
  return tags;
}

function xlCounts(source: string): Counts {
  const counts: Counts = { other: 0, submit: 0 };
  for (const tag of buttonTags(source)) {
    if (!SIZE_XL.test(tag)) {
      continue;
    }
    if (TYPE_SUBMIT.test(tag)) {
      counts.submit += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function problems(expected: Expected, source: string): string[] {
  const found = xlCounts(source);
  const out: string[] = [];
  if (found.submit !== expected.submit) {
    out.push(
      `${expected.file}: ${found.submit} botão(ões) de envio em size="xl", esperado ${expected.submit}. O botão principal do formulário usa size="xl" (DESIGN.md).`
    );
  }
  if (found.other !== expected.other) {
    out.push(
      `${expected.file}: ${found.other} botão(ões) size="xl" que não é de envio (o Cancelar da linha), esperado ${expected.other}.`
    );
  }
  return out;
}

describe("o botão principal dos formulários é size xl", () => {
  it.each(FORM_BUTTONS)("$file", (expected) => {
    const source = readFileSync(join(web, expected.file), "utf8");
    expect(problems(expected, source)).toEqual([]);
  });

  it("lê o fim do botão fora de chaves e de textos: => e > dentro de um valor não o cortam", () => {
    const source = `<Button onClick={() => go(a > b)} title="a > b" size="xl" type="submit">Salvar</Button>
      <Button size="xl" type="button" variant="outline" render={<a href="/x" />}>Cancelar</Button>`;
    expect(xlCounts(source)).toEqual({ other: 1, submit: 1 });
  });

  it("controle plantado: o botão de envio que volta ao padrão reprova", () => {
    const expected: Expected = { file: "planted.tsx", other: 1, submit: 1 };
    const kept = `<Button onClick={onCancel} size="xl" type="button" variant="outline">Cancelar</Button>
      <Button size="xl" type="submit">Salvar</Button>`;
    const reverted = kept.replace(
      '<Button size="xl" type="submit">',
      '<Button type="submit">'
    );
    expect(problems(expected, kept)).toEqual([]);
    expect(problems(expected, reverted)).toEqual([
      'planted.tsx: 0 botão(ões) de envio em size="xl", esperado 1. O botão principal do formulário usa size="xl" (DESIGN.md).',
    ]);
  });

  it("controle plantado: o Cancelar que troca de tamanho e o tamanho que vira variável reprovam", () => {
    const expected: Expected = { file: "planted.tsx", other: 1, submit: 1 };
    const submit = '<Button size="xl" type="submit">Salvar</Button>';
    const cancel =
      '<Button onClick={onCancel} size="xl" type="button">Cancelar</Button>';
    expect(
      problems(
        expected,
        `<Button onClick={onCancel} size="md" type="button">Cancelar</Button>${submit}`
      )
    ).toEqual([
      'planted.tsx: 0 botão(ões) size="xl" que não é de envio (o Cancelar da linha), esperado 1.',
    ]);
    expect(
      problems(
        expected,
        `${cancel}<Button size={size} type="submit">Salvar</Button>`
      )
    ).toEqual([
      'planted.tsx: 0 botão(ões) de envio em size="xl", esperado 1. O botão principal do formulário usa size="xl" (DESIGN.md).',
    ]);
  });

  it("controle plantado: um botão xl a mais no arquivo pede a lista atualizada", () => {
    const expected: Expected = { file: "planted.tsx", other: 0, submit: 1 };
    expect(
      problems(
        expected,
        '<Button size="xl" type="submit">A</Button><Button size="xl" type="button">B</Button>'
      )
    ).toEqual([
      'planted.tsx: 1 botão(ões) size="xl" que não é de envio (o Cancelar da linha), esperado 0.',
    ]);
  });

  it("controle plantado: um botão escrito dentro de comentário não conta", () => {
    expect(
      xlCounts(`// <Button size="xl" type="submit">
        /* <Button size="xl" type="button"> */
        <Button type="submit">Salvar</Button>`)
    ).toEqual({ other: 0, submit: 0 });
  });

  it("cada arquivo da lista existe uma vez só", () => {
    expect(new Set(FORM_BUTTONS.map((entry) => entry.file)).size).toBe(
      FORM_BUTTONS.length
    );
  });
});
