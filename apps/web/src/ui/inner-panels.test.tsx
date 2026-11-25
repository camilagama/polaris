import CheckIcon from "lucide-react/dist/esm/icons/check";
import StoreIcon from "lucide-react/dist/esm/icons/store";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckableOption } from "./checkable-option";
import { FieldLegend } from "./field";
import { FieldGroup } from "./field-group";
import { InsetBlock } from "./inset-block";
import { StepTile } from "./step-tile";

const CLASS = /class="([^"]*)"/;
const FRACTION_OF_GREY = /bg-muted\//;
const LEGEND = /<legend[^>]*>Endereço<\/legend>/;
const DISABLED_FIELDSET = /<fieldset[^>]*disabled/;
const SVG = /<svg[\s\S]*<\/svg>/;
const noop = () => undefined;

function classesOf(html: string): string[] {
  return (CLASS.exec(html)?.[1] ?? "").split(" ");
}

describe("InsetBlock", () => {
  it("é o cinza cheio e arredondado, sem borda e sem fração de cinza", () => {
    const html = renderToStaticMarkup(<InsetBlock>dado</InsetBlock>);
    const classes = classesOf(html);
    expect(classes).toContain("bg-muted");
    expect(classes).toContain("rounded-lg");
    expect(classes.some((name) => name.startsWith("border"))).toBe(false);
    expect(html).not.toMatch(FRACTION_OF_GREY);
    expect(html).toContain(">dado<");
  });

  it("deixa a tela acrescentar classe e atributo sem perder o cinza", () => {
    const html = renderToStaticMarkup(
      <InsetBlock className="grid gap-3" data-receipt-block="dates">
        x
      </InsetBlock>
    );
    expect(classesOf(html)).toEqual(
      expect.arrayContaining(["bg-muted", "grid", "gap-3"])
    );
    expect(html).toContain('data-receipt-block="dates"');
  });
});

describe("InsetBlock tone", () => {
  it("o padrão não tem anel", () => {
    const classes = classesOf(renderToStaticMarkup(<InsetBlock>x</InsetBlock>));
    expect(classes.some((name) => name.startsWith("ring"))).toBe(false);
  });

  it("destructive põe o anel interno de 1 px em destructive a 60 % sobre o mesmo cinza, sem fundo nem texto vermelho", () => {
    const classes = classesOf(
      renderToStaticMarkup(<InsetBlock tone="destructive">x</InsetBlock>)
    );
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-muted",
        "ring-1",
        "ring-inset",
        "ring-destructive/60",
      ])
    );
    expect(
      classes.some(
        (name) =>
          name.startsWith("bg-destructive") ||
          name.startsWith("text-destructive")
      )
    ).toBe(false);
  });

  it("a tela não precisa escrever classe de anel: o tom basta e o className dela convive", () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <InsetBlock className="grid gap-3 p-3" tone="destructive">
          x
        </InsetBlock>
      )
    );
    expect(classes).toEqual(
      expect.arrayContaining(["grid", "gap-3", "ring-destructive/60"])
    );
  });
});

describe("FieldGroup", () => {
  it("é um fieldset com borda de 1 px, arredondado e sem fundo", () => {
    const html = renderToStaticMarkup(
      <FieldGroup>
        <FieldLegend>Endereço</FieldLegend>
      </FieldGroup>
    );
    expect(html.startsWith("<fieldset")).toBe(true);
    const classes = classesOf(html);
    expect(classes).toEqual(
      expect.arrayContaining(["rounded-lg", "border", "border-border"])
    );
    expect(classes.some((name) => name.startsWith("bg-"))).toBe(false);
    expect(html).toMatch(LEGEND);
  });

  it("passa disabled ao fieldset, que desliga os campos de dentro", () => {
    const html = renderToStaticMarkup(
      <FieldGroup disabled>
        <input />
      </FieldGroup>
    );
    expect(html).toMatch(DISABLED_FIELDSET);
  });
});

describe("CheckableOption", () => {
  const draw = (checked: boolean, disabled = false) =>
    renderToStaticMarkup(
      <CheckableOption
        checked={checked}
        disabled={disabled}
        onCheckedChange={noop}
      >
        Azul / M
      </CheckableOption>
    );

  it("a linha inteira é o rótulo da caixa, com borda de 1 px e a altura de controle", () => {
    const html = draw(false);
    expect(html.startsWith("<label")).toBe(true);
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("Azul / M");
    expect(classesOf(html)).toEqual(
      expect.arrayContaining(["border", "border-border", "min-h-ctl-md"])
    );
  });

  it("marcada, a caixa diz que está marcada", () => {
    expect(draw(true)).toContain('aria-checked="true"');
    expect(draw(false)).toContain('aria-checked="false"');
  });

  it("desligada, a caixa fica desligada para o leitor de tela", () => {
    expect(draw(false, true)).toContain('aria-disabled="true"');
  });

  it("quebra o texto comprido em vez de passar da borda", () => {
    expect(draw(false)).toContain("[overflow-wrap:anywhere]");
  });

  it("desligada, o apagado fica só no texto e o cursor de bloqueio na linha", () => {
    const html = draw(false, true);
    expect(classesOf(html)).toEqual(
      expect.arrayContaining([
        "group/option",
        "has-disabled:cursor-not-allowed",
      ])
    );
    expect(html).toContain(
      'class="[overflow-wrap:anywhere] group-has-disabled/option:opacity-50"'
    );
    expect(classesOf(html)).not.toContain("opacity-50");
    expect(html).toContain("data-disabled:opacity-50");
  });
});

describe("StepTile", () => {
  const draw = (state: "current" | "done" | "todo") =>
    renderToStaticMarkup(
      <StepTile state={state}>
        <StoreIcon data-icon="store" />
      </StepTile>
    );

  it("tem 28 px nos três estados, para o estado não mover nada, e o ícone dentro tem 16 px", () => {
    for (const state of ["current", "done", "todo"] as const) {
      expect(classesOf(draw(state))).toEqual(
        expect.arrayContaining([
          "size-7",
          "rounded-md",
          "border",
          "[&amp;&gt;svg]:size-4",
        ])
      );
    }
  });

  it("é só decoração: escondida do leitor de tela, com o estado em data-step-box", () => {
    const html = draw("current");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-step-box="current"');
  });

  it("a cor diz o estado: atual com borda de tinta, feito sem borda, a fazer apagado", () => {
    expect(classesOf(draw("current"))).toContain("border-primary");
    expect(classesOf(draw("done"))).toContain("border-transparent");
    expect(classesOf(draw("todo"))).toContain("text-muted-foreground");
  });

  it("feito troca o ícone do passo pelo visto; os outros estados mostram o ícone", () => {
    const check = renderToStaticMarkup(<CheckIcon />);
    const checkPath = SVG.exec(check)?.[0] ?? "";
    expect(draw("done")).toContain(checkPath);
    expect(draw("done")).not.toContain('data-icon="store"');
    expect(draw("current")).toContain('data-icon="store"');
    expect(draw("todo")).toContain('data-icon="store"');
  });
});
