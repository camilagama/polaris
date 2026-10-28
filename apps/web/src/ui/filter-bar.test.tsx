import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilterBar } from "@/ui/filter-bar";
import {
  CLEAR_ALL_FROM,
  editLabel,
  type FilterField,
  type FilterRule,
  lockedLabel,
  pillMotion,
  removeLabel,
  removeRule,
  setRule,
  showClearAll,
  valueText,
  visibleRules,
} from "@/ui/filter-bar-model";

/**
 * The rules of the filter bar and its first paint. The rules (what a filter is, what its pill says, what adding,
 * editing, removing and "Limpar tudo" do, when motion is off) are pure functions in `filter-bar-model.ts`, tested here
 * without a browser; the markup of the bar is rendered to a string for the names, the `<search>` and the field that
 * cannot be used. That a touch opens the menu or the editor, where the focus goes and what the sizes are needs a
 * browser: e2e-pwa/ui-filter-bar.e2e.ts does it in the gallery.
 */
const FIELDS: FilterField[] = [
  { id: "periodo", label: "Período", today: "2026-10-24", type: "date-range" },
  {
    id: "situacao",
    label: "Situação",
    options: [
      { label: "Paga", value: "paga" },
      { label: "Cancelada", value: "cancelada" },
    ],
    type: "select",
  },
  { id: "cliente", label: "Cliente", type: "text" },
  {
    disabledReason: "Só com conexão",
    id: "produto",
    label: "Produto vendido",
    type: "text",
  },
];

const PERIOD: FilterRule = {
  fieldId: "periodo",
  value: { from: "2026-10-01", to: "2026-10-24" },
};
const PAID: FilterRule = { fieldId: "situacao", value: "paga" };
const CLIENT: FilterRule = { fieldId: "cliente", value: "Maria Souza" };

const noop = () => undefined;
const SEARCH_NAMED = /<search[^>]*aria-label="Filtrar vendas"/;
const STATUS_INSIDE =
  /<p role="status">1 venda com esse filtro<\/p><\/search>$/;
const ids = (rules: readonly FilterRule[]) => rules.map((rule) => rule.fieldId);

describe("o texto de cada pílula", () => {
  it("texto: o que se digitou, sem as pontas", () => {
    expect(valueText(FIELDS[2] as FilterField, "  Maria  ")).toBe("Maria");
  });

  it("escolha: o rótulo da opção, nunca o valor", () => {
    expect(valueText(FIELDS[1] as FilterField, "cancelada")).toBe("Cancelada");
  });

  it("período: 01/10 a 24/10; um dia por inteiro; com o ano quando não é o de hoje", () => {
    const field = FIELDS[0] as FilterField;
    expect(valueText(field, { from: "2026-10-01", to: "2026-10-24" })).toBe(
      "01/10 a 24/10"
    );
    expect(valueText(field, { from: "2026-10-24", to: "2026-10-24" })).toBe(
      "24/10/2026"
    );
    expect(valueText(field, { from: "2025-12-20", to: "2026-01-05" })).toBe(
      "20/12/2025 a 05/01/2026"
    );
  });

  it("o que não serve ao campo não tem texto: vazio, opção que não existe, período invertido, tipo trocado", () => {
    expect(valueText(FIELDS[2] as FilterField, "   ")).toBeUndefined();
    expect(valueText(FIELDS[1] as FilterField, "devolvida")).toBeUndefined();
    expect(
      valueText(FIELDS[0] as FilterField, {
        from: "2026-10-24",
        to: "2026-10-01",
      })
    ).toBeUndefined();
    expect(valueText(FIELDS[0] as FilterField, "01/10")).toBeUndefined();
    expect(
      valueText(FIELDS[2] as FilterField, {
        from: "2026-10-01",
        to: "2026-10-02",
      })
    ).toBeUndefined();
  });
});

describe("adicionar, editar e tirar", () => {
  it("adicionar põe o filtro no fim, na ordem em que foram escolhidos", () => {
    const next = setRule(FIELDS, [PERIOD], "cliente", "Ana");
    expect(next).toEqual([PERIOD, { fieldId: "cliente", value: "Ana" }]);
  });

  it("editar troca o valor onde o filtro está, sem mudar a ordem das pílulas", () => {
    const next = setRule(
      FIELDS,
      [PERIOD, PAID, CLIENT],
      "situacao",
      "cancelada"
    );
    expect(ids(next)).toEqual(["periodo", "situacao", "cliente"]);
    expect(next[1]).toEqual({ fieldId: "situacao", value: "cancelada" });
  });

  it("um campo repetido na lista é substituído, não duplicado: fica uma regra só, no primeiro lugar, com o valor novo", () => {
    const rules = [
      PERIOD,
      { fieldId: "cliente", value: "Ana" },
      PAID,
      { fieldId: "cliente", value: "Beto" },
    ];
    expect(setRule(FIELDS, rules, "cliente", "Caio")).toEqual([
      PERIOD,
      { fieldId: "cliente", value: "Caio" },
      PAID,
    ]);
    // um valor que não serve tira as duas
    expect(ids(setRule(FIELDS, rules, "cliente", null))).toEqual([
      "periodo",
      "situacao",
    ]);
    expect(rules).toHaveLength(4);
  });

  it("o texto guardado vai sem as pontas", () => {
    expect(setRule(FIELDS, [], "cliente", "  Ana  ")).toEqual([
      { fieldId: "cliente", value: "Ana" },
    ]);
  });

  it("um valor vazio tira o filtro: vazio nunca é filtro", () => {
    expect(ids(setRule(FIELDS, [PERIOD, CLIENT], "cliente", "  "))).toEqual([
      "periodo",
    ]);
    expect(ids(setRule(FIELDS, [PERIOD, CLIENT], "cliente", null))).toEqual([
      "periodo",
    ]);
    expect(setRule(FIELDS, [], "cliente", "")).toEqual([]);
  });

  it("uma opção que o campo não tem, um campo que não existe e um período inválido não entram", () => {
    expect(setRule(FIELDS, [], "situacao", "devolvida")).toEqual([]);
    expect(setRule(FIELDS, [], "outro", "x")).toEqual([]);
    expect(
      setRule(FIELDS, [], "periodo", { from: "2026-10-24", to: "2026-10-01" })
    ).toEqual([]);
  });

  it("tirar o filtro de um campo deixa os outros como estavam", () => {
    expect(removeRule([PERIOD, PAID, CLIENT], "situacao")).toEqual([
      PERIOD,
      CLIENT,
    ]);
    expect(removeRule([PERIOD], "cliente")).toEqual([PERIOD]);
  });

  it("não muda a lista que recebeu", () => {
    const rules = [PERIOD, CLIENT];
    setRule(FIELDS, rules, "cliente", "Ana");
    removeRule(rules, "periodo");
    expect(rules).toEqual([PERIOD, CLIENT]);
  });
});

describe("o que a barra mostra", () => {
  it("mostra só o que serve: ignora campo que saiu, valor sem opção, período ruim e o segundo filtro do mesmo campo", () => {
    const shown = visibleRules(FIELDS, [
      PERIOD,
      { fieldId: "situacao", value: "devolvida" },
      { fieldId: "sumiu", value: "x" },
      { fieldId: "periodo", value: { from: "2026-10-02", to: "2026-10-03" } },
      CLIENT,
    ]);
    expect(shown.map((item) => item.field.id)).toEqual(["periodo", "cliente"]);
    expect(shown.map((item) => item.text)).toEqual([
      "01/10 a 24/10",
      "Maria Souza",
    ]);
  });
});

describe("Limpar tudo", () => {
  it("só aparece com duas ou mais pílulas: com uma, o X dela é o mesmo gesto", () => {
    expect(CLEAR_ALL_FROM).toBe(2);
    expect(showClearAll(0)).toBe(false);
    expect(showClearAll(1)).toBe(false);
    expect(showClearAll(2)).toBe(true);
    expect(showClearAll(3)).toBe(true);
  });
});

describe("os nomes que o leitor de tela ouve", () => {
  it("a pílula diz o campo, o valor e que edita; o X diz que tira o filtro", () => {
    const period = FIELDS[0] as FilterField;
    expect(editLabel(period, "01/10 a 24/10")).toBe(
      "Período: 01/10 a 24/10, editar"
    );
    expect(removeLabel(period)).toBe("Tirar o filtro Período");
    // a pill that cannot be edited does not say it can
    expect(lockedLabel(period, "01/10 a 24/10")).toBe("Período: 01/10 a 24/10");
  });
});

describe("movimento", () => {
  it("no nível full a pílula entra e sai com opacidade e escala e as vizinhas deslizam (layout), como no Araute", () => {
    const motion = pillMotion("full");
    expect(motion.initial).toEqual({ opacity: 0, scale: 0.95, y: 4 });
    expect(motion.animate).toEqual({ opacity: 1, scale: 1, y: 0 });
    expect(motion.exit).toEqual({ opacity: 0, scale: 0.95, y: -4 });
    expect(motion.layout).toBe(true);
    expect(motion.transition?.type).toBe("spring");
  });

  it("no celular (essential) e com prefers-reduced-motion (none) nada se move: sem entrada, sem saída e sem deslizar", () => {
    expect(pillMotion("essential")).toEqual({});
    expect(pillMotion("none")).toEqual({});
  });
});

describe("a barra, na primeira pintura", () => {
  const html = (rules: FilterRule[], status?: string) =>
    renderToStaticMarkup(
      <FilterBar
        fields={FIELDS}
        label="Filtrar vendas"
        onChange={noop}
        value={rules}
      >
        {status ? <p role="status">{status}</p> : null}
      </FilterBar>
    );
  const attribute = (tag: string, name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const tagWith = (markup: string, label: string) =>
    new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0] ??
    "";

  it("é um <search> com o nome que a tela deu, e a linha de status da tela fica dentro dele", () => {
    const markup = html([PERIOD], "1 venda com esse filtro");
    expect(markup).toMatch(SEARCH_NAMED);
    expect(markup).toMatch(STATUS_INSIDE);
  });

  it("cada filtro é uma pílula com o nome certo e o X com o nome certo", () => {
    const markup = html([PERIOD, PAID, CLIENT]);
    for (const name of [
      "Período: 01/10 a 24/10, editar",
      "Situação: Paga, editar",
      "Cliente: Maria Souza, editar",
      "Tirar o filtro Período",
      "Tirar o filtro Situação",
      "Tirar o filtro Cliente",
    ]) {
      expect(markup, name).toContain(`aria-label="${name}"`);
    }
  });

  it("a pílula tem 44 px de altura no toque (36 px no mouse) e o X 48 px de largura no toque, para a área dele não entrar na do botão ao lado", () => {
    const markup = html([PERIOD]);
    expect(markup).toContain("h-9");
    expect(markup).toContain("touch:h-11");
    expect(markup).toContain("touch:w-12");
  });

  it("Limpar tudo só com duas ou mais pílulas", () => {
    expect(html([])).not.toContain("Limpar tudo");
    expect(html([PERIOD])).not.toContain("Limpar tudo");
    expect(html([PERIOD, PAID])).toContain("Limpar tudo");
  });

  it("sem filtros só há o botão Filtrar", () => {
    const markup = html([]);
    expect(markup).toContain("Filtrar");
    expect(markup).not.toContain('data-slot="filter-pill"');
  });

  it("um filtro cujo campo não pode ser usado agora fica aria-disabled, diz o motivo e continua podendo sair", () => {
    const markup = html([{ fieldId: "produto", value: "Camiseta" }]);
    const edit = tagWith(markup, "Produto vendido: Camiseta");
    expect(attribute(edit, "aria-disabled")).toBe("true");
    expect(attribute(edit, "disabled")).toBeUndefined();
    const reason = attribute(edit, "aria-describedby");
    expect(reason).toBeTruthy();
    expect(markup).toMatch(
      new RegExp(`<span[^>]*id="${reason}"[^>]*>Só com conexão</span>`)
    );
    expect(markup).toContain('aria-label="Tirar o filtro Produto vendido"');
  });

  it("o campo que pode ser usado abre o editor: a pílula é botão de popover, não aria-disabled", () => {
    const edit = tagWith(html([CLIENT]), "Cliente: Maria Souza, editar");
    expect(attribute(edit, "aria-disabled")).toBeUndefined();
    expect(attribute(edit, "aria-haspopup")).toBe("dialog");
  });

  it("um filtro de campo que saiu da lista, ou com valor que não serve, não vira pílula", () => {
    const markup = html([
      { fieldId: "sumiu", value: "x" },
      { fieldId: "situacao", value: "devolvida" },
    ]);
    expect(markup).not.toContain("filter-pill");
  });
});
