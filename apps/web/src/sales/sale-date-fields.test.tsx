import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DateField, DateRangeField } from "./sale-fields";

/** The markup of the date fields of the forms (t373): label, button name, help and error ties, and the "Limpar". */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const noop = () => undefined;

const BUTTON = /<button[^>]*data-slot="popover-trigger"[^>]*>/;
const HINT =
  /<p[^>]*id="stock-date-hint"[^>]*>Dia do movimento, no horário da loja\.<\/p>/;
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe("DateField", () => {
  it("o botão leva o nome do rótulo e a data, e a ajuda é lida junto com ele", () => {
    const markup = html(
      <DateField
        hint="Dia do movimento, no horário da loja."
        id="stock-date"
        label="Data"
        onChange={noop}
        today="2026-10-24"
        value="2026-10-20"
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-label")).toBe("Data, 20/10/2026");
    expect(attribute(button, "id")).toBe("stock-date");
    expect(attribute(button, "aria-describedby")).toBe("stock-date-hint");
    expect(markup).toMatch(HINT);
  });

  it("o erro vem antes da ajuda na leitura, e o botão fica inválido", () => {
    const markup = html(
      <DateField
        error="Use uma data válida."
        hint="Ajuda."
        id="d"
        label="Data"
        onChange={noop}
        value=""
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-invalid")).toBe("true");
    expect(attribute(button, "aria-label")).toBe("Data, Escolher data");
    expect(attribute(button, "aria-describedby")?.endsWith(" d-hint")).toBe(
      true
    );
    expect(markup).toContain("Use uma data válida.");
  });

  it("opcional: 'Limpar' só aparece com uma data, com o nome pedido", () => {
    const field = (value: string) =>
      html(
        <DateField
          clearLabel="Limpar data de término"
          id="ends"
          label="Termina em"
          onChange={noop}
          optional
          value={value}
        />
      );
    expect(field("")).not.toContain("Limpar");
    expect(field("2026-12-10")).toContain(
      'aria-label="Limpar data de término"'
    );
    expect(field("")).toContain("Opcional");
  });

  it("obrigatório nunca mostra 'Limpar'", () => {
    expect(
      html(<DateField id="d" label="Data" onChange={noop} value="2026-10-20" />)
    ).not.toContain("Limpar");
  });
});

describe("DateRangeField", () => {
  it("as duas pontas do rascunho viram o período do botão; sem uma delas é 'Escolher período'", () => {
    const field = (from: string, to: string) =>
      html(
        <DateRangeField
          from={from}
          hint="No máximo 366 dias."
          id="period"
          label="Período da meta"
          onChange={noop}
          to={to}
          today="2026-10-24"
        />
      );
    const full = BUTTON.exec(field("2026-10-01", "2026-10-31"))?.[0] ?? "";
    expect(attribute(full, "aria-label")).toBe(
      "Período da meta, 01/10 a 31/10"
    );
    expect(attribute(full, "aria-describedby")).toBe("period-hint");
    const half = BUTTON.exec(field("2026-10-01", ""))?.[0] ?? "";
    expect(attribute(half, "aria-label")).toBe(
      "Período da meta, Escolher período"
    );
  });
});
