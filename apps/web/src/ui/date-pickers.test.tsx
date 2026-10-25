import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Calendar } from "@/ui/calendar";
import { DatePicker } from "@/ui/date-picker";
import { DateRangePicker } from "@/ui/date-range-picker";
import { parseIsoDate } from "@/ui/date-values";

/**
 * The markup of the date pickers (t363): the accessible names and the error of the buttons, and the month grid of
 * the calendar (Portuguese caption and arrows, the chosen day, the disabled days with their reason, the sizes and
 * the focus in the classes). The browser checks (e2e-pwa/ui-date-pickers.e2e.ts) click, type and measure them in
 * the gallery.
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const noop = () => undefined;

const OCTOBER_24 = parseIsoDate("2026-10-24") as Date;

const BUTTON = /<button[^>]*data-slot="popover-trigger"[^>]*>/;
const TODAY_LABEL = /^Hoje, sábado, 24 de outubro de 2026/;
const DISABLED_ATTRIBUTE = /\sdisabled=""/;
const dayButton = (markup: string, iso: string) =>
  new RegExp(`<button[^>]*data-day="${iso}"[^>]*>`).exec(markup)?.[0] ?? "";
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe("DatePicker", () => {
  it("vazio: o botão diz o rótulo e Escolher data", () => {
    const markup = html(
      <DatePicker
        label="Data de competência"
        onValueChange={noop}
        today="2026-10-24"
        value={null}
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-label")).toBe(
      "Data de competência, Escolher data"
    );
    expect(markup).toContain("Escolher data");
    expect(attribute(button, "aria-invalid")).toBeUndefined();
  });

  it("com data: 24/10/2026 no texto e no nome", () => {
    const markup = html(
      <DatePicker
        label="Data de competência"
        onValueChange={noop}
        value="2026-10-24"
      />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-label")).toBe(
      "Data de competência, 24/10/2026"
    );
    expect(markup).toContain(">24/10/2026<");
  });

  it("erro: Escolha uma data, ligado ao botão", () => {
    const markup = html(
      <DatePicker error label="Vencimento" onValueChange={noop} value={null} />
    );
    const button = BUTTON.exec(markup)?.[0] ?? "";
    expect(attribute(button, "aria-invalid")).toBe("true");
    const describedBy = attribute(button, "aria-describedby");
    expect(describedBy).toBeTruthy();
    const error = new RegExp(`<div[^>]*\\sid="${describedBy}"[^>]*>`).exec(
      markup
    )?.[0];
    expect(error && attribute(error, "role")).toBe("alert");
    expect(markup).toContain("Escolha uma data");
  });
});

describe("DateRangePicker", () => {
  it("vazio: Escolher período", () => {
    const markup = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={null}
      />
    );
    expect(attribute(BUTTON.exec(markup)?.[0] ?? "", "aria-label")).toBe(
      "Período, Escolher período"
    );
  });

  it("um campo só: 01/10 a 24/10, e um dia só com o ano", () => {
    const range = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={{ from: "2026-10-01", to: "2026-10-24" }}
      />
    );
    expect(attribute(BUTTON.exec(range)?.[0] ?? "", "aria-label")).toBe(
      "Período, 01/10 a 24/10"
    );
    const oneDay = html(
      <DateRangePicker
        label="Período"
        onValueChange={noop}
        today="2026-10-24"
        value={{ from: "2026-10-24", to: "2026-10-24" }}
      />
    );
    expect(oneDay).toContain(">24/10/2026<");
  });
});

describe("Calendar", () => {
  const markup = html(
    <Calendar
      defaultMonth={OCTOBER_24}
      disabled={{ after: OCTOBER_24 }}
      disabledReason="Só até hoje"
      mode="single"
      selected={parseIsoDate("2026-10-20")}
      today={OCTOBER_24}
    />
  );

  it("em português: o mês, as setas e o dia com o nome inteiro", () => {
    expect(markup).toContain("Outubro de 2026");
    expect(markup).toContain('aria-label="Mês anterior"');
    expect(markup).toContain('aria-label="Próximo mês"');
    expect(attribute(dayButton(markup, "2026-10-24"), "aria-label")).toMatch(
      TODAY_LABEL
    );
  });

  it("o dia escolhido é marcado", () => {
    expect(dayButton(markup, "2026-10-20")).toContain(
      'data-selected-single="true"'
    );
  });

  it("dia fora do permitido: aria-disabled com o motivo, nunca disabled", () => {
    const off = dayButton(markup, "2026-10-25");
    expect(attribute(off, "aria-disabled")).toBe("true");
    expect(off).not.toMatch(DISABLED_ATTRIBUTE);
    const reasonId = attribute(off, "aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(markup).toContain(
      `<span class="sr-only" id="${reasonId}">Só até hoje</span>`
    );
    const allowed = dayButton(markup, "2026-10-23");
    expect(attribute(allowed, "aria-disabled")).toBeUndefined();
    expect(attribute(allowed, "aria-describedby")).toBeUndefined();
  });

  it("36 px no mouse, 44 no toque e o foco de 3 px nas classes", () => {
    expect(markup).toContain("[--cell-size:2.25rem]");
    expect(markup).toContain("touch:[--cell-size:min(2.75rem,");
    expect(dayButton(markup, "2026-10-23")).toContain("size-(--cell-size)");
    expect(dayButton(markup, "2026-10-23")).toContain("focus-ring");
    expect(markup).toContain('data-slot="calendar"');
  });
});
