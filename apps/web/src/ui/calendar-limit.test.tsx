import type { DayPickerProps } from "react-day-picker";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "@/ui/calendar";
import { parseIsoDate } from "@/ui/date-values";

const received = vi.hoisted(() => ({ props: [] as DayPickerProps[] }));

vi.mock("react-day-picker", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-day-picker")>();
  return {
    ...original,
    DayPicker: (props: DayPickerProps) => {
      received.props.push(props);
      return original.DayPicker(props);
    },
  };
});

const OCTOBER_24 = parseIsoDate("2026-10-24") as Date;
const LIMIT = { after: OCTOBER_24 };

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const dayButton = (markup: string, iso: string) =>
  new RegExp(`<button[^>]*data-day="${iso}"[^>]*>`).exec(markup)?.[0] ?? "";
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const REASON_LINE = /<p[^>]*>Só até hoje<\/p>/;
const PARAGRAPH = /<p[\s>]/;

beforeEach(() => {
  received.props = [];
});

describe("Calendar, o limite como modificador", () => {
  it("o limite chega ao DayPicker como modificador disabled e não como a prop, que faria a seta pular o dia", () => {
    html(
      <Calendar
        defaultMonth={OCTOBER_24}
        disabled={LIMIT}
        mode="single"
        today={OCTOBER_24}
      />
    );
    const props = received.props.at(-1);
    expect(props?.disabled).toBeUndefined();
    expect(props?.modifiers?.disabled).toBe(LIMIT);
  });

  it("os outros modificadores do chamador seguem", () => {
    html(
      <Calendar
        defaultMonth={OCTOBER_24}
        disabled={LIMIT}
        modifiers={{ marked: OCTOBER_24 }}
        mode="single"
      />
    );
    expect(received.props.at(-1)?.modifiers).toEqual({
      disabled: LIMIT,
      marked: OCTOBER_24,
    });
  });

  it("sem limite, o modificador disabled do chamador não é apagado", () => {
    const markup = html(
      <Calendar
        defaultMonth={OCTOBER_24}
        disabledReason="Só até hoje"
        modifiers={{ disabled: LIMIT }}
        mode="single"
        today={OCTOBER_24}
      />
    );
    expect(received.props.at(-1)?.modifiers?.disabled).toBe(LIMIT);
    expect(attribute(dayButton(markup, "2026-10-25"), "aria-disabled")).toBe(
      "true"
    );
  });

  it("sem limite e sem modificador, nenhum dia fica desligado", () => {
    const markup = html(
      <Calendar defaultMonth={OCTOBER_24} mode="single" today={OCTOBER_24} />
    );
    expect(received.props.at(-1)?.modifiers?.disabled).toBeUndefined();
    expect(markup).not.toContain('aria-disabled="true"');
  });
});

describe("Calendar, a linha do motivo", () => {
  const markup = html(
    <Calendar
      defaultMonth={OCTOBER_24}
      disabled={LIMIT}
      disabledReason="Só até hoje"
      mode="single"
      today={OCTOBER_24}
    />
  );
  const line = REASON_LINE.exec(markup)?.[0] ?? "";

  it("é texto visível ligado ao dia desligado, escondido (invisible, com a altura) enquanto nenhum dia desligado tem o foco", () => {
    const reasonId = attribute(
      dayButton(markup, "2026-10-25"),
      "aria-describedby"
    );
    expect(reasonId).toBeTruthy();
    expect(attribute(line, "id")).toBe(reasonId);
    expect(attribute(line, "class")).toContain("invisible");
    expect(attribute(line, "class")).not.toContain("sr-only");
    expect(attribute(line, "class")?.split(" ")).not.toContain("hidden");
  });

  it("reserva altura mínima, fica presa ao pé da caixa que rola e em cor cheia", () => {
    const classes = attribute(line, "class") ?? "";
    expect(classes).toContain("min-h-5");
    expect(classes).toContain("sticky bottom-0");
    expect(classes).toContain("bg-popover");
    expect(classes).toContain("text-muted-foreground");
    expect(classes).not.toContain("opacity");
  });

  it("não é região viva: o leitor lê o motivo uma vez, no foco do dia", () => {
    expect(line).not.toContain("aria-live");
    expect(line).not.toContain("role=");
  });

  it("sem motivo não há linha nem altura reservada", () => {
    const quiet = html(
      <Calendar
        defaultMonth={OCTOBER_24}
        disabled={LIMIT}
        mode="single"
        today={OCTOBER_24}
      />
    );
    expect(quiet).not.toMatch(PARAGRAPH);
    expect(
      attribute(dayButton(quiet, "2026-10-25"), "aria-describedby")
    ).toBeUndefined();
  });
});

describe("Calendar, o dia desligado", () => {
  const markup = html(
    <Calendar
      defaultMonth={OCTOBER_24}
      disabled={LIMIT}
      disabledReason="Só até hoje"
      mode="single"
      today={OCTOBER_24}
    />
  );
  const off = attribute(dayButton(markup, "2026-10-25"), "class") ?? "";
  const allowed = attribute(dayButton(markup, "2026-10-23"), "class") ?? "";

  it("recebe o toque: o ponteiro chega ao dia e o cursor diz que não vale", () => {
    expect(off).toContain("aria-disabled:pointer-events-auto");
    expect(off).toContain("aria-disabled:cursor-not-allowed");
  });

  it("só o número apaga: riscado, texto a 40% e a opacidade do botão devolvida, para o contorno do foco não apagar", () => {
    expect(off).toContain("aria-disabled:text-foreground/40");
    expect(off).toContain("aria-disabled:line-through");
    expect(off).toContain("aria-disabled:opacity-100");
    expect(off).not.toContain("aria-disabled:opacity-40");
  });

  it("não acende no hover nem afunda ao apertar", () => {
    expect(off).toContain("aria-disabled:hover:bg-transparent!");
    expect(off).toContain("aria-disabled:active:not-aria-[haspopup]:scale-100");
  });

  it("o contorno de foco é o de todo controle", () => {
    expect(off).toContain("focus-ring");
    expect(allowed).toContain("focus-ring");
  });
});
